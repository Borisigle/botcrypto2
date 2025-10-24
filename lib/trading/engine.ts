import type {
  ClosedTrade,
  DailyPerformance,
  FootprintBar,
  FootprintSignal,
  InvalidationActionOption,
  InvalidationActionType,
  InvalidationEvent,
  InvalidationEvidenceItem,
  InvalidationSettings,
  InvalidationSeverity,
  InvalidationTriggerId,
  PendingTrade,
  Position,
  SignalSide,
  SignalStrategy,
  Trade,
  TradeExitReason,
  TradeFirstHit,
  TradeResult,
  TradingSession,
  TradingSettings,
  TradingState,
} from "@/types";

const DEFAULT_INVALIDATION_SETTINGS: InvalidationSettings = {
  aggressiveness: "moderate",
  lookbackBars: 6,
  autoCloseHighSeverity: false,
  autoCloseThreshold: 85,
  minOppositeSignalScore: 75,
  stackedImbalanceLevels: 4,
  stackedImbalanceRatio: 4,
  stackedImbalanceWindowSeconds: 60,
  minProgressR: 0.5,
  deltaFlipWindow: 2,
  cumDeltaLookback: 5,
  timeDecayMinutes: 9,
  liquiditySweepPercentile: 0.85,
  liquidityRetracePercent: 0.8,
  keyLevelDeltaThreshold: 0.65,
};

const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  autoTake: false,
  riskPerTradePercent: 1,
  feesPercent: 0.01,
  slippageTicks: 0.5,
  partialTakePercent: 0.5,
  timeStopMinutes: 15,
  retestWindowMinutes: 5,
  beOffsetTicks: 0.5,
  invalidationBars: 0,
  invalidations: DEFAULT_INVALIDATION_SETTINGS,
};

interface TradingEngineOptions {
  priceStep: number;
  timeframeMs: number;
  settings?: Partial<TradingSettings>;
  history?: ClosedTrade[];
}

export interface TradingPersistenceSnapshot {
  settings: TradingSettings;
  history: ClosedTrade[];
}

const MAX_SIGNAL_CACHE = 400;
const MAX_HISTORY = 2000;
const MAX_CLOSED_CACHE = 120;
const MAX_INVALIDATION_EVENTS = 240;
const PRICE_EPSILON = 1e-8;
const PNL_EPSILON = 1e-9;
const INVALIDATION_COOLDOWN_MS = 60_000;

const SESSION_KEYS: TradingSession[] = ["asia", "eu", "us", "other"];
const STRATEGY_KEYS: SignalStrategy[] = ["absorption-failure", "poc-migration", "delta-divergence"];

const INVALIDATION_WEIGHTS: Record<InvalidationTriggerId, number> = {
  "opposite-signal": 40,
  "stacked-imbalance": 18,
  "delta-poc-flip": 16,
  "cumdelta-break": 15,
  "key-level-recapture": 18,
  "time-decay": 12,
  "liquidity-sweep": 21,
};

const AGGRESSIVENESS_MULTIPLIER: Record<InvalidationSettings["aggressiveness"], number> = {
  strict: 1.1,
  moderate: 1,
  relaxed: 0.85,
};

const INVALIDATION_ACTIONS: Record<InvalidationActionType, InvalidationActionOption> = {
  close: { type: "close", label: "Cerrar ahora" },
  reduce: { type: "reduce", label: "Reducir 50%" },
  "tighten-stop": { type: "tighten-stop", label: "Mover SL (-0.5R)" },
  hold: { type: "hold", label: "Mantener" },
};

const INVALIDATION_RECOMMENDATIONS: Record<InvalidationSeverity, string> = {
  high: "Se recomienda cerrar la posición de inmediato.",
  medium: "Considera reducir exposición o ajustar el stop.",
  low: "Mantener con stop ajustado y monitoreo cercano.",
};

function getDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function directionFromSide(side: SignalSide): 1 | -1 {
  return side === "long" ? 1 : -1;
}

function applyEntrySlippage(side: SignalSide, price: number, slippage: number): number {
  return side === "long" ? price + slippage : price - slippage;
}

function applyExitSlippage(side: SignalSide, price: number, slippage: number): number {
  return side === "long" ? price - slippage : price + slippage;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeAverage(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

interface SummaryAccumulator {
  trades: number;
  winners: number;
  losers: number;
  breakeven: number;
  netR: number;
  winR: number;
  lossR: number;
}

interface PositionMeta {
  entryBarTime: number | null;
  entryCumDelta: number | null;
  entryPoc: number | null;
  entrySignalScore: number | null;
  lastInvalidationAt: number;
  lastScore: number;
  lastTriggers: InvalidationTriggerId[];
}

interface InvalidationEvaluationContext {
  now: number;
  reason: "signal" | "trade" | "bars";
  signals?: FootprintSignal[];
}

interface TriggerResult {
  id: InvalidationTriggerId;
  severity: number;
  evidence: InvalidationEvidenceItem[];
  markerPrice?: number;
  barTime?: number | null;
  barIndex?: number | null;
}

function createSummaryAccumulator(): SummaryAccumulator {
  return {
    trades: 0,
    winners: 0,
    losers: 0,
    breakeven: 0,
    netR: 0,
    winR: 0,
    lossR: 0,
  };
}

function reduceTrades(trades: ClosedTrade[]): SummaryAccumulator {
  const acc = createSummaryAccumulator();
  for (const trade of trades) {
    acc.trades += 1;
    acc.netR += trade.realizedR;
    if (trade.realizedPnl > PNL_EPSILON) {
      acc.winners += 1;
      acc.winR += trade.realizedR;
    } else if (trade.realizedPnl < -PNL_EPSILON) {
      acc.losers += 1;
      acc.lossR += trade.realizedR;
    } else {
      acc.breakeven += 1;
    }
  }
  return acc;
}

function accumulatorToSummary(acc: SummaryAccumulator, riskFraction: number) {
  const trades = acc.trades;
  const netR = acc.netR;
  const netPercent = netR * riskFraction;
  const avgR = trades ? netR / trades : 0;
  const winRate = trades ? acc.winners / trades : 0;
  const lossRate = trades ? acc.losers / trades : 0;
  const avgWin = acc.winners ? acc.winR / acc.winners : 0;
  const avgLoss = acc.losers ? Math.abs(acc.lossR / acc.losers) : 0;
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  return {
    trades,
    winners: acc.winners,
    losers: acc.losers,
    breakeven: acc.breakeven,
    netR,
    netPercent,
    avgR,
    expectancy,
    winRate,
    lossRate,
  };
}

function createDailyPerformance(day: string, trades: ClosedTrade[], riskFraction: number): DailyPerformance {
  const totals = accumulatorToSummary(reduceTrades(trades), riskFraction);

  const bySession = SESSION_KEYS.reduce<Record<TradingSession, ReturnType<typeof accumulatorToSummary>>>(
    (acc, session) => {
      const filtered = trades.filter((trade) => trade.session === session);
      acc[session] = accumulatorToSummary(reduceTrades(filtered), riskFraction);
      return acc;
    },
    {
      asia: accumulatorToSummary(createSummaryAccumulator(), riskFraction),
      eu: accumulatorToSummary(createSummaryAccumulator(), riskFraction),
      us: accumulatorToSummary(createSummaryAccumulator(), riskFraction),
      other: accumulatorToSummary(createSummaryAccumulator(), riskFraction),
    },
  );

  const byStrategy = STRATEGY_KEYS.reduce<Record<SignalStrategy, ReturnType<typeof accumulatorToSummary>>>(
    (acc, strategy) => {
      const filtered = trades.filter((trade) => trade.strategy === strategy);
      acc[strategy] = accumulatorToSummary(reduceTrades(filtered), riskFraction);
      return acc;
    },
    {
      "absorption-failure": accumulatorToSummary(createSummaryAccumulator(), riskFraction),
      "poc-migration": accumulatorToSummary(createSummaryAccumulator(), riskFraction),
      "delta-divergence": accumulatorToSummary(createSummaryAccumulator(), riskFraction),
    },
  );

  return {
    day,
    totals,
    bySession: {
      asia: bySession.asia,
      eu: bySession.eu,
      us: bySession.us,
      other: bySession.other,
    },
    byStrategy: {
      "absorption-failure": byStrategy["absorption-failure"],
      "poc-migration": byStrategy["poc-migration"],
      "delta-divergence": byStrategy["delta-divergence"],
    },
  };
}

function clonePending(items: PendingTrade[]): PendingTrade[] {
  return items.map((item) => ({ ...item }));
}

function clonePositions(items: Position[]): Position[] {
  return items.map((item) => ({ ...item }));
}

function cloneClosed(items: ClosedTrade[]): ClosedTrade[] {
  return items.map((item) => ({ ...item }));
}

export class TradingEngine {
  private priceStep: number;

  private timeframeMs: number;

  private clockOffsetMs = 0;

  private settings: TradingSettings;

  private signals = new Map<string, FootprintSignal>();

  private pending: PendingTrade[] = [];

  private positions: Position[] = [];

  private closed: ClosedTrade[] = [];

  private history: ClosedTrade[] = [];

  private invalidations: InvalidationEvent[] = [];

  private lastBars: FootprintBar[] = [];

  private positionMeta = new Map<string, PositionMeta>();

  private daily: DailyPerformance;

  private lastPrice: number | null = null;

  private lastTimestamp = 0;

  private version = 0;

  constructor(options: TradingEngineOptions) {
    this.priceStep = options.priceStep;
    this.timeframeMs = options.timeframeMs;

    const providedSettings = options.settings ?? {};
    const { invalidations: providedInvalidations, ...restSettings } = providedSettings;

    this.settings = {
      ...DEFAULT_TRADING_SETTINGS,
      ...restSettings,
      invalidations: {
        ...DEFAULT_INVALIDATION_SETTINGS,
        ...(providedInvalidations ?? {}),
      },
    };

    if (options.history?.length) {
      this.history = cloneClosed(options.history).slice(-MAX_HISTORY);
      this.closed = cloneClosed(this.history.slice(-MAX_CLOSED_CACHE));
    }

    const riskFraction = this.settings.riskPerTradePercent / 100;
    const day = this.getCurrentDayKey();
    const trades = this.history.filter((trade) => trade.day === day);
    this.daily = createDailyPerformance(day, trades, riskFraction);
  }

  get defaultSettings(): TradingSettings {
    return {
      ...DEFAULT_TRADING_SETTINGS,
      invalidations: { ...DEFAULT_INVALIDATION_SETTINGS },
    };
  }

  getSettings(): TradingSettings {
    return {
      ...this.settings,
      invalidations: { ...this.settings.invalidations },
    };
  }

  updateMarketContext(context: { priceStep?: number; timeframeMs?: number }) {
    if (typeof context.priceStep === "number" && context.priceStep > 0 && Math.abs(context.priceStep - this.priceStep) > PRICE_EPSILON) {
      this.priceStep = context.priceStep;
    }
    if (typeof context.timeframeMs === "number" && context.timeframeMs > 0 && context.timeframeMs !== this.timeframeMs) {
      this.timeframeMs = context.timeframeMs;
    }
  }

  updateClockOffset(offsetMs: number): boolean {
    if (!Number.isFinite(offsetMs)) {
      return false;
    }
    const normalized = Math.round(offsetMs);
    if (normalized === this.clockOffsetMs) {
      return false;
    }
    this.clockOffsetMs = normalized;
    this.updateDailyPerformance();
    this.bumpVersion();
    return true;
  }

  updateSettings(partial: Partial<TradingSettings>): boolean {
    const { invalidations: invalidationPartial, ...rest } = partial;

    const nextInvalidations: InvalidationSettings = {
      ...this.settings.invalidations,
      ...(invalidationPartial ?? {}),
    };

    nextInvalidations.lookbackBars = Math.max(1, Math.floor(nextInvalidations.lookbackBars));
    nextInvalidations.autoCloseThreshold = clamp(nextInvalidations.autoCloseThreshold, 0, 100);
    nextInvalidations.minOppositeSignalScore = clamp(nextInvalidations.minOppositeSignalScore, 0, 100);
    nextInvalidations.stackedImbalanceLevels = Math.max(2, Math.floor(nextInvalidations.stackedImbalanceLevels));
    nextInvalidations.stackedImbalanceRatio = Math.max(1, nextInvalidations.stackedImbalanceRatio);
    nextInvalidations.stackedImbalanceWindowSeconds = Math.max(15, nextInvalidations.stackedImbalanceWindowSeconds);
    nextInvalidations.minProgressR = Math.max(0, nextInvalidations.minProgressR);
    nextInvalidations.deltaFlipWindow = Math.max(2, Math.floor(nextInvalidations.deltaFlipWindow));
    nextInvalidations.cumDeltaLookback = Math.max(3, Math.floor(nextInvalidations.cumDeltaLookback));
    nextInvalidations.timeDecayMinutes = Math.max(1, Math.floor(nextInvalidations.timeDecayMinutes));
    nextInvalidations.liquiditySweepPercentile = clamp(nextInvalidations.liquiditySweepPercentile, 0, 1);
    nextInvalidations.liquidityRetracePercent = clamp(nextInvalidations.liquidityRetracePercent, 0, 1);
    nextInvalidations.keyLevelDeltaThreshold = clamp(nextInvalidations.keyLevelDeltaThreshold, 0, 1);

    const next: TradingSettings = {
      ...this.settings,
      ...rest,
      invalidations: nextInvalidations,
    };

    next.partialTakePercent = clamp(next.partialTakePercent, 0, 1);
    next.retestWindowMinutes = Math.max(0, next.retestWindowMinutes);
    next.slippageTicks = Math.max(0, next.slippageTicks);
    next.feesPercent = Math.max(0, next.feesPercent);
    next.riskPerTradePercent = Math.max(0, next.riskPerTradePercent);
    next.beOffsetTicks = Math.max(0, next.beOffsetTicks);
    next.invalidationBars = Math.max(0, Math.floor(next.invalidationBars));

    const changed = JSON.stringify(this.settings) !== JSON.stringify(next);
    if (!changed) {
      return false;
    }

    this.settings = next;
    this.updateDailyPerformance();
    this.bumpVersion();
    return true;
  }

  syncSignals(signals: FootprintSignal[], bars?: FootprintBar[]): boolean {
    let changed = false;

    const barsChanged = Array.isArray(bars) ? this.updateBars(bars) : false;
    const newSignals: FootprintSignal[] = [];

    for (const signal of signals) {
      const existing = this.signals.get(signal.id);
      this.signals.set(signal.id, signal);
      if (!existing) {
        newSignals.push(signal);
        changed = true;
        if (this.settings.autoTake) {
          const created = this.createPendingFromSignal(signal, true);
          if (created) {
            changed = true;
          }
        }
        if (this.settings.invalidationBars > 0) {
          const legacyInvalidated = this.handleLegacyInvalidation(signal);
          if (legacyInvalidated) {
            changed = true;
          }
        }
      }
    }

    if (this.signals.size > MAX_SIGNAL_CACHE) {
      const toDelete = this.signals.size - MAX_SIGNAL_CACHE;
      let removed = 0;
      for (const key of this.signals.keys()) {
        if (removed >= toDelete) {
          break;
        }
        if (!this.pending.find((trade) => trade.signalId === key) && !this.positions.find((position) => position.signalId === key)) {
          this.signals.delete(key);
          removed += 1;
        }
      }
    }

    let evaluationChanged = false;
    if (newSignals.length) {
      evaluationChanged = this.evaluateInvalidations({
        now: newSignals[newSignals.length - 1].timestamp,
        reason: "signal",
        signals: newSignals,
      });
    } else if (barsChanged) {
      const latestTime = this.lastBars.length ? this.lastBars[this.lastBars.length - 1].endTime : this.now();
      evaluationChanged = this.evaluateInvalidations({ now: latestTime, reason: "bars" });
    }

    if (evaluationChanged) {
      changed = true;
    }

    if (changed) {
      this.bumpVersion();
    }

    return changed;
  }

  takeSignal(signalId: string): PendingTrade | null {
    const signal = this.signals.get(signalId);
    if (!signal) {
      return null;
    }

    const created = this.createPendingFromSignal(signal, false);
    if (created) {
      this.bumpVersion();
    }
    return created;
  }

  cancelPending(id: string): boolean {
    const index = this.pending.findIndex((item) => item.id === id);
    if (index === -1) {
      return false;
    }
    this.pending.splice(index, 1);
    this.bumpVersion();
    return true;
  }

  flattenPosition(id: string, price?: number, reason: TradeExitReason = "cancelled"): boolean {
    const index = this.positions.findIndex((item) => item.id === id);
    if (index === -1) {
      return false;
    }
    const exitPrice = typeof price === "number" ? price : this.lastPrice ?? this.positions[index].lastPrice;
    this.closePosition(index, exitPrice, this.lastTimestamp || this.now(), reason);
    this.bumpVersion();
    return true;
  }

  handleTrade(trade: Trade): boolean {
    this.lastPrice = trade.price;
    this.lastTimestamp = trade.timestamp;

    let changed = false;

    if (this.pending.length) {
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        const pending = this.pending[index];
        if (trade.timestamp >= pending.expiresAt) {
          this.pending.splice(index, 1);
          changed = true;
          continue;
        }

        const shouldFill =
          pending.side === "long" ? trade.price <= pending.entry + PRICE_EPSILON : trade.price >= pending.entry - PRICE_EPSILON;

        if (shouldFill) {
          this.pending.splice(index, 1);
          const position = this.openPositionFromPending(pending, trade);
          if (position) {
            this.positions.push(position);
            changed = true;
          }
        }
      }
    }

    if (!this.positions.length) {
      if (changed) {
        this.bumpVersion();
      }
      return changed;
    }

    for (let index = this.positions.length - 1; index >= 0; index -= 1) {
      const position = this.positions[index];
      const direction = directionFromSide(position.side);

      const move = (trade.price - position.entryPrice) * direction;
      const rMove = move / Math.max(position.riskPerUnit, PRICE_EPSILON);
      if (rMove > position.mfe) {
        position.mfe = rMove;
      }
      const adverse = Math.max(0, -rMove);
      if (adverse > position.mae) {
        position.mae = adverse;
      }
      position.lastPrice = trade.price;

      if (!position.target1Hit) {
        const targetHit =
          direction > 0
            ? trade.price >= position.target1 - PRICE_EPSILON
            : trade.price <= position.target1 + PRICE_EPSILON;
        if (targetHit) {
          changed = this.handleTarget1(position, trade) || changed;
        }
      }

      const target2Hit =
        direction > 0 ? trade.price >= position.target2 - PRICE_EPSILON : trade.price <= position.target2 + PRICE_EPSILON;
      if (target2Hit) {
        if (position.firstHit === "none") {
          position.firstHit = "tp2";
        }
        this.closePosition(index, position.target2, trade.timestamp, "tp2");
        changed = true;
        continue;
      }

      const stopHit =
        direction > 0 ? trade.price <= position.stopPrice + PRICE_EPSILON : trade.price >= position.stopPrice - PRICE_EPSILON;
      if (stopHit) {
        if (position.firstHit === "none") {
          position.firstHit = position.target1Hit ? "tp1" : "stop";
        }
        const reason: TradeExitReason = position.target1Hit ? "breakeven" : "stop";
        this.closePosition(index, position.stopPrice, trade.timestamp, reason);
        changed = true;
        continue;
      }

      if (position.timeStopAt !== null && trade.timestamp >= position.timeStopAt) {
        if (position.firstHit === "none") {
          position.firstHit = "time-stop";
        }
        this.closePosition(index, trade.price, trade.timestamp, "time-stop");
        changed = true;
      }
    }

    const evaluationChanged = this.evaluateInvalidations({ now: trade.timestamp, reason: "trade" });
    if (evaluationChanged) {
      changed = true;
    }

    if (changed) {
      this.bumpVersion();
    }

    return changed;
  }

  private handleLegacyInvalidation(signal: FootprintSignal): boolean {
    if (!this.settings.invalidationBars) {
      return false;
    }

    let changed = false;
    const oppositeSide: SignalSide = signal.side === "long" ? "short" : "long";

    for (let index = this.positions.length - 1; index >= 0; index -= 1) {
      const position = this.positions[index];
      if (position.side !== oppositeSide) {
        continue;
      }
      if (position.strategy !== signal.strategy) {
        continue;
      }
      const barsSinceEntry = signal.barIndex - position.entryBarIndex;
      if (barsSinceEntry <= 0 || barsSinceEntry > this.settings.invalidationBars) {
        continue;
      }

      if (position.firstHit === "none") {
        position.firstHit = "invalidation";
      }
      const exitPrice = this.lastPrice ?? signal.entry;
      this.closePosition(index, exitPrice, signal.timestamp, "invalidation");
      changed = true;
    }

    return changed;
  }

  resetDay(day?: string): void {
    const targetDay = day ?? this.getCurrentDayKey();
    this.history = this.history.filter((trade) => trade.day !== targetDay);
    this.closed = this.closed.filter((trade) => trade.day !== targetDay);
    this.updateDailyPerformance();
    this.bumpVersion();
  }

  exportHistory(format: "json" | "csv" = "json"): string {
    if (format === "json") {
      return JSON.stringify(this.history, null, 2);
    }

    const header = [
      "id",
      "signalId",
      "strategy",
      "side",
      "session",
      "entryPrice",
      "entryFillPrice",
      "exitPrice",
      "entryTime",
      "exitTime",
      "holdMinutes",
      "firstHit",
      "exitReason",
      "result",
      "realizedPnl",
      "realizedR",
      "feesPaid",
      "mfe",
      "mae",
      "day",
    ];

    const rows = this.history.map((trade) =>
      [
        trade.id,
        trade.signalId,
        trade.strategy,
        trade.side,
        trade.session,
        trade.entryPrice.toFixed(2),
        trade.entryFillPrice.toFixed(2),
        trade.exitPrice.toFixed(2),
        trade.entryTime,
        trade.exitTime,
        trade.holdMinutes.toFixed(2),
        trade.firstHit,
        trade.exitReason,
        trade.result,
        trade.realizedPnl.toFixed(6),
        trade.realizedR.toFixed(4),
        trade.feesPaid.toFixed(6),
        trade.mfe.toFixed(4),
        trade.mae.toFixed(4),
        trade.day,
      ].join(","),
    );

    return [header.join(","), ...rows].join("\n");
  }

  getState(): TradingState {
    return {
      settings: {
        ...this.settings,
        invalidations: { ...this.settings.invalidations },
      },
      pending: clonePending(this.pending),
      positions: clonePositions(this.positions),
      closed: cloneClosed(this.closed),
      history: cloneClosed(this.history),
      daily: {
        day: this.daily.day,
        totals: { ...this.daily.totals },
        bySession: {
          asia: { ...this.daily.bySession.asia },
          eu: { ...this.daily.bySession.eu },
          us: { ...this.daily.bySession.us },
          other: { ...this.daily.bySession.other },
        },
        byStrategy: {
          "absorption-failure": { ...this.daily.byStrategy["absorption-failure"] },
          "poc-migration": { ...this.daily.byStrategy["poc-migration"] },
          "delta-divergence": { ...this.daily.byStrategy["delta-divergence"] },
        },
      },
      invalidations: this.invalidations.map((event) => ({
        ...event,
        evidence: event.evidence.map((item) => ({ ...item })),
        actions: event.actions.map((action) => ({ ...action })),
        triggers: event.triggers.map((item) => ({ ...item })),
      })),
      version: this.version,
    };
  }

  getPersistenceSnapshot(): TradingPersistenceSnapshot {
    return {
      settings: {
        ...this.settings,
        invalidations: { ...this.settings.invalidations },
      },
      history: cloneClosed(this.history),
    };
  }

  private createPendingFromSignal(signal: FootprintSignal, auto: boolean): PendingTrade | null {
    if (this.pending.some((item) => item.signalId === signal.id)) {
      return null;
    }
    if (this.positions.some((item) => item.signalId === signal.id)) {
      return null;
    }

    const riskPerUnit = Math.abs(signal.entry - signal.stop);
    if (riskPerUnit < PRICE_EPSILON) {
      return null;
    }

    const direction = directionFromSide(signal.side);
    const providedTarget1 = Number.isFinite(signal.target1) ? signal.target1 : signal.entry + direction * riskPerUnit * 2;
    const rrToProvidedTarget = Math.abs(providedTarget1 - signal.entry) / Math.max(riskPerUnit, PRICE_EPSILON);
    if (rrToProvidedTarget + PRICE_EPSILON < 2) {
      return null;
    }

    const target1 = Number((signal.entry + direction * riskPerUnit * 2).toFixed(6));
    const target2 = Number((signal.entry + direction * riskPerUnit * 3).toFixed(6));

    const retestWindow = Math.max(0, this.settings.retestWindowMinutes) * 60_000;
    const pending: PendingTrade = {
      id: signal.id,
      signalId: signal.id,
      side: signal.side,
      strategy: signal.strategy,
      session: signal.session,
      entry: signal.entry,
      stop: signal.stop,
      target1,
      target2,
      createdAt: signal.timestamp,
      expiresAt: signal.timestamp + retestWindow,
      entryType: "touch",
      auto,
      barIndex: signal.barIndex,
    };

    this.pending.push(pending);
    return pending;
  }

  private openPositionFromPending(pending: PendingTrade, trade: Trade): Position | null {
    const slippage = this.settings.slippageTicks * this.priceStep;
    const fillPrice = applyEntrySlippage(pending.side, pending.entry, slippage);

    const riskPerUnit = Math.abs(pending.entry - pending.stop);
    if (riskPerUnit < PRICE_EPSILON) {
      return null;
    }

    const riskFraction = this.settings.riskPerTradePercent / 100;
    if (riskFraction <= 0) {
      return null;
    }

    const size = riskFraction / riskPerUnit;
    const partialSize = size * clamp(this.settings.partialTakePercent, 0, 1);
    const remainingSize = size;
    const timeStopAt = this.settings.timeStopMinutes
      ? trade.timestamp + Math.max(0, this.settings.timeStopMinutes) * 60_000
      : null;

    const feeRate = this.settings.feesPercent / 100;
    const entryFee = Math.abs(fillPrice * size) * feeRate;

    const position: Position = {
      id: pending.id,
      signalId: pending.signalId,
      side: pending.side,
      strategy: pending.strategy,
      session: pending.session,
      entryPrice: pending.entry,
      entryFillPrice: fillPrice,
      originalStop: pending.stop,
      stopPrice: pending.stop,
      target1: pending.target1,
      target2: pending.target2,
      entryTime: trade.timestamp,
      entryBarIndex: pending.barIndex,
      size,
      remainingSize,
      partialSize,
      riskAmount: riskFraction,
      riskPerUnit,
      timeStopAt,
      target1Hit: false,
      firstHit: "none",
      realizedPnl: -entryFee,
      realizedR: -entryFee / riskFraction,
      feesPaid: entryFee,
      mfe: 0,
      mae: 0,
      lastPrice: trade.price,
    };

    this.initializePositionMeta(position);

    return position;
  }

  private updateBars(bars: FootprintBar[]): boolean {
    if (!bars.length) {
      const hadBars = this.lastBars.length > 0;
      this.lastBars = [];
      return hadBars;
    }
    const limit = 360;
    this.lastBars = bars.slice(-Math.min(limit, bars.length));
    return true;
  }

  private initializePositionMeta(position: Position): void {
    const existing = this.positionMeta.get(position.id);
    const signal = this.signals.get(position.signalId);
    const { bar, index } = this.findBarForTime(position.entryTime);

    const meta: PositionMeta = existing ?? {
      entryBarTime: bar?.startTime ?? null,
      entryCumDelta: bar?.cumulativeDelta ?? null,
      entryPoc: bar?.pocPrice ?? null,
      entrySignalScore: signal?.score ?? null,
      lastInvalidationAt: 0,
      lastScore: 0,
      lastTriggers: [],
    };

    if (!existing) {
      this.positionMeta.set(position.id, meta);
    } else {
      meta.entryBarTime = meta.entryBarTime ?? bar?.startTime ?? null;
      meta.entryCumDelta = meta.entryCumDelta ?? bar?.cumulativeDelta ?? null;
      meta.entryPoc = meta.entryPoc ?? bar?.pocPrice ?? null;
      meta.entrySignalScore = meta.entrySignalScore ?? signal?.score ?? null;
    }

    if (bar && typeof index === "number" && index >= 0 && position.entryBarIndex < 0) {
      position.entryBarIndex = index;
    }
  }

  private findBarForTime(timestamp: number): { bar: FootprintBar | null; index: number } {
    for (let index = this.lastBars.length - 1; index >= 0; index -= 1) {
      const bar = this.lastBars[index];
      if (timestamp >= bar.startTime && timestamp <= bar.endTime) {
        return { bar, index };
      }
    }
    return { bar: this.lastBars.length ? this.lastBars[this.lastBars.length - 1] : null, index: this.lastBars.length - 1 };
  }

  private handleTarget1(position: Position, trade: Trade): boolean {
    if (position.target1Hit) {
      return false;
    }

    const closeSize = position.partialSize > 0 ? Math.min(position.partialSize, position.remainingSize) : 0;
    if (closeSize <= 0 || closeSize >= position.remainingSize) {
      position.target1Hit = true;
      position.firstHit = position.firstHit === "none" ? "tp1" : position.firstHit;
      position.stopPrice = this.computeBreakEvenStop(position);
      return true;
    }

    const slippage = this.settings.slippageTicks * this.priceStep;
    const exitFill = applyExitSlippage(position.side, position.target1, slippage);
    const feeRate = this.settings.feesPercent / 100;
    const exitFee = Math.abs(exitFill * closeSize) * feeRate;
    const direction = directionFromSide(position.side);
    const gross = (exitFill - position.entryFillPrice) * closeSize * direction;
    const net = gross - exitFee;

    position.realizedPnl += net;
    position.realizedR += net / position.riskAmount;
    position.feesPaid += exitFee;
    position.remainingSize -= closeSize;
    position.target1Hit = true;
    if (position.firstHit === "none") {
      position.firstHit = "tp1";
    }
    position.stopPrice = this.computeBreakEvenStop(position);
    return true;
  }

  private evaluateInvalidations(context: InvalidationEvaluationContext): boolean {
    if (!this.positions.length) {
      return false;
    }

    const bars = this.lastBars;
    const settings = this.settings.invalidations;
    const now = context.now;
    const severityMultiplier = AGGRESSIVENESS_MULTIPLIER[settings.aggressiveness] ?? 1;

    let changed = false;
    const autoCloseQueue: Array<{ positionId: string; price: number; eventId: string }> = [];

    for (const position of this.positions) {
      this.initializePositionMeta(position);
      const meta = this.positionMeta.get(position.id);
      if (!meta) {
        continue;
      }

      const triggers = this.computeTriggerResults({
        position,
        meta,
        context,
        settings,
        severityMultiplier,
        bars,
      });

      if (!triggers.length) {
        continue;
      }

      if (now - meta.lastInvalidationAt < INVALIDATION_COOLDOWN_MS) {
        continue;
      }

      const event = this.buildInvalidationEvent({
        position,
        meta,
        triggers,
        now,
        settings,
      });

      if (!event) {
        continue;
      }

      this.invalidations.push(event);
      if (this.invalidations.length > MAX_INVALIDATION_EVENTS) {
        this.invalidations.splice(0, this.invalidations.length - MAX_INVALIDATION_EVENTS);
      }

      meta.lastInvalidationAt = now;
      meta.lastScore = event.score;
      meta.lastTriggers = event.triggers.map((item) => item.id);

      changed = true;

      if (event.autoClosed) {
        autoCloseQueue.push({
          positionId: position.id,
          price: event.price,
          eventId: event.id,
        });
      }
    }

    for (const action of autoCloseQueue) {
      this.flattenPosition(action.positionId, action.price, "invalidation");
      const event = this.invalidations.find((item) => item.id === action.eventId);
      if (event) {
        event.resolved = true;
        event.positionOpen = false;
        event.autoClosed = true;
        event.actionTaken = "close";
      }
    }

    return changed;
  }

  private computeTriggerResults(params: {
    position: Position;
    meta: PositionMeta;
    context: InvalidationEvaluationContext;
    settings: InvalidationSettings;
    severityMultiplier: number;
    bars: FootprintBar[];
  }): TriggerResult[] {
    const { position, meta, context, settings, bars } = params;
    const results: TriggerResult[] = [];

    const opposite = this.evaluateOppositeSignal(position, meta, context, settings);
    if (opposite) {
      results.push(opposite);
    }

    const stacked = this.evaluateStackedImbalance(position, bars, settings);
    if (stacked) {
      results.push(stacked);
    }

    const deltaFlip = this.evaluateDeltaPocFlip(position, meta, bars, settings);
    if (deltaFlip) {
      results.push(deltaFlip);
    }

    const cumDelta = this.evaluateCumDeltaBreak(position, meta, bars, settings);
    if (cumDelta) {
      results.push(cumDelta);
    }

    const keyLevel = this.evaluateKeyLevelRecapture(position, meta, bars, settings);
    if (keyLevel) {
      results.push(keyLevel);
    }

    const timeDecay = this.evaluateTimeDecay(position, context.now, settings);
    if (timeDecay) {
      results.push(timeDecay);
    }

    const liquidity = this.evaluateLiquiditySweep(position, bars, settings);
    if (liquidity) {
      results.push(liquidity);
    }

    return results;
  }

  private evaluateOppositeSignal(
    position: Position,
    meta: PositionMeta,
    context: InvalidationEvaluationContext,
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!context.signals?.length) {
      return null;
    }

    const oppositeSide: SignalSide = position.side === "long" ? "short" : "long";
    const entryBaseTime = meta.entryBarTime ?? position.entryTime;
    let best: TriggerResult | null = null;

    for (const signal of context.signals) {
      if (signal.side !== oppositeSide) {
        continue;
      }
      if (signal.strategy !== position.strategy) {
        continue;
      }

      const barsSinceEntry = Math.max(
        0,
        Math.round((signal.barTime - entryBaseTime) / Math.max(this.timeframeMs, 1)),
      );
      if (barsSinceEntry <= 0 || barsSinceEntry > settings.lookbackBars) {
        continue;
      }

      const hasConfluence = signal.strategies.length >= 2;
      if (signal.score < settings.minOppositeSignalScore && !hasConfluence) {
        continue;
      }

      const severityBase = Math.max(signal.score / 100, hasConfluence ? 0.9 : 0.6);
      const severity = clamp(severityBase, 0, 1.2);
      const evidence: InvalidationEvidenceItem[] = [
        { label: "Score", value: signal.score.toFixed(0) },
        { label: "Confluencia", value: `${signal.strategies.length}` },
        { label: "Barras", value: `${barsSinceEntry}` },
      ];

      const result: TriggerResult = {
        id: "opposite-signal",
        severity,
        evidence,
        markerPrice: signal.entry,
        barTime: signal.barTime,
        barIndex: signal.barIndex,
      };

      if (!best || severity > best.severity) {
        best = result;
      }
    }

    return best;
  }

  private evaluateStackedImbalance(
    position: Position,
    bars: FootprintBar[],
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!bars.length) {
      return null;
    }
    if (position.mfe >= settings.minProgressR) {
      return null;
    }

    const windowMs = settings.stackedImbalanceWindowSeconds * 1000;
    const latestTime = bars[bars.length - 1].endTime;
    const thresholdRatio = settings.stackedImbalanceRatio;
    const minLevels = settings.stackedImbalanceLevels;
    const direction = directionFromSide(position.side);
    const limitDistance = this.priceStep * Math.max(minLevels + 2, 6);

    let bestResult: TriggerResult | null = null;

    for (let idx = bars.length - 1; idx >= 0; idx -= 1) {
      const bar = bars[idx];
      if (latestTime - bar.endTime > windowMs) {
        break;
      }

      const levels = [...bar.levels].sort((a, b) => a.price - b.price);
      let consecutive = 0;
      let bestConsecutive = 0;
      let ratioAccumulator = 0;
      let bestAverage = 0;
      let previousPrice: number | null = null;
      let bestPrice: number | undefined;

      for (const level of levels) {
        if (Math.abs(level.price - position.entryPrice) > limitDistance) {
          continue;
        }

        const dominant = direction > 0 ? level.askVol : level.bidVol;
        const opposing = direction > 0 ? level.bidVol : level.askVol;
        const ratio = opposing <= PRICE_EPSILON ? dominant : dominant / Math.max(opposing, PRICE_EPSILON);

        if (ratio >= thresholdRatio) {
          if (previousPrice !== null && Math.abs(level.price - previousPrice - this.priceStep) < this.priceStep * 0.25) {
            consecutive += 1;
            ratioAccumulator += ratio;
          } else {
            consecutive = 1;
            ratioAccumulator = ratio;
          }
          previousPrice = level.price;

          if (consecutive >= bestConsecutive) {
            bestConsecutive = consecutive;
            const averageRatio = ratioAccumulator / consecutive;
            if (averageRatio > bestAverage) {
              bestAverage = averageRatio;
              bestPrice = level.price;
            }
          }
        } else {
          consecutive = 0;
          ratioAccumulator = 0;
          previousPrice = null;
        }
      }

      if (bestConsecutive >= minLevels && bestPrice !== undefined) {
        const severity = clamp(
          0.5 * (bestAverage / thresholdRatio) + 0.5 * (bestConsecutive / minLevels),
          0,
          1.5,
        );
        const evidence: InvalidationEvidenceItem[] = [
          { label: "Niveles", value: `${bestConsecutive}` },
          { label: "Ratio", value: bestAverage.toFixed(2) },
          { label: "Barra", value: new Date(bar.endTime).toLocaleTimeString() },
        ];

        const result: TriggerResult = {
          id: "stacked-imbalance",
          severity,
          evidence,
          markerPrice: bestPrice,
          barTime: bar.endTime,
          barIndex: idx,
        };

        if (!bestResult || severity > bestResult.severity) {
          bestResult = result;
        }
      }
    }

    return bestResult;
  }


  private evaluateDeltaPocFlip(
    position: Position,
    meta: PositionMeta,
    bars: FootprintBar[],
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!bars.length) {
      return null;
    }

    const direction = directionFromSide(position.side);
    const window = Math.max(2, settings.deltaFlipWindow);
    const entryTime = meta.entryBarTime ?? position.entryTime;
    const { bar: entryBar } = this.findBarForTime(entryTime);
    const entryIndex = entryBar ? Math.max(this.lastBars.indexOf(entryBar), 0) : Math.max(bars.length - window, 0);
    const subset = bars.slice(entryIndex);
    if (subset.length < 2) {
      return null;
    }

    const windowBars = subset.slice(-window);
    if (windowBars.length < 2) {
      return null;
    }

    const allOppositeDelta = windowBars.every((bar) => direction * bar.totalDelta < 0);
    if (!allOppositeDelta) {
      return null;
    }

    const pocValues = windowBars.map((bar) => (typeof bar.pocPrice === "number" ? bar.pocPrice : bar.closePrice));
    const pocShift = pocValues[pocValues.length - 1] - pocValues[0];

    const entryPoc =
      typeof meta.entryPoc === "number"
        ? meta.entryPoc
        : entryBar
          ? typeof entryBar.pocPrice === "number"
            ? entryBar.pocPrice
            : entryBar.closePrice
          : position.entryPrice;

    const lastBar = windowBars[windowBars.length - 1];
    const lastClose = lastBar.closePrice;

    const pocAgainst =
      direction > 0 ? pocValues[pocValues.length - 1] < entryPoc - this.priceStep * 0.25 : pocValues[pocValues.length - 1] > entryPoc + this.priceStep * 0.25;

    const crossEntry =
      direction > 0 ? lastClose < position.entryPrice - this.priceStep * 0.25 : lastClose > position.entryPrice + this.priceStep * 0.25;

    if (!pocAgainst || !crossEntry) {
      return null;
    }

    const deltaMagnitudes = windowBars.map((bar) => Math.abs(bar.totalDelta));
    const volumeMagnitudes = windowBars.map((bar) => Math.max(bar.totalVolume, 1e-6));
    const avgDelta = safeAverage(deltaMagnitudes);
    const avgVolume = safeAverage(volumeMagnitudes);
    const severity = clamp(
      avgDelta / Math.max(avgVolume, 1e-6) + Math.min(Math.abs(pocShift) / (this.priceStep * window), 1.2),
      0,
      1.5,
    );

    const evidence: InvalidationEvidenceItem[] = [
      { label: "Δ prom", value: avgDelta.toFixed(2) },
      { label: "POC shift", value: pocShift.toFixed(2) },
      { label: "Cierre", value: lastClose.toFixed(2) },
    ];

    return {
      id: "delta-poc-flip",
      severity,
      evidence,
      markerPrice: lastClose,
      barTime: lastBar.endTime,
      barIndex: bars.indexOf(lastBar),
    };
  }

  private evaluateCumDeltaBreak(
    position: Position,
    meta: PositionMeta,
    bars: FootprintBar[],
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!bars.length) {
      return null;
    }

    const lookback = Math.max(3, settings.cumDeltaLookback);
    const entryTime = meta.entryBarTime ?? position.entryTime;
    const { bar: entryBar } = this.findBarForTime(entryTime);
    const entryCum = meta.entryCumDelta ?? entryBar?.cumulativeDelta;
    if (entryCum === null || entryCum === undefined) {
      return null;
    }

    const windowBars = bars.slice(-lookback);
    if (!windowBars.length) {
      return null;
    }

    const cumValues = windowBars.map((bar) => bar.cumulativeDelta);
    const minCum = Math.min(...cumValues);
    const maxCum = Math.max(...cumValues);
    const direction = directionFromSide(position.side);
    const brokeAgainst = direction > 0 ? minCum < entryCum : maxCum > entryCum;
    if (!brokeAgainst) {
      return null;
    }

    const deltaDrop = direction > 0 ? entryCum - minCum : maxCum - entryCum;
    const incremental = windowBars.map((bar) => Math.abs(bar.totalDelta));
    const avgIncremental = safeAverage(incremental);
    const severity = clamp(deltaDrop / Math.max(avgIncremental, 1e-6), 0, 1.5);

    const referenceCum = direction > 0 ? minCum : maxCum;
    const lastBar = windowBars[windowBars.length - 1];

    const evidence: InvalidationEvidenceItem[] = [
      { label: "CumΔ entrada", value: entryCum.toFixed(2) },
      { label: "CumΔ actual", value: referenceCum.toFixed(2) },
      { label: "Δ neto", value: deltaDrop.toFixed(2) },
    ];

    return {
      id: "cumdelta-break",
      severity,
      evidence,
      markerPrice: lastBar.closePrice,
      barTime: lastBar.endTime,
      barIndex: bars.indexOf(lastBar),
    };
  }

  private evaluateKeyLevelRecapture(
    position: Position,
    meta: PositionMeta,
    bars: FootprintBar[],
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!bars.length) {
      return null;
    }

    const lastBar = bars[bars.length - 1];
    const direction = directionFromSide(position.side);
    const close = lastBar.closePrice;
    const poc = typeof lastBar.pocPrice === "number" ? lastBar.pocPrice : close;
    const entryPoc =
      typeof meta.entryPoc === "number"
        ? meta.entryPoc
        : (() => {
            const entryBarInfo = this.findBarForTime(meta.entryBarTime ?? position.entryTime);
            const entryBar = entryBarInfo.bar;
            if (!entryBar) {
              return position.entryPrice;
            }
            return typeof entryBar.pocPrice === "number" ? entryBar.pocPrice : entryBar.closePrice;
          })();

    const delta = lastBar.totalDelta;
    const deltaAgainst = direction > 0 ? delta < 0 : delta > 0;
    const pocAgainst = direction > 0 ? poc < entryPoc : poc > entryPoc;
    const cross =
      direction > 0 ? close < entryPoc - this.priceStep * 0.25 : close > entryPoc + this.priceStep * 0.25;

    if (!deltaAgainst || !pocAgainst || !cross) {
      return null;
    }

    const deltaStrength = Math.abs(delta) / Math.max(lastBar.totalVolume, 1e-6);
    if (deltaStrength < settings.keyLevelDeltaThreshold) {
      return null;
    }

    const severity = clamp(deltaStrength, 0, 1.5);

    const evidence: InvalidationEvidenceItem[] = [
      { label: "Cierre", value: close.toFixed(2) },
      { label: "POC actual", value: poc.toFixed(2) },
      { label: "Δ ratio", value: deltaStrength.toFixed(2) },
    ];

    return {
      id: "key-level-recapture",
      severity,
      evidence,
      markerPrice: close,
      barTime: lastBar.endTime,
      barIndex: bars.length - 1,
    };
  }

  private evaluateTimeDecay(
    position: Position,
    now: number,
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!settings.timeDecayMinutes) {
      return null;
    }

    const elapsedMinutes = (now - position.entryTime) / 60_000;
    if (elapsedMinutes < settings.timeDecayMinutes) {
      return null;
    }

    if (position.mfe >= settings.minProgressR) {
      return null;
    }

    const severity = clamp(
      (elapsedMinutes - settings.timeDecayMinutes) / Math.max(settings.timeDecayMinutes, 1),
      0,
      1.5,
    );

    const evidence: InvalidationEvidenceItem[] = [
      { label: "Hold", value: `${elapsedMinutes.toFixed(1)}m` },
      { label: "MFE", value: `${position.mfe.toFixed(2)}R` },
    ];

    return {
      id: "time-decay",
      severity,
      evidence,
      markerPrice: position.lastPrice,
      barTime: null,
      barIndex: null,
    };
  }

  private evaluateLiquiditySweep(
    position: Position,
    bars: FootprintBar[],
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!bars.length) {
      return null;
    }

    const direction = directionFromSide(position.side);
    const lastBar = bars[bars.length - 1];
    const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;
    const entryPrice = position.entryPrice;

    const wick =
      direction > 0 ? entryPrice - lastBar.lowPrice : lastBar.highPrice - entryPrice;
    if (wick <= this.priceStep * 0.25) {
      return null;
    }

    const retrace =
      direction > 0
        ? (lastBar.closePrice - lastBar.lowPrice) / Math.max(wick, this.priceStep)
        : (lastBar.highPrice - lastBar.closePrice) / Math.max(wick, this.priceStep);

    if (retrace < settings.liquidityRetracePercent) {
      return null;
    }

    const volumes = bars.slice(-40).map((bar) => bar.totalVolume).sort((a, b) => a - b);
    const percentileIndex = Math.max(0, Math.floor((volumes.length - 1) * settings.liquiditySweepPercentile));
    const percentileVolume = volumes.length ? volumes[percentileIndex] : 0;

    if (lastBar.totalVolume < percentileVolume) {
      return null;
    }

    const followThrough = prevBar
      ? direction > 0
        ? prevBar.closePrice < entryPrice - wick * 0.2
        : prevBar.closePrice > entryPrice + wick * 0.2
      : false;
    if (followThrough) {
      return null;
    }

    const severity = clamp(
      wick / Math.max(position.riskPerUnit, this.priceStep) +
        (percentileVolume > 0 ? lastBar.totalVolume / Math.max(percentileVolume, 1e-6) - 1 : 0),
      0,
      1.5,
    );

    const evidence: InvalidationEvidenceItem[] = [
      { label: "Barrida", value: wick.toFixed(2) },
      { label: "Retrace", value: `${(retrace * 100).toFixed(0)}%` },
      { label: "Volumen", value: lastBar.totalVolume.toFixed(0) },
    ];

    const markerPrice = direction > 0 ? lastBar.lowPrice : lastBar.highPrice;

    return {
      id: "liquidity-sweep",
      severity,
      evidence,
      markerPrice,
      barTime: lastBar.endTime,
      barIndex: bars.length - 1,
    };
  }

  private buildInvalidationEvent(args: {
    position: Position;
    meta: PositionMeta;
    triggers: TriggerResult[];
    now: number;
    settings: InvalidationSettings;
  }): InvalidationEvent | null {
    const { position, triggers, now, settings } = args;
    if (!triggers.length) {
      return null;
    }

    let scoreAccumulator = 0;
    let primary = triggers[0];
    let highestContribution = -Infinity;

    const normalizedTriggers = triggers.map((trigger) => {
      const weight = INVALIDATION_WEIGHTS[trigger.id] ?? 0;
      const severity = clamp(trigger.severity, 0, 1.5);
      const contribution = weight * Math.min(severity, 1.2);
      if (contribution > highestContribution) {
        highestContribution = contribution;
        primary = trigger;
      }
      scoreAccumulator += contribution;
      return {
        id: trigger.id,
        severity: clamp(severity, 0, 1.2),
      };
    });

    const score = Math.min(100, Math.round(scoreAccumulator));
    if (score < 40) {
      return null;
    }

    const severityLevel: InvalidationSeverity = score >= 85 ? "high" : score >= 65 ? "medium" : "low";
    const recommendation = INVALIDATION_RECOMMENDATIONS[severityLevel];
    const actions = this.getActionsForSeverity(severityLevel);

    const evidence: InvalidationEvidenceItem[] = [];
    const appendEvidence = (items: InvalidationEvidenceItem[]) => {
      for (const item of items) {
        if (evidence.length >= 5) {
          break;
        }
        if (!evidence.some((existing) => existing.label === item.label && existing.value === item.value)) {
          evidence.push(item);
        }
      }
    };

    appendEvidence(primary.evidence);
    for (const trigger of triggers) {
      if (trigger === primary) {
        continue;
      }
      appendEvidence(trigger.evidence);
      if (evidence.length >= 5) {
        break;
      }
    }
    evidence.push({ label: "Score", value: `${score}` });

    const markerPrice = primary.markerPrice ?? position.lastPrice;

    const event: InvalidationEvent = {
      id: `${position.id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      positionId: position.id,
      positionSide: position.side,
      strategy: position.strategy,
      triggerId: primary.id,
      triggerLabel: this.getTriggerLabel(primary.id),
      triggers: normalizedTriggers,
      score,
      severity: severityLevel,
      evidence,
      recommendation,
      actions,
      timestamp: now,
      session: position.session,
      price: markerPrice,
      barTime: primary.barTime ?? null,
      barIndex: primary.barIndex ?? null,
      autoClosed: settings.autoCloseHighSeverity && score >= settings.autoCloseThreshold,
      resolved: false,
      actionTaken: undefined,
      positionOpen: true,
    };

    return event;
  }

  private getTriggerLabel(triggerId: InvalidationTriggerId): string {
    switch (triggerId) {
      case "opposite-signal":
        return "Señal opuesta";
      case "stacked-imbalance":
        return "Imbalance apilado";
      case "delta-poc-flip":
        return "Flip delta + POC";
      case "cumdelta-break":
        return "Ruptura cum-delta";
      case "key-level-recapture":
        return "Re-captura de nivel";
      case "time-decay":
        return "Time decay";
      case "liquidity-sweep":
        return "Liquidity sweep";
      default:
        return triggerId;
    }
  }

  private getActionsForSeverity(severity: InvalidationSeverity): InvalidationActionOption[] {
    switch (severity) {
      case "high":
        return [
          { ...INVALIDATION_ACTIONS.close },
          { ...INVALIDATION_ACTIONS.reduce },
          { ...INVALIDATION_ACTIONS["tighten-stop"] },
        ];
      case "medium":
        return [
          { ...INVALIDATION_ACTIONS.reduce },
          { ...INVALIDATION_ACTIONS["tighten-stop"] },
          { ...INVALIDATION_ACTIONS.hold },
        ];
      default:
        return [
          { ...INVALIDATION_ACTIONS["tighten-stop"] },
          { ...INVALIDATION_ACTIONS.hold },
          { ...INVALIDATION_ACTIONS.reduce },
        ];
    }
  }

  private computeBreakEvenStop(position: Position): number {
    const offset = this.settings.beOffsetTicks * this.priceStep;
    const direction = directionFromSide(position.side);
    return position.entryPrice + offset * direction;
  }

  private closePosition(index: number, price: number, timestamp: number, reason: TradeExitReason) {
    const position = this.positions[index];
    const slippage = this.settings.slippageTicks * this.priceStep;
    const exitFill = applyExitSlippage(position.side, price, slippage);
    const size = position.remainingSize;
    const direction = directionFromSide(position.side);
    const feeRate = this.settings.feesPercent / 100;
    const exitFee = Math.abs(exitFill * size) * feeRate;
    const gross = (exitFill - position.entryFillPrice) * size * direction;
    const net = gross - exitFee;

    position.realizedPnl += net;
    position.realizedR += net / position.riskAmount;
    position.feesPaid += exitFee;
    position.remainingSize = 0;

    const holdMinutes = (timestamp - position.entryTime) / 60_000;
    const result: TradeResult =
      position.realizedPnl > PNL_EPSILON
        ? "win"
        : position.realizedPnl < -PNL_EPSILON
          ? "loss"
          : "breakeven";

    const closed: ClosedTrade = {
      id: position.id,
      signalId: position.signalId,
      side: position.side,
      strategy: position.strategy,
      session: position.session,
      entryPrice: position.entryPrice,
      entryFillPrice: position.entryFillPrice,
      exitPrice: exitFill,
      entryTime: position.entryTime,
      exitTime: timestamp,
      holdMinutes,
      firstHit: position.firstHit,
      exitReason: reason,
      result,
      realizedPnl: position.realizedPnl,
      realizedR: position.realizedR,
      feesPaid: position.feesPaid,
      mfe: position.mfe,
      mae: position.mae,
      day: getDayKey(timestamp),
    };

    this.positions.splice(index, 1);
    this.positionMeta.delete(position.id);
    this.markInvalidationsClosed(position.id, reason);
    this.closed.push(closed);
    if (this.closed.length > MAX_CLOSED_CACHE) {
      this.closed.splice(0, this.closed.length - MAX_CLOSED_CACHE);
    }
    this.history.push(closed);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }

    this.updateDailyPerformance();
  }

  private markInvalidationsClosed(positionId: string, reason: TradeExitReason): void {
    for (const event of this.invalidations) {
      if (event.positionId !== positionId) {
        continue;
      }
      event.positionOpen = false;
      if (!event.resolved) {
        event.resolved = true;
        if (!event.actionTaken) {
          event.actionTaken = reason === "invalidation" ? "close" : "hold";
        }
      }
    }
  }

  applyInvalidationAction(eventId: string, action: InvalidationActionType): boolean {
    const event = this.invalidations.find((item) => item.id === eventId);
    if (!event) {
      return false;
    }

    let changed = false;
    let shouldBump = false;

    switch (action) {
      case "close":
        changed = this.flattenPosition(event.positionId, undefined, "invalidation");
        break;
      case "reduce":
        changed = this.reducePosition(event.positionId, 0.5);
        shouldBump = changed;
        break;
      case "tighten-stop":
        changed = this.tightenStop(event.positionId);
        shouldBump = changed;
        break;
      case "hold":
        event.resolved = true;
        event.actionTaken = "hold";
        event.positionOpen = this.positions.some((pos) => pos.id === event.positionId);
        this.bumpVersion();
        return true;
      default:
        return false;
    }

    if (!changed) {
      return false;
    }

    const stillOpen = this.positions.some((pos) => pos.id === event.positionId);

    if (action === "close") {
      event.actionTaken = "close";
      event.positionOpen = false;
      event.resolved = true;
    } else if (action === "reduce") {
      event.actionTaken = stillOpen ? "reduce" : "close";
      event.positionOpen = stillOpen;
      event.resolved = true;
    } else if (action === "tighten-stop") {
      event.actionTaken = "tighten-stop";
      event.positionOpen = stillOpen;
      event.resolved = true;
    }

    if (shouldBump) {
      this.bumpVersion();
    }

    return true;
  }

  private reducePosition(positionId: string, fraction: number): boolean {
    const index = this.positions.findIndex((item) => item.id === positionId);
    if (index === -1) {
      return false;
    }

    const position = this.positions[index];
    const fractionClamped = clamp(fraction, 0, 1);
    if (fractionClamped <= 0) {
      return false;
    }

    const closeSize = position.remainingSize * fractionClamped;
    if (closeSize <= PRICE_EPSILON) {
      return false;
    }

    const slippage = this.settings.slippageTicks * this.priceStep;
    const price = this.lastPrice ?? position.lastPrice;
    const exitFill = applyExitSlippage(position.side, price, slippage);
    const direction = directionFromSide(position.side);
    const feeRate = this.settings.feesPercent / 100;
    const exitFee = Math.abs(exitFill * closeSize) * feeRate;
    const gross = (exitFill - position.entryFillPrice) * closeSize * direction;
    const net = gross - exitFee;

    position.realizedPnl += net;
    position.realizedR += net / position.riskAmount;
    position.feesPaid += exitFee;
    position.remainingSize -= closeSize;
    position.partialSize = Math.min(position.partialSize, position.remainingSize);
    position.lastPrice = price;

    if (position.remainingSize <= PRICE_EPSILON) {
      this.closePosition(index, price, this.lastTimestamp || this.now(), "invalidation");
      return true;
    }

    return true;
  }

  private tightenStop(positionId: string): boolean {
    const position = this.positions.find((item) => item.id === positionId);
    if (!position) {
      return false;
    }

    const direction = directionFromSide(position.side);
    const targetStop = position.entryPrice - direction * position.riskPerUnit * 0.5;
    if (direction > 0) {
      if (targetStop > position.stopPrice + PRICE_EPSILON) {
        position.stopPrice = targetStop;
        return true;
      }
      return false;
    }

    if (targetStop < position.stopPrice - PRICE_EPSILON) {
      position.stopPrice = targetStop;
      return true;
    }

    return false;
  }

  private computeDefaultTarget2(side: SignalSide, entry: number, stop: number): number {
    const direction = directionFromSide(side);
    const risk = Math.abs(entry - stop);
    return entry + 2 * risk * direction;
  }

  private now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private getCurrentDayKey(): string {
    return getDayKey(this.now());
  }

  private updateDailyPerformance() {
    const day = this.getCurrentDayKey();
    const trades = this.history.filter((trade) => trade.day === day);
    const riskFraction = this.settings.riskPerTradePercent / 100;
    this.daily = createDailyPerformance(day, trades, riskFraction);
  }

  private bumpVersion() {
    this.version += 1;
  }
}

export { DEFAULT_TRADING_SETTINGS, TradingEngine };

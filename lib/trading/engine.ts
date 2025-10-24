import type {
  ClosedTrade,
  DailyPerformance,
  FootprintSignal,
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
const PRICE_EPSILON = 1e-8;
const PNL_EPSILON = 1e-9;

const SESSION_KEYS: TradingSession[] = ["asia", "eu", "us", "other"];
const STRATEGY_KEYS: SignalStrategy[] = ["absorption-failure", "poc-migration", "delta-divergence"];

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

interface SummaryAccumulator {
  trades: number;
  winners: number;
  losers: number;
  breakeven: number;
  netR: number;
  winR: number;
  lossR: number;
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

  private settings: TradingSettings;

  private signals = new Map<string, FootprintSignal>();

  private pending: PendingTrade[] = [];

  private positions: Position[] = [];

  private closed: ClosedTrade[] = [];

  private history: ClosedTrade[] = [];

  private daily: DailyPerformance;

  private lastPrice: number | null = null;

  private lastTimestamp = 0;

  private version = 0;

  constructor(options: TradingEngineOptions) {
    this.priceStep = options.priceStep;
    this.timeframeMs = options.timeframeMs;
    this.settings = {
      ...DEFAULT_TRADING_SETTINGS,
      ...(options.settings ?? {}),
    };

    if (options.history?.length) {
      this.history = cloneClosed(options.history).slice(-MAX_HISTORY);
      this.closed = cloneClosed(this.history.slice(-MAX_CLOSED_CACHE));
    }

    const riskFraction = this.settings.riskPerTradePercent / 100;
    const day = getDayKey(Date.now());
    const trades = this.history.filter((trade) => trade.day === day);
    this.daily = createDailyPerformance(day, trades, riskFraction);
  }

  get defaultSettings(): TradingSettings {
    return { ...DEFAULT_TRADING_SETTINGS };
  }

  getSettings(): TradingSettings {
    return { ...this.settings };
  }

  updateMarketContext(context: { priceStep?: number; timeframeMs?: number }) {
    if (typeof context.priceStep === "number" && context.priceStep > 0 && Math.abs(context.priceStep - this.priceStep) > PRICE_EPSILON) {
      this.priceStep = context.priceStep;
    }
    if (typeof context.timeframeMs === "number" && context.timeframeMs > 0 && context.timeframeMs !== this.timeframeMs) {
      this.timeframeMs = context.timeframeMs;
    }
  }

  updateSettings(partial: Partial<TradingSettings>): boolean {
    const next: TradingSettings = {
      ...this.settings,
      ...partial,
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

  syncSignals(signals: FootprintSignal[]): boolean {
    let changed = false;

    for (const signal of signals) {
      const existing = this.signals.get(signal.id);
      if (!existing) {
        this.signals.set(signal.id, signal);
        changed = true;
        if (this.settings.autoTake) {
          const created = this.createPendingFromSignal(signal, true);
          if (created) {
            changed = true;
          }
        }
        const invalidated = this.handleInvalidation(signal);
        if (invalidated) {
          changed = true;
        }
      } else {
        this.signals.set(signal.id, signal);
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
    this.closePosition(index, exitPrice, this.lastTimestamp || Date.now(), reason);
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

    if (changed) {
      this.bumpVersion();
    }

    return changed;
  }

  handleInvalidation(signal: FootprintSignal): boolean {
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
    const targetDay = day ?? getDayKey(Date.now());
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
      settings: { ...this.settings },
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
      version: this.version,
    };
  }

  getPersistenceSnapshot(): TradingPersistenceSnapshot {
    return {
      settings: { ...this.settings },
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

    const target2 = Number.isFinite(signal.target2)
      ? signal.target2
      : this.computeDefaultTarget2(signal.side, signal.entry, signal.stop);

    const riskPerUnit = Math.abs(signal.entry - signal.stop);
    if (riskPerUnit < PRICE_EPSILON) {
      return null;
    }

    const retestWindow = Math.max(0, this.settings.retestWindowMinutes) * 60_000;
    const pending: PendingTrade = {
      id: signal.id,
      signalId: signal.id,
      side: signal.side,
      strategy: signal.strategy,
      session: signal.session,
      entry: signal.entry,
      stop: signal.stop,
      target1: signal.target1,
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

    return position;
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

  private computeDefaultTarget2(side: SignalSide, entry: number, stop: number): number {
    const direction = directionFromSide(side);
    const risk = Math.abs(entry - stop);
    return entry + 2 * risk * direction;
  }

  private updateDailyPerformance() {
    const day = getDayKey(Date.now());
    const trades = this.history.filter((trade) => trade.day === day);
    const riskFraction = this.settings.riskPerTradePercent / 100;
    this.daily = createDailyPerformance(day, trades, riskFraction);
  }

  private bumpVersion() {
    this.version += 1;
  }
}

export { DEFAULT_TRADING_SETTINGS, TradingEngine };

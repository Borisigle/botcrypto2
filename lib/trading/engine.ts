import type {
  ClosedTrade,
  DailyPerformance,
  DepthBarMetrics,
  DepthSweepEvent,
  FootprintBar,
  FootprintSignal,
  InvalidationActionOption,
  InvalidationActionType,
  InvalidationEvent,
  InvalidationEvidenceItem,
  InvalidationSettings,
  InvalidationSeverity,
  InvalidationThesis,
  InvalidationTriggerId,
  ObjectiveInvalidationBreakdown,
  ObjectiveInvalidationKpiBucket,
  ObjectiveInvalidationKpis,
  ObjectiveInvalidationSettings,
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
  TradingTimelineEntry,
} from "@/types";
import { DEFAULT_GUARDRAIL_SETTINGS, RiskGuardrailManager, cloneGuardrailSettings } from "@/lib/trading/guardrails";

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

const DEFAULT_OBJECTIVE_INVALIDATION_SETTINGS: ObjectiveInvalidationSettings = {
  enabled: true,
  persistenceSeconds: 60,
  persistenceBars: 2,
  gracePeriodSeconds: 90,
  hysteresisPoints: 10,
  printsThreshold: 55,
  depthThreshold: 45,
  printsWeight: 0.55,
  depthWeight: 0.45,
  severeThreshold: 90,
  highThreshold: 75,
  mediumThreshold: 60,
  winnerProtectMfeR: 0.7,
  winnerProtectTp1DistanceR: 0.3,
  winnerProtectDepthThreshold: 40,
  severeSweepLevels: 4,
  severeSweepWindowMs: 2_000,
  severeSweepMinTicks: 2,
  severeSweepDeltaPercentile: 0.9,
  timeDecayMinutes: 10,
  timeDecayMinMfe: 0.3,
  timeDecayContraBars: 2,
  timeDecayDeltaThreshold: 0.4,
  timeDecayOfiThreshold: 50,
  autoCloseSevere: true,
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
  invalidations: { ...DEFAULT_INVALIDATION_SETTINGS },
  objectiveInvalidation: { ...DEFAULT_OBJECTIVE_INVALIDATION_SETTINGS },
  guardrails: cloneGuardrailSettings(DEFAULT_GUARDRAIL_SETTINGS),
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
const MAX_TIMELINE_ENTRIES = 200;
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
  "objective-prints": 18,
  "objective-depth": 24,
  "objective-time-decay": 16,
};

const AGGRESSIVENESS_MULTIPLIER: Record<InvalidationSettings["aggressiveness"], number> = {
  strict: 1.1,
  moderate: 1,
  relaxed: 0.85,
};

const INVALIDATION_ACTIONS: Record<InvalidationActionType, InvalidationActionOption> = {
  close: { type: "close", label: "Cerrar" },
  reduce: { type: "reduce", label: "Reducir 50%" },
  "tighten-stop": { type: "tighten-stop", label: "Mover SL a BE (-0.5R)" },
  hold: { type: "hold", label: "Mantener" },
};

const INVALIDATION_RECOMMENDATIONS: Record<InvalidationSeverity, string> = {
  high: "Cerrar la posición de inmediato.",
  medium: "Reducir 50% y mover el SL a -0.5R.",
  low: "Mantener y mover el SL a BE/-0.5R.",
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

function normalizeObjectiveSettings(settings: ObjectiveInvalidationSettings): ObjectiveInvalidationSettings {
  const next = { ...settings };
  next.persistenceSeconds = Math.max(10, Math.round(next.persistenceSeconds));
  next.persistenceBars = Math.max(1, Math.round(next.persistenceBars));
  next.gracePeriodSeconds = Math.max(0, Math.round(next.gracePeriodSeconds));
  next.hysteresisPoints = Math.max(1, Math.round(next.hysteresisPoints));
  next.printsThreshold = clamp(next.printsThreshold, 0, 100);
  next.depthThreshold = clamp(next.depthThreshold, 0, 100);
  const weightSum = Math.max(0.0001, next.printsWeight + next.depthWeight);
  next.printsWeight = clamp(next.printsWeight / weightSum, 0, 1);
  next.depthWeight = clamp(1 - next.printsWeight, 0, 1);
  next.severeThreshold = clamp(next.severeThreshold, 0, 100);
  next.highThreshold = clamp(Math.min(next.highThreshold, next.severeThreshold), 0, next.severeThreshold);
  next.mediumThreshold = clamp(Math.min(next.mediumThreshold, next.highThreshold), 0, next.highThreshold);
  next.winnerProtectMfeR = Math.max(0, next.winnerProtectMfeR);
  next.winnerProtectTp1DistanceR = Math.max(0, next.winnerProtectTp1DistanceR);
  next.winnerProtectDepthThreshold = Math.max(0, next.winnerProtectDepthThreshold);
  next.severeSweepLevels = Math.max(1, Math.round(next.severeSweepLevels));
  next.severeSweepWindowMs = Math.max(100, Math.round(next.severeSweepWindowMs));
  next.severeSweepMinTicks = Math.max(1, Math.round(next.severeSweepMinTicks));
  next.severeSweepDeltaPercentile = clamp(next.severeSweepDeltaPercentile, 0, 1);
  next.timeDecayMinutes = Math.max(1, Math.round(next.timeDecayMinutes));
  next.timeDecayMinMfe = Math.max(0, next.timeDecayMinMfe);
  next.timeDecayContraBars = Math.max(1, Math.round(next.timeDecayContraBars));
  next.timeDecayDeltaThreshold = Math.max(0, next.timeDecayDeltaThreshold);
  next.timeDecayOfiThreshold = Math.max(0, next.timeDecayOfiThreshold);
  next.autoCloseSevere = Boolean(next.autoCloseSevere);
  return next;
}

function cloneObjectiveKpiBucket(source: ObjectiveInvalidationKpiBucket): ObjectiveInvalidationKpiBucket {
  return {
    events: source.events,
    falsePositives: source.falsePositives,
    falsePositiveRate: source.falsePositiveRate,
    stopsAvoided: source.stopsAvoided,
    savedR: source.savedR,
    expectancyDelta: source.expectancyDelta,
  };
}

function cloneObjectiveKpis(source: ObjectiveInvalidationKpis): ObjectiveInvalidationKpis {
  return {
    day: source.day,
    total: cloneObjectiveKpiBucket(source.total),
    perSession: {
      asia: cloneObjectiveKpiBucket(source.perSession.asia),
      eu: cloneObjectiveKpiBucket(source.perSession.eu),
      us: cloneObjectiveKpiBucket(source.perSession.us),
      other: cloneObjectiveKpiBucket(source.perSession.other),
    },
    perStrategy: {
      "absorption-failure": cloneObjectiveKpiBucket(source.perStrategy["absorption-failure"]),
      "poc-migration": cloneObjectiveKpiBucket(source.perStrategy["poc-migration"]),
      "delta-divergence": cloneObjectiveKpiBucket(source.perStrategy["delta-divergence"]),
    },
  };
}

interface ObjectiveKpiAccumulator {
  events: number;
  falsePositives: number;
  stopsAvoided: number;
  savedR: number;
  actualTotalR: number;
  baselineTotalR: number;
  tradeCount: number;
}

function createObjectiveKpiAccumulator(): ObjectiveKpiAccumulator {
  return {
    events: 0,
    falsePositives: 0,
    stopsAvoided: 0,
    savedR: 0,
    actualTotalR: 0,
    baselineTotalR: 0,
    tradeCount: 0,
  };
}

function finalizeObjectiveBucket(acc: ObjectiveKpiAccumulator): ObjectiveInvalidationKpiBucket {
  const falsePositiveRate = acc.events > 0 ? acc.falsePositives / acc.events : 0;
  const expectancyDelta =
    acc.tradeCount > 0
      ? acc.actualTotalR / acc.tradeCount - acc.baselineTotalR / acc.tradeCount
      : 0;
  return {
    events: acc.events,
    falsePositives: acc.falsePositives,
    falsePositiveRate,
    stopsAvoided: acc.stopsAvoided,
    savedR: acc.savedR,
    expectancyDelta,
  };
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
  objectiveStartAt: number | null;
  objectiveStartBar: number | null;
  objectiveActiveThreshold: number | null;
  objectiveLastScore: number;
  objectiveLastComponents: { prints: number; depth: number } | null;
  objectiveLastReasons: string[];
  objectiveLastEventId?: string | null;
}

interface InvalidationEvaluationContext {
  now: number;
  reason: "signal" | "trade" | "bars";
  signals?: FootprintSignal[];
}

interface TriggerNarrative {
  summary?: string;
  prints?: string[];
  depth?: string[];
}

interface TriggerResult {
  id: InvalidationTriggerId;
  severity: number;
  evidence: InvalidationEvidenceItem[];
  markerPrice?: number;
  barTime?: number | null;
  barIndex?: number | null;
  thesis?: TriggerNarrative;
}

interface ObjectivePrintsEvaluation {
  score: number;
  evidence: InvalidationEvidenceItem[];
  reasons: string[];
  markerPrice: number | null;
  barTime: number | null;
  barIndex: number | null;
  deltaAgainstCount: number;
  pocAgainstCount: number;
  cumDeltaBroken: boolean;
}

interface ObjectiveDepthEvaluation {
  score: number;
  evidence: InvalidationEvidenceItem[];
  reasons: string[];
  markerPrice: number | null;
  barTime: number | null;
  barIndex: number | null;
  severeEvent: boolean;
  depthPressureStrong: boolean;
  lastSweep: DepthSweepEvent | null;
  ofiAgainst: number;
  ofiAgainstCount: number;
  replenishment: number;
}

interface ObjectiveEvaluation {
  prints: ObjectivePrintsEvaluation;
  depth: ObjectiveDepthEvaluation;
  doubleConfirmed: boolean;
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

  private guardrails: RiskGuardrailManager;

  private signals = new Map<string, FootprintSignal>();

  private pending: PendingTrade[] = [];

  private positions: Position[] = [];

  private closed: ClosedTrade[] = [];

  private history: ClosedTrade[] = [];

  private invalidations: InvalidationEvent[] = [];

  private timeline: TradingTimelineEntry[] = [];

  private lastBars: FootprintBar[] = [];

  private positionMeta = new Map<string, PositionMeta>();

  private daily: DailyPerformance;

  private objectiveKpis: ObjectiveInvalidationKpis;

  private lastPrice: number | null = null;

  private lastTimestamp = 0;

  private version = 0;

  constructor(options: TradingEngineOptions) {
    this.priceStep = options.priceStep;
    this.timeframeMs = options.timeframeMs;

    const providedSettings = options.settings ?? {};
    const {
      invalidations: providedInvalidations,
      objectiveInvalidation: providedObjectiveInvalidation,
      guardrails: providedGuardrails,
      ...restSettings
    } = providedSettings;

    const mergedObjective = normalizeObjectiveSettings({
      ...DEFAULT_OBJECTIVE_INVALIDATION_SETTINGS,
      ...(providedObjectiveInvalidation ?? {}),
    });

    this.settings = {
      ...DEFAULT_TRADING_SETTINGS,
      ...restSettings,
      invalidations: {
        ...DEFAULT_INVALIDATION_SETTINGS,
        ...(providedInvalidations ?? {}),
      },
      objectiveInvalidation: mergedObjective,
      guardrails: cloneGuardrailSettings(DEFAULT_GUARDRAIL_SETTINGS),
    };

    this.guardrails = new RiskGuardrailManager({
      settings: {
        ...this.settings.guardrails,
        ...(providedGuardrails ?? {}),
      },
      now: Date.now(),
    });

    this.settings.guardrails = this.guardrails.getSettings();

    if (options.history?.length) {
      this.history = cloneClosed(options.history).slice(-MAX_HISTORY);
      this.closed = cloneClosed(this.history.slice(-MAX_CLOSED_CACHE));
    }

    const riskFraction = this.settings.riskPerTradePercent / 100;
    const day = this.getCurrentDayKey();
    const trades = this.history.filter((trade) => trade.day === day);
    this.daily = createDailyPerformance(day, trades, riskFraction);
    this.objectiveKpis = this.buildObjectiveKpis();
  }

  get defaultSettings(): TradingSettings {
    return {
      ...DEFAULT_TRADING_SETTINGS,
      invalidations: { ...DEFAULT_INVALIDATION_SETTINGS },
      objectiveInvalidation: { ...DEFAULT_OBJECTIVE_INVALIDATION_SETTINGS },
      guardrails: cloneGuardrailSettings(DEFAULT_GUARDRAIL_SETTINGS),
    };
  }

  getSettings(): TradingSettings {
    return {
      ...this.settings,
      invalidations: { ...this.settings.invalidations },
      objectiveInvalidation: { ...this.settings.objectiveInvalidation },
      guardrails: cloneGuardrailSettings(this.settings.guardrails),
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
    const {
      invalidations: invalidationPartial,
      objectiveInvalidation: objectivePartial,
      guardrails: guardrailPartial,
      ...rest
    } = partial;

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

    const nextObjective = objectivePartial
      ? normalizeObjectiveSettings({
          ...this.settings.objectiveInvalidation,
          ...objectivePartial,
        })
      : this.settings.objectiveInvalidation;

    let guardrailsChanged = false;
    let guardrailSettings = this.settings.guardrails;
    if (guardrailPartial !== undefined) {
      guardrailsChanged = this.guardrails.updateSettings(guardrailPartial);
      guardrailSettings = this.guardrails.getSettings();
    }

    const next: TradingSettings = {
      ...this.settings,
      ...rest,
      invalidations: nextInvalidations,
      objectiveInvalidation: nextObjective,
      guardrails: guardrailSettings,
    };

    next.partialTakePercent = clamp(next.partialTakePercent, 0, 1);
    next.retestWindowMinutes = Math.max(0, next.retestWindowMinutes);
    next.slippageTicks = Math.max(0, next.slippageTicks);
    next.feesPercent = Math.max(0, next.feesPercent);
    next.riskPerTradePercent = Math.max(0, next.riskPerTradePercent);
    next.beOffsetTicks = Math.max(0, next.beOffsetTicks);
    next.invalidationBars = Math.max(0, Math.floor(next.invalidationBars));

    const changed = JSON.stringify(this.settings) !== JSON.stringify(next) || guardrailsChanged;
    if (!changed) {
      return false;
    }

    this.settings = {
      ...next,
      invalidations: nextInvalidations,
      guardrails: guardrailSettings,
    };
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
          const { pending, guardrailsChanged } = this.createPendingFromSignal(signal, true);
          if (pending) {
            changed = true;
          }
          if (guardrailsChanged) {
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

    const { pending, guardrailsChanged } = this.createPendingFromSignal(signal, false);
    if (pending) {
      this.bumpVersion();
      return pending;
    }
    if (guardrailsChanged) {
      this.bumpVersion();
    }
    return null;
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
    this.guardrails.reset(this.now());
    this.updateDailyPerformance();
    this.objectiveKpis = this.buildObjectiveKpis();
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
        objectiveInvalidation: { ...this.settings.objectiveInvalidation },
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
        thesis: {
          summary: event.thesis.summary,
          prints: [...event.thesis.prints],
          depth: [...event.thesis.depth],
        },
      })),
      timeline: this.timeline.map((entry) => ({ ...entry })),
      guardrails: this.guardrails.getState(),
      kpis: cloneObjectiveKpis(this.objectiveKpis),
      version: this.version,
    };
  }

  getPersistenceSnapshot(): TradingPersistenceSnapshot {
    return {
      settings: {
        ...this.settings,
        invalidations: { ...this.settings.invalidations },
        objectiveInvalidation: { ...this.settings.objectiveInvalidation },
        guardrails: cloneGuardrailSettings(this.settings.guardrails),
      },
      history: cloneClosed(this.history),
    };
  }

  private createPendingFromSignal(signal: FootprintSignal, auto: boolean): {
    pending: PendingTrade | null;
    guardrailsChanged: boolean;
  } {
    const evaluation = this.guardrails.evaluateEntry({
      now: this.now(),
      signal,
      auto,
    });

    if (this.pending.some((item) => item.signalId === signal.id)) {
      return { pending: null, guardrailsChanged: evaluation.changed };
    }
    if (this.positions.some((item) => item.signalId === signal.id)) {
      return { pending: null, guardrailsChanged: evaluation.changed };
    }

    if (!evaluation.allowed) {
      return { pending: null, guardrailsChanged: evaluation.changed };
    }

    const riskPerUnit = Math.abs(signal.entry - signal.stop);
    if (riskPerUnit < PRICE_EPSILON) {
      return { pending: null, guardrailsChanged: evaluation.changed };
    }

    const direction = directionFromSide(signal.side);
    const providedTarget1 = Number.isFinite(signal.target1) ? signal.target1 : signal.entry + direction * riskPerUnit * 2;
    const rrToProvidedTarget = Math.abs(providedTarget1 - signal.entry) / Math.max(riskPerUnit, PRICE_EPSILON);
    if (rrToProvidedTarget + PRICE_EPSILON < 2) {
      return { pending: null, guardrailsChanged: evaluation.changed };
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
    return { pending, guardrailsChanged: evaluation.changed };
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
      objectiveStartAt: null,
      objectiveStartBar: null,
      objectiveActiveThreshold: null,
      objectiveLastScore: 0,
      objectiveLastComponents: null,
      objectiveLastReasons: [],
      objectiveLastEventId: null,
    };

    if (!existing) {
      this.positionMeta.set(position.id, meta);
    } else {
      meta.entryBarTime = meta.entryBarTime ?? bar?.startTime ?? null;
      meta.entryCumDelta = meta.entryCumDelta ?? bar?.cumulativeDelta ?? null;
      meta.entryPoc = meta.entryPoc ?? bar?.pocPrice ?? null;
      meta.entrySignalScore = meta.entrySignalScore ?? signal?.score ?? null;
      if (typeof meta.objectiveStartAt === "undefined") {
        meta.objectiveStartAt = null;
      }
      if (typeof meta.objectiveStartBar === "undefined") {
        meta.objectiveStartBar = null;
      }
      if (typeof meta.objectiveActiveThreshold === "undefined") {
        meta.objectiveActiveThreshold = null;
      }
      if (typeof meta.objectiveLastScore !== "number") {
        meta.objectiveLastScore = 0;
      }
      if (!meta.objectiveLastComponents) {
        meta.objectiveLastComponents = null;
      }
      if (!Array.isArray(meta.objectiveLastReasons)) {
        meta.objectiveLastReasons = [];
      }
      if (typeof meta.objectiveLastEventId === "undefined") {
        meta.objectiveLastEventId = null;
      }
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
    const objective = this.settings.objectiveInvalidation;
    if (objective && objective.enabled) {
      return this.evaluateObjectiveInvalidations(context, objective);
    }
    return this.evaluateLegacyInvalidations(context);
  }

  private evaluateObjectiveInvalidations(
    context: InvalidationEvaluationContext,
    settings: ObjectiveInvalidationSettings,
  ): boolean {
    if (!this.positions.length) {
      return false;
    }

    const now = context.now;
    const bars = this.lastBars;
    let changed = false;
    const autoCloseQueue: Array<{ positionId: string; price: number; eventId: string; timestamp: number }> = [];

    for (const position of this.positions) {
      this.initializePositionMeta(position);
      const meta = this.positionMeta.get(position.id);
      if (!meta) {
        continue;
      }

      const prints = this.computeObjectivePrints({
        position,
        meta,
        bars,
        settings,
      });
      const depth = this.computeObjectiveDepth({
        position,
        meta,
        bars,
        settings,
        now,
      });

      const doubleConfirmed =
        prints.score >= settings.printsThreshold && depth.score >= settings.depthThreshold;

      const direction = directionFromSide(position.side);
      const lastMarkerPrice =
        depth.markerPrice ?? prints.markerPrice ?? position.lastPrice ?? position.entryPrice;

      let strategyCompliant = true;
      if (position.strategy === "poc-migration") {
        const closeAgainst =
          lastMarkerPrice !== null
            ? direction > 0
              ? lastMarkerPrice < position.entryPrice - this.priceStep * 0.25
              : lastMarkerPrice > position.entryPrice + this.priceStep * 0.25
            : false;
        if (prints.pocAgainstCount < 2 || !closeAgainst) {
          strategyCompliant = false;
        }
      } else if (position.strategy === "absorption-failure") {
        if (depth.replenishment < 1.2 || depth.ofiAgainstCount < Math.max(1, settings.persistenceBars - 1)) {
          strategyCompliant = false;
        }
      }

      if (!doubleConfirmed || !strategyCompliant) {
        meta.objectiveStartAt = null;
        meta.objectiveStartBar = null;
        meta.objectiveLastScore = clamp(
          Math.round(prints.score * settings.printsWeight + depth.score * settings.depthWeight),
          0,
          100,
        );
        meta.objectiveLastComponents = { prints: prints.score, depth: depth.score };
        meta.objectiveLastReasons = [...prints.reasons, ...depth.reasons];
        continue;
      }

      const latestBarIndex = bars.length ? bars.length - 1 : null;
      if (meta.objectiveStartAt === null) {
        meta.objectiveStartAt = now;
        meta.objectiveStartBar = latestBarIndex;
      }

      let persistenceSatisfied =
        meta.objectiveStartAt !== null &&
        now - meta.objectiveStartAt >= settings.persistenceSeconds * 1_000;

      if (!persistenceSatisfied && meta.objectiveStartBar !== null && latestBarIndex !== null) {
        const elapsedBars = latestBarIndex - meta.objectiveStartBar + 1;
        if (elapsedBars >= settings.persistenceBars) {
          persistenceSatisfied = true;
        }
      }

      const combinedBaseScore = clamp(
        Math.round(prints.score * settings.printsWeight + depth.score * settings.depthWeight),
        0,
        100,
      );

      if (!persistenceSatisfied) {
        meta.objectiveLastScore = combinedBaseScore;
        meta.objectiveLastComponents = { prints: prints.score, depth: depth.score };
        meta.objectiveLastReasons = [...prints.reasons, ...depth.reasons];
        continue;
      }

      const elapsedSinceEntry = now - position.entryTime;
      const severeOverride = depth.severeEvent;
      if (elapsedSinceEntry < settings.gracePeriodSeconds * 1_000 && !severeOverride) {
        meta.objectiveLastScore = combinedBaseScore;
        meta.objectiveLastComponents = { prints: prints.score, depth: depth.score };
        meta.objectiveLastReasons = [...prints.reasons, ...depth.reasons];
        continue;
      }

      const timeDecay = this.evaluateObjectiveTimeDecay({
        position,
        bars,
        settings,
        direction,
        now,
      });

      let combinedScore = combinedBaseScore;
      if (timeDecay.escalated) {
        combinedScore = Math.max(combinedScore, settings.highThreshold);
      }

      const thresholds = {
        severe: settings.severeThreshold,
        high: settings.highThreshold,
        medium: settings.mediumThreshold,
      };

      if (combinedScore < thresholds.medium) {
        meta.objectiveLastScore = combinedScore;
        meta.objectiveLastComponents = { prints: prints.score, depth: depth.score };
        meta.objectiveLastReasons = [...prints.reasons, ...depth.reasons, ...timeDecay.reasons];
        continue;
      }

      const activeThreshold = meta.objectiveActiveThreshold;
      if (
        activeThreshold !== null &&
        combinedScore < activeThreshold - settings.hysteresisPoints
      ) {
        meta.objectiveActiveThreshold = null;
      }

      const objectiveLevel: "severe" | "high" | "medium" =
        combinedScore >= thresholds.severe
          ? "severe"
          : combinedScore >= thresholds.high
            ? "high"
            : "medium";

      const severity: InvalidationSeverity =
        objectiveLevel === "medium" ? "medium" : "high";

      const thresholdValue =
        objectiveLevel === "severe"
          ? thresholds.severe
          : objectiveLevel === "high"
            ? thresholds.high
            : thresholds.medium;

      const lastEvent =
        meta.objectiveLastEventId &&
        this.invalidations.find((event) => event.id === meta.objectiveLastEventId);
      const lastEventActive = Boolean(lastEvent && !lastEvent.resolved && lastEvent.positionOpen);
      const isUpgrade =
        activeThreshold !== null && thresholdValue > activeThreshold;

      if (lastEventActive && !isUpgrade) {
        meta.objectiveLastScore = combinedScore;
        meta.objectiveLastComponents = { prints: prints.score, depth: depth.score };
        meta.objectiveLastReasons = [...prints.reasons, ...depth.reasons, ...timeDecay.reasons];
        continue;
      }

      const persistenceSeconds =
        meta.objectiveStartAt !== null
          ? Math.max(0, Math.round((now - meta.objectiveStartAt) / 1000))
          : 0;

      const winnerProtected = this.isWinnerProtected({
        position,
        depth,
        settings,
      });

      const breakdown: ObjectiveInvalidationBreakdown = {
        printsScore: prints.score,
        depthScore: depth.score,
        persistenceSeconds,
        reasons: Array.from(
          new Set([...prints.reasons, ...depth.reasons, ...timeDecay.reasons]),
        ),
        timeDecayEscalated: timeDecay.escalated,
        winnerProtected,
      };

      const triggers: TriggerResult[] = [
        this.buildObjectivePrintsTrigger(prints, position, lastMarkerPrice),
        this.buildObjectiveDepthTrigger(depth, position, lastMarkerPrice),
      ];
      if (timeDecay.trigger) {
        triggers.push(timeDecay.trigger);
      }

      const event = this.buildObjectiveInvalidationEvent({
        position,
        now,
        score: combinedScore,
        level: objectiveLevel,
        severity,
        triggers,
        prints,
        depth,
        breakdown,
        settings,
        winnerProtected,
        markerPrice: lastMarkerPrice,
      });

      this.invalidations.push(event);
      if (this.invalidations.length > MAX_INVALIDATION_EVENTS) {
        this.invalidations.splice(0, this.invalidations.length - MAX_INVALIDATION_EVENTS);
      }

      meta.lastInvalidationAt = now;
      meta.lastScore = event.score;
      meta.lastTriggers = event.triggers.map((item) => item.id);
      meta.objectiveActiveThreshold = thresholdValue;
      meta.objectiveLastScore = combinedScore;
      meta.objectiveLastComponents = { prints: prints.score, depth: depth.score };
      meta.objectiveLastReasons = breakdown.reasons;
      meta.objectiveLastEventId = event.id;

      this.appendTimelineForEvent(event, position);

      if (event.autoClosed) {
        autoCloseQueue.push({
          positionId: position.id,
          price: event.price,
          eventId: event.id,
          timestamp: event.timestamp,
        });
      }

      changed = true;
    }

    for (const action of autoCloseQueue) {
      this.flattenPosition(action.positionId, action.price, "invalidation");
      const event = this.invalidations.find((item) => item.id === action.eventId);
      if (event) {
        event.resolved = true;
        event.positionOpen = false;
        event.autoClosed = true;
        event.actionTaken = "close";
        this.resolveTimelineEvent(event.id, "close", true, action.timestamp);
      }
    }

    if (changed) {
      this.objectiveKpis = this.buildObjectiveKpis();
    }

    return changed;
  }

  private computeObjectivePrints(params: {
    position: Position;
    meta: PositionMeta;
    bars: FootprintBar[];
    settings: ObjectiveInvalidationSettings;
  }): ObjectivePrintsEvaluation {
    const { position, meta, bars, settings } = params;
    const direction = directionFromSide(position.side);
    const lookback = Math.max(settings.persistenceBars + 1, 3);
    const subset = bars.slice(-lookback);
    if (!subset.length) {
      return {
        score: 0,
        evidence: [],
        reasons: [],
        markerPrice: null,
        barTime: null,
        barIndex: null,
        deltaAgainstCount: 0,
        pocAgainstCount: 0,
        cumDeltaBroken: false,
      };
    }

    let deltaAgainstCount = 0;
    let pocAgainstCount = 0;
    const entryPoc = meta.entryPoc ?? position.entryPrice;
    const entryCum = meta.entryCumDelta;
    let minCum = entryCum ?? Number.POSITIVE_INFINITY;
    let maxCum = entryCum ?? Number.NEGATIVE_INFINITY;

    const evidence: InvalidationEvidenceItem[] = [];
    const reasons: string[] = [];

    for (const bar of subset) {
      if (direction * bar.totalDelta < 0) {
        deltaAgainstCount += 1;
      }
      const barPoc = typeof bar.pocPrice === "number" ? bar.pocPrice : bar.closePrice;
      if (
        direction > 0
          ? barPoc < entryPoc - this.priceStep * 0.25
          : barPoc > entryPoc + this.priceStep * 0.25
      ) {
        pocAgainstCount += 1;
      }
      if (entryCum !== null && entryCum !== undefined) {
        minCum = Math.min(minCum, bar.cumulativeDelta);
        maxCum = Math.max(maxCum, bar.cumulativeDelta);
      }
    }

    let score = 0;

    if (deltaAgainstCount >= Math.min(subset.length, settings.persistenceBars)) {
      const ratio = deltaAgainstCount / subset.length;
      const component = Math.min(45, 25 + ratio * 40);
      score += component;
      evidence.push({
        label: "Δ contrario",
        value: `${deltaAgainstCount}/${subset.length}`,
      });
      reasons.push(`Delta contrario en ${deltaAgainstCount}/${subset.length} velas`);
    }

    if (pocAgainstCount >= 2) {
      score += 30;
      evidence.push({
        label: "POC contra",
        value: `${pocAgainstCount}`,
      });
      reasons.push(`POC desplazado contra la entrada (${pocAgainstCount})`);
    }

    const lastBar = subset[subset.length - 1];
    const closeAgainst =
      direction > 0
        ? lastBar.closePrice < position.entryPrice - this.priceStep * 0.25
        : lastBar.closePrice > position.entryPrice + this.priceStep * 0.25;
    if (closeAgainst) {
      score += 15;
      evidence.push({ label: "Cierre", value: lastBar.closePrice.toFixed(2) });
      reasons.push(`Cierre por el lado opuesto (${lastBar.closePrice.toFixed(2)})`);
    }

    let cumDeltaBroken = false;
    if (entryCum !== null && entryCum !== undefined) {
      cumDeltaBroken = direction > 0 ? minCum < entryCum : maxCum > entryCum;
      if (cumDeltaBroken) {
        score += 15;
        const reference = direction > 0 ? minCum : maxCum;
        evidence.push({
          label: "CumΔ",
          value: reference.toFixed(2),
        });
        reasons.push("CumΔ revierte la zona de entrada");
      }
    }

    score = Math.min(100, score);

    const barIndex = bars.indexOf(lastBar);

    return {
      score,
      evidence,
      reasons,
      markerPrice: lastBar.closePrice,
      barTime: lastBar.endTime,
      barIndex: barIndex >= 0 ? barIndex : null,
      deltaAgainstCount,
      pocAgainstCount,
      cumDeltaBroken,
    };
  }

  private computeObjectiveDepth(params: {
    position: Position;
    meta: PositionMeta;
    bars: FootprintBar[];
    settings: ObjectiveInvalidationSettings;
    now: number;
  }): ObjectiveDepthEvaluation {
    const { position, bars, settings, now } = params;
    const direction = directionFromSide(position.side);
    const lookback = Math.max(settings.persistenceBars + 1, 3);
    const subset = bars.slice(-lookback);
    if (!subset.length) {
      return {
        score: 0,
        evidence: [],
        reasons: [],
        markerPrice: null,
        barTime: null,
        barIndex: null,
        severeEvent: false,
        depthPressureStrong: false,
        lastSweep: null,
        ofiAgainst: 0,
        ofiAgainstCount: 0,
        replenishment: 1,
      };
    }

    let ofiAgainst = 0;
    let ofiAgainstCount = 0;
    let replenishment = 1;
    let lastSweep: DepthSweepEvent | null = null;
    let score = 0;
    const evidence: InvalidationEvidenceItem[] = [];
    const reasons: string[] = [];

    for (const bar of subset) {
      const depth = bar.depth;
      if (!depth) {
        continue;
      }

      const ofi = depth.avgOfi;
      const ofiIsAgainst = direction > 0 ? ofi < 0 : ofi > 0;
      if (ofiIsAgainst) {
        ofiAgainst += Math.abs(ofi);
        ofiAgainstCount += 1;
      }

      const sideReplenishment = direction > 0 ? depth.maxReplenishmentAsk : depth.maxReplenishmentBid;
      replenishment = Math.max(replenishment, sideReplenishment);

      if (Array.isArray(depth.sweeps)) {
        for (const sweep of depth.sweeps) {
          const sweepAgainst =
            (direction > 0 && sweep.direction === "down") ||
            (direction < 0 && sweep.direction === "up");
          if (!sweepAgainst) {
            continue;
          }
          if (
            sweep.levelsCleared >= settings.severeSweepLevels &&
            sweep.priceMoveTicks >= settings.severeSweepMinTicks
          ) {
            if (!lastSweep || (sweep.detectedAt ?? 0) > (lastSweep.detectedAt ?? 0)) {
              lastSweep = sweep;
            }
          }
        }
      }
    }

    if (ofiAgainstCount >= Math.max(1, settings.persistenceBars - 1)) {
      const ratio = ofiAgainstCount / subset.length;
      const component = Math.min(40, 18 + ratio * 40);
      score += component;
      evidence.push({
        label: "OFI contra",
        value: `${ofiAgainstCount}/${subset.length}`,
      });
      reasons.push(`OFI contra en ${ofiAgainstCount}/${subset.length} velas`);
    }

    if (replenishment > 1.2) {
      const component = Math.min(35, (replenishment - 1) * 40);
      score += component;
      evidence.push({ label: "Replenish", value: replenishment.toFixed(2) });
      reasons.push(`Replenishment sostenido (${replenishment.toFixed(2)})`);
    }

    let severeEvent = false;
    if (lastSweep) {
      const withinWindow =
        typeof lastSweep.detectedAt === "number"
          ? now - lastSweep.detectedAt <= settings.severeSweepWindowMs
          : true;
      if (withinWindow) {
        severeEvent = true;
        score += 40;
        evidence.push({
          label: "Sweep",
          value: `${lastSweep.levelsCleared} niveles`,
        });
        reasons.push(
          `Barrida de liquidez (${lastSweep.levelsCleared} niveles · ${lastSweep.priceMoveTicks} ticks)`,
        );
      }
    }

    score = Math.min(100, score);

    const lastDepthBar = [...subset].reverse().find((bar) => bar.depth);
    const markerPrice = lastDepthBar ? lastDepthBar.closePrice : null;
    const barIndex = lastDepthBar ? bars.indexOf(lastDepthBar) : -1;

    return {
      score,
      evidence,
      reasons,
      markerPrice,
      barTime: lastDepthBar?.endTime ?? null,
      barIndex: barIndex >= 0 ? barIndex : null,
      severeEvent,
      depthPressureStrong: score >= settings.winnerProtectDepthThreshold,
      lastSweep,
      ofiAgainst,
      ofiAgainstCount,
      replenishment,
    };
  }

  private evaluateObjectiveTimeDecay(params: {
    position: Position;
    bars: FootprintBar[];
    settings: ObjectiveInvalidationSettings;
    direction: 1 | -1;
    now: number;
  }): {
    escalated: boolean;
    trigger: TriggerResult | null;
    reasons: string[];
  } {
    const { position, bars, settings, direction, now } = params;
    const elapsedMinutes = (now - position.entryTime) / 60_000;
    if (elapsedMinutes < settings.timeDecayMinutes) {
      return { escalated: false, trigger: null, reasons: [] };
    }
    if (position.mfe >= settings.timeDecayMinMfe) {
      return { escalated: false, trigger: null, reasons: [] };
    }

    const lookback = Math.max(1, settings.timeDecayContraBars);
    const subset = bars.slice(-lookback);
    if (!subset.length) {
      return { escalated: false, trigger: null, reasons: [] };
    }

    let deltaAgainstCount = 0;
    let ofiAgainstCount = 0;

    for (const bar of subset) {
      if (direction * bar.totalDelta < -settings.timeDecayDeltaThreshold) {
        deltaAgainstCount += 1;
      }
      const depth = bar.depth;
      if (depth) {
        const ofi = depth.avgOfi;
        if (direction > 0 ? ofi < -settings.timeDecayOfiThreshold : ofi > settings.timeDecayOfiThreshold) {
          ofiAgainstCount += 1;
        }
      }
    }

    if (deltaAgainstCount < lookback || ofiAgainstCount < Math.max(1, lookback - 1)) {
      return { escalated: false, trigger: null, reasons: [] };
    }

    const reasons = [
      `Hold ${elapsedMinutes.toFixed(1)}m sin progreso (< ${settings.timeDecayMinMfe.toFixed(2)}R)`,
      `Delta y OFI en contra (${deltaAgainstCount}/${lookback})`,
    ];

    const severity = clamp(0.6 + (elapsedMinutes - settings.timeDecayMinutes) / settings.timeDecayMinutes, 0.6, 1.2);
    const trigger: TriggerResult = {
      id: "objective-time-decay",
      severity,
      evidence: [
        { label: "Hold", value: `${elapsedMinutes.toFixed(1)}m` },
        { label: "MFE", value: `${position.mfe.toFixed(2)}R` },
      ],
      markerPrice: subset[subset.length - 1].closePrice,
      barTime: subset[subset.length - 1].endTime,
      barIndex: bars.length ? bars.length - 1 : null,
      thesis: {
        summary: "Time decay sin avance",
        prints: [
          `Delta en contra en ${deltaAgainstCount}/${lookback} velas`,
        ],
        depth: [
          `OFI en contra en ${ofiAgainstCount}/${lookback} velas`,
        ],
      },
    };

    return { escalated: true, trigger, reasons };
  }

  private isWinnerProtected(params: {
    position: Position;
    depth: ObjectiveDepthEvaluation;
    settings: ObjectiveInvalidationSettings;
  }): boolean {
    const { position, depth, settings } = params;
    const direction = directionFromSide(position.side);
    const riskPerUnit = Math.max(position.riskPerUnit, PRICE_EPSILON);
    const distanceToTp1 = (position.target1 - position.lastPrice) * direction;
    const distanceToTp1R = distanceToTp1 / riskPerUnit;
    const nearTp1 = distanceToTp1R <= settings.winnerProtectTp1DistanceR + 1e-6;
    const mfeProtected = position.mfe >= settings.winnerProtectMfeR - 1e-6;

    if (!nearTp1 && !mfeProtected) {
      return false;
    }

    if (depth.depthPressureStrong) {
      return false;
    }

    return true;
  }

  private buildObjectivePrintsTrigger(
    evaluation: ObjectivePrintsEvaluation,
    position: Position,
    markerPrice: number,
  ): TriggerResult {
    return {
      id: "objective-prints",
      severity: clamp(evaluation.score / 100, 0, 1.2),
      evidence: evaluation.evidence.slice(0, 5),
      markerPrice,
      barTime: evaluation.barTime,
      barIndex: evaluation.barIndex,
      thesis: {
        summary: "Presión de prints contra la tesis",
        prints: evaluation.reasons,
        depth: [],
      },
    };
  }

  private buildObjectiveDepthTrigger(
    evaluation: ObjectiveDepthEvaluation,
    position: Position,
    markerPrice: number,
  ): TriggerResult {
    return {
      id: "objective-depth",
      severity: clamp(evaluation.score / 100, 0, 1.2),
      evidence: evaluation.evidence.slice(0, 5),
      markerPrice,
      barTime: evaluation.barTime,
      barIndex: evaluation.barIndex,
      thesis: {
        summary: "L2/OFI valida la invalidación",
        prints: [],
        depth: evaluation.reasons,
      },
    };
  }

  private buildObjectiveInvalidationEvent(params: {
    position: Position;
    now: number;
    score: number;
    level: "severe" | "high" | "medium";
    severity: InvalidationSeverity;
    triggers: TriggerResult[];
    prints: ObjectivePrintsEvaluation;
    depth: ObjectiveDepthEvaluation;
    breakdown: ObjectiveInvalidationBreakdown;
    settings: ObjectiveInvalidationSettings;
    winnerProtected: boolean;
    markerPrice: number;
  }): InvalidationEvent {
    const { position, now, score, level, severity, triggers, breakdown, settings, winnerProtected, markerPrice } = params;

    let recommendation: string;
    let actions: InvalidationActionOption[] = [];
    let suggestedAction: InvalidationActionType = "hold";
    let autoClosed = false;

    if (level === "severe" && !winnerProtected) {
      recommendation = "Severo: cerrar 100% de la posición.";
      actions = [
        { ...INVALIDATION_ACTIONS.close },
        { ...INVALIDATION_ACTIONS.reduce },
        { ...INVALIDATION_ACTIONS["tighten-stop"] },
      ];
      suggestedAction = "close";
      autoClosed = settings.autoCloseSevere;
    } else if (level === "high") {
      recommendation = "Alto: reducir 50% o mover el SL a -0.5R.";
      actions = [
        { ...INVALIDATION_ACTIONS.reduce },
        { ...INVALIDATION_ACTIONS["tighten-stop"] },
        { ...INVALIDATION_ACTIONS.hold },
      ];
      suggestedAction = "reduce";
    } else {
      recommendation = "Medio: monitorear y ajustar el SL si es necesario.";
      actions = [
        { ...INVALIDATION_ACTIONS["tighten-stop"] },
        { ...INVALIDATION_ACTIONS.hold },
      ];
      suggestedAction = "tighten-stop";
    }

    if (winnerProtected) {
      recommendation = "Protección de ganadora: mover SL a BE +0.5 tick y mantener.";
      actions = [
        { ...INVALIDATION_ACTIONS["tighten-stop"] },
        { ...INVALIDATION_ACTIONS.hold },
        { ...INVALIDATION_ACTIONS.reduce },
      ];
      suggestedAction = "tighten-stop";
      autoClosed = false;
    }

    const event: InvalidationEvent = {
      id: `${position.id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      positionId: position.id,
      positionSide: position.side,
      strategy: position.strategy,
      triggerId: triggers[0]?.id ?? "objective-prints",
      triggerLabel: this.getTriggerLabel(triggers[0]?.id ?? "objective-prints"),
      triggers: triggers.map((item) => ({ id: item.id, severity: clamp(item.severity, 0, 1.2) })),
      policy: "objective",
      breakdown,
      score,
      severity,
      evidence: triggers.flatMap((trigger) => trigger.evidence).slice(0, 5),
      recommendation,
      thesis: {
        summary: `Invalidación objetiva (${level})`,
        prints: triggers[0]?.thesis?.prints ?? [],
        depth: triggers[1]?.thesis?.depth ?? [],
      },
      actions,
      suggestedAction,
      timestamp: now,
      session: position.session,
      price: markerPrice ?? position.lastPrice ?? position.entryPrice,
      barTime: triggers[0]?.barTime ?? null,
      barIndex: triggers[0]?.barIndex ?? null,
      autoClosed,
      resolved: autoClosed,
      actionTaken: autoClosed ? "close" : undefined,
      positionOpen: !autoClosed,
    };

    if (autoClosed) {
      event.resolved = true;
      event.actionTaken = "close";
    }

    return event;
  }

  private appendTimelineForEvent(event: InvalidationEvent, position: Position): void {
    const entry: TradingTimelineEntry = {
      id: `${event.id}-timeline`,
      timestamp: event.timestamp,
      type: "invalidation",
      eventId: event.id,
      positionId: event.positionId,
      signalId: position.signalId,
      triggerLabel: event.triggerLabel,
      severity: event.severity,
      recommendation: event.recommendation,
      suggestedAction: event.suggestedAction,
      status: event.autoClosed ? "resolved" : "pending",
      autoResolved: event.autoClosed,
      resolvedAt: event.autoClosed ? event.timestamp : undefined,
      thesisSummary: event.thesis.summary,
    };

    this.timeline.push(entry);
    if (this.timeline.length > MAX_TIMELINE_ENTRIES) {
      this.timeline.splice(0, this.timeline.length - MAX_TIMELINE_ENTRIES);
    }
  }

  private resolveTimelineEvent(
    eventId: string,
    action: InvalidationActionType,
    autoResolved: boolean,
    resolvedAt: number,
  ): void {
    for (const entry of this.timeline) {
      if (entry.eventId !== eventId) {
        continue;
      }
      entry.status = "resolved";
      entry.actionTaken = action;
      entry.autoResolved = autoResolved;
      entry.resolvedAt = resolvedAt;
    }
  }

  private buildObjectiveKpis(): ObjectiveInvalidationKpis {
    const day = this.getCurrentDayKey();
    const events = this.invalidations.filter(
      (event) => event.policy === "objective" && getDayKey(event.timestamp) === day,
    );
    const trades = this.history.filter((trade) => trade.day === day);
    const tradeMap = new Map(trades.map((trade) => [trade.id, trade]));

    const total = createObjectiveKpiAccumulator();
    const perSession: Record<TradingSession, ObjectiveKpiAccumulator> = {
      asia: createObjectiveKpiAccumulator(),
      eu: createObjectiveKpiAccumulator(),
      us: createObjectiveKpiAccumulator(),
      other: createObjectiveKpiAccumulator(),
    };
    const perStrategy: Record<SignalStrategy, ObjectiveKpiAccumulator> = {
      "absorption-failure": createObjectiveKpiAccumulator(),
      "poc-migration": createObjectiveKpiAccumulator(),
      "delta-divergence": createObjectiveKpiAccumulator(),
    };

    for (const event of events) {
      const trade = tradeMap.get(event.positionId);
      const buckets = [total, perSession[event.session], perStrategy[event.strategy]];

      for (const bucket of buckets) {
        bucket.events += 1;
        if (!trade) {
          continue;
        }
        bucket.tradeCount += 1;
        const baselineR = trade.exitReason === "invalidation" ? -1 : trade.realizedR;
        bucket.actualTotalR += trade.realizedR;
        bucket.baselineTotalR += baselineR;
        if (trade.exitReason === "invalidation") {
          bucket.stopsAvoided += 1;
          bucket.savedR += Math.max(0, -1 - trade.realizedR);
        }
        if (trade.firstHit === "tp1" || trade.firstHit === "tp2" || trade.exitReason === "tp2") {
          bucket.falsePositives += 1;
        }
      }
    }

    return {
      day,
      total: finalizeObjectiveBucket(total),
      perSession: {
        asia: finalizeObjectiveBucket(perSession.asia),
        eu: finalizeObjectiveBucket(perSession.eu),
        us: finalizeObjectiveBucket(perSession.us),
        other: finalizeObjectiveBucket(perSession.other),
      },
      perStrategy: {
        "absorption-failure": finalizeObjectiveBucket(perStrategy["absorption-failure"]),
        "poc-migration": finalizeObjectiveBucket(perStrategy["poc-migration"]),
        "delta-divergence": finalizeObjectiveBucket(perStrategy["delta-divergence"]),
      },
    };
  }

  private evaluateLegacyInvalidations(context: InvalidationEvaluationContext): boolean {
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

      const thesisPrints = [
        `Señal ${signal.side === "long" ? "long" : "short"} ${formatStrategy(signal.strategy)}`,
        `Confluencias: ${signal.strategies.length}`,
        `Barras desde entrada: ${barsSinceEntry}`,
      ];
      const thesisDepth: string[] = [];
      if (signal.l2) {
        const confidence = Number.isFinite(signal.l2.confidence)
          ? Math.round(signal.l2.confidence * 100)
          : null;
        if (signal.l2.confirmed && confidence !== null) {
          thesisDepth.push(`L2 confirmado (${confidence}%)`);
        } else if (confidence !== null) {
          thesisDepth.push(`L2 parcial (${confidence}%)`);
        }
        if (signal.l2.reason) {
          thesisDepth.push(signal.l2.reason);
        }
        if (signal.l2.absorption) {
          const durationSec = signal.l2.absorption.durationMs / 1000;
          const durationText = Number.isFinite(durationSec) ? `${durationSec.toFixed(1)}s` : "-";
          const replenishment = signal.l2.absorption.replenishmentFactor;
          const replenishmentText = Number.isFinite(replenishment) ? replenishment.toFixed(1) : "-";
          thesisDepth.push(`Absorción ${durationText} · factor ${replenishmentText}`);
        }
        if (signal.l2.sweep) {
          thesisDepth.push(
            `Sweep ${signal.l2.sweep.levelsCleared} niveles (${signal.l2.sweep.priceMoveTicks} ticks)`,
          );
        }
        if (signal.l2.spoof) {
          thesisDepth.push(
            `Spoof ${signal.l2.spoof.side === "bid" ? "bid" : "ask"} ${signal.l2.spoof.size.toFixed(0)}`,
          );
        }
      }

      const result: TriggerResult = {
        id: "opposite-signal",
        severity,
        evidence,
        markerPrice: signal.entry,
        barTime: signal.barTime,
        barIndex: signal.barIndex,
        thesis: {
          summary: `Señal opuesta (${signal.score.toFixed(0)} pts)`,
          prints: thesisPrints,
          depth: thesisDepth,
        },
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

        const stackLevels = Math.max(bestConsecutive, 1);
        const referencePrice = typeof bestPrice === "number" ? bestPrice.toFixed(2) : "-";
        const thesisPrints = [
          `Stack de ${stackLevels} niveles`,
          `Ratio medio: ${bestAverage.toFixed(2)}`,
          `Nivel de presión: ${referencePrice}`,
        ];
        if (typeof bestPrice === "number") {
          const distance = Math.abs(bestPrice - position.entryPrice);
          thesisPrints.push(`Distancia vs entrada: ${distance.toFixed(2)}`);
        }

        const result: TriggerResult = {
          id: "stacked-imbalance",
          severity,
          evidence,
          markerPrice: bestPrice,
          barTime: bar.endTime,
          barIndex: idx,
          thesis: {
            summary: `Imbalance apilado (${stackLevels} niveles)`,
            prints: thesisPrints,
            depth: [],
          },
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

    const directionLabel = position.side === "long" ? "bajista" : "alcista";
    const thesisPrints = [
      `Delta ${directionLabel} sostenido (${avgDelta.toFixed(2)})`,
      `Desplazamiento POC: ${pocShift.toFixed(2)}`,
      `Cierre en ${lastClose.toFixed(2)}`,
    ];

    return {
      id: "delta-poc-flip",
      severity,
      evidence,
      markerPrice: lastClose,
      barTime: lastBar.endTime,
      barIndex: bars.indexOf(lastBar),
      thesis: {
        summary: "Flip de delta + POC contra la entrada",
        prints: thesisPrints,
        depth: [],
      },
    };
  }

  private evaluateCumDeltaBreak(
    position: Position,
    meta: PositionMeta,
    bars: FootprintBar[],
    settings: InvalidationSettings,
  ): TriggerResult | null {
    if (!bars.length) return null;
    const lookback = Math.max(3, settings.cumDeltaLookback);
    const entryTime = meta.entryBarTime ?? position.entryTime;
    const { bar: entryBar } = this.findBarForTime(entryTime);
    const entryCum = meta.entryCumDelta ?? entryBar?.cumulativeDelta;
    if (entryCum == null) return null;
    if (bars.length < lookback) return null;
    // TODO: full logic; placeholder return to compile
    return null;
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

    const thesisPrints = [
      `Cierre ${close.toFixed(2)}`,
      `POC vs entrada: ${(poc - entryPoc).toFixed(2)}`,
      `Δ ratio: ${deltaStrength.toFixed(2)}`,
    ];
    const thesisSummary =
      position.side === "long"
        ? "Re-captura bajista del nivel clave"
        : "Re-captura alcista del nivel clave";

    return {
      id: "key-level-recapture",
      severity,
      evidence,
      markerPrice: close,
      barTime: lastBar.endTime,
      barIndex: bars.length - 1,
      thesis: {
        summary: thesisSummary,
        prints: thesisPrints,
        depth: [],
      },
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

    const thesisPrints = [
      `Hold ${elapsedMinutes.toFixed(1)}m`,
      `MFE ${position.mfe.toFixed(2)}R`,
    ];

    return {
      id: "time-decay",
      severity,
      evidence,
      markerPrice: position.lastPrice,
      barTime: null,
      barIndex: null,
      thesis: {
        summary: `Sin progreso tras ${elapsedMinutes.toFixed(1)}m`,
        prints: thesisPrints,
        depth: [],
      },
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
    const thesisDepth = [
      `Barrida ${wick.toFixed(2)}`,
      `Retrace ${(retrace * 100).toFixed(0)}%`,
      `Volumen ${lastBar.totalVolume.toFixed(0)} (p${percentileVolume.toFixed(0)})`,
    ];

    return {
      id: "liquidity-sweep",
      severity,
      evidence,
      markerPrice,
      barTime: lastBar.endTime,
      barIndex: bars.length - 1,
      thesis: {
        summary: "Barrida de liquidez contra la entrada",
        prints: [],
        depth: thesisDepth,
      },
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

    this.guardrails.recordClosedTrade(closed);
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

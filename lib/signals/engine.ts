import type {
  DetectorOverrides,
  FootprintBar,
  FootprintSignal,
  SignalControlState,
  SignalMode,
  SignalStats,
  SignalStrategy,
  SignalSide,
  SignalEvidenceItem,
  TradingSession,
} from "@/types";

const MAX_SIGNAL_HISTORY = 150;
const PERCENTILE_LOOKBACK = 240;
const ATR_LOOKBACK = 120;
const ABSORPTION_LOOKBACK = 12;
const DIVERGENCE_LOOKBACK = 16;
const POC_LOOKBACK = 6;
const DAY_MS = 86_400_000;
const WEEK_MS = DAY_MS * 7;
const PRICE_STEP_MULTIPLIER_STOP = 2;
const PRICE_STEP_MULTIPLIER_TARGET_1 = 1.0;
const PRICE_STEP_MULTIPLIER_TARGET_2 = 1.8;

interface ModePreset {
  id: SignalMode;
  label: string;
  minScore: number;
  stackRatio: number;
  stackLevels: number;
  minDeltaPercentile: number;
  minVolumePercentile: number;
  keyLevelDistancePercent: number;
  requireKeyLevel: boolean;
  requireConfluence: boolean;
  minStrategies: number;
  maxSignalsPerSession: number | null;
  maxSignalsPerDay: number | null;
  avoidLowLiquidity: boolean;
  atrPercentileRange: [number, number] | null;
}

export const MODE_PRESETS: Record<SignalMode, ModePreset> = {
  conservative: {
    id: "conservative",
    label: "Conservador",
    minScore: 75,
    stackRatio: 4,
    stackLevels: 4,
    minDeltaPercentile: 0.85,
    minVolumePercentile: 0.85,
    keyLevelDistancePercent: 0.12,
    requireKeyLevel: true,
    requireConfluence: true,
    minStrategies: 2,
    maxSignalsPerSession: 1,
    maxSignalsPerDay: 2,
    avoidLowLiquidity: true,
    atrPercentileRange: [0.25, 0.8],
  },
  standard: {
    id: "standard",
    label: "Estándar",
    minScore: 60,
    stackRatio: 3,
    stackLevels: 3,
    minDeltaPercentile: 0.7,
    minVolumePercentile: 0.7,
    keyLevelDistancePercent: 0.2,
    requireKeyLevel: false,
    requireConfluence: false,
    minStrategies: 1,
    maxSignalsPerSession: null,
    maxSignalsPerDay: 6,
    avoidLowLiquidity: false,
    atrPercentileRange: [0.15, 0.9],
  },
  aggressive: {
    id: "aggressive",
    label: "Agresivo",
    minScore: 45,
    stackRatio: 2.5,
    stackLevels: 2,
    minDeltaPercentile: 0.55,
    minVolumePercentile: 0.55,
    keyLevelDistancePercent: 0.35,
    requireKeyLevel: false,
    requireConfluence: false,
    minStrategies: 1,
    maxSignalsPerSession: null,
    maxSignalsPerDay: null,
    avoidLowLiquidity: false,
    atrPercentileRange: null,
  },
};

export function createDefaultSignalControlState(): SignalControlState {
  return {
    mode: "conservative",
    enabledStrategies: {
      "absorption-failure": true,
      "poc-migration": true,
      "delta-divergence": true,
    },
    overrides: {},
  };
}

interface ActiveThresholds {
  minScore: number;
  stackRatio: number;
  stackLevels: number;
  minDeltaPercentile: number;
  minVolumePercentile: number;
  keyLevelDistancePercent: number;
  requireKeyLevel: boolean;
  requireConfluence: boolean;
  minStrategies: number;
  maxSignalsPerSession: number | null;
  maxSignalsPerDay: number | null;
  avoidLowLiquidity: boolean;
  atrPercentileRange: [number, number] | null;
}

interface StackInfo {
  levels: number;
  ratio: number;
  maxObservedRatio: number;
  anchorPrice: number | null;
  cumulativeVolume: number;
}

interface KeyLevel {
  label: string;
  price: number;
}

interface KeyLevelMatch extends KeyLevel {
  distancePercent: number;
}

interface DayStats {
  high: number;
  low: number;
  poc: number | null;
}

interface WeekStats {
  high: number;
  low: number;
}

interface PocMigration {
  direction: 1 | -1;
  drift: number;
  steps: number;
  lookback: number;
  aligned: boolean;
  averageDeltaSign: number;
}

interface StrategyHit {
  strategy: SignalStrategy;
  side: SignalSide;
  rawScore: number;
  stackRatio: number;
  stackLevels: number;
  deltaPercentile: number;
  volumePercentile: number;
  atrPercentile: number;
  keyMatch: KeyLevelMatch | null;
  keyLevelDistance: number | null;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  evidence: SignalEvidenceItem[];
  pocDrift?: number;
}

interface DetectionContext {
  bars: FootprintBar[];
  index: number;
  bar: FootprintBar;
  session: TradingSession;
  thresholds: ActiveThresholds;
  deltaPercentile: number;
  volumePercentile: number;
  atrPercentile: number;
  stackBid: StackInfo;
  stackAsk: StackInfo;
  keyMatch: KeyLevelMatch | null;
  pocMigration: PocMigration | null;
  prevDayStats: DayStats | undefined;
  prevWeekStats: WeekStats | undefined;
  previousPoc: number | null;
  sessionVwap: number | null;
}

export class SignalEngine {
  private priceStep: number;

  private timeframeMs: number;

  private config: SignalControlState;

  private signals: FootprintSignal[] = [];

  private signalStats: SignalStats = {
    dailyCount: 0,
    sessionCount: {
      asia: 0,
      eu: 0,
      us: 0,
      other: 0,
    },
    estimatePerDay: 0,
    lastReset: 0,
  };

  private barKeys = new Set<number>();

  private deltaHistory: number[] = [];

  private volumeHistory: number[] = [];

  private atrHistory: number[] = [];

  private prevClose: number | null = null;

  private dailySignalCounts = new Map<string, number>();

  private sessionSignalCounts = new Map<string, number>();

  private emittedKeys = new Set<string>();

  constructor(options: { priceStep: number; timeframeMs: number; config?: SignalControlState }) {
    this.priceStep = options.priceStep;
    this.timeframeMs = options.timeframeMs;
    this.config = options.config ?? createDefaultSignalControlState();
  }

  updateConfig(config: Partial<SignalControlState>) {
    this.config = {
      mode: config.mode ?? this.config.mode,
      enabledStrategies: {
        ...this.config.enabledStrategies,
        ...(config.enabledStrategies ?? {}),
      },
      overrides: {
        ...this.config.overrides,
        ...(config.overrides ?? {}),
      },
    };
  }

  updateSettings(settings: { priceStep?: number; timeframeMs?: number }) {
    if (typeof settings.priceStep === "number" && settings.priceStep > 0) {
      this.priceStep = settings.priceStep;
    }
    if (typeof settings.timeframeMs === "number" && settings.timeframeMs > 0) {
      this.timeframeMs = settings.timeframeMs;
    }
  }

  reset() {
    this.signals = [];
    this.signalStats = {
      dailyCount: 0,
      sessionCount: {
        asia: 0,
        eu: 0,
        us: 0,
        other: 0,
      },
      estimatePerDay: 0,
      lastReset: 0,
    };
    this.barKeys.clear();
    this.deltaHistory = [];
    this.volumeHistory = [];
    this.atrHistory = [];
    this.prevClose = null;
    this.dailySignalCounts.clear();
    this.sessionSignalCounts.clear();
    this.emittedKeys.clear();
  }

  process(bars: FootprintBar[]): { signals: FootprintSignal[]; stats: SignalStats } {
    if (!bars.length) {
      this.reset();
      return { signals: this.signals, stats: this.signalStats };
    }

    const sorted = [...bars].sort((a, b) => a.startTime - b.startTime);
    const dayStats = buildDayStats(sorted);
    const weekStats = buildWeekStats(sorted);

    for (let index = 0; index < sorted.length; index += 1) {
      const bar = sorted[index];
      if (this.barKeys.has(bar.startTime)) {
        continue;
      }

      this.evaluateBar({
        bars: sorted,
        index,
        bar,
        dayStats,
        weekStats,
      });

      this.barKeys.add(bar.startTime);
      if (this.barKeys.size > 800) {
        const iterator = this.barKeys.values().next();
        if (!iterator.done && typeof iterator.value === "number") {
          this.barKeys.delete(iterator.value);
        }
      }
    }

    this.updateStats(sorted);

    return {
      signals: [...this.signals],
      stats: { ...this.signalStats, sessionCount: { ...this.signalStats.sessionCount } },
    };
  }

  private evaluateBar(args: {
    bars: FootprintBar[];
    index: number;
    bar: FootprintBar;
    dayStats: Map<string, DayStats>;
    weekStats: Map<string, WeekStats>;
  }) {
    const { bars, index, bar, dayStats, weekStats } = args;
    const thresholds = this.getActiveThresholds();
    const dayKey = getDayKey(bar.startTime);
    const session = getTradingSession(bar.startTime);

    const prevClose = this.prevClose;
    const trueRange = computeTrueRange(bar, prevClose);
    const absDelta = Math.abs(bar.totalDelta);
    const totalVolume = Math.max(0, bar.totalVolume);

    const deltaPercentile = percentileRank(this.deltaHistory, absDelta);
    const volumePercentile = percentileRank(this.volumeHistory, totalVolume);
    const atrPercentile = percentileRank(this.atrHistory, trueRange);

    const stackBid = computeStackedImbalance(bar.levels, "bid", thresholds.stackRatio);
    const stackAsk = computeStackedImbalance(bar.levels, "ask", thresholds.stackRatio);

    const prevDayStats = dayStats.get(getDayKey(bar.startTime - DAY_MS));
    const prevWeekStats = weekStats.get(getWeekKey(bar.startTime - WEEK_MS));
    const previousPoc = index > 0 ? bars[index - 1].pocPrice ?? null : null;
    const sessionVwap = computeSessionVwap(bars, index);

    const keyLevels = collectKeyLevels({
      prevDay: prevDayStats,
      prevWeek: prevWeekStats,
      sessionVwap,
      previousPoc,
    });
    const keyMatch = findClosestKeyLevel(bar.closePrice, keyLevels);

    const pocMigration = computePocMigration(bars, index, this.priceStep);

    const context: DetectionContext = {
      bars,
      index,
      bar,
      session,
      thresholds,
      deltaPercentile,
      volumePercentile,
      atrPercentile,
      stackBid,
      stackAsk,
      keyMatch,
      pocMigration,
      prevDayStats,
      prevWeekStats,
      previousPoc,
      sessionVwap,
    };

    const hits: StrategyHit[] = [];
    hits.push(...this.detectAbsorption(context));
    hits.push(...this.detectPocMigration(context));
    hits.push(...this.detectDeltaDivergence(context));

    const enabledHits = hits.filter((hit) => this.config.enabledStrategies[hit.strategy]);
    if (!enabledHits.length) {
      this.pushHistories(absDelta, totalVolume, trueRange);
      this.prevClose = bar.closePrice;
      return;
    }

    const grouped = new Map<SignalSide, StrategyHit[]>();
    for (const hit of enabledHits) {
      const group = grouped.get(hit.side);
      if (group) {
        group.push(hit);
      } else {
        grouped.set(hit.side, [hit]);
      }
    }

    for (const [side, sideHits] of grouped.entries()) {
      this.createSignalFromHits({ side, hits: sideHits, context, dayKey });
    }

    this.pushHistories(absDelta, totalVolume, trueRange);
    this.prevClose = bar.closePrice;
  }

  private createSignalFromHits(params: {
    side: SignalSide;
    hits: StrategyHit[];
    context: DetectionContext;
    dayKey: string;
  }) {
    const { side, hits, context, dayKey } = params;
    if (!hits.length) {
      return;
    }

    const thresholds = context.thresholds;
    const strategies = Array.from(new Set(hits.map((hit) => hit.strategy)));
    const bestHit = hits.reduce((prev, curr) => (curr.rawScore > prev.rawScore ? curr : prev));
    const stackRatio = Math.max(...hits.map((hit) => hit.stackRatio));
    const stackLevels = Math.max(...hits.map((hit) => hit.stackLevels));
    const deltaPercentile = Math.max(...hits.map((hit) => hit.deltaPercentile));
    const volumePercentile = Math.max(...hits.map((hit) => hit.volumePercentile));
    const atrPercentile = Math.max(...hits.map((hit) => hit.atrPercentile));

    const keyMatch = hits.find((hit) => hit.keyMatch)?.keyMatch ?? context.keyMatch;
    const keyLevelDistance = keyMatch?.distancePercent ?? null;

    const baseScore = Math.max(...hits.map((hit) => hit.rawScore));
    const confluenceBonus = Math.max(0, strategies.length - 1) * 7;
    const finalScore = Math.min(100, baseScore + confluenceBonus);

    if (thresholds.avoidLowLiquidity && (context.session === "asia" || context.session === "other")) {
      return;
    }

    if (thresholds.requireKeyLevel) {
      if (!keyMatch || keyLevelDistance === null || keyLevelDistance > thresholds.keyLevelDistancePercent) {
        return;
      }
    } else if (keyLevelDistance !== null && keyLevelDistance > thresholds.keyLevelDistancePercent * 1.8) {
      return;
    }

    if (stackRatio < thresholds.stackRatio || stackLevels < thresholds.stackLevels) {
      return;
    }
    if (deltaPercentile < thresholds.minDeltaPercentile) {
      return;
    }
    if (volumePercentile < thresholds.minVolumePercentile) {
      return;
    }
    if (thresholds.atrPercentileRange) {
      const [minAtr, maxAtr] = thresholds.atrPercentileRange;
      if (atrPercentile < minAtr || atrPercentile > maxAtr) {
        return;
      }
    }

    const meetsConfluence = strategies.length >= thresholds.minStrategies;
    if (thresholds.requireConfluence && !meetsConfluence && finalScore < thresholds.minScore) {
      return;
    }
    if (!thresholds.requireConfluence && finalScore < thresholds.minScore) {
      return;
    }

    if (thresholds.maxSignalsPerDay !== null) {
      const dayCount = this.dailySignalCounts.get(dayKey) ?? 0;
      if (dayCount >= thresholds.maxSignalsPerDay) {
        return;
      }
    }

    const sessionKey = `${dayKey}-${context.session}`;
    if (
      thresholds.maxSignalsPerSession !== null &&
      (context.session === "eu" || context.session === "us")
    ) {
      const sessionCount = this.sessionSignalCounts.get(sessionKey) ?? 0;
      if (sessionCount >= thresholds.maxSignalsPerSession) {
        return;
      }
    }

    const signalKey = `${context.bar.startTime}-${side}-${strategies.sort().join("|")}`;
    if (this.emittedKeys.has(signalKey)) {
      return;
    }
    this.emittedKeys.add(signalKey);

    const mergedEvidence = mergeEvidence(hits, keyMatch);

    const entry = roundToStep(bestHit.entry, this.priceStep);
    const stop = roundToStep(bestHit.stop, this.priceStep);
    const target1 = roundToStep(bestHit.target1, this.priceStep);
    const target2 = roundToStep(bestHit.target2, this.priceStep);

    const signal: FootprintSignal = {
      id: `${context.bar.startTime}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: context.bar.endTime,
      barTime: context.bar.startTime,
      barIndex: context.index,
      price: entry,
      entry,
      stop,
      target1,
      target2,
      score: Math.round(finalScore),
      session: context.session,
      side,
      strategy: bestHit.strategy,
      strategies,
      levelLabel: keyMatch?.label ?? null,
      evidence: mergedEvidence,
    };

    this.signals.push(signal);
    this.signals.sort((a, b) => a.barTime - b.barTime);
    while (this.signals.length > MAX_SIGNAL_HISTORY) {
      this.signals.shift();
    }

    this.dailySignalCounts.set(dayKey, (this.dailySignalCounts.get(dayKey) ?? 0) + 1);
    this.sessionSignalCounts.set(sessionKey, (this.sessionSignalCounts.get(sessionKey) ?? 0) + 1);
  }

  private detectAbsorption(context: DetectionContext): StrategyHit[] {
    const { bar, bars, index, thresholds, stackBid, stackAsk, keyMatch, deltaPercentile, volumePercentile, atrPercentile } = context;
    const results: StrategyHit[] = [];
    const lookback = Math.min(index, ABSORPTION_LOOKBACK);
    const previousBars = bars.slice(Math.max(0, index - lookback), index);
    const prevHigh = previousBars.length ? Math.max(...previousBars.map((item) => item.highPrice)) : bar.highPrice;
    const prevLow = previousBars.length ? Math.min(...previousBars.map((item) => item.lowPrice)) : bar.lowPrice;

    const range = Math.max(bar.highPrice - bar.lowPrice, this.priceStep * 2);
    const closePosition = (bar.closePrice - bar.lowPrice) / range;

    const longConditions = [
      stackBid.levels >= Math.max(1, thresholds.stackLevels - 1),
      stackBid.ratio >= Math.max(1.5, thresholds.stackRatio * 0.8),
      bar.totalDelta < 0,
      closePosition > 0.55,
      bar.lowPrice <= prevLow + this.priceStep * 0.5,
    ];

    if (longConditions.every(Boolean)) {
      const stackStrength = average([stackBid.ratio / Math.max(thresholds.stackRatio, 1), stackBid.maxObservedRatio / (thresholds.stackRatio * 1.2)]);
      const levelStrength = stackBid.levels / Math.max(thresholds.stackLevels, 1);
      const imbalanceScore = clamp(stackStrength * 25 + levelStrength * 15, 0, 40);
      const deltaScore = clamp(deltaPercentile * 25, 0, 25);
      const volumeScore = clamp(volumePercentile * 20, 0, 20);
      const keyScore = keyMatch ? clamp((thresholds.keyLevelDistancePercent - keyMatch.distancePercent) / thresholds.keyLevelDistancePercent * 12, 0, 12) : 0;
      const atrScore = atrPercentileContribution(atrPercentile, thresholds.atrPercentileRange);
      const reversalBonus = closePosition > 0.65 ? 6 : 0;

      const rawScore = clamp(imbalanceScore + deltaScore + volumeScore + keyScore + atrScore + reversalBonus, 0, 100);

      const entry = bar.closePrice;
      const stop = bar.lowPrice - this.priceStep * PRICE_STEP_MULTIPLIER_STOP;
      const target1 = entry + range * PRICE_STEP_MULTIPLIER_TARGET_1;
      const target2 = entry + range * PRICE_STEP_MULTIPLIER_TARGET_2;

      const evidence: SignalEvidenceItem[] = [
        { label: "Stack", value: `${stackBid.ratio.toFixed(2)}× / ${stackBid.levels} niveles` },
        { label: "|Delta|", value: `P${Math.round(deltaPercentile * 100)}` },
        { label: "Volumen", value: `P${Math.round(volumePercentile * 100)}` },
        { label: "Cierre", value: `${(closePosition * 100).toFixed(1)}% del rango` },
      ];

      results.push({
        strategy: "absorption-failure",
        side: "long",
        rawScore,
        stackRatio: stackBid.ratio,
        stackLevels: stackBid.levels,
        deltaPercentile,
        volumePercentile,
        atrPercentile,
        keyMatch,
        keyLevelDistance: keyMatch?.distancePercent ?? null,
        entry,
        stop,
        target1,
        target2,
        evidence,
      });
    }

    const closePositionShort = (bar.closePrice - bar.lowPrice) / Math.max(bar.highPrice - bar.lowPrice, this.priceStep * 2);
    const shortConditions = [
      stackAsk.levels >= Math.max(1, thresholds.stackLevels - 1),
      stackAsk.ratio >= Math.max(1.5, thresholds.stackRatio * 0.8),
      bar.totalDelta > 0,
      closePositionShort < 0.45,
      bar.highPrice >= prevHigh - this.priceStep * 0.5,
    ];

    if (shortConditions.every(Boolean)) {
      const stackStrength = average([stackAsk.ratio / Math.max(thresholds.stackRatio, 1), stackAsk.maxObservedRatio / (thresholds.stackRatio * 1.2)]);
      const levelStrength = stackAsk.levels / Math.max(thresholds.stackLevels, 1);
      const imbalanceScore = clamp(stackStrength * 25 + levelStrength * 15, 0, 40);
      const deltaScore = clamp(deltaPercentile * 25, 0, 25);
      const volumeScore = clamp(volumePercentile * 20, 0, 20);
      const keyScore = keyMatch ? clamp((thresholds.keyLevelDistancePercent - keyMatch.distancePercent) / thresholds.keyLevelDistancePercent * 12, 0, 12) : 0;
      const atrScore = atrPercentileContribution(atrPercentile, thresholds.atrPercentileRange);
      const reversalBonus = closePositionShort < 0.35 ? 6 : 0;

      const rawScore = clamp(imbalanceScore + deltaScore + volumeScore + keyScore + atrScore + reversalBonus, 0, 100);

      const entry = bar.closePrice;
      const stop = bar.highPrice + this.priceStep * PRICE_STEP_MULTIPLIER_STOP;
      const target1 = entry - (bar.highPrice - bar.lowPrice) * PRICE_STEP_MULTIPLIER_TARGET_1;
      const target2 = entry - (bar.highPrice - bar.lowPrice) * PRICE_STEP_MULTIPLIER_TARGET_2;

      const evidence: SignalEvidenceItem[] = [
        { label: "Stack", value: `${stackAsk.ratio.toFixed(2)}× / ${stackAsk.levels} niveles` },
        { label: "|Delta|", value: `P${Math.round(deltaPercentile * 100)}` },
        { label: "Volumen", value: `P${Math.round(volumePercentile * 100)}` },
        { label: "Cierre", value: `${(closePositionShort * 100).toFixed(1)}% del rango` },
      ];

      results.push({
        strategy: "absorption-failure",
        side: "short",
        rawScore,
        stackRatio: stackAsk.ratio,
        stackLevels: stackAsk.levels,
        deltaPercentile,
        volumePercentile,
        atrPercentile,
        keyMatch,
        keyLevelDistance: keyMatch?.distancePercent ?? null,
        entry,
        stop,
        target1,
        target2,
        evidence,
      });
    }

    return results;
  }

  private detectPocMigration(context: DetectionContext): StrategyHit[] {
    const { pocMigration, bar, thresholds, deltaPercentile, volumePercentile, atrPercentile, keyMatch } = context;
    if (!pocMigration) {
      return [];
    }

    const side: SignalSide = pocMigration.direction > 0 ? "long" : "short";
    const stackInfo = pocMigration.direction > 0 ? context.stackBid : context.stackAsk;

    const driftStrength = clamp(Math.abs(pocMigration.drift) / (this.priceStep * 4), 0, 1.5);
    const stepsStrength = clamp(pocMigration.steps / Math.max(2, thresholds.stackLevels), 0, 1.5);
    const alignmentBonus = pocMigration.aligned ? 10 : 0;
    const deltaScore = clamp(deltaPercentile * 20, 0, 20);
    const volumeScore = clamp(volumePercentile * 15, 0, 15);
    const keyScore = keyMatch ? clamp((thresholds.keyLevelDistancePercent - keyMatch.distancePercent) / thresholds.keyLevelDistancePercent * 10, 0, 10) : 0;
    const stackScore = clamp((stackInfo.ratio / Math.max(thresholds.stackRatio, 1)) * 15, 0, 20);
    const atrScore = atrPercentileContribution(atrPercentile, thresholds.atrPercentileRange);

    const rawScore = clamp(driftStrength * 28 + stepsStrength * 18 + alignmentBonus + deltaScore + volumeScore + stackScore + keyScore + atrScore, 0, 100);

    const range = Math.max(bar.highPrice - bar.lowPrice, this.priceStep * 2);
    const entry = bar.closePrice;
    const stop = side === "long" ? bar.lowPrice - this.priceStep * PRICE_STEP_MULTIPLIER_STOP : bar.highPrice + this.priceStep * PRICE_STEP_MULTIPLIER_STOP;
    const directionMultiplier = side === "long" ? 1 : -1;
    const target1 = entry + directionMultiplier * range * PRICE_STEP_MULTIPLIER_TARGET_1;
    const target2 = entry + directionMultiplier * range * PRICE_STEP_MULTIPLIER_TARGET_2;

    const evidence: SignalEvidenceItem[] = [
      { label: "POC drift", value: `${directionMultiplier > 0 ? "+" : "-"}${Math.round(Math.abs(pocMigration.drift) / this.priceStep)} ticks` },
      { label: "Pasos", value: `${pocMigration.steps} barras` },
      { label: "Alineación", value: pocMigration.aligned ? "Sí" : "No" },
      { label: "|Delta|", value: `P${Math.round(deltaPercentile * 100)}` },
    ];

    return [
      {
        strategy: "poc-migration",
        side,
        rawScore,
        stackRatio: stackInfo.ratio,
        stackLevels: stackInfo.levels,
        deltaPercentile,
        volumePercentile,
        atrPercentile,
        keyMatch,
        keyLevelDistance: keyMatch?.distancePercent ?? null,
        entry,
        stop,
        target1,
        target2,
        evidence,
        pocDrift: pocMigration.drift,
      },
    ];
  }

  private detectDeltaDivergence(context: DetectionContext): StrategyHit[] {
    const { bars, index, bar, stackBid, stackAsk, thresholds, deltaPercentile, volumePercentile, atrPercentile, keyMatch } = context;
    const slice = bars.slice(Math.max(0, index - DIVERGENCE_LOOKBACK), index);
    if (!slice.length) {
      return [];
    }

    const prevHigh = Math.max(...slice.map((item) => item.highPrice));
    const prevLow = Math.min(...slice.map((item) => item.lowPrice));
    const prevCumHigh = Math.max(...slice.map((item) => item.cumulativeDelta));
    const prevCumLow = Math.min(...slice.map((item) => item.cumulativeDelta));

    const results: StrategyHit[] = [];

    if (bar.highPrice >= prevHigh - this.priceStep * 0.25 && bar.totalDelta < 0 && bar.cumulativeDelta <= prevCumHigh) {
      const divergenceStrength = clamp((prevCumHigh - bar.cumulativeDelta) / Math.max(1, Math.abs(prevCumHigh)), 0, 1.2);
      const stackStrength = stackAsk.ratio / Math.max(thresholds.stackRatio, 1);
      const stackLevelStrength = stackAsk.levels / Math.max(thresholds.stackLevels, 1);
      const deltaScore = clamp(deltaPercentile * 22, 0, 22);
      const volumeScore = clamp(volumePercentile * 15, 0, 15);
      const keyScore = keyMatch ? clamp((thresholds.keyLevelDistancePercent - keyMatch.distancePercent) / thresholds.keyLevelDistancePercent * 10, 0, 10) : 0;
      const atrScore = atrPercentileContribution(atrPercentile, thresholds.atrPercentileRange);

      const rawScore = clamp(divergenceStrength * 30 + stackStrength * 18 + stackLevelStrength * 12 + deltaScore + volumeScore + keyScore + atrScore, 0, 100);

      const range = Math.max(bar.highPrice - bar.lowPrice, this.priceStep * 2);
      const entry = bar.closePrice;
      const stop = bar.highPrice + this.priceStep * PRICE_STEP_MULTIPLIER_STOP;
      const target1 = entry - range * PRICE_STEP_MULTIPLIER_TARGET_1;
      const target2 = entry - range * PRICE_STEP_MULTIPLIER_TARGET_2;

      const evidence: SignalEvidenceItem[] = [
        { label: "Divergencia", value: `${(divergenceStrength * 100).toFixed(1)}%` },
        { label: "CumDelta", value: `${bar.cumulativeDelta.toFixed(2)} vs ${prevCumHigh.toFixed(2)}` },
        { label: "Stack", value: `${stackAsk.ratio.toFixed(2)}× / ${stackAsk.levels}` },
      ];

      results.push({
        strategy: "delta-divergence",
        side: "short",
        rawScore,
        stackRatio: stackAsk.ratio,
        stackLevels: stackAsk.levels,
        deltaPercentile,
        volumePercentile,
        atrPercentile,
        keyMatch,
        keyLevelDistance: keyMatch?.distancePercent ?? null,
        entry,
        stop,
        target1,
        target2,
        evidence,
      });
    }

    if (bar.lowPrice <= prevLow + this.priceStep * 0.25 && bar.totalDelta > 0 && bar.cumulativeDelta >= prevCumLow) {
      const divergenceStrength = clamp((bar.cumulativeDelta - prevCumLow) / Math.max(1, Math.abs(prevCumLow)), 0, 1.2);
      const stackStrength = stackBid.ratio / Math.max(thresholds.stackRatio, 1);
      const stackLevelStrength = stackBid.levels / Math.max(thresholds.stackLevels, 1);
      const deltaScore = clamp(deltaPercentile * 22, 0, 22);
      const volumeScore = clamp(volumePercentile * 15, 0, 15);
      const keyScore = keyMatch ? clamp((thresholds.keyLevelDistancePercent - keyMatch.distancePercent) / thresholds.keyLevelDistancePercent * 10, 0, 10) : 0;
      const atrScore = atrPercentileContribution(atrPercentile, thresholds.atrPercentileRange);

      const rawScore = clamp(divergenceStrength * 30 + stackStrength * 18 + stackLevelStrength * 12 + deltaScore + volumeScore + keyScore + atrScore, 0, 100);

      const range = Math.max(bar.highPrice - bar.lowPrice, this.priceStep * 2);
      const entry = bar.closePrice;
      const stop = bar.lowPrice - this.priceStep * PRICE_STEP_MULTIPLIER_STOP;
      const target1 = entry + range * PRICE_STEP_MULTIPLIER_TARGET_1;
      const target2 = entry + range * PRICE_STEP_MULTIPLIER_TARGET_2;

      const evidence: SignalEvidenceItem[] = [
        { label: "Divergencia", value: `${(divergenceStrength * 100).toFixed(1)}%` },
        { label: "CumDelta", value: `${bar.cumulativeDelta.toFixed(2)} vs ${prevCumLow.toFixed(2)}` },
        { label: "Stack", value: `${stackBid.ratio.toFixed(2)}× / ${stackBid.levels}` },
      ];

      results.push({
        strategy: "delta-divergence",
        side: "long",
        rawScore,
        stackRatio: stackBid.ratio,
        stackLevels: stackBid.levels,
        deltaPercentile,
        volumePercentile,
        atrPercentile,
        keyMatch,
        keyLevelDistance: keyMatch?.distancePercent ?? null,
        entry,
        stop,
        target1,
        target2,
        evidence,
      });
    }

    return results;
  }

  private getActiveThresholds(): ActiveThresholds {
    const preset = MODE_PRESETS[this.config.mode];
    const overrides: DetectorOverrides = this.config.overrides ?? {};
    return {
      minScore: overrides.minScore ?? preset.minScore,
      stackRatio: overrides.stackRatio ?? preset.stackRatio,
      stackLevels: overrides.stackLevels ?? preset.stackLevels,
      minDeltaPercentile: overrides.minDeltaPercentile ?? preset.minDeltaPercentile,
      minVolumePercentile: overrides.minVolumePercentile ?? preset.minVolumePercentile,
      keyLevelDistancePercent: overrides.keyLevelDistancePercent ?? preset.keyLevelDistancePercent,
      requireKeyLevel: preset.requireKeyLevel,
      requireConfluence: preset.requireConfluence,
      minStrategies: preset.minStrategies,
      maxSignalsPerSession: preset.maxSignalsPerSession,
      maxSignalsPerDay: preset.maxSignalsPerDay,
      avoidLowLiquidity: preset.avoidLowLiquidity,
      atrPercentileRange: preset.atrPercentileRange,
    };
  }

  private pushHistories(absDelta: number, totalVolume: number, trueRange: number) {
    this.deltaHistory.push(absDelta);
    this.volumeHistory.push(totalVolume);
    this.atrHistory.push(trueRange);
    if (this.deltaHistory.length > PERCENTILE_LOOKBACK) {
      this.deltaHistory.shift();
    }
    if (this.volumeHistory.length > PERCENTILE_LOOKBACK) {
      this.volumeHistory.shift();
    }
    if (this.atrHistory.length > ATR_LOOKBACK) {
      this.atrHistory.shift();
    }
  }

  private updateStats(sorted: FootprintBar[]) {
    if (!sorted.length) {
      this.signalStats = {
        dailyCount: 0,
        sessionCount: {
          asia: 0,
          eu: 0,
          us: 0,
          other: 0,
        },
        estimatePerDay: 0,
        lastReset: 0,
      };
      return;
    }

    const latestBar = sorted[sorted.length - 1];
    const dayKey = getDayKey(latestBar.startTime);
    const sessionCount: Record<TradingSession, number> = {
      asia: this.sessionSignalCounts.get(`${dayKey}-asia`) ?? 0,
      eu: this.sessionSignalCounts.get(`${dayKey}-eu`) ?? 0,
      us: this.sessionSignalCounts.get(`${dayKey}-us`) ?? 0,
      other: this.sessionSignalCounts.get(`${dayKey}-other`) ?? 0,
    };

    const barsPerDay = Math.max(1, Math.round(DAY_MS / this.timeframeMs));
    const lookbackBars = Math.min(barsPerDay, sorted.length);
    const cutoffIndex = Math.max(0, sorted.length - lookbackBars);
    const cutoffTime = sorted[cutoffIndex]?.startTime ?? latestBar.startTime;
    const signalsInWindow = this.signals.filter((signal) => signal.barTime >= cutoffTime).length;
    const estimatePerDay = lookbackBars > 0 ? (signalsInWindow / lookbackBars) * barsPerDay : 0;

    this.signalStats = {
      dailyCount: this.dailySignalCounts.get(dayKey) ?? 0,
      sessionCount,
      estimatePerDay: Number.isFinite(estimatePerDay) ? Number(estimatePerDay.toFixed(2)) : 0,
      lastReset: toDayStartTimestamp(dayKey),
    };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentileRank(history: number[], value: number): number {
  if (!history.length || !Number.isFinite(value)) {
    return 0;
  }
  const lessOrEqual = history.filter((item) => item <= value).length;
  return clamp(lessOrEqual / history.length, 0, 1);
}

function computeTrueRange(bar: FootprintBar, prevClose: number | null): number {
  const highLow = bar.highPrice - bar.lowPrice;
  if (prevClose === null) {
    return Math.max(highLow, 0);
  }
  const highClose = Math.abs(bar.highPrice - prevClose);
  const lowClose = Math.abs(bar.lowPrice - prevClose);
  return Math.max(highLow, highClose, lowClose);
}

function computeStackedImbalance(
  levels: FootprintBar["levels"],
  side: "bid" | "ask",
  threshold: number,
): StackInfo {
  if (!levels.length) {
    return { levels: 0, ratio: 0, maxObservedRatio: 0, anchorPrice: null, cumulativeVolume: 0 };
  }
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  let best: StackInfo = {
    levels: 0,
    ratio: 0,
    maxObservedRatio: 0,
    anchorPrice: null,
    cumulativeVolume: 0,
  };
  let currentLevels = 0;
  let currentMinRatio = Number.POSITIVE_INFINITY;
  let currentVolume = 0;
  let currentPrices: number[] = [];
  let maxObserved = 0;

  const pushBest = () => {
    if (currentLevels === 0) {
      return;
    }
    if (currentLevels > best.levels || (currentLevels === best.levels && currentMinRatio > best.ratio)) {
      best = {
        levels: currentLevels,
        ratio: currentMinRatio,
        maxObservedRatio: Math.max(maxObserved, best.maxObservedRatio),
        anchorPrice: currentPrices.length ? currentPrices[currentPrices.length - 1] : best.anchorPrice,
        cumulativeVolume: currentVolume,
      };
    }
  };

  for (const level of sorted) {
    const ratio = side === "bid"
      ? (level.bidVol + 1e-6) / (level.askVol + 1e-6)
      : (level.askVol + 1e-6) / (level.bidVol + 1e-6);
    if (ratio > maxObserved) {
      maxObserved = ratio;
    }
    if (ratio >= threshold) {
      currentLevels += 1;
      currentMinRatio = Math.min(currentMinRatio, ratio);
      currentVolume += level.totalVolume;
      currentPrices.push(level.price);
    } else {
      pushBest();
      currentLevels = 0;
      currentMinRatio = Number.POSITIVE_INFINITY;
      currentVolume = 0;
      currentPrices = [];
    }
  }

  pushBest();

  if (best.levels === 0) {
    best.maxObservedRatio = Math.max(best.maxObservedRatio, maxObserved);
  }

  return {
    levels: best.levels,
    ratio: best.ratio || maxObserved,
    maxObservedRatio: Math.max(best.maxObservedRatio, maxObserved),
    anchorPrice: best.anchorPrice,
    cumulativeVolume: best.cumulativeVolume,
  };
}

function getDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function toDayStartTimestamp(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map((part) => Number(part));
  const date = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return date;
}

function getWeekKey(timestamp: number): string {
  const date = new Date(timestamp);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getTradingSession(timestamp: number): TradingSession {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  if (hour >= 7 && hour < 12) {
    return "eu";
  }
  if (hour >= 12 && hour < 20) {
    return "us";
  }
  if (hour >= 20 || hour < 7) {
    return "asia";
  }
  return "other";
}

function buildDayStats(bars: FootprintBar[]): Map<string, DayStats> {
  const raw = new Map<string, { high: number; low: number; volumeByPrice: Map<number, number> }>();
  for (const bar of bars) {
    const key = getDayKey(bar.startTime);
    let stats = raw.get(key);
    if (!stats) {
      stats = { high: bar.highPrice, low: bar.lowPrice, volumeByPrice: new Map() };
      raw.set(key, stats);
    } else {
      stats.high = Math.max(stats.high, bar.highPrice);
      stats.low = Math.min(stats.low, bar.lowPrice);
    }
    for (const level of bar.levels) {
      stats.volumeByPrice.set(
        level.price,
        (stats.volumeByPrice.get(level.price) ?? 0) + level.totalVolume,
      );
    }
  }

  const result = new Map<string, DayStats>();
  for (const [key, stats] of raw.entries()) {
    let poc: number | null = null;
    let maxVolume = 0;
    for (const [price, volume] of stats.volumeByPrice.entries()) {
      if (volume > maxVolume) {
        maxVolume = volume;
        poc = price;
      }
    }
    result.set(key, { high: stats.high, low: stats.low, poc });
  }
  return result;
}

function buildWeekStats(bars: FootprintBar[]): Map<string, WeekStats> {
  const map = new Map<string, WeekStats>();
  for (const bar of bars) {
    const key = getWeekKey(bar.startTime);
    const stats = map.get(key);
    if (!stats) {
      map.set(key, { high: bar.highPrice, low: bar.lowPrice });
    } else {
      stats.high = Math.max(stats.high, bar.highPrice);
      stats.low = Math.min(stats.low, bar.lowPrice);
    }
  }
  return map;
}

function collectKeyLevels(args: {
  prevDay?: DayStats;
  prevWeek?: WeekStats;
  sessionVwap: number | null;
  previousPoc: number | null;
}): KeyLevel[] {
  const levels: KeyLevel[] = [];
  if (args.prevDay) {
    levels.push({ label: "PDH", price: args.prevDay.high });
    levels.push({ label: "PDL", price: args.prevDay.low });
    if (args.prevDay.poc !== null) {
      levels.push({ label: "POC previo", price: args.prevDay.poc });
    }
  }
  if (args.prevWeek) {
    levels.push({ label: "Semanal High", price: args.prevWeek.high });
    levels.push({ label: "Semanal Low", price: args.prevWeek.low });
  }
  if (args.sessionVwap !== null && Number.isFinite(args.sessionVwap)) {
    levels.push({ label: "VWAP sesión", price: args.sessionVwap });
  }
  if (args.previousPoc !== null && Number.isFinite(args.previousPoc)) {
    levels.push({ label: "POC último", price: args.previousPoc });
  }
  return levels;
}

function findClosestKeyLevel(price: number, levels: KeyLevel[]): KeyLevelMatch | null {
  if (!levels.length) {
    return null;
  }
  let closest: KeyLevelMatch | null = null;
  for (const level of levels) {
    const distancePercent = Math.abs(price - level.price) / price * 100;
    if (!closest || distancePercent < closest.distancePercent) {
      closest = { ...level, distancePercent };
    }
  }
  return closest;
}

function computeSessionVwap(bars: FootprintBar[], index: number): number | null {
  const bar = bars[index];
  const dayKey = getDayKey(bar.startTime);
  const session = getTradingSession(bar.startTime);
  let volume = 0;
  let priceVolume = 0;
  for (let i = index; i >= 0; i -= 1) {
    const candidate = bars[i];
    if (getDayKey(candidate.startTime) !== dayKey) {
      break;
    }
    if (getTradingSession(candidate.startTime) !== session) {
      break;
    }
    const refPrice = candidate.pocPrice ?? (candidate.highPrice + candidate.lowPrice) / 2;
    volume += candidate.totalVolume;
    priceVolume += refPrice * candidate.totalVolume;
  }
  if (volume <= 0) {
    return null;
  }
  return priceVolume / volume;
}

function computePocMigration(
  bars: FootprintBar[],
  index: number,
  priceStep: number,
): PocMigration | null {
  const slice = bars.slice(Math.max(0, index - POC_LOOKBACK + 1), index + 1).filter((bar) => typeof bar.pocPrice === "number");
  if (slice.length < 3) {
    return null;
  }
  const pocPrices = slice.map((bar) => bar.pocPrice as number);
  const first = pocPrices[0];
  const last = pocPrices[pocPrices.length - 1];
  const drift = last - first;
  if (Math.abs(drift) < priceStep * 2) {
    return null;
  }
  const direction: 1 | -1 = drift > 0 ? 1 : -1;
  let aligned = true;
  for (let i = 1; i < pocPrices.length; i += 1) {
    const stepDirection = Math.sign(pocPrices[i] - pocPrices[i - 1]) || direction;
    if (stepDirection !== direction) {
      aligned = false;
      break;
    }
  }
  const steps = pocPrices.length - 1;
  const avgDelta = average(slice.map((bar) => bar.totalDelta));
  const averageDeltaSign = Math.sign(avgDelta);
  const alignedDelta = averageDeltaSign === direction || averageDeltaSign === 0;
  return {
    direction,
    drift,
    steps,
    lookback: slice.length,
    aligned: aligned && alignedDelta,
    averageDeltaSign,
  };
}

function roundToStep(price: number, step: number): number {
  if (!Number.isFinite(price) || step <= 0) {
    return price;
  }
  const rounded = Math.round(price / step) * step;
  return Number(rounded.toFixed(6));
}

function mergeEvidence(hits: StrategyHit[], keyMatch: KeyLevelMatch | null): SignalEvidenceItem[] {
  const map = new Map<string, string>();
  for (const hit of hits) {
    for (const evidence of hit.evidence) {
      if (!map.has(evidence.label)) {
        map.set(evidence.label, evidence.value);
      }
    }
  }
  if (keyMatch) {
    map.set("Nivel clave", `${keyMatch.label} (${keyMatch.distancePercent.toFixed(2)}%)`);
  }
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

function atrPercentileContribution(percentile: number, range: [number, number] | null): number {
  if (!range) {
    return 4;
  }
  const [min, max] = range;
  if (percentile >= min && percentile <= max) {
    return 6;
  }
  return Math.max(0, 6 - Math.abs(percentile - clamp((min + max) / 2, 0, 1)) * 12);
}

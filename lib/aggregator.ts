import { DepthAnalytics } from "@/lib/depth";
import { MODE_PRESETS, SignalEngine, createDefaultSignalControlState } from "@/lib/signals";
import type {
  DepthBarMetrics,
  DepthState,
  DepthStreamMessage,
  FootprintBar,
  FootprintSignal,
  FootprintState,
  HistoricalFootprintBarSeed,
  LevelBin,
  SignalControlState,
  SignalStats,
  Trade,
} from "@/types";

export interface AggregatorSettings {
  timeframeMs: number;
  priceStep: number;
  maxBars: number;
}

interface InternalLevel {
  price: number;
  askVol: number;
  bidVol: number;
  totalVolume: number;
}

interface InternalBar {
  startTime: number;
  endTime: number;
  levels: Map<number, InternalLevel>;
  totalDelta: number;
  pocPrice: number | null;
  pocVolume: number;
  totalVolume: number;
  highPrice: number;
  lowPrice: number;
  openPrice: number | null;
  closePrice: number | null;
  skeleton: boolean;
  depth?: DepthBarMetrics | null;
}

export function timeframeToMs(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    default:
      throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
}

export function precisionFromStep(step: number): number {
  const stepString = step.toString();
  if (stepString.includes("e-")) {
    const [, exponent] = stepString.split("e-");
    return parseInt(exponent ?? "0", 10);
  }

  const decimals = stepString.split(".")[1];
  return decimals ? decimals.length : 0;
}

const EPSILON = 1e-9;
const MAX_TRACKED_TRADE_IDS = 50_000;

function createInitialSignalStats(): SignalStats {
  return {
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
}

export function priceToBin(price: number, step: number, precision: number): number {
  const steps = Math.floor((price + EPSILON) / step);
  const binPrice = steps * step;
  return Number(binPrice.toFixed(precision));
}

export class FootprintAggregator {
  private settings: AggregatorSettings;

  private precision: number;

  private bars: InternalBar[] = [];

  private barMap = new Map<number, InternalBar>();

  private signals: FootprintSignal[] = [];

  private signalStats: SignalStats = createInitialSignalStats();

  private signalEngine: SignalEngine;

  private signalConfig: SignalControlState = createDefaultSignalControlState();

  private depthAnalytics: DepthAnalytics;

  private depthState: DepthState | null = null;

  private seenTradeIds = new Set<number>();

  private tradeIdQueue: number[] = [];

  private tradeIdQueueStart = 0;

  constructor(settings: AggregatorSettings) {
    this.settings = { ...settings };
    this.precision = precisionFromStep(settings.priceStep);
    this.signalEngine = new SignalEngine({
      priceStep: settings.priceStep,
      timeframeMs: settings.timeframeMs,
      config: this.signalConfig,
    });
    this.depthAnalytics = new DepthAnalytics({
      timeframeMs: settings.timeframeMs,
      priceStep: settings.priceStep,
    });
    this.applyDepthOverrides(this.signalConfig);
  }

  updateSettings(partial: Partial<AggregatorSettings>, options?: { reset?: boolean }) {
    const nextSettings = { ...this.settings, ...partial } as AggregatorSettings;
    this.settings = nextSettings;
    this.precision = precisionFromStep(nextSettings.priceStep);
    this.signalEngine.updateSettings({
      priceStep: nextSettings.priceStep,
      timeframeMs: nextSettings.timeframeMs,
    });
    this.depthAnalytics.updateSettings({
      timeframeMs: nextSettings.timeframeMs,
      priceStep: nextSettings.priceStep,
    });

    if (options?.reset) {
      this.reset();
    } else {
      this.signalEngine.reset();
      this.recomputeSignals();
    }
  }

  updateSignalConfig(partial: Partial<SignalControlState>) {
    this.signalConfig = {
      mode: partial.mode ?? this.signalConfig.mode,
      enabledStrategies: {
        ...this.signalConfig.enabledStrategies,
        ...(partial.enabledStrategies ?? {}),
      },
      overrides: {
        ...this.signalConfig.overrides,
        ...(partial.overrides ?? {}),
      },
    };
    this.signalEngine.reset();
    this.signalEngine.updateConfig(this.signalConfig);
    this.applyDepthOverrides(this.signalConfig);
    this.recomputeSignals();
  }

  reset() {
    this.bars = [];
    this.barMap.clear();
    this.signals = [];
    this.signalStats = createInitialSignalStats();
    this.signalEngine.reset();
    this.depthAnalytics.reset();
    this.depthState = null;
    this.seenTradeIds.clear();
    this.tradeIdQueue = [];
    this.tradeIdQueueStart = 0;
  }

  ingestTrades(trades: Trade[]): FootprintState {
    if (!trades.length) {
      const bars = this.recomputeSignals();
      this.depthState = this.depthAnalytics.getDepthState();
      return this.buildState(bars);
    }

    for (const trade of trades) {
      this.processTrade(trade);
    }

    this.prune();

    const bars = this.recomputeSignals();
    this.depthState = this.depthAnalytics.getDepthState();
    return this.buildState(bars);
  }

  ingestDepth(messages: DepthStreamMessage[]): FootprintState {
    if (!messages.length) {
      const bars = this.recomputeSignals();
      this.depthState = this.depthAnalytics.getDepthState();
      return this.buildState(bars);
    }

    for (const message of messages) {
      try {
        if (message.type === "snapshot") {
          this.depthAnalytics.reset();
          this.depthAnalytics.applySnapshot(message.snapshot);
        } else {
          this.depthAnalytics.applyDiff(message.diff);
        }
      } catch (error) {
        console.warn("Depth ingestion error", error);
        this.depthAnalytics.reset();
      }
    }

    this.depthState = this.depthAnalytics.getDepthState();
    const bars = this.recomputeSignals();
    return this.buildState(bars);
  }

  getState(): FootprintState {
    const bars = this.recomputeSignals();
    this.depthState = this.depthAnalytics.getDepthState();
    return this.buildState(bars);
  }

  seedSkeletonBars(seeds: HistoricalFootprintBarSeed[]) {
    if (!Array.isArray(seeds) || !seeds.length) {
      return;
    }

    const timeframeMs = this.settings.timeframeMs;
    if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) {
      return;
    }

    type NormalizedSeed = {
      startTime: number;
      endTime: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    };

    const normalized: NormalizedSeed[] = [];

    for (const seed of seeds) {
      if (!seed) {
        continue;
      }
      const startCandidate = Number(seed.startTime);
      const open = Number(seed.open);
      const highRaw = Number(seed.high);
      const lowRaw = Number(seed.low);
      const close = Number(seed.close);
      const volumeRaw = Number(seed.volume);

      if (
        !Number.isFinite(startCandidate) ||
        !Number.isFinite(open) ||
        !Number.isFinite(highRaw) ||
        !Number.isFinite(lowRaw) ||
        !Number.isFinite(close)
      ) {
        continue;
      }

      const startTime = Math.floor(Math.trunc(startCandidate) / timeframeMs) * timeframeMs;
      const endTime = startTime + timeframeMs;
      const high = Math.max(highRaw, lowRaw);
      const low = Math.min(highRaw, lowRaw);
      const volume = Number.isFinite(volumeRaw) ? Math.max(0, volumeRaw) : 0;

      normalized.push({
        startTime,
        endTime,
        open,
        high,
        low,
        close,
        volume,
      });
    }

    if (!normalized.length) {
      return;
    }

    normalized.sort((a, b) => a.startTime - b.startTime);

    this.signalEngine.reset();
    this.signals = [];
    this.signalStats = createInitialSignalStats();

    const priceStep = this.settings.priceStep;
    const precision = this.precision;
    const MAX_SKELETON_LEVELS = 3000;

    for (const item of normalized) {
      const bar = this.getOrCreateBar(item.startTime, item.endTime);
      bar.levels.clear();
      bar.totalDelta = 0;
      bar.pocPrice = null;
      bar.pocVolume = 0;
      bar.totalVolume = item.volume;
      bar.highPrice = item.high;
      bar.lowPrice = item.low;
      bar.openPrice = item.open;
      bar.closePrice = item.close;
      bar.skeleton = true;
      bar.depth = null;

      if (priceStep > 0 && Number.isFinite(item.low) && Number.isFinite(item.high) && item.high >= item.low) {
        const startPrice = item.low;
        const endPrice = item.high;
        const rawSteps = Math.max(0, Math.floor((endPrice - startPrice) / priceStep));
        const cappedSteps = Math.min(rawSteps, MAX_SKELETON_LEVELS);

        for (let index = 0; index <= cappedSteps; index += 1) {
          const price = Number((startPrice + index * priceStep).toFixed(precision));
          if (!Number.isFinite(price)) {
            continue;
          }
          bar.levels.set(price, {
            price,
            askVol: 0,
            bidVol: 0,
            totalVolume: 0,
          });
        }

        const shouldIncludeEnd = cappedSteps < rawSteps || cappedSteps === 0;
        if (shouldIncludeEnd) {
          const price = Number(endPrice.toFixed(precision));
          if (Number.isFinite(price)) {
            bar.levels.set(price, {
              price,
              askVol: 0,
              bidVol: 0,
              totalVolume: 0,
            });
          }
        }
      }
    }

    this.bars.sort((a, b) => a.startTime - b.startTime);
    this.prune();
  }

  private buildState(bars: FootprintBar[]): FootprintState {
    return {
      bars,
      signals: [...this.signals],
      signalStats: {
        dailyCount: this.signalStats.dailyCount,
        estimatePerDay: this.signalStats.estimatePerDay,
        lastReset: this.signalStats.lastReset,
        sessionCount: { ...this.signalStats.sessionCount },
      },
      depth: this.depthState,
    };
  }

  private applyDepthOverrides(config: SignalControlState) {
    try {
      const preset = MODE_PRESETS[config.mode] ?? MODE_PRESETS.conservative;
      const overrides = config.overrides ?? {};
      const toMs = (seconds: number | undefined, fallback: number) => {
        const source = Number.isFinite(seconds) ? (seconds as number) : fallback;
        return Math.max(200, Math.round(source * 1000));
      };
      const thresholds = {
        absorptionWindowMs: toMs(overrides.depthAbsorptionWindowSec, preset.depthAbsorptionWindowSec),
        absorptionMinDurationMs: toMs(overrides.depthAbsorptionMinDurationSec, preset.depthAbsorptionMinDurationSec),
        replenishmentFactor: overrides.depthReplenishFactor ?? preset.depthReplenishFactor,
        maxTickProgress: overrides.depthMaxTickProgress ?? preset.depthMaxTickProgress,
        sweepTickThreshold: overrides.depthSweepTickThreshold ?? preset.depthSweepTickThreshold,
        sweepWindowMs: toMs(overrides.depthSweepWindowSec, preset.depthSweepWindowSec),
        sweepDeltaThreshold: overrides.depthSweepDeltaThreshold ?? preset.depthSweepDeltaThreshold,
        sweepMinLevels: Math.max(1, Math.round(overrides.depthSweepMinLevels ?? preset.depthSweepMinLevels)),
        spoofWindowMs: toMs(overrides.depthSpoofWindowSec, preset.depthSpoofWindowSec),
        spoofSizeThreshold: overrides.depthSpoofSizeThreshold ?? preset.depthSpoofSizeThreshold,
      };
      this.depthAnalytics.updateThresholds(thresholds);
    } catch (error) {
      console.warn("Failed to apply depth overrides", error);
    }
  }

  private serializeBars(): FootprintBar[] {
    const bars: FootprintBar[] = [];
    let cumulative = 0;

    const sortedBars = [...this.bars].sort((a, b) => a.startTime - b.startTime);

    for (const bar of sortedBars) {
      cumulative += bar.totalDelta;
      const levels: LevelBin[] = Array.from(bar.levels.values())
        .sort((a, b) => a.price - b.price)
        .map((level) => ({
          price: level.price,
          askVol: Number(level.askVol.toFixed(6)),
          bidVol: Number(level.bidVol.toFixed(6)),
          delta: Number((level.askVol - level.bidVol).toFixed(6)),
          totalVolume: Number(level.totalVolume.toFixed(6)),
        }));

      const defaultPrice = levels.length ? levels[0].price : 0;
      const openPrice = Number.isFinite(bar.openPrice ?? NaN) ? (bar.openPrice as number) : defaultPrice;
      const closePrice = Number.isFinite(bar.closePrice ?? NaN)
        ? (bar.closePrice as number)
        : Number.isFinite(bar.openPrice ?? NaN)
          ? (bar.openPrice as number)
          : defaultPrice;
      const highPrice = Number.isFinite(bar.highPrice) ? bar.highPrice : Math.max(defaultPrice, closePrice);
      const lowPrice = Number.isFinite(bar.lowPrice) ? bar.lowPrice : Math.min(defaultPrice, closePrice);
      const depthMetrics = this.depthAnalytics.getBarMetrics(bar.startTime, {
        totalDelta: bar.totalDelta,
      });
      bar.depth = depthMetrics ?? bar.depth ?? null;

      bars.push({
        startTime: bar.startTime,
        endTime: bar.endTime,
        levels,
        pocPrice: bar.pocPrice,
        pocVolume: Number(bar.pocVolume.toFixed(6)),
        totalDelta: Number(bar.totalDelta.toFixed(6)),
        cumulativeDelta: Number(cumulative.toFixed(6)),
        totalVolume: Number(bar.totalVolume.toFixed(6)),
        highPrice: Number(highPrice.toFixed(6)),
        lowPrice: Number(lowPrice.toFixed(6)),
        openPrice: Number(openPrice.toFixed(6)),
        closePrice: Number(closePrice.toFixed(6)),
        skeleton: bar.skeleton,
        depth: bar.depth ?? null,
      });
    }

    return bars;
  }

  private recomputeSignals(): FootprintBar[] {
    const bars = this.serializeBars();
    const { signals, stats } = this.signalEngine.process(bars);
    this.signals = signals;
    this.signalStats = stats;
    return bars;
  }

  private processTrade(trade: Trade) {
    if (!this.registerTradeId(trade.tradeId)) {
      return;
    }
    this.depthAnalytics.ingestTrade(trade);

    const { timeframeMs, priceStep } = this.settings;

    const barStart = Math.floor(trade.timestamp / timeframeMs) * timeframeMs;
    const barEnd = barStart + timeframeMs;
    const bar = this.getOrCreateBar(barStart, barEnd);
    bar.skeleton = false;

    if (bar.openPrice === null) {
      bar.openPrice = trade.price;
    }
    bar.closePrice = trade.price;
    bar.highPrice = Math.max(bar.highPrice, trade.price);
    bar.lowPrice = Math.min(bar.lowPrice, trade.price);
    bar.totalVolume += trade.quantity;

    const levelPrice = priceToBin(trade.price, priceStep, this.precision);
    let level = bar.levels.get(levelPrice);

    if (!level) {
      level = {
        price: levelPrice,
        askVol: 0,
        bidVol: 0,
        totalVolume: 0,
      };
      bar.levels.set(levelPrice, level);
    }

    if (trade.isBuyerMaker) {
      level.bidVol += trade.quantity;
      bar.totalDelta -= trade.quantity;
    } else {
      level.askVol += trade.quantity;
      bar.totalDelta += trade.quantity;
    }

    level.totalVolume = level.askVol + level.bidVol;

    if (
      level.totalVolume > bar.pocVolume ||
      (level.totalVolume === bar.pocVolume &&
        level.price > (bar.pocPrice ?? Number.NEGATIVE_INFINITY))
    ) {
      bar.pocPrice = level.price;
      bar.pocVolume = level.totalVolume;
    }
  }

  private getOrCreateBar(startTime: number, endTime: number): InternalBar {
    const existing = this.barMap.get(startTime);
    if (existing) {
      return existing;
    }

    const bar: InternalBar = {
      startTime,
      endTime,
      levels: new Map(),
      totalDelta: 0,
      pocPrice: null,
      pocVolume: 0,
      totalVolume: 0,
      highPrice: Number.NEGATIVE_INFINITY,
      lowPrice: Number.POSITIVE_INFINITY,
      openPrice: null,
      closePrice: null,
      skeleton: false,
      depth: null,
    };

    this.barMap.set(startTime, bar);
    this.bars.push(bar);
    this.bars.sort((a, b) => a.startTime - b.startTime);

    return bar;
  }

  private registerTradeId(tradeId: number): boolean {
    if (!Number.isFinite(tradeId)) {
      return true;
    }
    const normalized = Math.trunc(tradeId);
    if (this.seenTradeIds.has(normalized)) {
      return false;
    }
    this.seenTradeIds.add(normalized);
    this.tradeIdQueue.push(normalized);
    this.trimTradeIdCache();
    return true;
  }

  private trimTradeIdCache() {
    while (this.tradeIdQueue.length - this.tradeIdQueueStart > MAX_TRACKED_TRADE_IDS) {
      const id = this.tradeIdQueue[this.tradeIdQueueStart];
      if (typeof id === "number") {
        this.seenTradeIds.delete(id);
      }
      this.tradeIdQueueStart += 1;
    }

    if (this.tradeIdQueueStart > 0 && this.tradeIdQueueStart * 2 > this.tradeIdQueue.length) {
      this.tradeIdQueue = this.tradeIdQueue.slice(this.tradeIdQueueStart);
      this.tradeIdQueueStart = 0;
    }
  }

  private prune() {
    const { maxBars } = this.settings;
    if (this.bars.length <= maxBars) {
      return;
    }

    const removeCount = this.bars.length - maxBars;
    const removed = this.bars.splice(0, removeCount);

    for (const bar of removed) {
      this.barMap.delete(bar.startTime);
    }
  }
}

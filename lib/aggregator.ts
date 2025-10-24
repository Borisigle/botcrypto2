import { SignalEngine, createDefaultSignalControlState } from "@/lib/signals";
import type {
  FootprintBar,
  FootprintSignal,
  FootprintState,
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

  constructor(settings: AggregatorSettings) {
    this.settings = { ...settings };
    this.precision = precisionFromStep(settings.priceStep);
    this.signalEngine = new SignalEngine({
      priceStep: settings.priceStep,
      timeframeMs: settings.timeframeMs,
      config: this.signalConfig,
    });
  }

  updateSettings(partial: Partial<AggregatorSettings>, options?: { reset?: boolean }) {
    const nextSettings = { ...this.settings, ...partial } as AggregatorSettings;
    this.settings = nextSettings;
    this.precision = precisionFromStep(nextSettings.priceStep);
    this.signalEngine.updateSettings({
      priceStep: nextSettings.priceStep,
      timeframeMs: nextSettings.timeframeMs,
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
    this.recomputeSignals();
  }

  reset() {
    this.bars = [];
    this.barMap.clear();
    this.signals = [];
    this.signalStats = createInitialSignalStats();
    this.signalEngine.reset();
  }

  ingestTrades(trades: Trade[]): FootprintState {
    if (!trades.length) {
      const bars = this.recomputeSignals();
      return this.buildState(bars);
    }

    for (const trade of trades) {
      this.processTrade(trade);
    }

    this.prune();

    const bars = this.recomputeSignals();
    return this.buildState(bars);
  }

  getState(): FootprintState {
    const bars = this.recomputeSignals();
    return this.buildState(bars);
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
    };
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
    const { timeframeMs, priceStep } = this.settings;

    const barStart = Math.floor(trade.timestamp / timeframeMs) * timeframeMs;
    const barEnd = barStart + timeframeMs;
    const bar = this.getOrCreateBar(barStart, barEnd);

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
    };

    this.barMap.set(startTime, bar);
    this.bars.push(bar);
    this.bars.sort((a, b) => a.startTime - b.startTime);

    return bar;
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

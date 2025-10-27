import type {
  DepthAbsorptionConfirmation,
  DepthBarMetrics,
  DepthDiff,
  DepthSnapshot,
  DepthSpoofingEvent,
  DepthState,
  DepthSweepEvent,
  SignalSide,
  Trade,
} from "@/types";

import { DepthOrderBook, DepthGapError, type DepthLevelChange } from "./book";

interface DepthThresholds {
  absorptionWindowMs: number;
  absorptionMinDurationMs: number;
  replenishmentFactor: number;
  maxTickProgress: number;
  sweepTickThreshold: number;
  sweepWindowMs: number;
  sweepDeltaThreshold: number;
  sweepMinLevels: number;
  spoofWindowMs: number;
  spoofSizeThreshold: number;
}

interface DepthAnalyticsOptions {
  timeframeMs: number;
  priceStep: number;
  depthLevels?: number;
  thresholds?: Partial<DepthThresholds>;
}

interface BarAccumulator {
  startTime: number;
  ofiSum: number;
  netOfi: number;
  ofiCount: number;
  maxImbalance: number;
  minImbalance: number;
  queueDeltaBid: number;
  queueDeltaAsk: number;
  maxReplenishmentBid: number;
  maxReplenishmentAsk: number;
  absorptions: DepthAbsorptionConfirmation[];
  pendingSweeps: PendingSweep[];
  spoofEvents: DepthSpoofingEvent[];
  latestBestBid: number | null;
  latestBestBidSize: number;
  latestBestAsk: number | null;
  latestBestAskSize: number;
}

interface AbsorptionTracker {
  side: SignalSide;
  price: number;
  startTime: number;
  referencePrice: number;
  initialQueue: number;
  maxQueue: number;
  tradeCount: number;
  confirmed: boolean;
  confirmedAt?: number;
  lastEventTime: number;
  replenishmentFactor: number;
}

interface SpoofCandidate {
  side: "bid" | "ask";
  price: number;
  size: number;
  addedAt: number;
}

interface PendingSweep extends DepthSweepEvent {
  requiresDelta: boolean;
  volumeRemoved: number;
}

const DEFAULT_THRESHOLDS: DepthThresholds = {
  absorptionWindowMs: 4_000,
  absorptionMinDurationMs: 1_200,
  replenishmentFactor: 1.35,
  maxTickProgress: 2,
  sweepTickThreshold: 4,
  sweepWindowMs: 1_500,
  sweepDeltaThreshold: 12,
  sweepMinLevels: 3,
  spoofWindowMs: 2_000,
  spoofSizeThreshold: 40,
};

const DEFAULT_DEPTH_LEVELS = 100;
const OFI_WINDOW_MS = 3_000;
const QUANTITY_EPSILON = 1e-9;
const SPOOF_DISTANCE_TICKS = 5;

export class DepthAnalytics {
  private readonly orderBook: DepthOrderBook;

  private timeframeMs: number;

  private priceStep: number;

  private thresholds: DepthThresholds;

  private accumulators = new Map<number, BarAccumulator>();

  private latestState: DepthState | null = null;

  private absorptionTrackers: Record<SignalSide, AbsorptionTracker | null> = {
    long: null,
    short: null,
  };

  private spoofCandidates = new Map<string, SpoofCandidate>();

  private lastTradeAtPrice = new Map<number, number>();

  private ofiWindow: Array<{ time: number; value: number }> = [];

  private lastAbsorption: DepthAbsorptionConfirmation | null = null;

  private lastSweep: DepthSweepEvent | null = null;

  private lastSpoof: DepthSpoofingEvent | null = null;

  constructor(options: DepthAnalyticsOptions) {
    this.timeframeMs = Math.max(1_000, Math.floor(options.timeframeMs));
    this.priceStep = options.priceStep > 0 ? options.priceStep : 0.5;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
    this.orderBook = new DepthOrderBook({ maxLevels: options.depthLevels ?? DEFAULT_DEPTH_LEVELS });
  }

  updateSettings(partial: { timeframeMs?: number; priceStep?: number }) {
    if (typeof partial.timeframeMs === "number" && partial.timeframeMs > 0) {
      this.timeframeMs = Math.floor(partial.timeframeMs);
    }
    if (typeof partial.priceStep === "number" && partial.priceStep > 0) {
      this.priceStep = partial.priceStep;
    }
  }

  reset() {
    this.orderBook.reset();
    this.accumulators.clear();
    this.latestState = null;
    this.absorptionTrackers.long = null;
    this.absorptionTrackers.short = null;
    this.spoofCandidates.clear();
    this.lastTradeAtPrice.clear();
    this.ofiWindow = [];
    this.lastAbsorption = null;
    this.lastSweep = null;
    this.lastSpoof = null;
  }

  updateThresholds(partial: Partial<DepthThresholds>) {
    this.thresholds = sanitizeThresholds({ ...this.thresholds, ...partial });
  }

  applySnapshot(snapshot: DepthSnapshot) {
    this.orderBook.applySnapshot(snapshot);
    this.latestState = null;
    this.absorptionTrackers.long = null;
    this.absorptionTrackers.short = null;
    this.updateState(snapshot.timestamp ?? Date.now());
  }

  applyDiff(diff: DepthDiff) {
    const eventTime = Number.isFinite(diff.eventTime) ? diff.eventTime : Date.now();
    const barStart = this.resolveBarStart(eventTime);
    const accumulator = this.getAccumulator(barStart);

    const prevBestBid = this.orderBook.getBestBid();
    const prevBestAsk = this.orderBook.getBestAsk();

    let changes: DepthLevelChange[] = [];
    try {
      changes = this.orderBook.applyDiff(diff);
    } catch (error) {
      if (error instanceof DepthGapError) {
        // Surface the error to allow caller to resync.
        throw error;
      }
      console.warn("DepthAnalytics: failed to apply diff", error);
      return;
    }

    const nextBestBid = this.orderBook.getBestBid();
    const nextBestAsk = this.orderBook.getBestAsk();

    const ofiDelta = computeOfiDelta(changes);
    if (ofiDelta !== 0) {
      this.pushOfiSample(eventTime, ofiDelta);
    }
    accumulator.ofiSum += ofiDelta;
    accumulator.netOfi += ofiDelta;
    accumulator.ofiCount += 1;

    const bidSize = nextBestBid?.quantity ?? 0;
    const askSize = nextBestAsk?.quantity ?? 0;
    const imbalance = computeImbalance(bidSize, askSize);
    accumulator.maxImbalance = Math.max(accumulator.maxImbalance, imbalance);
    accumulator.minImbalance = Math.min(accumulator.minImbalance, imbalance);

    accumulator.queueDeltaBid += sumChanges(changes, "bid");
    accumulator.queueDeltaAsk += sumChanges(changes, "ask");

    if (prevBestBid && bidSize > QUANTITY_EPSILON && prevBestBid.quantity > QUANTITY_EPSILON) {
      const ratio = bidSize / prevBestBid.quantity;
      accumulator.maxReplenishmentBid = Math.max(accumulator.maxReplenishmentBid, ratio);
    }
    if (prevBestAsk && askSize > QUANTITY_EPSILON && prevBestAsk.quantity > QUANTITY_EPSILON) {
      const ratio = askSize / prevBestAsk.quantity;
      accumulator.maxReplenishmentAsk = Math.max(accumulator.maxReplenishmentAsk, ratio);
    }

    accumulator.latestBestBid = nextBestBid?.price ?? accumulator.latestBestBid;
    accumulator.latestBestBidSize = bidSize;
    accumulator.latestBestAsk = nextBestAsk?.price ?? accumulator.latestBestAsk;
    accumulator.latestBestAskSize = askSize;

    this.processAbsorption({
      eventTime,
      accumulator,
      nextBestBid,
      nextBestAsk,
    });

    this.processSweep({
      eventTime,
      accumulator,
      prevBestBid,
      prevBestAsk,
      nextBestBid,
      nextBestAsk,
      changes,
    });

    this.processSpoof({
      eventTime,
      accumulator,
      changes,
      nextBestBid,
      nextBestAsk,
    });

    this.updateState(eventTime);
  }

  ingestTrade(trade: Trade) {
    const timestamp = Number.isFinite(trade.timestamp) ? trade.timestamp : Date.now();
    const side: SignalSide = trade.isBuyerMaker ? "long" : "short";
    const bestLevel = side === "long" ? this.orderBook.getBestBid() : this.orderBook.getBestAsk();
    if (!bestLevel) {
      return;
    }

    const tickDistance = Math.abs(trade.price - bestLevel.price) / this.priceStep;
    if (!Number.isFinite(tickDistance) || tickDistance > this.thresholds.maxTickProgress + 0.5) {
      return;
    }

    const tracker = this.absorptionTrackers[side];
    if (!tracker || timestamp - tracker.startTime > this.thresholds.absorptionWindowMs) {
      this.absorptionTrackers[side] = {
        side,
        price: trade.price,
        startTime: timestamp,
        referencePrice: bestLevel.price,
        initialQueue: Math.max(bestLevel.quantity, QUANTITY_EPSILON),
        maxQueue: bestLevel.quantity,
        tradeCount: 1,
        confirmed: false,
        lastEventTime: timestamp,
        replenishmentFactor: 1,
      };
    } else {
      tracker.price = trade.price;
      tracker.tradeCount += 1;
      tracker.lastEventTime = timestamp;
      tracker.maxQueue = Math.max(tracker.maxQueue, bestLevel.quantity);
    }

    const roundedPrice = roundPrice(trade.price, this.priceStep);
    this.lastTradeAtPrice.set(roundedPrice, timestamp);
    if (this.lastTradeAtPrice.size > 400) {
      this.pruneTradeCache(timestamp);
    }
  }

  getDepthState(): DepthState | null {
    return this.latestState;
  }

  getBarMetrics(startTime: number, context: { totalDelta: number }): DepthBarMetrics | null {
    const accumulator = this.accumulators.get(startTime);
    if (!accumulator) {
      return null;
    }
    this.accumulators.delete(startTime);

    const avgOfi = accumulator.ofiCount ? accumulator.ofiSum / accumulator.ofiCount : 0;
    const maxImbalance = accumulator.maxImbalance === Number.NEGATIVE_INFINITY ? 0 : clamp(accumulator.maxImbalance, -1, 1);
    const minImbalance = accumulator.minImbalance === Number.POSITIVE_INFINITY ? 0 : clamp(accumulator.minImbalance, -1, 1);
    const deltaMagnitude = Math.abs(context.totalDelta);

    const sweeps: DepthSweepEvent[] = [];
    for (const pending of accumulator.pendingSweeps) {
      if (pending.requiresDelta) {
        if (deltaMagnitude >= this.thresholds.sweepDeltaThreshold) {
          sweeps.push({
            direction: pending.direction,
            levelsCleared: Math.max(pending.levelsCleared, this.thresholds.sweepMinLevels),
            priceMoveTicks: pending.priceMoveTicks,
            deltaSpike: deltaMagnitude,
            detectedAt: pending.detectedAt,
          });
        }
      } else {
        sweeps.push({
          direction: pending.direction,
          levelsCleared: Math.max(pending.levelsCleared, this.thresholds.sweepMinLevels),
          priceMoveTicks: pending.priceMoveTicks,
          deltaSpike: deltaMagnitude,
          detectedAt: pending.detectedAt,
        });
      }
    }

    const metrics: DepthBarMetrics = {
      avgOfi,
      netOfi: accumulator.netOfi,
      maxImbalance,
      minImbalance,
      bestBid: accumulator.latestBestBid,
      bestAsk: accumulator.latestBestAsk,
      bestBidSize: accumulator.latestBestBidSize,
      bestAskSize: accumulator.latestBestAskSize,
      queueDeltaBid: accumulator.queueDeltaBid,
      queueDeltaAsk: accumulator.queueDeltaAsk,
      maxReplenishmentBid: accumulator.maxReplenishmentBid,
      maxReplenishmentAsk: accumulator.maxReplenishmentAsk,
      absorptions: accumulator.absorptions,
      sweeps,
      spoofEvents: accumulator.spoofEvents,
    };

    return metrics;
  }

  private resolveBarStart(time: number): number {
    const safe = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : Date.now();
    return Math.floor(safe / this.timeframeMs) * this.timeframeMs;
  }

  private getAccumulator(startTime: number): BarAccumulator {
    const existing = this.accumulators.get(startTime);
    if (existing) {
      return existing;
    }
    const accumulator: BarAccumulator = {
      startTime,
      ofiSum: 0,
      netOfi: 0,
      ofiCount: 0,
      maxImbalance: Number.NEGATIVE_INFINITY,
      minImbalance: Number.POSITIVE_INFINITY,
      queueDeltaBid: 0,
      queueDeltaAsk: 0,
      maxReplenishmentBid: 1,
      maxReplenishmentAsk: 1,
      absorptions: [],
      pendingSweeps: [],
      spoofEvents: [],
      latestBestBid: null,
      latestBestBidSize: 0,
      latestBestAsk: null,
      latestBestAskSize: 0,
    };
    this.accumulators.set(startTime, accumulator);
    return accumulator;
  }

  private processAbsorption(params: {
    eventTime: number;
    accumulator: BarAccumulator;
    nextBestBid: { price: number; quantity: number } | null;
    nextBestAsk: { price: number; quantity: number } | null;
  }) {
    const { eventTime, accumulator, nextBestBid, nextBestAsk } = params;

    for (const side of ["long", "short"] as const) {
      const tracker = this.absorptionTrackers[side];
      if (!tracker) {
        continue;
      }
      const best = side === "long" ? nextBestBid : nextBestAsk;
      if (!best) {
        this.finalizeAbsorption(tracker, eventTime, accumulator, tracker.confirmed ? "confirmed" : "rejected");
        this.absorptionTrackers[side] = null;
        continue;
      }

      tracker.replenishmentFactor = Math.max(
        tracker.replenishmentFactor,
        tracker.initialQueue > QUANTITY_EPSILON ? best.quantity / tracker.initialQueue : 0,
      );
      tracker.maxQueue = Math.max(tracker.maxQueue, best.quantity);
      tracker.lastEventTime = eventTime;

      const priceMoveTicks = Math.abs(best.price - tracker.referencePrice) / this.priceStep;
      const elapsed = eventTime - tracker.startTime;

      if (!tracker.confirmed && tracker.replenishmentFactor >= this.thresholds.replenishmentFactor) {
        tracker.confirmed = true;
        tracker.confirmedAt = eventTime;
      }

      if (priceMoveTicks > this.thresholds.maxTickProgress + 0.001) {
        this.finalizeAbsorption(tracker, eventTime, accumulator, tracker.confirmed ? "confirmed" : "rejected");
        this.absorptionTrackers[side] = null;
        continue;
      }

      if (elapsed > this.thresholds.absorptionWindowMs) {
        this.finalizeAbsorption(tracker, eventTime, accumulator, tracker.confirmed ? "confirmed" : "rejected");
        this.absorptionTrackers[side] = null;
        continue;
      }

      if (tracker.confirmed && elapsed >= this.thresholds.absorptionMinDurationMs) {
        this.finalizeAbsorption(tracker, eventTime, accumulator, "confirmed");
        this.absorptionTrackers[side] = null;
      }
    }
  }

  private finalizeAbsorption(
    tracker: AbsorptionTracker,
    eventTime: number,
    accumulator: BarAccumulator,
    status: "confirmed" | "rejected",
  ) {
    const confirmedAt = tracker.confirmedAt ?? eventTime;
    const duration = Math.max(0, confirmedAt - tracker.startTime);
    const averageOfi = accumulator.ofiCount ? accumulator.ofiSum / accumulator.ofiCount : 0;
    const record: DepthAbsorptionConfirmation = {
      side: tracker.side,
      price: tracker.price,
      startTime: tracker.startTime,
      confirmedAt,
      durationMs: duration,
      replenishmentFactor: tracker.replenishmentFactor,
      ofi: averageOfi,
      status,
      tradeCount: tracker.tradeCount,
    };
    accumulator.absorptions.push(record);
    this.lastAbsorption = record;
  }

  private processSweep(params: {
    eventTime: number;
    accumulator: BarAccumulator;
    prevBestBid: { price: number; quantity: number } | null;
    prevBestAsk: { price: number; quantity: number } | null;
    nextBestBid: { price: number; quantity: number } | null;
    nextBestAsk: { price: number; quantity: number } | null;
    changes: DepthLevelChange[];
  }) {
    const { eventTime, accumulator, prevBestBid, prevBestAsk, nextBestBid, nextBestAsk, changes } = params;
    const tickThreshold = this.thresholds.sweepTickThreshold;
    if (tickThreshold <= 0) {
      return;
    }

    if (prevBestBid && nextBestBid) {
      const priceDropTicks = (prevBestBid.price - nextBestBid.price) / this.priceStep;
      if (priceDropTicks >= tickThreshold) {
        const pending: PendingSweep = {
          direction: "down",
          levelsCleared: Math.round(Math.max(priceDropTicks, this.thresholds.sweepMinLevels)),
          priceMoveTicks: Math.round(priceDropTicks),
          deltaSpike: 0,
          detectedAt: eventTime,
          requiresDelta: true,
          volumeRemoved: computeRemovedVolume(changes, "bid", nextBestBid.price),
        };
        accumulator.pendingSweeps.push(pending);
        this.lastSweep = pending;
      }
    }

    if (prevBestAsk && nextBestAsk) {
      const priceLiftTicks = (nextBestAsk.price - prevBestAsk.price) / this.priceStep;
      if (priceLiftTicks >= tickThreshold) {
        const pending: PendingSweep = {
          direction: "up",
          levelsCleared: Math.round(Math.max(priceLiftTicks, this.thresholds.sweepMinLevels)),
          priceMoveTicks: Math.round(priceLiftTicks),
          deltaSpike: 0,
          detectedAt: eventTime,
          requiresDelta: true,
          volumeRemoved: computeRemovedVolume(changes, "ask", nextBestAsk.price),
        };
        accumulator.pendingSweeps.push(pending);
        this.lastSweep = pending;
      }
    }
  }

  private processSpoof(params: {
    eventTime: number;
    accumulator: BarAccumulator;
    changes: DepthLevelChange[];
    nextBestBid: { price: number; quantity: number } | null;
    nextBestAsk: { price: number; quantity: number } | null;
  }) {
    const { eventTime, accumulator, changes, nextBestBid, nextBestAsk } = params;
    if (this.thresholds.spoofSizeThreshold <= 0) {
      return;
    }

    const bestBidPrice = nextBestBid?.price ?? null;
    const bestAskPrice = nextBestAsk?.price ?? null;

    for (const change of changes) {
      const delta = change.currentQuantity - change.previousQuantity;
      const key = `${change.side}:${change.price}`;

      if (delta > this.thresholds.spoofSizeThreshold) {
        const distanceTicks = computeDistanceTicks(change.side, change.price, bestBidPrice, bestAskPrice, this.priceStep);
        if (distanceTicks !== null && distanceTicks <= SPOOF_DISTANCE_TICKS) {
          this.spoofCandidates.set(key, {
            side: change.side,
            price: change.price,
            size: change.currentQuantity,
            addedAt: eventTime,
          });
        }
        continue;
      }

      if (delta < -this.thresholds.spoofSizeThreshold) {
        const candidate = this.spoofCandidates.get(key);
        if (!candidate) {
          continue;
        }
        const elapsed = eventTime - candidate.addedAt;
        if (elapsed > this.thresholds.spoofWindowMs) {
          this.spoofCandidates.delete(key);
          continue;
        }
        const roundedPrice = roundPrice(change.price, this.priceStep);
        const lastTrade = this.lastTradeAtPrice.get(roundedPrice) ?? 0;
        if (eventTime - lastTrade <= this.thresholds.spoofWindowMs * 0.6) {
          this.spoofCandidates.delete(key);
          continue;
        }
        const event: DepthSpoofingEvent = {
          side: change.side,
          price: change.price,
          size: candidate.size,
          addedAt: candidate.addedAt,
          cancelledAt: eventTime,
        };
        accumulator.spoofEvents.push(event);
        this.lastSpoof = event;
        this.spoofCandidates.delete(key);
      }
    }

    for (const [key, candidate] of this.spoofCandidates.entries()) {
      if (eventTime - candidate.addedAt > this.thresholds.spoofWindowMs * 2) {
        this.spoofCandidates.delete(key);
      }
    }
  }

  private pushOfiSample(time: number, value: number) {
    this.ofiWindow.push({ time, value });
    this.sweepOfiWindow(time);
  }

  private sweepOfiWindow(time: number) {
    const cutoff = time - OFI_WINDOW_MS;
    while (this.ofiWindow.length && this.ofiWindow[0].time < cutoff) {
      this.ofiWindow.shift();
    }
  }

  private getCurrentOfi(time: number): number {
    this.sweepOfiWindow(time);
    let total = 0;
    for (const sample of this.ofiWindow) {
      total += sample.value;
    }
    return total;
  }

  private pruneTradeCache(now: number) {
    const expiry = this.thresholds.spoofWindowMs * 3;
    for (const [price, timestamp] of this.lastTradeAtPrice.entries()) {
      if (now - timestamp > expiry) {
        this.lastTradeAtPrice.delete(price);
      }
    }
  }

  private updateState(eventTime: number) {
    const bestBid = this.orderBook.getBestBid();
    const bestAsk = this.orderBook.getBestAsk();
    const bids = this.orderBook.getLevels("bid", 20);
    const asks = this.orderBook.getLevels("ask", 20);
    const ofi = this.getCurrentOfi(eventTime);

    const pendingAbsorptions: DepthAbsorptionConfirmation[] = [];
    for (const side of ["long", "short"] as const) {
      const tracker = this.absorptionTrackers[side];
      if (!tracker) {
        continue;
      }
      pendingAbsorptions.push({
        side,
        price: tracker.price,
        startTime: tracker.startTime,
        confirmedAt: tracker.confirmedAt ?? tracker.startTime,
        durationMs: Math.max(0, eventTime - tracker.startTime),
        replenishmentFactor: tracker.replenishmentFactor,
        ofi,
        status: tracker.confirmed ? "confirmed" : "pending",
        tradeCount: tracker.tradeCount,
      });
    }

    this.latestState = {
      timestamp: eventTime,
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      bestBidSize: bestBid?.quantity ?? 0,
      bestAskSize: bestAsk?.quantity ?? 0,
      spread: bestBid && bestAsk ? bestAsk.price - bestBid.price : null,
      imbalance: computeImbalance(bestBid?.quantity ?? 0, bestAsk?.quantity ?? 0),
      ofi,
      bids,
      asks,
      pendingAbsorptions,
      lastAbsorption: this.lastAbsorption,
      lastSweep: this.lastSweep,
      lastSpoof: this.lastSpoof,
    };
  }
}

function computeOfiDelta(changes: DepthLevelChange[]): number {
  let total = 0;
  for (const change of changes) {
    const diff = change.currentQuantity - change.previousQuantity;
    if (!Number.isFinite(diff) || Math.abs(diff) < QUANTITY_EPSILON) {
      continue;
    }
    total += change.side === "bid" ? diff : -diff;
  }
  return total;
}

function sumChanges(changes: DepthLevelChange[], side: "bid" | "ask"): number {
  let total = 0;
  for (const change of changes) {
    if (change.side !== side) {
      continue;
    }
    total += change.currentQuantity - change.previousQuantity;
  }
  return total;
}

function computeImbalance(bidSize: number, askSize: number): number {
  const total = bidSize + askSize;
  if (total <= QUANTITY_EPSILON) {
    return 0;
  }
  return clamp((bidSize - askSize) / total, -1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sanitizeThresholds(thresholds: DepthThresholds): DepthThresholds {
  return {
    absorptionWindowMs: clamp(Math.floor(thresholds.absorptionWindowMs), 500, 20_000),
    absorptionMinDurationMs: clamp(Math.floor(thresholds.absorptionMinDurationMs), 250, 10_000),
    replenishmentFactor: Math.max(thresholds.replenishmentFactor, 1.05),
    maxTickProgress: Math.max(thresholds.maxTickProgress, 1),
    sweepTickThreshold: Math.max(thresholds.sweepTickThreshold, 2),
    sweepWindowMs: clamp(Math.floor(thresholds.sweepWindowMs), 200, 5_000),
    sweepDeltaThreshold: Math.max(thresholds.sweepDeltaThreshold, 5),
    sweepMinLevels: Math.max(Math.floor(thresholds.sweepMinLevels), 1),
    spoofWindowMs: clamp(Math.floor(thresholds.spoofWindowMs), 500, 5_000),
    spoofSizeThreshold: Math.max(thresholds.spoofSizeThreshold, 5),
  };
}

function computeRemovedVolume(changes: DepthLevelChange[], side: "bid" | "ask", pivotPrice: number): number {
  let total = 0;
  for (const change of changes) {
    if (change.side !== side) {
      continue;
    }
    const removal = change.previousQuantity - change.currentQuantity;
    if (removal <= QUANTITY_EPSILON) {
      continue;
    }
    if (side === "bid") {
      if (change.price >= pivotPrice - QUANTITY_EPSILON) {
        total += removal;
      }
    } else if (change.price <= pivotPrice + QUANTITY_EPSILON) {
      total += removal;
    }
  }
  return total;
}

function computeDistanceTicks(
  side: "bid" | "ask",
  price: number,
  bestBid: number | null,
  bestAsk: number | null,
  step: number,
): number | null {
  if (side === "bid") {
    if (!Number.isFinite(price) || bestBid === null) {
      return null;
    }
    return Math.abs(bestBid - price) / step;
  }
  if (!Number.isFinite(price) || bestAsk === null) {
    return null;
  }
  return Math.abs(price - bestAsk) / step;
}

function roundPrice(price: number, step: number): number {
  if (!Number.isFinite(price) || step <= 0) {
    return Number(price.toFixed(6));
  }
  const multiplier = Math.round(price / step);
  return Number((multiplier * step).toFixed(6));
}

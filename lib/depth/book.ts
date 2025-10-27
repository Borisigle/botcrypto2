import type { DepthDiff, DepthLevel, DepthSnapshot } from "@/types";

export interface DepthOrderBookOptions {
  maxLevels?: number;
}

export interface DepthLevelChange {
  side: "bid" | "ask";
  price: number;
  previousQuantity: number;
  currentQuantity: number;
}

export class DepthGapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepthGapError";
  }
}

const DEFAULT_MAX_LEVELS = 100;
const QUANTITY_EPSILON = 1e-9;

export class DepthOrderBook {
  private readonly maxLevels: number;

  private bids = new Map<number, number>();

  private asks = new Map<number, number>();

  private lastUpdateId = 0;

  private bidsCache: DepthLevel[] = [];

  private asksCache: DepthLevel[] = [];

  private bidsDirty = true;

  private asksDirty = true;

  constructor(options?: DepthOrderBookOptions) {
    const limit = options?.maxLevels ?? DEFAULT_MAX_LEVELS;
    this.maxLevels = Math.max(1, Math.floor(limit));
  }

  getLastUpdateId(): number {
    return this.lastUpdateId;
  }

  setLastUpdateId(id: number) {
    if (Number.isFinite(id) && id > 0) {
      this.lastUpdateId = Math.trunc(id);
    }
  }

  reset() {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = 0;
    this.bidsCache = [];
    this.asksCache = [];
    this.bidsDirty = true;
    this.asksDirty = true;
  }

  applySnapshot(snapshot: DepthSnapshot) {
    this.reset();
    this.lastUpdateId = Math.trunc(snapshot.lastUpdateId);

    for (const level of snapshot.bids) {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity)) {
        continue;
      }
      if (level.quantity <= QUANTITY_EPSILON) {
        continue;
      }
      this.bids.set(level.price, level.quantity);
    }

    for (const level of snapshot.asks) {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity)) {
        continue;
      }
      if (level.quantity <= QUANTITY_EPSILON) {
        continue;
      }
      this.asks.set(level.price, level.quantity);
    }

    this.trim("bid");
    this.trim("ask");
    this.bidsDirty = true;
    this.asksDirty = true;
  }

  applyDiff(diff: DepthDiff): DepthLevelChange[] {
    if (!Number.isFinite(diff.finalUpdateId)) {
      return [];
    }

    const finalId = Math.trunc(diff.finalUpdateId);
    const firstId = Math.trunc(diff.firstUpdateId);

    if (this.lastUpdateId > 0 && firstId > this.lastUpdateId + 1) {
      throw new DepthGapError(
        `Depth gap detected: expected ${this.lastUpdateId + 1}, received ${firstId}`,
      );
    }

    if (finalId <= this.lastUpdateId) {
      return [];
    }

    const changes: DepthLevelChange[] = [];

    for (const level of diff.bids) {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity)) {
        continue;
      }
      const price = level.price;
      const previous = this.bids.get(price) ?? 0;
      const quantity = level.quantity;

      if (quantity <= QUANTITY_EPSILON) {
        if (previous > QUANTITY_EPSILON) {
          this.bids.delete(price);
          changes.push({ side: "bid", price, previousQuantity: previous, currentQuantity: 0 });
        }
      } else {
        this.bids.set(price, quantity);
        changes.push({ side: "bid", price, previousQuantity: previous, currentQuantity: quantity });
      }
    }

    for (const level of diff.asks) {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity)) {
        continue;
      }
      const price = level.price;
      const previous = this.asks.get(price) ?? 0;
      const quantity = level.quantity;

      if (quantity <= QUANTITY_EPSILON) {
        if (previous > QUANTITY_EPSILON) {
          this.asks.delete(price);
          changes.push({ side: "ask", price, previousQuantity: previous, currentQuantity: 0 });
        }
      } else {
        this.asks.set(price, quantity);
        changes.push({ side: "ask", price, previousQuantity: previous, currentQuantity: quantity });
      }
    }

    this.lastUpdateId = finalId;
    this.trim("bid");
    this.trim("ask");
    if (changes.some((change) => change.side === "bid")) {
      this.bidsDirty = true;
    }
    if (changes.some((change) => change.side === "ask")) {
      this.asksDirty = true;
    }

    return changes;
  }

  getBestBid(): DepthLevel | null {
    const [level] = this.getLevels("bid", 1);
    return level ?? null;
  }

  getBestAsk(): DepthLevel | null {
    const [level] = this.getLevels("ask", 1);
    return level ?? null;
  }

  getLevels(side: "bid" | "ask", depth = this.maxLevels): DepthLevel[] {
    this.ensureCache(side);
    const cache = side === "bid" ? this.bidsCache : this.asksCache;
    if (!cache.length) {
      return [];
    }
    return cache.slice(0, Math.min(depth, cache.length));
  }

  getQuantity(side: "bid" | "ask", price: number): number {
    const map = side === "bid" ? this.bids : this.asks;
    return map.get(price) ?? 0;
  }

  private ensureCache(side: "bid" | "ask") {
    if (side === "bid" ? this.bidsDirty : this.asksDirty) {
      this.rebuild(side);
    }
  }

  private rebuild(side: "bid" | "ask") {
    const map = side === "bid" ? this.bids : this.asks;
    const entries: DepthLevel[] = [];

    for (const [price, quantity] of map.entries()) {
      if (quantity <= QUANTITY_EPSILON) {
        continue;
      }
      entries.push({ price, quantity });
    }

    entries.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));

    const limited = entries.slice(0, this.maxLevels);
    if (side === "bid") {
      this.bidsCache = limited;
      this.bidsDirty = false;
    } else {
      this.asksCache = limited;
      this.asksDirty = false;
    }
  }

  private trim(side: "bid" | "ask") {
    const map = side === "bid" ? this.bids : this.asks;
    if (map.size <= this.maxLevels) {
      return;
    }

    const sorted = Array.from(map.entries()).sort((a, b) =>
      side === "bid" ? b[0] - a[0] : a[0] - b[0],
    );
    for (let index = this.maxLevels; index < sorted.length; index += 1) {
      const [price] = sorted[index];
      map.delete(price);
    }
    if (side === "bid") {
      this.bidsDirty = true;
    } else {
      this.asksDirty = true;
    }
  }
}

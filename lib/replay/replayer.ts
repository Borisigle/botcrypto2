import { inflate } from "pako";

import type {
  RecordingChunkMeta,
  RecordingDatasetSummary,
  ReplaySpeed,
  ReplayStatus,
  Trade,
} from "@/types";

import type { RecorderStorage } from "./storage";

const decoder = new TextDecoder();

export interface ReplayCallbacks {
  onTrade: (trade: Trade) => void;
  onProgress?: (progress: number) => void;
  onComplete?: () => void;
  onStatusChange?: (status: ReplayStatus) => void;
  onError?: (error: Error) => void;
}

export interface ReplayStartOptions extends ReplayCallbacks {
  speed?: ReplaySpeed;
  accelerated?: boolean;
}

const DEFAULT_SPEED: ReplaySpeed = 1;
const DEFAULT_TICK_INTERVAL = 16;

export class AggTradeReplayer {
  private readonly storage: RecorderStorage;

  private dataset: RecordingDatasetSummary | null = null;

  private chunks: RecordingChunkMeta[] = [];

  private chunkIndex = 0;

  private buffer: Trade[] = [];

  private status: ReplayStatus = "idle";

  private speed: number = DEFAULT_SPEED;

  private startWallClock = 0;

  private baseTimestamp = 0;

  private lastDeliveredTimestamp = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private callbacks: Required<ReplayCallbacks> = {
    onTrade: () => {},
    onProgress: () => {},
    onComplete: () => {},
    onStatusChange: () => {},
    onError: () => {},
  };

  private accelerated = false;

  constructor(storage: RecorderStorage) {
    this.storage = storage;
  }

  getStatus(): ReplayStatus {
    return this.status;
  }

  getDataset(): RecordingDatasetSummary | null {
    return this.dataset ? { ...this.dataset } : null;
  }

  async start(datasetId: string, options: ReplayStartOptions): Promise<void> {
    await this.stop();

    this.speed = options.speed ?? DEFAULT_SPEED;
    this.accelerated = Boolean(options.accelerated);
    this.callbacks = {
      onTrade: options.onTrade,
      onProgress: options.onProgress ?? (() => {}),
      onComplete: options.onComplete ?? (() => {}),
      onStatusChange: options.onStatusChange ?? (() => {}),
      onError: options.onError ?? (() => {}),
    };

    try {
      this.dataset = await this.storage.getDataset(datasetId);
      if (!this.dataset) {
        throw new Error("Replay dataset not found");
      }
      this.chunks = await this.storage.listChunks(datasetId);
      this.chunkIndex = 0;
      this.buffer = [];
      this.lastDeliveredTimestamp = this.dataset.startTime ?? 0;
      await this.loadNextChunk();

      if (!this.buffer.length) {
        this.reportProgress(1);
        this.setStatus("complete");
        this.callbacks.onComplete();
        return;
      }

      this.baseTimestamp =
        this.buffer[0]?.timestamp ?? this.dataset.startTime ?? 0;
      this.lastDeliveredTimestamp = this.baseTimestamp;
      this.startWallClock = now();
      this.reportProgress(0);
      this.setStatus("playing");

      if (this.accelerated) {
        await this.runAccelerated();
      } else {
        this.scheduleTick();
      }
    } catch (error) {
      this.setStatus("error");
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.chunks = [];
    this.chunkIndex = 0;
    this.dataset = null;
    this.setStatus("idle");
  }

  async pause(): Promise<void> {
    if (this.status !== "playing") {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setStatus("paused");
  }

  async resume(): Promise<void> {
    if (!this.dataset || this.status !== "paused") {
      return;
    }
    this.startWallClock = now();
    this.setStatus("playing");
    if (this.accelerated) {
      await this.runAccelerated();
    } else {
      this.scheduleTick();
    }
  }

  setSpeed(speed: ReplaySpeed): void {
    if (!this.dataset) {
      return;
    }
    if (speed <= 0) {
      return;
    }
    const wallNow = now();
    const elapsedSim = this.lastDeliveredTimestamp - this.baseTimestamp;
    this.speed = speed;
    this.startWallClock = wallNow - elapsedSim / this.speed;
  }

  private async runAccelerated(): Promise<void> {
    while (this.status === "playing") {
      if (!this.buffer.length) {
        const loaded = await this.loadNextChunk();
        if (!loaded) {
          break;
        }
        continue;
      }
      const trade = this.buffer.shift()!;
      this.deliverTrade(trade);
    }

    if (this.status === "playing") {
      this.finish();
    }
  }

  private scheduleTick(): void {
    if (this.status !== "playing") {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, DEFAULT_TICK_INTERVAL);
  }

  private async tick(): Promise<void> {
    if (this.status !== "playing") {
      return;
    }

    if (!this.buffer.length) {
      const loaded = await this.loadNextChunk();
      if (!loaded && !this.buffer.length) {
        this.finish();
        return;
      }
    }

    if (!this.buffer.length) {
      this.scheduleTick();
      return;
    }

    const targetTimestamp = this.computeTargetTimestamp();
    let delivered = 0;

    while (this.buffer.length) {
      const trade = this.buffer[0];
      if (trade.timestamp > targetTimestamp) {
        break;
      }
      this.buffer.shift();
      this.deliverTrade(trade);
      delivered += 1;
    }

    if (!this.buffer.length && this.chunkIndex >= this.chunks.length) {
      this.finish();
      return;
    }

    if (!delivered) {
      // Nothing dispatched, widen wait to reduce CPU.
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, DEFAULT_TICK_INTERVAL);
      return;
    }

    this.scheduleTick();
  }

  private computeTargetTimestamp(): number {
    const wallNow = now();
    const elapsedWall = wallNow - this.startWallClock;
    const elapsedSim = elapsedWall * this.speed;
    return this.baseTimestamp + elapsedSim;
  }

  private deliverTrade(trade: Trade) {
    this.callbacks.onTrade(trade);
    this.lastDeliveredTimestamp = trade.timestamp;
    this.reportProgress();
  }

  private reportProgress(explicit?: number) {
    if (!this.dataset) {
      return;
    }
    if (typeof explicit === "number") {
      this.callbacks.onProgress(Math.max(0, Math.min(1, explicit)));
      return;
    }

    const duration = this.dataset.durationMs ?? 0;
    if (duration <= 0) {
      // Fallback to trade-based progress
      const remainingChunks = this.chunks.length - this.chunkIndex;
      const denominator = Math.max(this.dataset.chunkCount || 1, 1);
      const approx = 1 - remainingChunks / denominator;
      this.callbacks.onProgress(Math.max(0, Math.min(1, approx)));
      return;
    }

    const startTime = this.dataset.startTime ?? this.baseTimestamp;
    const elapsed = Math.max(0, this.lastDeliveredTimestamp - startTime);
    const progress =
      duration > 0 ? Math.min(1, elapsed / Math.max(duration, 1)) : 1;
    this.callbacks.onProgress(progress);
  }

  private setStatus(status: ReplayStatus) {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private async loadNextChunk(): Promise<boolean> {
    if (this.chunkIndex >= this.chunks.length) {
      return false;
    }
    const meta = this.chunks[this.chunkIndex];
    this.chunkIndex += 1;
    const payload = await this.storage.getChunkData(meta.id);
    if (!payload) {
      return false;
    }
    try {
      const trades = decodeChunk(payload, meta);
      if (trades.length) {
        this.buffer.push(...trades);
        if (!this.baseTimestamp) {
          this.baseTimestamp = trades[0].timestamp;
        }
        return true;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError(err);
    }
    return false;
  }

  private finish() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reportProgress(1);
    this.setStatus("complete");
    this.callbacks.onComplete();
  }
}

function decodeChunk(payload: Uint8Array, meta: RecordingChunkMeta): Trade[] {
  const bytes = meta.compressed ? inflate(payload) : payload;
  const text = decoder.decode(bytes);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const trades: Trade[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const trade = normalizeTrade(parsed);
      if (trade) {
        trades.push(trade);
      }
    } catch (error) {
      console.warn("Failed to parse replay trade", error);
    }
  }

  trades.sort((a, b) => a.timestamp - b.timestamp || a.tradeId - b.tradeId);
  return trades;
}

function normalizeTrade(value: any): Trade | null {
  if (!value) {
    return null;
  }
  const price = Number(value.price);
  const quantity = Number(value.quantity);
  const timestamp = Number(value.timestamp);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(quantity) ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }
  const tradeIdRaw = value.tradeId ?? value.id ?? timestamp;
  const tradeId = Number.isFinite(Number(tradeIdRaw))
    ? Math.trunc(Number(tradeIdRaw))
    : Math.trunc(timestamp);
  return {
    tradeId,
    price,
    quantity,
    timestamp,
    isBuyerMaker: Boolean(value.isBuyerMaker),
  };
}

function now(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

import { deflate } from "pako";

import type {
  RecordingChunkMeta,
  RecordingDatasetSummary,
  Timeframe,
  Trade,
} from "@/types";

import { createRecorderStorage, type RecorderStorage } from "./storage";

export interface RecorderContext {
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  label?: string;
  datasetId?: string;
}

export interface RecorderOptions {
  chunkDurationMs?: number;
  chunkTradeTarget?: number;
  maxDatasets?: number;
  maxTotalBytes?: number;
  onDatasetUpdate?: (dataset: RecordingDatasetSummary) => void;
}

const DEFAULT_CHUNK_DURATION_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CHUNK_TRADE_TARGET = 10_000;
const DEFAULT_MAX_DATASETS = 6;
const DEFAULT_MAX_TOTAL_BYTES = 300 * 1024 * 1024; // ~300MB

const encoder = new TextEncoder();

export class AggTradeRecorder {
  private readonly storage: RecorderStorage;

  private readonly options: Required<RecorderOptions>;

  private activeDataset: RecordingDatasetSummary | null = null;

  private chunkBuffer: Trade[] = [];

  private chunkStartTime: number | null = null;

  private chunkEndTime: number | null = null;

  private chunkIndex = 0;

  private flushPromise: Promise<void> = Promise.resolve();

  private flushScheduled = false;

  constructor(storage?: RecorderStorage, options?: RecorderOptions) {
    this.storage = storage ?? createRecorderStorage();
    this.options = {
      chunkDurationMs: options?.chunkDurationMs ?? DEFAULT_CHUNK_DURATION_MS,
      chunkTradeTarget: options?.chunkTradeTarget ?? DEFAULT_CHUNK_TRADE_TARGET,
      maxDatasets: options?.maxDatasets ?? DEFAULT_MAX_DATASETS,
      maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      onDatasetUpdate: options?.onDatasetUpdate ?? (() => {}),
    };
  }

  getStorage(): RecorderStorage {
    return this.storage;
  }

  getActiveDataset(): RecordingDatasetSummary | null {
    return this.activeDataset ? cloneDataset(this.activeDataset) : null;
  }

  isRecording(): boolean {
    return Boolean(this.activeDataset);
  }

  async start(context: RecorderContext): Promise<RecordingDatasetSummary> {
    await this.flushPending(true);

    const now = Date.now();
    const dataset: RecordingDatasetSummary = {
      id: context.datasetId ?? generateDatasetId(),
      label: context.label ?? buildDefaultLabel(context.symbol, now),
      symbol: context.symbol,
      timeframe: context.timeframe,
      priceStep: context.priceStep,
      createdAt: now,
      updatedAt: now,
      startTime: null,
      endTime: null,
      totalTrades: 0,
      totalBytes: 0,
      chunkCount: 0,
      durationMs: 0,
    };

    this.activeDataset = dataset;
    this.chunkBuffer = [];
    this.chunkStartTime = null;
    this.chunkEndTime = null;
    this.chunkIndex = 0;

    await this.storage.saveDataset(dataset);
    this.options.onDatasetUpdate(cloneDataset(dataset));
    await this.enforceLimits();
    return cloneDataset(dataset);
  }

  async rotate(context: RecorderContext): Promise<RecordingDatasetSummary> {
    return this.start(context);
  }

  async stop(): Promise<void> {
    await this.flushPending(true);
    if (this.activeDataset) {
      this.options.onDatasetUpdate(cloneDataset(this.activeDataset));
    }
    this.activeDataset = null;
    this.chunkBuffer = [];
    this.chunkStartTime = null;
    this.chunkEndTime = null;
    this.chunkIndex = 0;
  }

  async record(trade: Trade): Promise<void> {
    if (!this.activeDataset) {
      return;
    }

    this.chunkBuffer.push({ ...trade });

    if (this.chunkStartTime === null || trade.timestamp < this.chunkStartTime) {
      this.chunkStartTime = trade.timestamp;
    }
    if (this.chunkEndTime === null || trade.timestamp > this.chunkEndTime) {
      this.chunkEndTime = trade.timestamp;
    }

    if (
      this.activeDataset.startTime === null ||
      trade.timestamp < this.activeDataset.startTime
    ) {
      this.activeDataset.startTime = trade.timestamp;
    }
    if (
      this.activeDataset.endTime === null ||
      trade.timestamp > this.activeDataset.endTime
    ) {
      this.activeDataset.endTime = trade.timestamp;
    }

    this.activeDataset.totalTrades += 1;
    if (
      this.activeDataset.startTime !== null &&
      this.activeDataset.endTime !== null
    ) {
      this.activeDataset.durationMs = Math.max(
        0,
        this.activeDataset.endTime - this.activeDataset.startTime,
      );
    }
    this.activeDataset.updatedAt = Date.now();

    if (this.shouldFlush()) {
      await this.queueFlush();
    }
  }

  async listDatasets(): Promise<RecordingDatasetSummary[]> {
    return this.storage.listDatasets();
  }

  private shouldFlush(): boolean {
    if (!this.activeDataset) {
      return false;
    }
    if (this.chunkBuffer.length >= this.options.chunkTradeTarget) {
      return true;
    }
    if (this.chunkStartTime !== null && this.chunkEndTime !== null) {
      return (
        this.chunkEndTime - this.chunkStartTime >= this.options.chunkDurationMs
      );
    }
    return false;
  }

  private async queueFlush(): Promise<void> {
    if (this.flushScheduled) {
      return this.flushPromise;
    }
    this.flushScheduled = true;
    this.flushPromise = this.flushPromise
      .then(() => this.flushChunk())
      .catch((error) => {
        console.warn("Recorder flush failed", error);
      })
      .finally(() => {
        this.flushScheduled = false;
      });
    return this.flushPromise;
  }

  private async flushPending(force = false): Promise<void> {
    if (!force) {
      return this.queueFlush();
    }
    await this.flushPromise;
    await this.flushChunk();
  }

  private async flushChunk(): Promise<void> {
    if (!this.activeDataset) {
      this.chunkBuffer = [];
      this.chunkStartTime = null;
      this.chunkEndTime = null;
      return;
    }
    if (
      !this.chunkBuffer.length ||
      this.chunkStartTime === null ||
      this.chunkEndTime === null
    ) {
      return;
    }

    const trades = this.chunkBuffer;
    this.chunkBuffer = [];
    const startTime = this.chunkStartTime;
    const endTime = this.chunkEndTime;
    this.chunkStartTime = null;
    this.chunkEndTime = null;

    const encoded = encoder.encode(
      trades.map((trade) => JSON.stringify(trade)).join("\n"),
    );
    const compressed = deflate(encoded, { level: 6 });

    const chunkMeta: RecordingChunkMeta = {
      id: `${this.activeDataset.id}-${String(this.chunkIndex).padStart(6, "0")}`,
      datasetId: this.activeDataset.id,
      index: this.chunkIndex,
      startTime,
      endTime,
      tradeCount: trades.length,
      byteLength: compressed.byteLength,
      storedAt: Date.now(),
      compressed: true,
    };

    this.chunkIndex += 1;

    await this.storage.saveChunk(chunkMeta, compressed);

    this.activeDataset.chunkCount += 1;
    this.activeDataset.totalBytes += chunkMeta.byteLength;
    if (
      this.activeDataset.startTime === null ||
      startTime < this.activeDataset.startTime
    ) {
      this.activeDataset.startTime = startTime;
    }
    if (
      this.activeDataset.endTime === null ||
      endTime > this.activeDataset.endTime
    ) {
      this.activeDataset.endTime = endTime;
    }
    if (
      this.activeDataset.startTime !== null &&
      this.activeDataset.endTime !== null
    ) {
      this.activeDataset.durationMs = Math.max(
        0,
        this.activeDataset.endTime - this.activeDataset.startTime,
      );
    }
    this.activeDataset.updatedAt = chunkMeta.storedAt;

    await this.storage.saveDataset(this.activeDataset);
    this.options.onDatasetUpdate(cloneDataset(this.activeDataset));
    await this.enforceLimits();
  }

  private async enforceLimits(): Promise<void> {
    const datasets = await this.storage.listDatasets();
    const activeId = this.activeDataset?.id ?? null;
    let working = datasets.sort((a, b) => a.createdAt - b.createdAt);

    if (working.length > this.options.maxDatasets) {
      for (const dataset of [...working]) {
        if (working.length <= this.options.maxDatasets) {
          break;
        }
        if (dataset.id === activeId) {
          continue;
        }
        await this.storage.deleteDataset(dataset.id);
        working = working.filter((item) => item.id !== dataset.id);
      }
    }

    if (this.options.maxTotalBytes > 0) {
      let totalBytes = working.reduce(
        (sum, item) => sum + (item.totalBytes ?? 0),
        0,
      );
      if (totalBytes > this.options.maxTotalBytes) {
        for (const dataset of [...working]) {
          if (totalBytes <= this.options.maxTotalBytes) {
            break;
          }
          if (dataset.id === activeId) {
            continue;
          }
          await this.storage.deleteDataset(dataset.id);
          totalBytes -= dataset.totalBytes ?? 0;
          working = working.filter((item) => item.id !== dataset.id);
        }
      }
    }
  }
}

function generateDatasetId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `dataset-${crypto.randomUUID()}`;
  }
  return `dataset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildDefaultLabel(symbol: string, timestamp: number): string {
  const iso = new Date(timestamp)
    .toISOString()
    .replace(/[:T]/g, "-")
    .slice(0, 16);
  return `${symbol.toUpperCase()} ${iso}`;
}

function cloneDataset(
  dataset: RecordingDatasetSummary,
): RecordingDatasetSummary {
  return { ...dataset };
}

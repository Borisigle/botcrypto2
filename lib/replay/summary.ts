import { inflate } from "pako";

import { FootprintAggregator, timeframeToMs } from "@/lib/aggregator";
import { MODE_PRESETS, createDefaultSignalControlState } from "@/lib/signals";
import type {
  RecordingChunkMeta,
  ReplayMetrics,
  ReplayModeSummary,
  SignalControlState,
  SignalMode,
  Trade,
} from "@/types";

import type { RecorderStorage } from "./storage";

const decoder = new TextDecoder();

export async function computeReplayMetrics(
  storage: RecorderStorage,
  datasetId: string,
): Promise<ReplayMetrics> {
  const dataset = await storage.getDataset(datasetId);
  if (!dataset) {
    return { perMode: [] };
  }

  const chunks = await storage.listChunks(datasetId);
  if (!chunks.length) {
    return { perMode: [] };
  }

  const timeframeMs = timeframeToMs(dataset.timeframe);
  const estimatedBars = estimateMaxBars(dataset.durationMs, timeframeMs);
  const aggregator = new FootprintAggregator({
    timeframeMs,
    priceStep: dataset.priceStep,
    maxBars: estimatedBars,
  });

  for (const chunk of chunks) {
    const payload = await storage.getChunkData(chunk.id);
    if (!payload) {
      continue;
    }
    const trades = decodeChunk(payload, chunk);
    if (trades.length) {
      aggregator.ingestTrades(trades);
    }
  }

  const defaultConfig = createDefaultSignalControlState();
  const perMode: ReplayModeSummary[] = [];

  const modes = Object.keys(MODE_PRESETS) as SignalMode[];
  for (const mode of modes) {
    const config: SignalControlState = {
      mode,
      enabledStrategies: { ...defaultConfig.enabledStrategies },
      overrides: {},
    };
    aggregator.updateSignalConfig(config);
    const state = aggregator.getState();
    const stats = state.signalStats;
    perMode.push({
      mode,
      label: MODE_PRESETS[mode].label,
      estimatePerDay: Number(stats.estimatePerDay ?? 0),
      dailyCount: Number(stats.dailyCount ?? 0),
    });
  }

  return { perMode };
}

function estimateMaxBars(
  durationMs: number | null,
  timeframeMs: number,
): number {
  if (!durationMs || durationMs <= 0) {
    return 800;
  }
  const expectedBars = Math.ceil(durationMs / Math.max(timeframeMs, 1));
  return Math.max(400, expectedBars + 200);
}

function decodeChunk(payload: Uint8Array, meta: RecordingChunkMeta): Trade[] {
  const bytes = meta.compressed ? inflate(payload) : payload;
  const text = decoder.decode(bytes);
  const trades: Trade[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const trade = normalizeTrade(parsed);
      if (trade) {
        trades.push(trade);
      }
    } catch (error) {
      console.warn("Failed to parse replay chunk entry", error);
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

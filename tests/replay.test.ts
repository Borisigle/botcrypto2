import { describe, expect, it } from "vitest";

import { AggTradeRecorder } from "@/lib/replay/recorder";
import { AggTradeReplayer } from "@/lib/replay/replayer";
import { computeReplayMetrics } from "@/lib/replay/summary";
import { MemoryRecorderStorage } from "@/lib/replay/storage";
import type { Trade } from "@/types";

function createTrades(): Trade[] {
  const base = Date.now();
  return [
    {
      tradeId: 1,
      price: 100,
      quantity: 0.25,
      timestamp: base,
      isBuyerMaker: false,
    },
    {
      tradeId: 2,
      price: 100.5,
      quantity: 0.15,
      timestamp: base + 200,
      isBuyerMaker: true,
    },
    {
      tradeId: 3,
      price: 99.8,
      quantity: 0.4,
      timestamp: base + 450,
      isBuyerMaker: false,
    },
    {
      tradeId: 4,
      price: 100.2,
      quantity: 0.3,
      timestamp: base + 1_400,
      isBuyerMaker: true,
    },
    {
      tradeId: 5,
      price: 99.9,
      quantity: 0.2,
      timestamp: base + 1_620,
      isBuyerMaker: false,
    },
  ];
}

describe("replay pipeline", () => {
  it("records trades and replays them deterministically", async () => {
    const storage = new MemoryRecorderStorage();
    const recorder = new AggTradeRecorder(storage, {
      chunkDurationMs: 500,
      chunkTradeTarget: 3,
    });

    const dataset = await recorder.start({
      symbol: "BTCUSDT",
      timeframe: "1m",
      priceStep: 0.5,
      label: "test-dataset",
    });

    const trades = createTrades();
    for (const trade of trades) {
      await recorder.record(trade);
    }

    await recorder.stop();

    const datasets = await storage.listDatasets();
    expect(datasets).toHaveLength(1);
    const storedDataset = datasets[0];
    expect(storedDataset.id).toBe(dataset.id);
    expect(storedDataset.totalTrades).toBe(trades.length);
    expect(storedDataset.chunkCount).toBeGreaterThan(0);

    const chunks = await storage.listChunks(dataset.id);
    expect(chunks.length).toBeGreaterThan(0);

    const captured: Trade[] = [];
    const replayer = new AggTradeReplayer(storage);
    await replayer.start(dataset.id, {
      speed: 5,
      accelerated: true,
      onTrade: (trade) => {
        captured.push(trade);
      },
    });

    expect(captured.map((trade) => trade.tradeId)).toEqual(
      trades.map((trade) => trade.tradeId),
    );

    const metrics = await computeReplayMetrics(storage, dataset.id);
    expect(metrics.perMode.length).toBeGreaterThan(0);
  });
});

/// <reference types="vitest" />

import { describe, expect, it } from "vitest";

import {
  FootprintAggregator,
  precisionFromStep,
  priceToBin,
  timeframeToMs,
} from "@/lib/aggregator";
import type { Trade } from "@/types";

describe("precisionFromStep", () => {
  it("detects decimal precision from step", () => {
    expect(precisionFromStep(1)).toBe(0);
    expect(precisionFromStep(0.5)).toBe(1);
    expect(precisionFromStep(0.25)).toBe(2);
  });
});

describe("priceToBin", () => {
  it("floors prices to the nearest step", () => {
    const precision = precisionFromStep(0.5);
    expect(priceToBin(60234.78, 0.5, precision)).toBe(60234.5);
    expect(priceToBin(60234.21, 0.5, precision)).toBe(60234);
    expect(priceToBin(60234.99, 0.5, precision)).toBe(60234.5);
  });
});

describe("FootprintAggregator", () => {
  it("aggregates trades by timeframe and price bins", () => {
    const aggregator = new FootprintAggregator({
      timeframeMs: timeframeToMs("1m"),
      priceStep: 0.5,
      maxBars: 10,
    });

    const trades: Trade[] = [
      {
        tradeId: 1,
        price: 50000.12,
        quantity: 0.1,
        timestamp: 1_000,
        isBuyerMaker: false,
      },
      {
        tradeId: 2,
        price: 50000.38,
        quantity: 0.2,
        timestamp: 1_500,
        isBuyerMaker: true,
      },
      {
        tradeId: 3,
        price: 50001.1,
        quantity: 0.3,
        timestamp: 59_000,
        isBuyerMaker: false,
      },
    ];

    const state = aggregator.ingestTrades(trades);

    expect(state.bars).toHaveLength(1);
    const [bar] = state.bars;
    expect(bar.levels).toHaveLength(2);

    const firstLevel = bar.levels.find((lvl) => lvl.price === 50000);
    expect(firstLevel).toBeDefined();
    expect(firstLevel?.askVol).toBeCloseTo(0.1);
    expect(firstLevel?.bidVol).toBeCloseTo(0.2);
    expect(firstLevel?.delta).toBeCloseTo(-0.1);

    const secondLevel = bar.levels.find((lvl) => lvl.price === 50001);
    expect(secondLevel).toBeDefined();
    expect(secondLevel?.askVol).toBeCloseTo(0.3);
    expect(secondLevel?.bidVol).toBe(0);
    expect(bar.totalDelta).toBeCloseTo(0.2);
    expect(bar.pocPrice).toBe(50001);
    expect(bar.pocVolume).toBeCloseTo(0.3);
  });

  it("tracks cumulative delta across bars and prunes old data", () => {
    const aggregator = new FootprintAggregator({
      timeframeMs: timeframeToMs("1m"),
      priceStep: 1,
      maxBars: 2,
    });

    const trades: Trade[] = [
      { tradeId: 1, price: 30_000, quantity: 1, timestamp: 5_000, isBuyerMaker: false },
      { tradeId: 2, price: 30_001, quantity: 2, timestamp: 65_000, isBuyerMaker: true },
      { tradeId: 3, price: 30_002, quantity: 3, timestamp: 125_000, isBuyerMaker: false },
    ];

    aggregator.ingestTrades(trades.slice(0, 2));
    const state = aggregator.ingestTrades([trades[2]]);

    expect(state.bars).toHaveLength(2);
    expect(state.bars[0].cumulativeDelta).toBeCloseTo(-1);
    expect(state.bars[1].cumulativeDelta).toBeCloseTo(2);
    expect(state.bars[0].totalDelta).toBeCloseTo(-1);
    expect(state.bars[1].totalDelta).toBeCloseTo(3);
  });
});

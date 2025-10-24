import { describe, expect, it } from "vitest";

import { TradingEngine } from "@/lib/trading/engine";
import type { FootprintSignal, Trade } from "@/types";

let tradeCounter = 0;
let signalCounter = 0;

const BASE_TIMESTAMP = 1_700_000_000_000;

function createSignal(overrides: Partial<FootprintSignal>): FootprintSignal {
  const entry = overrides.entry ?? 100;
  const stop = overrides.stop ?? entry - 5;
  const target1 = overrides.target1 ?? entry + 5;
  const target2 = overrides.target2 ?? entry + 10;
  signalCounter += 1;
  return {
    id: overrides.id ?? `signal-${signalCounter}`,
    timestamp: overrides.timestamp ?? BASE_TIMESTAMP,
    barTime: overrides.barTime ?? BASE_TIMESTAMP,
    barIndex: overrides.barIndex ?? 0,
    price: overrides.price ?? entry,
    entry,
    stop,
    target1,
    target2,
    score: overrides.score ?? 80,
    session: overrides.session ?? "eu",
    side: overrides.side ?? "long",
    strategy: overrides.strategy ?? "absorption-failure",
    strategies: overrides.strategies ?? [overrides.strategy ?? "absorption-failure"],
    levelLabel: overrides.levelLabel ?? null,
    evidence: overrides.evidence ?? [],
  };
}

function createTrade(overrides: Partial<Trade>): Trade {
  tradeCounter += 1;
  return {
    tradeId: overrides.tradeId ?? tradeCounter,
    price: overrides.price ?? 100,
    quantity: overrides.quantity ?? 1,
    timestamp: overrides.timestamp ?? BASE_TIMESTAMP,
    isBuyerMaker: overrides.isBuyerMaker ?? false,
  };
}

describe("TradingEngine", () => {
  it("handles TP1 partial, moves stop to BE and closes at breakeven", () => {
    const engine = new TradingEngine({ priceStep: 1, timeframeMs: 60_000 });
    engine.updateSettings({
      autoTake: true,
      partialTakePercent: 0.5,
      beOffsetTicks: 0,
      slippageTicks: 0,
      feesPercent: 0,
    });

    const signal = createSignal({ id: "tp1-be", side: "long", entry: 100, stop: 95, target1: 105, target2: 110 });
    engine.syncSignals([signal]);

    let state = engine.getState();
    expect(state.pending).toHaveLength(1);

    engine.handleTrade(createTrade({ price: 100, timestamp: BASE_TIMESTAMP + 1000 }));
    state = engine.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.positions).toHaveLength(1);

    engine.handleTrade(createTrade({ price: 105, timestamp: BASE_TIMESTAMP + 2000 }));
    state = engine.getState();
    expect(state.positions[0].target1Hit).toBe(true);
    expect(state.positions[0].stopPrice).toBeCloseTo(100, 6);

    engine.handleTrade(createTrade({ price: 100, timestamp: BASE_TIMESTAMP + 3000 }));
    state = engine.getState();
    expect(state.positions).toHaveLength(0);
    expect(state.closed).toHaveLength(1);

    const closed = state.closed[0];
    expect(closed.exitReason).toBe("breakeven");
    expect(closed.firstHit).toBe("tp1");
    expect(closed.realizedR).toBeGreaterThan(0);
    expect(closed.realizedR).toBeCloseTo(0.5, 2);
  });

  it("includes slippage and fees in realized pnl", () => {
    const engine = new TradingEngine({ priceStep: 1, timeframeMs: 60_000 });
    engine.updateSettings({
      autoTake: false,
      partialTakePercent: 0,
      slippageTicks: 1,
      feesPercent: 0.02,
      beOffsetTicks: 0,
      riskPerTradePercent: 1,
    });

    const signal = createSignal({ id: "loss", side: "long", entry: 100, stop: 99, target1: 101, target2: 102 });
    engine.syncSignals([signal]);
    engine.takeSignal(signal.id);

    let state = engine.getState();
    expect(state.pending).toHaveLength(1);

    engine.handleTrade(createTrade({ price: 100, timestamp: BASE_TIMESTAMP + 1000 }));
    state = engine.getState();
    expect(state.positions).toHaveLength(1);

    engine.handleTrade(createTrade({ price: 99, timestamp: BASE_TIMESTAMP + 2000 }));
    state = engine.getState();
    expect(state.positions).toHaveLength(0);
    expect(state.closed).toHaveLength(1);

    const closed = state.closed[0];
    expect(closed.exitReason).toBe("stop");
    expect(closed.realizedR).toBeLessThan(0);
    expect(closed.realizedR).toBeCloseTo(-3.04, 2);
    expect(closed.realizedPnl).toBeCloseTo(-0.0304, 4);
  });

  it("prioritises stop before targets for short trades", () => {
    const engine = new TradingEngine({ priceStep: 1, timeframeMs: 60_000 });
    engine.updateSettings({
      autoTake: true,
      partialTakePercent: 0,
      slippageTicks: 0,
      feesPercent: 0,
    });

    const signal = createSignal({ id: "short-stop", side: "short", entry: 100, stop: 105, target1: 98, target2: 95 });
    engine.syncSignals([signal]);

    engine.handleTrade(createTrade({ price: 100, timestamp: BASE_TIMESTAMP + 1000 }));
    engine.handleTrade(createTrade({ price: 106, timestamp: BASE_TIMESTAMP + 2000 }));

    const state = engine.getState();
    expect(state.positions).toHaveLength(0);
    expect(state.closed).toHaveLength(1);
    const closed = state.closed[0];
    expect(closed.exitReason).toBe("stop");
    expect(closed.firstHit).toBe("stop");
  });

  it("closes at target2 when reached", () => {
    const engine = new TradingEngine({ priceStep: 1, timeframeMs: 60_000 });
    engine.updateSettings({
      autoTake: true,
      partialTakePercent: 0,
      slippageTicks: 0,
      feesPercent: 0,
    });

    const signal = createSignal({ id: "tp2", side: "long", entry: 50, stop: 45, target1: 55, target2: 60 });
    engine.syncSignals([signal]);
    engine.handleTrade(createTrade({ price: 50, timestamp: BASE_TIMESTAMP + 1000 }));
    engine.handleTrade(createTrade({ price: 60, timestamp: BASE_TIMESTAMP + 2000 }));

    const state = engine.getState();
    expect(state.positions).toHaveLength(0);
    const closed = state.closed[0];
    expect(closed.exitReason).toBe("tp2");
    expect(closed.firstHit === "tp2" || closed.firstHit === "tp1").toBe(true);
    expect(closed.realizedR).toBeGreaterThan(0);
  });

  it("resolves trade exits by tick order when timestamps tie", () => {
    const engine = new TradingEngine({ priceStep: 1, timeframeMs: 60_000 });
    engine.updateSettings({
      autoTake: true,
      partialTakePercent: 0.5,
      slippageTicks: 0,
      feesPercent: 0,
      beOffsetTicks: 0,
    });

    const signal = createSignal({
      id: "tie",
      side: "long",
      entry: 100,
      stop: 95,
      target1: 105,
      target2: 110,
    });
    engine.syncSignals([signal]);
    engine.handleTrade(createTrade({ tradeId: 1, price: 100, timestamp: BASE_TIMESTAMP + 1000 }));

    const simultaneous = [
      createTrade({ tradeId: 2, price: 105, timestamp: BASE_TIMESTAMP + 2000, isBuyerMaker: false }),
      createTrade({ tradeId: 3, price: 95, timestamp: BASE_TIMESTAMP + 2000, isBuyerMaker: true }),
    ].sort((a, b) => (a.timestamp - b.timestamp) || (a.tradeId - b.tradeId));

    for (const trade of simultaneous) {
      engine.handleTrade(trade);
    }

    const state = engine.getState();
    expect(state.positions).toHaveLength(0);
    expect(state.closed).toHaveLength(1);
    const closed = state.closed[0];
    expect(closed.firstHit).toBe("tp1");
    expect(closed.exitReason).toBe("breakeven");
  });
});

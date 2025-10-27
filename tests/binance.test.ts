import { describe, expect, it, vi } from "vitest";

import { clampDepthLimit, __testDispatchAggTradeMessage } from "@/lib/binance";

function createAggTradeMessage(): string {
  return JSON.stringify({
    stream: "btcusdt@aggTrade",
    data: {
      e: "aggTrade",
      t: 123456,
      p: "100.5",
      q: "0.25",
      T: 1_700_000_000_000,
      m: true,
    },
  });
}

describe("BinanceAggTradeStream dispatch guard", () => {
  it("warns and does not throw when onTrade handler is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = createAggTradeMessage();

    expect(() => {
      __testDispatchAggTradeMessage(message, {});
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("onTrade handler is not a function."),
    );

    warnSpy.mockRestore();
  });

  it("delivers trades to onTrade handler when provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = createAggTradeMessage();
    const onTrade = vi.fn();

    __testDispatchAggTradeMessage(message, { onTrade });

    expect(onTrade).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe("clampDepthLimit", () => {
  it("defaults to 100 when limit is undefined", () => {
    expect(clampDepthLimit()).toBe(100);
  });

  it("rounds to the nearest allowed value", () => {
    expect(clampDepthLimit(7)).toBe(5);
    expect(clampDepthLimit(9)).toBe(10);
    expect(clampDepthLimit(55)).toBe(50);
    expect(clampDepthLimit(600)).toBe(500);
  });

  it("prefers the higher bound when equidistant", () => {
    expect(clampDepthLimit(15)).toBe(20);
    expect(clampDepthLimit(75)).toBe(100);
  });

  it("clamps to the allowed range", () => {
    expect(clampDepthLimit(-10)).toBe(5);
    expect(clampDepthLimit(9999)).toBe(1000);
  });

  it("keeps existing allowed values intact", () => {
    expect(clampDepthLimit(500)).toBe(500);
    expect(clampDepthLimit(1000)).toBe(1000);
  });
});

import { describe, expect, it, vi } from "vitest";

import { __testDispatchAggTradeMessage } from "@/lib/binance";

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

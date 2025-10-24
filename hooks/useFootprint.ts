'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BinanceAggTradeStream } from "@/lib/binance";
import type { Trade, FootprintBar, ConnectionStatus, Settings, Timeframe } from "@/types";

const DEFAULT_SETTINGS: Settings = {
  symbol: "BTCUSDT",
  timeframe: "1m",
  priceStep: 0.5,
  maxBars: 400,
  showCumulativeDelta: true,
};

const FLUSH_INTERVAL = 200;

interface PriceBounds {
  min: number;
  max: number;
  maxVolume: number;
}

interface WorkerStateMessage {
  type: "state";
  state: { bars: FootprintBar[] };
}

interface WorkerErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = WorkerStateMessage | WorkerErrorMessage;

export function useFootprint() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [bars, setBars] = useState<FootprintBar[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  const handleStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
    if (status === "connected") {
      setLastError(null);
    }
  }, []);

  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const tradeBufferRef = useRef<Trade[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const streamRef = useRef<BinanceAggTradeStream | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const worker = new Worker(new URL("../workers/aggregator.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "state") {
        setBars(message.state.bars);
        setLastError(null);
      } else if (message.type === "error") {
        setLastError(message.message);
      }
    };

    worker.postMessage({
      type: "init",
      settings: {
        timeframe: settings.timeframe,
        priceStep: settings.priceStep,
        maxBars: settings.maxBars,
      },
    });

    workerReadyRef.current = true;

    return () => {
      worker.terminate();
      workerRef.current = null;
      workerReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushTrades = useCallback(
    (force = false) => {
      const worker = workerRef.current;
      if (!worker || !workerReadyRef.current) {
        return;
      }

      const buffer = tradeBufferRef.current;
      if (!buffer.length) {
        return;
      }

      if (!force && buffer.length < 50 && flushTimerRef.current !== null) {
        return;
      }

      worker.postMessage({ type: "trades", trades: buffer.splice(0) });
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return () => {};
    }

    const stream = new BinanceAggTradeStream(settings.symbol, {
      onTrade: (trade) => {
        tradeBufferRef.current.push(trade);
        if (tradeBufferRef.current.length >= 150) {
          flushTrades(true);
        } else if (flushTimerRef.current === null) {
          flushTimerRef.current = window.setTimeout(() => {
            flushTrades(true);
          }, FLUSH_INTERVAL);
        }
      },
      onStatusChange: handleStatusChange,
      onError: (message) => setLastError(message),
    });

    streamRef.current = stream;
    stream.connect();

    return () => {
      flushTrades(true);
      stream.disconnect();
      streamRef.current = null;
    };
  }, [settings.symbol, flushTrades, handleStatusChange]);

  useEffect(() => {
    if (!workerReadyRef.current || !workerRef.current) {
      return;
    }

    workerRef.current.postMessage({ type: "clear" });
    tradeBufferRef.current = [];
    setBars([]);
  }, [settings.symbol]);

  useEffect(() => {
    if (!workerReadyRef.current || !workerRef.current) {
      return;
    }

    workerRef.current.postMessage({
      type: "settings",
      settings: {
        timeframe: settings.timeframe,
        priceStep: settings.priceStep,
        maxBars: settings.maxBars,
      },
      reset: true,
    });

    tradeBufferRef.current = [];
    setBars([]);
  }, [settings.timeframe, settings.priceStep, settings.maxBars]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
      }
      flushTrades(true);
    };
  }, [flushTrades]);

  const priceBounds = useMemo<PriceBounds | null>(() => {
    if (!bars.length) {
      return null;
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let maxVolume = 0;

    for (const bar of bars) {
      for (const level of bar.levels) {
        if (level.price < min) {
          min = level.price;
        }
        if (level.price > max) {
          max = level.price;
        }
        if (level.totalVolume > maxVolume) {
          maxVolume = level.totalVolume;
        }
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }

    return { min, max, maxVolume };
  }, [bars]);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const setTimeframe = useCallback((timeframe: Timeframe) => {
    updateSettings({ timeframe });
  }, [updateSettings]);

  const setPriceStep = useCallback((priceStep: number) => {
    updateSettings({ priceStep });
  }, [updateSettings]);

  const toggleCumulativeDelta = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      showCumulativeDelta: !prev.showCumulativeDelta,
    }));
  }, []);

  return {
    bars,
    settings,
    updateSettings,
    setTimeframe,
    setPriceStep,
    toggleCumulativeDelta,
    connectionStatus,
    priceBounds,
    lastError,
  };
}

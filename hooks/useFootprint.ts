'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BinanceAggTradeStream } from "@/lib/binance";
import { createDefaultSignalControlState } from "@/lib/signals";
import type {
  ConnectionStatus,
  DetectorOverrides,
  FootprintBar,
  FootprintSignal,
  FootprintState,
  Settings,
  SignalControlState,
  SignalMode,
  SignalStats,
  SignalStrategy,
  Timeframe,
  Trade,
} from "@/types";

const DEFAULT_SETTINGS: Settings = {
  symbol: "BTCUSDT",
  timeframe: "1m",
  priceStep: 0.5,
  maxBars: 400,
  showCumulativeDelta: true,
};

const FLUSH_INTERVAL = 200;
const SIGNAL_CONFIG_STORAGE_KEY = "footprint.signalConfig";

const EMPTY_SIGNAL_STATS: SignalStats = {
  dailyCount: 0,
  estimatePerDay: 0,
  lastReset: 0,
  sessionCount: {
    asia: 0,
    eu: 0,
    us: 0,
    other: 0,
  },
};

interface PriceBounds {
  min: number;
  max: number;
  maxVolume: number;
}

interface WorkerStateMessage {
  type: "state";
  state: FootprintState;
}

interface WorkerErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = WorkerStateMessage | WorkerErrorMessage;

function mergeSignalControl(
  base: SignalControlState,
  partial: Partial<SignalControlState>,
): SignalControlState {
  return {
    mode: partial.mode ?? base.mode,
    enabledStrategies: {
      ...base.enabledStrategies,
      ...(partial.enabledStrategies ?? {}),
    },
    overrides: {
      ...base.overrides,
      ...(partial.overrides ?? {}),
    },
  };
}

function normalizeSignalStats(stats?: SignalStats): SignalStats {
  if (!stats) {
    return {
      ...EMPTY_SIGNAL_STATS,
      sessionCount: { ...EMPTY_SIGNAL_STATS.sessionCount },
    };
  }

  return {
    dailyCount: stats.dailyCount ?? 0,
    estimatePerDay: stats.estimatePerDay ?? 0,
    lastReset: stats.lastReset ?? 0,
    sessionCount: {
      asia: stats.sessionCount?.asia ?? 0,
      eu: stats.sessionCount?.eu ?? 0,
      us: stats.sessionCount?.us ?? 0,
      other: stats.sessionCount?.other ?? 0,
    },
  };
}

export function useFootprint() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [bars, setBars] = useState<FootprintBar[]>([]);
  const [signals, setSignals] = useState<FootprintSignal[]>([]);
  const [signalStats, setSignalStats] = useState<SignalStats>(() => normalizeSignalStats());
  const [signalControl, setSignalControl] = useState<SignalControlState>(() =>
    createDefaultSignalControlState(),
  );
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  const handleStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
    if (status === "connected") {
      setLastError(null);
    }
  }, []);

  const signalControlRef = useRef<SignalControlState>(signalControl);
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
        setBars(message.state.bars ?? []);
        setSignals(message.state.signals ?? []);
        setSignalStats(normalizeSignalStats(message.state.signalStats));
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
    worker.postMessage({ type: "detector-config", config: signalControlRef.current });

    workerReadyRef.current = true;

    return () => {
      worker.terminate();
      workerRef.current = null;
      workerReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const stored = window.localStorage.getItem(SIGNAL_CONFIG_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<SignalControlState>;
        setSignalControl((prev) => mergeSignalControl(prev, parsed));
      }
    } catch (error) {
      console.warn("Failed to restore signal config", error);
    }
  }, []);

  useEffect(() => {
    signalControlRef.current = signalControl;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(SIGNAL_CONFIG_STORAGE_KEY, JSON.stringify(signalControl));
      } catch (error) {
        console.warn("Failed to persist signal config", error);
      }
    }
    if (workerRef.current && workerReadyRef.current) {
      workerRef.current.postMessage({ type: "detector-config", config: signalControl });
    }
  }, [signalControl]);

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

  const setSignalMode = useCallback((mode: SignalMode) => {
    setSignalControl((prev) => {
      if (prev.mode === mode) {
        return prev;
      }
      return { ...prev, mode };
    });
  }, []);

  const toggleStrategy = useCallback((strategy: SignalStrategy) => {
    setSignalControl((prev) => ({
      ...prev,
      enabledStrategies: {
        ...prev.enabledStrategies,
        [strategy]: !prev.enabledStrategies[strategy],
      },
    }));
  }, []);

  const updateSignalOverrides = useCallback((overrides: Partial<DetectorOverrides>) => {
    setSignalControl((prev) => ({
      ...prev,
      overrides: {
        ...prev.overrides,
        ...overrides,
      },
    }));
  }, []);

  return {
    bars,
    signals,
    signalStats,
    signalControl,
    settings,
    updateSettings,
    setTimeframe,
    setPriceStep,
    toggleCumulativeDelta,
    setSignalMode,
    toggleStrategy,
    updateSignalOverrides,
    connectionStatus,
    priceBounds,
    lastError,
  };
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { timeframeToMs } from "@/lib/aggregator";
import { BinanceAggTradeStream } from "@/lib/binance";
import { TradingEngine, DEFAULT_TRADING_SETTINGS } from "@/lib/trading/engine";
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
  TradingSettings,
  TradingState,
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
const TRADING_SETTINGS_STORAGE_KEY = "footprint.trading.settings";
const TRADING_HISTORY_STORAGE_KEY = "footprint.trading.history";

const DEFAULT_TRADING_STATE: TradingState = (() => {
  const engine = new TradingEngine({
    priceStep: DEFAULT_SETTINGS.priceStep,
    timeframeMs: timeframeToMs(DEFAULT_SETTINGS.timeframe),
    settings: DEFAULT_TRADING_SETTINGS,
  });
  return engine.getState();
})();

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
  const [tradingState, setTradingState] = useState<TradingState>(DEFAULT_TRADING_STATE);

  const handleStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
    if (status === "connected") {
      setLastError(null);
    }
  }, []);

  const signalControlRef = useRef<SignalControlState>(signalControl);
  const tradingEngineRef = useRef<TradingEngine | null>(null);
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
        const nextBars = message.state.bars ?? [];
        const nextSignals = message.state.signals ?? [];
        setBars(nextBars);
        setSignals(nextSignals);
        setSignalStats(normalizeSignalStats(message.state.signalStats));
        setLastError(null);
        const engine = tradingEngineRef.current;
        if (engine) {
          const updated = engine.syncSignals(nextSignals);
          if (updated) {
            setTradingState(engine.getState());
          }
        }
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
    if (typeof window === "undefined") {
      return;
    }

    let storedSettings: Partial<TradingSettings> | undefined;
    try {
      const raw = window.localStorage.getItem(TRADING_SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TradingSettings>;
        if (parsed && typeof parsed === "object") {
          storedSettings = parsed;
        }
      }
    } catch (error) {
      console.warn("Failed to restore trading settings", error);
    }

    let storedHistory: TradingState["history"] | undefined;
    try {
      const rawHistory = window.localStorage.getItem(TRADING_HISTORY_STORAGE_KEY);
      if (rawHistory) {
        const parsed = JSON.parse(rawHistory);
        if (Array.isArray(parsed)) {
          storedHistory = parsed as TradingState["history"];
        }
      }
    } catch (error) {
      console.warn("Failed to restore trading history", error);
    }

    const engine = new TradingEngine({
      priceStep: DEFAULT_SETTINGS.priceStep,
      timeframeMs: timeframeToMs(DEFAULT_SETTINGS.timeframe),
      settings: storedSettings,
      history: storedHistory,
    });
    tradingEngineRef.current = engine;
    setTradingState(engine.getState());

    return () => {
      tradingEngineRef.current = null;
    };
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

  useEffect(() => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return;
    }
    engine.updateMarketContext({
      priceStep: settings.priceStep,
      timeframeMs: timeframeToMs(settings.timeframe),
    });
  }, [settings.priceStep, settings.timeframe]);

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
        const engine = tradingEngineRef.current;
        if (engine) {
          const updated = engine.handleTrade(trade);
          if (updated) {
            setTradingState(engine.getState());
          }
        }
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const engine = tradingEngineRef.current;
    if (!engine) {
      return;
    }
    const snapshot = engine.getPersistenceSnapshot();
    try {
      window.localStorage.setItem(TRADING_SETTINGS_STORAGE_KEY, JSON.stringify(snapshot.settings));
    } catch (error) {
      console.warn("Failed to persist trading settings", error);
    }
    try {
      window.localStorage.setItem(TRADING_HISTORY_STORAGE_KEY, JSON.stringify(snapshot.history));
    } catch (error) {
      console.warn("Failed to persist trading history", error);
    }
  }, [tradingState.version]);

  const updateTradingSettings = useCallback((partial: Partial<TradingSettings>) => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return false;
    }
    const changed = engine.updateSettings(partial);
    if (changed) {
      setTradingState(engine.getState());
    }
    return changed;
  }, []);

  const takeSignal = useCallback((signalId: string) => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return null;
    }
    const created = engine.takeSignal(signalId);
    if (created) {
      setTradingState(engine.getState());
    }
    return created;
  }, []);

  const cancelPendingTrade = useCallback((id: string) => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return false;
    }
    const removed = engine.cancelPending(id);
    if (removed) {
      setTradingState(engine.getState());
    }
    return removed;
  }, []);

  const flattenPosition = useCallback((id: string, price?: number) => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return false;
    }
    const closed = engine.flattenPosition(id, price);
    if (closed) {
      setTradingState(engine.getState());
    }
    return closed;
  }, []);

  const resetTradingDay = useCallback(() => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return;
    }
    engine.resetDay();
    setTradingState(engine.getState());
  }, []);

  const exportTradingHistory = useCallback((format: "json" | "csv" = "json") => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return "";
    }
    return engine.exportHistory(format);
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
    tradingState,
    updateTradingSettings,
    takeSignal,
    cancelPendingTrade,
    flattenPosition,
    resetTradingDay,
    exportTradingHistory,
  };
}

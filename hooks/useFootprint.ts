"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { timeframeToMs } from "@/lib/aggregator";
import {
  BinanceAggTradeStream,
  fetchAggTrades,
  fetchServerTime,
  fetchSymbolMarketConfig,
  type StreamStatusMeta,
} from "@/lib/binance";
import { BinanceDepthStream } from "@/lib/depth";
import { AggTradeRecorder } from "@/lib/replay/recorder";
import { AggTradeReplayer } from "@/lib/replay/replayer";
import { computeReplayMetrics } from "@/lib/replay/summary";
import { TradingEngine, DEFAULT_TRADING_SETTINGS } from "@/lib/trading/engine";
import { createDefaultSignalControlState } from "@/lib/signals";
import type {
  ConnectionDiagnostics,
  ConnectionStatus,
  DepthState,
  DepthStreamMessage,
  DetectorOverrides,
  FootprintBar,
  FootprintSignal,
  FootprintState,
  FootprintMode,
  InvalidationActionType,
  RecordingDatasetSummary,
  ReplayMetrics,
  ReplaySpeed,
  ReplayState,
  Settings,
  SignalControlState,
  SignalMode,
  SignalStats,
  SignalStrategy,
  SymbolMarketConfig,
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
const BACKFILL_LOOKBACK_MINUTES = 3;
const BACKFILL_LOOKBACK_MS = BACKFILL_LOOKBACK_MINUTES * 60_000;
const SERVER_TIME_SYNC_INTERVAL = 60_000;
const MAX_TRACKED_TRADE_IDS = 50_000;

const INITIAL_MARKET_CONFIG: SymbolMarketConfig = {
  tickSize: 0.1,
  stepSize: 0.001,
  minPriceStep: 0.1,
  maxPriceStep: 2,
};

const INITIAL_DIAGNOSTICS: ConnectionDiagnostics = {
  reconnectAttempts: 0,
  serverTimeOffsetMs: 0,
  lastGapFillAt: null,
  gapFrom: null,
  gapTo: null,
  gapTradeCount: 0,
};

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

const INITIAL_REPLAY_STATE: ReplayState = {
  datasetId: null,
  speed: 1,
  status: "idle",
  progress: 0,
  error: null,
  durationMs: null,
  startedAt: null,
  completedAt: null,
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

interface TradeIdCache {
  set: Set<number>;
  queue: number[];
  start: number;
}

function createTradeIdCache(): TradeIdCache {
  return {
    set: new Set<number>(),
    queue: [],
    start: 0,
  };
}

function registerTradeId(cache: TradeIdCache, rawTradeId: number): boolean {
  if (!Number.isFinite(rawTradeId)) {
    return true;
  }
  const tradeId = Math.trunc(rawTradeId);
  if (cache.set.has(tradeId)) {
    return false;
  }
  cache.set.add(tradeId);
  cache.queue.push(tradeId);

  while (cache.queue.length - cache.start > MAX_TRACKED_TRADE_IDS) {
    const id = cache.queue[cache.start];
    if (typeof id === "number") {
      cache.set.delete(id);
    }
    cache.start += 1;
  }

  if (cache.start > 0 && cache.start * 2 > cache.queue.length) {
    cache.queue = cache.queue.slice(cache.start);
    cache.start = 0;
  }

  return true;
}

function resetTradeIdCache(cache: TradeIdCache) {
  cache.set.clear();
  cache.queue = [];
  cache.start = 0;
}

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

function normalizePriceStep(step: number, config: SymbolMarketConfig): number {
  const tick = config.tickSize > 0 ? config.tickSize : 0.1;
  const min = config.minPriceStep > 0 ? config.minPriceStep : tick;
  const maxBase =
    config.maxPriceStep > min ? config.maxPriceStep : Math.max(min, tick * 40);
  if (!Number.isFinite(step) || step <= 0) {
    return Number(min.toFixed(8));
  }
  const multiplier = Math.max(1, Math.round(step / tick));
  const normalized = multiplier * tick;
  const clamped = Math.min(Math.max(normalized, min), maxBase);
  return Number(clamped.toFixed(8));
}

export function useFootprint() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [bars, setBars] = useState<FootprintBar[]>([]);
  const [signals, setSignals] = useState<FootprintSignal[]>([]);
  const [signalStats, setSignalStats] = useState<SignalStats>(() =>
    normalizeSignalStats(),
  );
  const [signalControl, setSignalControl] = useState<SignalControlState>(() =>
    createDefaultSignalControlState(),
  );
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [tradingState, setTradingState] = useState<TradingState>(
    DEFAULT_TRADING_STATE,
  );
  const [connectionDiagnostics, setConnectionDiagnostics] =
    useState<ConnectionDiagnostics>(INITIAL_DIAGNOSTICS);
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState(0);
  const [marketConfig, setMarketConfig] = useState<SymbolMarketConfig>(
    INITIAL_MARKET_CONFIG,
  );
  const [mode, setMode] = useState<FootprintMode>("live");
  const [recordingDataset, setRecordingDataset] =
    useState<RecordingDatasetSummary | null>(null);
  const [availableDatasets, setAvailableDatasets] = useState<
    RecordingDatasetSummary[]
  >([]);
  const [replayState, setReplayState] =
    useState<ReplayState>(INITIAL_REPLAY_STATE);
  const [replayMetrics, setReplayMetrics] = useState<ReplayMetrics>({
    perMode: [],
  });
  const [depth, setDepth] = useState<DepthState | null>(null);
  const [depthStatus, setDepthStatus] =
    useState<ConnectionStatus>("connecting");
  const [depthStatusMeta, setDepthStatusMeta] = useState<StreamStatusMeta | null>(null);

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

  const priceStepConfig = useMemo(
    () => ({
      min: marketConfig.minPriceStep,
      max: marketConfig.maxPriceStep,
      step: marketConfig.tickSize,
    }),
    [marketConfig],
  );

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    replayStateRef.current = replayState;
  }, [replayState]);

  const signalControlRef = useRef<SignalControlState>(signalControl);
  const tradingEngineRef = useRef<TradingEngine | null>(null);
  const liveEngineRef = useRef<TradingEngine | null>(null);
  const liveSettingsRef = useRef<Settings | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const tradeBufferRef = useRef<Trade[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const streamRef = useRef<BinanceAggTradeStream | null>(null);
  const depthStreamRef = useRef<BinanceDepthStream | null>(null);
  const depthBufferRef = useRef<DepthStreamMessage[]>([]);
  const depthFlushTimerRef = useRef<number | null>(null);
  const lastTradeTimeRef = useRef<number | null>(null);
  const tradeIdCacheRef = useRef<TradeIdCache>(createTradeIdCache());
  const serverTimeOffsetRef = useRef(0);
  const symbolRef = useRef(settings.symbol);
  const backfillPromiseRef = useRef<Promise<void> | null>(null);
  const recoveringRef = useRef(false);
  const recoveryQueueRef = useRef<Trade[]>([]);
  const wasEverConnectedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const marketConfigRef = useRef<SymbolMarketConfig>(INITIAL_MARKET_CONFIG);
  const recorderRef = useRef<AggTradeRecorder | null>(null);
  const recorderReadyRef = useRef(false);
  const recorderContextRef = useRef<{
    symbol: string;
    timeframe: Timeframe;
    priceStep: number;
  } | null>(null);
  const replayerRef = useRef<AggTradeReplayer | null>(null);
  const modeRef = useRef<FootprintMode>("live");
  const replayStateRef = useRef<ReplayState>(INITIAL_REPLAY_STATE);
  const datasetMetricsCacheRef = useRef<Map<string, ReplayMetrics>>(new Map());

  const syncServerTime = useCallback(async () => {
    try {
      const serverTime = await fetchServerTime();
      const offset = Math.round(serverTime - Date.now());
      serverTimeOffsetRef.current = offset;
      setServerTimeOffsetMs(offset);
      setConnectionDiagnostics((prev) => ({
        ...prev,
        serverTimeOffsetMs: offset,
      }));
    } catch (error) {
      console.warn("Failed to sync server time", error);
    }
  }, []);

  const refreshDatasets = useCallback(async () => {
    if (!recorderRef.current) {
      return;
    }
    try {
      const list = await recorderRef.current.listDatasets();
      setAvailableDatasets(list);
    } catch (error) {
      console.warn("Failed to refresh replay datasets", error);
    }
  }, []);

  const flushTrades = useCallback((force = false) => {
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
  }, []);

  const flushDepthUpdates = useCallback((force = false) => {
    const worker = workerRef.current;
    if (!worker || !workerReadyRef.current) {
      depthBufferRef.current = [];
      if (depthFlushTimerRef.current !== null) {
        window.clearTimeout(depthFlushTimerRef.current);
        depthFlushTimerRef.current = null;
      }
      return;
    }

    if (!depthBufferRef.current.length) {
      if (force && depthFlushTimerRef.current !== null) {
        window.clearTimeout(depthFlushTimerRef.current);
        depthFlushTimerRef.current = null;
      }
      return;
    }

    const batch = depthBufferRef.current.splice(0);
    worker.postMessage({ type: "depth", updates: batch });
    if (depthFlushTimerRef.current !== null) {
      window.clearTimeout(depthFlushTimerRef.current);
      depthFlushTimerRef.current = null;
    }
  }, []);

  const pushTrade = useCallback(
    (trade: Trade) => {
      tradeBufferRef.current.push(trade);
      if (modeRef.current === "live" && recorderRef.current) {
        recorderRef.current.record(trade).catch((error) => {
          console.warn("Failed to record trade", error);
        });
      }
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
    [flushTrades],
  );

  const drainRecoveryQueue = useCallback(() => {
    if (!recoveryQueueRef.current.length) {
      return;
    }
    const queued = recoveryQueueRef.current.splice(0);
    for (const trade of queued) {
      pushTrade(trade);
    }
    flushTrades(true);
  }, [pushTrade, flushTrades]);

  const startBackfill = useCallback(() => {
    if (backfillPromiseRef.current) {
      return backfillPromiseRef.current;
    }
    if (!workerReadyRef.current || !workerRef.current) {
      return Promise.resolve();
    }

    recoveringRef.current = true;

    const promise = (async () => {
      const symbol = symbolRef.current;
      const serverOffset = serverTimeOffsetRef.current;
      const serverNow = Date.now() + serverOffset;
      const fallbackStart = serverNow - BACKFILL_LOOKBACK_MS;
      const lastProcessed = lastTradeTimeRef.current ?? fallbackStart;
      const startTime = Math.max(
        0,
        Math.min(lastProcessed, serverNow) - BACKFILL_LOOKBACK_MS,
      );
      const endTime = Math.max(serverNow, startTime + 1);

      let collected: Trade[] = [];
      let nextStart = startTime;
      let nextFromId: number | undefined;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const chunk = await fetchAggTrades({
          symbol,
          startTime: nextFromId ? undefined : nextStart,
          endTime,
          fromId: nextFromId,
          limit: 1000,
        });

        if (!chunk.length) {
          break;
        }

        collected = collected.concat(chunk);
        const last = chunk[chunk.length - 1];
        if (!last) {
          break;
        }

        if (chunk.length < 1000 || last.timestamp >= endTime) {
          break;
        }

        nextStart = last.timestamp + 1;
        nextFromId = last.tradeId + 1;
      }

      collected.sort(
        (a, b) => a.timestamp - b.timestamp || a.tradeId - b.tradeId,
      );

      const fresh: Trade[] = [];
      for (const trade of collected) {
        if (registerTradeId(tradeIdCacheRef.current, trade.tradeId)) {
          fresh.push(trade);
          lastTradeTimeRef.current = Math.max(
            lastTradeTimeRef.current ?? 0,
            trade.timestamp,
          );
        }
      }

      if (fresh.length) {
        for (const trade of fresh) {
          pushTrade(trade);
        }
        flushTrades(true);
      }

      setConnectionDiagnostics((prev) => ({
        ...prev,
        lastGapFillAt: serverNow,
        gapFrom: fresh.length ? fresh[0].timestamp : null,
        gapTo: fresh.length ? fresh[fresh.length - 1].timestamp : null,
        gapTradeCount: fresh.length,
      }));
    })()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
      })
      .finally(() => {
        backfillPromiseRef.current = null;
        recoveringRef.current = false;
        drainRecoveryQueue();
        flushTrades(true);
      });

    backfillPromiseRef.current = promise;
    return promise;
  }, [drainRecoveryQueue, flushTrades, pushTrade]);

  const processIncomingTrade = useCallback(
    (trade: Trade) => {
      lastTradeTimeRef.current = Math.max(
        lastTradeTimeRef.current ?? 0,
        trade.timestamp,
      );
      if (!registerTradeId(tradeIdCacheRef.current, trade.tradeId)) {
        return;
      }

      if (recoveringRef.current && backfillPromiseRef.current) {
        recoveryQueueRef.current.push(trade);
        return;
      }

      pushTrade(trade);
    },
    [pushTrade],
  );

  const handleStreamOpen = useCallback(() => {
    setConnectionStatus("connected");
    setLastError(null);
  }, []);

  const handleStreamClose = useCallback(() => {
    setConnectionStatus((prev) =>
      prev === "disconnected" ? prev : "reconnecting",
    );
  }, []);

  const handleStreamError = useCallback((error: unknown) => {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error("[binance]", error);
    setLastError(message);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    const recorder = new AggTradeRecorder(undefined, {
      onDatasetUpdate: (dataset) => {
        if (cancelled) {
          return;
        }
        setRecordingDataset(dataset);
        void refreshDatasets();
      },
    });
    recorderRef.current = recorder;

    recorder
      .start({
        symbol: DEFAULT_SETTINGS.symbol,
        timeframe: DEFAULT_SETTINGS.timeframe,
        priceStep: DEFAULT_SETTINGS.priceStep,
      })
      .then((dataset) => {
        if (cancelled) {
          return;
        }
        recorderReadyRef.current = true;
        recorderContextRef.current = {
          symbol: dataset.symbol,
          timeframe: dataset.timeframe,
          priceStep: dataset.priceStep,
        };
        setRecordingDataset(dataset);
        void refreshDatasets();
      })
      .catch((error) => {
        console.warn("Failed to start trade recorder", error);
      });

    return () => {
      cancelled = true;
      recorderRef.current = null;
      recorder.stop().catch((error) => {
        console.warn("Failed to stop recorder", error);
      });
    };
  }, [refreshDatasets]);

  useEffect(() => {
    if (!recorderReadyRef.current) {
      return;
    }
    if (mode !== "live") {
      return;
    }
    const context = recorderContextRef.current;
    const symbolChanged = !context || context.symbol !== settings.symbol;
    const timeframeChanged =
      !context || context.timeframe !== settings.timeframe;
    const priceStepChanged =
      !context || Math.abs(context.priceStep - settings.priceStep) > 1e-8;

    if (!symbolChanged && !timeframeChanged && !priceStepChanged) {
      return;
    }

    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }
    let cancelled = false;
    recorder
      .rotate({
        symbol: settings.symbol,
        timeframe: settings.timeframe,
        priceStep: settings.priceStep,
      })
      .then((dataset) => {
        if (cancelled) {
          return;
        }
        recorderContextRef.current = {
          symbol: dataset.symbol,
          timeframe: dataset.timeframe,
          priceStep: dataset.priceStep,
        };
        setRecordingDataset(dataset);
        void refreshDatasets();
      })
      .catch((error) => {
        console.warn("Failed to rotate recorder dataset", error);
      });

    return () => {
      cancelled = true;
    };
  }, [
    mode,
    settings.symbol,
    settings.timeframe,
    settings.priceStep,
    refreshDatasets,
  ]);

  const handleStatusChange = useCallback(
    (status: ConnectionStatus, meta?: StreamStatusMeta) => {
      setConnectionStatus(status);

      if (status === "reconnecting") {
        const attempts = meta?.attempts ?? reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = attempts;
        setConnectionDiagnostics((prev) => ({
          ...prev,
          reconnectAttempts: attempts,
        }));
      } else if (status === "connected") {
        const attempts = meta?.attempts ?? reconnectAttemptsRef.current;
        setLastError(null);
        setConnectionDiagnostics((prev) => ({
          ...prev,
          reconnectAttempts: attempts,
        }));
        reconnectAttemptsRef.current = 0;

        if (wasEverConnectedRef.current && attempts > 0) {
          startBackfill();
        }
        wasEverConnectedRef.current = true;
        syncServerTime();
      } else if (status === "disconnected") {
        reconnectAttemptsRef.current = 0;
        wasEverConnectedRef.current = false;
        setConnectionDiagnostics((prev) => ({
          ...prev,
          reconnectAttempts: 0,
        }));
      }
    },
    [startBackfill, syncServerTime],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const worker = new Worker(
      new URL("../workers/aggregator.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    workerRef.current = worker;

    worker.onmessage = (
      event: MessageEvent<WorkerStateMessage | WorkerErrorMessage>,
    ) => {
      const message = event.data;
      if (message.type === "state") {
        const nextBars = message.state.bars ?? [];
        const nextSignals = message.state.signals ?? [];
        setBars(nextBars);
        setSignals(nextSignals);
        setSignalStats(normalizeSignalStats(message.state.signalStats));
        setDepth(message.state.depth ?? null);
        setLastError(null);
        const engine = tradingEngineRef.current;
        if (engine) {
          const updated = engine.syncSignals(nextSignals, nextBars);
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
    worker.postMessage({
      type: "detector-config",
      config: signalControlRef.current,
    });

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
      const rawHistory = window.localStorage.getItem(
        TRADING_HISTORY_STORAGE_KEY,
      );
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
    engine.updateClockOffset(serverTimeOffsetRef.current);
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
        window.localStorage.setItem(
          SIGNAL_CONFIG_STORAGE_KEY,
          JSON.stringify(signalControl),
        );
      } catch (error) {
        console.warn("Failed to persist signal config", error);
      }
    }
    if (workerRef.current && workerReadyRef.current) {
      workerRef.current.postMessage({
        type: "detector-config",
        config: signalControl,
      });
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    syncServerTime();
    const interval = window.setInterval(() => {
      syncServerTime();
    }, SERVER_TIME_SYNC_INTERVAL);

    return () => {
      window.clearInterval(interval);
    };
  }, [syncServerTime]);

  useEffect(() => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return;
    }
    const changed = engine.updateClockOffset(serverTimeOffsetMs);
    if (changed) {
      setTradingState(engine.getState());
    }
  }, [serverTimeOffsetMs]);

  useEffect(() => {
    let cancelled = false;
    symbolRef.current = settings.symbol;

    (async () => {
      try {
        const config = await fetchSymbolMarketConfig(settings.symbol);
        if (cancelled) {
          return;
        }
        if (config) {
          marketConfigRef.current = config;
          setMarketConfig(config);
          setSettings((prev) => {
            const normalized = normalizePriceStep(prev.priceStep, config);
            if (Math.abs(normalized - prev.priceStep) < 1e-9) {
              return prev;
            }
            return { ...prev, priceStep: normalized };
          });
        }
      } catch (error) {
        console.warn("Failed to load symbol market config", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settings.symbol]);

  useEffect(() => {
    resetTradeIdCache(tradeIdCacheRef.current);
    lastTradeTimeRef.current = null;
    recoveryQueueRef.current = [];
    backfillPromiseRef.current = null;
    recoveringRef.current = false;
    wasEverConnectedRef.current = false;
    reconnectAttemptsRef.current = 0;
    setConnectionDiagnostics((prev) => ({
      ...prev,
      reconnectAttempts: 0,
      lastGapFillAt: null,
      gapFrom: null,
      gapTo: null,
      gapTradeCount: 0,
    }));
  }, [settings.symbol]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return () => {};
    }
    if (mode !== "live") {
      return () => {};
    }

    const stream = new BinanceAggTradeStream(settings.symbol, {
      handlers: {
        onTrade: processIncomingTrade,
        onStatusChange: handleStatusChange,
        onError: handleStreamError,
        onOpen: handleStreamOpen,
        onClose: handleStreamClose,
      },
    });

    streamRef.current = stream;
    wasEverConnectedRef.current = false;
    stream.connect();

    return () => {
      flushTrades(true);
      stream.disconnect();
      streamRef.current = null;
      recoveringRef.current = false;
      recoveryQueueRef.current = [];
      backfillPromiseRef.current = null;
    };
  }, [
    mode,
    settings.symbol,
    processIncomingTrade,
    handleStatusChange,
    handleStreamError,
    handleStreamOpen,
    handleStreamClose,
    flushTrades,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return () => {};
    }
    if (mode !== "live") {
      depthStreamRef.current?.disconnect();
      depthStreamRef.current = null;
      depthBufferRef.current = [];
      setDepth(null);
      setDepthStatus("disconnected");
      setDepthStatusMeta(null);
      return () => {};
    }

    const stream = new BinanceDepthStream(
      settings.symbol,
      {
        onMessage: (message) => {
          if (!workerReadyRef.current || !workerRef.current) {
            return;
          }
          depthBufferRef.current.push(message);
          if (message.type === "snapshot" || depthBufferRef.current.length >= 6) {
            flushDepthUpdates(true);
          } else if (depthFlushTimerRef.current === null) {
            depthFlushTimerRef.current = window.setTimeout(() => flushDepthUpdates(true), 80);
          }
        },
        onStatusChange: (status, meta) => {
          setDepthStatus(status);
          if (meta?.scope === "snapshot") {
            setDepthStatusMeta({ ...meta });
          } else if (status === "disconnected") {
            setDepthStatusMeta(null);
          }
        },
        onError: (message) => {
          setLastError((prev) => prev ?? message);
        },
      },
      { levels: 100, snapshotIntervalMs: 60_000 },
    );

    depthStreamRef.current = stream;
    setDepthStatus("connecting");
    setDepthStatusMeta(null);
    stream.connect();

    return () => {
      stream.disconnect();
      if (depthFlushTimerRef.current !== null) {
        window.clearTimeout(depthFlushTimerRef.current);
        depthFlushTimerRef.current = null;
      }
      depthBufferRef.current = [];
      depthStreamRef.current = null;
    };
  }, [mode, settings.symbol, flushDepthUpdates]);

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

  useEffect(() => {
    return () => {
      if (depthFlushTimerRef.current !== null) {
        window.clearTimeout(depthFlushTimerRef.current);
        depthFlushTimerRef.current = null;
      }
      if (depthBufferRef.current.length) {
        flushDepthUpdates(true);
      }
    };
  }, [flushDepthUpdates]);

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
      window.localStorage.setItem(
        TRADING_SETTINGS_STORAGE_KEY,
        JSON.stringify(snapshot.settings),
      );
    } catch (error) {
      console.warn("Failed to persist trading settings", error);
    }
    try {
      window.localStorage.setItem(
        TRADING_HISTORY_STORAGE_KEY,
        JSON.stringify(snapshot.history),
      );
    } catch (error) {
      console.warn("Failed to persist trading history", error);
    }
  }, [tradingState.version]);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const setTimeframe = useCallback(
    (timeframe: Timeframe) => {
      updateSettings({ timeframe });
    },
    [updateSettings],
  );

  const setPriceStep = useCallback((priceStep: number) => {
    setSettings((prev) => {
      const normalized = normalizePriceStep(priceStep, marketConfigRef.current);
      if (Math.abs(normalized - prev.priceStep) < 1e-9) {
        return prev;
      }
      return { ...prev, priceStep: normalized };
    });
  }, []);

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

  const updateSignalOverrides = useCallback(
    (overrides: Partial<DetectorOverrides>) => {
      setSignalControl((prev) => ({
        ...prev,
        overrides: {
          ...prev.overrides,
          ...overrides,
        },
      }));
    },
    [],
  );

  const updateTradingSettings = useCallback(
    (partial: Partial<TradingSettings>) => {
      const engine = tradingEngineRef.current;
      if (!engine) {
        return false;
      }
      const changed = engine.updateSettings(partial);
      if (changed) {
        setTradingState(engine.getState());
      }
      return changed;
    },
    [],
  );

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

  const applyInvalidationAction = useCallback(
    (eventId: string, action: InvalidationActionType) => {
      const engine = tradingEngineRef.current;
      if (!engine) {
        return false;
      }
      const changed = engine.applyInvalidationAction(eventId, action);
      if (changed) {
        setTradingState(engine.getState());
      }
      return changed;
    },
    [],
  );

  const resetTradingDay = useCallback(() => {
    const engine = tradingEngineRef.current;
    if (!engine) {
      return;
    }
    engine.resetDay();
    setTradingState(engine.getState());
  }, []);

  const exportTradingHistory = useCallback(
    (format: "json" | "csv" = "json") => {
      const engine = tradingEngineRef.current;
      if (!engine) {
        return "";
      }
      return engine.exportHistory(format);
    },
    [],
  );

  const startReplay = useCallback(
    async (
      datasetId: string,
      speed: ReplaySpeed = replayStateRef.current.speed ?? 1,
    ) => {
      const recorder = recorderRef.current;
      if (!recorder) {
        return false;
      }
      try {
        const storage = recorder.getStorage();
        const dataset = await storage.getDataset(datasetId);
        if (!dataset) {
          setReplayState((prev) => ({
            ...prev,
            datasetId,
            status: "error",
            error: "Dataset not found",
          }));
          return false;
        }

        setReplayMetrics({ perMode: [] });
        setReplayState({
          datasetId,
          speed,
          status: "loading",
          progress: 0,
          error: null,
          durationMs: dataset.durationMs ?? null,
          startedAt: Date.now(),
          completedAt: null,
        });
        setMode("replay");
        setConnectionStatus("connecting");
        setLastError(null);

        liveSettingsRef.current = { ...settings };
        if (streamRef.current) {
          streamRef.current.disconnect();
          streamRef.current = null;
        }

        liveEngineRef.current = tradingEngineRef.current;

        const baseSettings = tradingEngineRef.current?.getSettings();
        const replayEngine = new TradingEngine({
          priceStep: dataset.priceStep,
          timeframeMs: timeframeToMs(dataset.timeframe),
          settings: baseSettings,
        });
        tradingEngineRef.current = replayEngine;
        setTradingState(replayEngine.getState());

        setSettings((prev) => ({
          ...prev,
          symbol: dataset.symbol,
          timeframe: dataset.timeframe,
          priceStep: dataset.priceStep,
        }));

        workerRef.current?.postMessage({ type: "clear" });
        tradeBufferRef.current = [];
        setBars([]);
        setSignals([]);
        setSignalStats(normalizeSignalStats());

        resetTradeIdCache(tradeIdCacheRef.current);
        lastTradeTimeRef.current = null;
        recoveringRef.current = false;
        recoveryQueueRef.current = [];
        backfillPromiseRef.current = null;

        const replayer = new AggTradeReplayer(storage);
        replayerRef.current = replayer;

        await replayer.start(datasetId, {
          speed,
          onTrade: processIncomingTrade,
          onProgress: (progress) => {
            setReplayState((prev) => ({
              ...prev,
              progress,
            }));
          },
          onStatusChange: (status) => {
            setReplayState((prev) => ({
              ...prev,
              status,
            }));
            if (status === "playing") {
              setConnectionStatus("connected");
            }
          },
          onComplete: () => {
            setReplayState((prev) => ({
              ...prev,
              status: "complete",
              progress: 1,
              completedAt: Date.now(),
            }));
          },
          onError: (error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            setReplayState((prev) => ({
              ...prev,
              status: "error",
              error: message,
            }));
            setLastError(message);
          },
        });

        const cachedMetrics = datasetMetricsCacheRef.current.get(datasetId);
        if (cachedMetrics) {
          setReplayMetrics(cachedMetrics);
        } else {
          computeReplayMetrics(storage, datasetId)
            .then((metrics) => {
              datasetMetricsCacheRef.current.set(datasetId, metrics);
              setReplayMetrics(metrics);
            })
            .catch((error) => {
              console.warn("Failed to compute replay metrics", error);
            });
        }

        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        replayerRef.current = null;
        if (liveEngineRef.current) {
          tradingEngineRef.current = liveEngineRef.current;
          setTradingState(liveEngineRef.current.getState());
          liveEngineRef.current = null;
        }
        if (liveSettingsRef.current) {
          setSettings((prev) => ({
            ...prev,
            symbol: liveSettingsRef.current!.symbol,
            timeframe: liveSettingsRef.current!.timeframe,
            priceStep: liveSettingsRef.current!.priceStep,
          }));
          liveSettingsRef.current = null;
        }
        setMode("live");
        setConnectionStatus("connecting");
        setReplayState((prev) => ({
          ...prev,
          datasetId,
          status: "error",
          error: message,
        }));
        setLastError(message);
        return false;
      }
    },
    [settings, processIncomingTrade],
  );

  const stopReplay = useCallback(async () => {
    const replayer = replayerRef.current;
    if (replayer) {
      try {
        await replayer.stop();
      } catch (error) {
        console.warn("Failed to stop replay", error);
      }
      replayerRef.current = null;
    }

    setReplayMetrics({ perMode: [] });
    setReplayState({ ...INITIAL_REPLAY_STATE });

    const savedSettings = liveSettingsRef.current;
    if (savedSettings) {
      setSettings((prev) => ({
        ...prev,
        symbol: savedSettings.symbol,
        timeframe: savedSettings.timeframe,
        priceStep: savedSettings.priceStep,
      }));
      liveSettingsRef.current = null;
    }

    const engine = liveEngineRef.current;
    if (engine) {
      tradingEngineRef.current = engine;
      liveEngineRef.current = null;
      setTradingState(engine.getState());
    } else {
      const fallback = new TradingEngine({
        priceStep: settings.priceStep,
        timeframeMs: timeframeToMs(settings.timeframe),
      });
      tradingEngineRef.current = fallback;
      setTradingState(fallback.getState());
    }

    workerRef.current?.postMessage({ type: "clear" });
    tradeBufferRef.current = [];
    setBars([]);
    setSignals([]);
    setSignalStats(normalizeSignalStats());
    resetTradeIdCache(tradeIdCacheRef.current);
    lastTradeTimeRef.current = null;
    recoveringRef.current = false;
    recoveryQueueRef.current = [];
    backfillPromiseRef.current = null;

    setMode("live");
    setConnectionStatus("connecting");
    setLastError(null);
  }, [settings.priceStep, settings.timeframe]);

  const changeReplaySpeed = useCallback((speed: ReplaySpeed) => {
    setReplayState((prev) => ({
      ...prev,
      speed,
    }));
    if (replayerRef.current) {
      replayerRef.current.setSpeed(speed);
    }
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
    depthStatus,
    depthStatusMeta,
    priceBounds,
    lastError,
    tradingState,
    updateTradingSettings,
    takeSignal,
    cancelPendingTrade,
    flattenPosition,
    applyInvalidationAction,
    resetTradingDay,
    exportTradingHistory,
    connectionDiagnostics,
    serverTimeOffsetMs,
    priceStepConfig,
    mode,
    recordingDataset,
    availableDatasets,
    replayState,
    replayMetrics,
    startReplay,
    stopReplay,
    setReplaySpeed: changeReplaySpeed,
    refreshDatasets,
  };
}

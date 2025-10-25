/// <reference lib="webworker" />

import { FootprintAggregator, timeframeToMs } from "@/lib/aggregator";
import type { AggregatorSettings } from "@/lib/aggregator";
import { createDefaultSignalControlState } from "@/lib/signals";
import type { DepthStreamMessage, FootprintState, SignalControlState, Trade } from "@/types";

interface InitMessage {
  type: "init";
  settings: WorkerSettings;
}

interface TradesMessage {
  type: "trades";
  trades: Trade[];
}

interface SettingsMessage {
  type: "settings";
  settings: Partial<WorkerSettings>;
  reset?: boolean;
}

interface DetectorConfigMessage {
  type: "detector-config";
  config: Partial<SignalControlState>;
}

interface DepthMessage {
  type: "depth";
  updates: DepthStreamMessage[];
}

interface ClearMessage {
  type: "clear";
}

type WorkerMessage = InitMessage | TradesMessage | SettingsMessage | DetectorConfigMessage | DepthMessage | ClearMessage;

type WorkerSettings = {
  timeframe: string;
  priceStep: number;
  maxBars: number;
};

let aggregator: FootprintAggregator | null = null;
let currentSettings: WorkerSettings | null = null;
let detectorConfig: SignalControlState = createDefaultSignalControlState();

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case "init":
        currentSettings = message.settings;
        aggregator = createAggregator(currentSettings, detectorConfig);
        sendState(aggregator.getState());
        break;
      case "trades":
        if (!aggregator) {
          if (!currentSettings) {
            return;
          }
          aggregator = createAggregator(currentSettings, detectorConfig);
        }
        if (!message.trades.length) {
          return;
        }
        sendState(aggregator.ingestTrades(message.trades));
        break;
      case "settings":
        currentSettings = {
          timeframe: message.settings.timeframe ?? currentSettings?.timeframe ?? "1m",
          priceStep: message.settings.priceStep ?? currentSettings?.priceStep ?? 0.5,
          maxBars: message.settings.maxBars ?? currentSettings?.maxBars ?? 400,
        };

        if (!aggregator) {
          aggregator = createAggregator(currentSettings, detectorConfig);
          sendState(aggregator.getState());
          break;
        }

        const partial: Partial<AggregatorSettings> = {};
        if (message.settings.timeframe) {
          partial.timeframeMs = timeframeToMs(message.settings.timeframe);
        }
        if (typeof message.settings.priceStep === "number") {
          partial.priceStep = message.settings.priceStep;
        }
        if (typeof message.settings.maxBars === "number") {
          partial.maxBars = message.settings.maxBars;
        }

        aggregator.updateSettings(partial, { reset: message.reset });
        sendState(aggregator.getState());
        break;
      case "detector-config":
        detectorConfig = mergeSignalConfig(detectorConfig, message.config);
        if (aggregator) {
          aggregator.updateSignalConfig(detectorConfig);
          sendState(aggregator.getState());
        } else {
          sendState(emptyState());
        }
        break;
      case "depth":
        if (!aggregator) {
          if (!currentSettings) {
            return;
          }
          aggregator = createAggregator(currentSettings, detectorConfig);
        }
        sendState(aggregator.ingestDepth(message.updates));
        break;
      case "clear":
        aggregator?.reset();
        sendState(aggregator ? aggregator.getState() : emptyState());
        break;
      default:
        break;
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    ctx.postMessage({ type: "error", message: messageText });
  }
};

function createAggregator(settings: WorkerSettings, config: SignalControlState) {
  const timeframeMs = timeframeToMs(settings.timeframe);
  const instance = new FootprintAggregator({
    timeframeMs,
    priceStep: settings.priceStep,
    maxBars: settings.maxBars,
  });
  instance.updateSignalConfig(config);
  return instance;
}

function sendState(state: FootprintState) {
  ctx.postMessage({ type: "state", state });
}

function mergeSignalConfig(
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

function emptyState(): FootprintState {
  return {
    bars: [],
    signals: [],
    signalStats: {
      dailyCount: 0,
      estimatePerDay: 0,
      lastReset: 0,
      sessionCount: {
        asia: 0,
        eu: 0,
        us: 0,
        other: 0,
      },
    },
  };
}

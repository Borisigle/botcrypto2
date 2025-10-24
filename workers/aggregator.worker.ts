/// <reference lib="webworker" />

import { FootprintAggregator, timeframeToMs } from "@/lib/aggregator";
import type { AggregatorSettings } from "@/lib/aggregator";
import type { FootprintState, Trade } from "@/types";

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

interface ClearMessage {
  type: "clear";
}

type WorkerMessage = InitMessage | TradesMessage | SettingsMessage | ClearMessage;

type WorkerSettings = {
  timeframe: string;
  priceStep: number;
  maxBars: number;
};

let aggregator: FootprintAggregator | null = null;
let currentSettings: WorkerSettings | null = null;

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case "init":
        currentSettings = message.settings;
        aggregator = createAggregator(currentSettings);
        sendState(aggregator.getState());
        break;
      case "trades":
        if (!aggregator) {
          if (!currentSettings) {
            return;
          }
          aggregator = createAggregator(currentSettings);
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
          aggregator = createAggregator(currentSettings);
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
      case "clear":
        aggregator?.reset();
        sendState(aggregator?.getState() ?? { bars: [] });
        break;
      default:
        break;
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    ctx.postMessage({ type: "error", message: messageText });
  }
};

function createAggregator(settings: WorkerSettings) {
  const timeframeMs = timeframeToMs(settings.timeframe);
  return new FootprintAggregator({
    timeframeMs,
    priceStep: settings.priceStep,
    maxBars: settings.maxBars,
  });
}

function sendState(state: FootprintState) {
  ctx.postMessage({ type: "state", state });
}

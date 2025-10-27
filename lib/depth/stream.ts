import type { ConnectionStatus, DepthSnapshot, DepthStreamMessage } from "@/types";

import { clampDepthLimit, DepthSnapshotError, fetchDepthSnapshot, type StreamStatusMeta } from "@/lib/binance";

interface DepthStreamHandlers {
  onMessage: (message: DepthStreamMessage) => void;
  onStatusChange?: (status: ConnectionStatus, meta?: StreamStatusMeta) => void;
  onError?: (message: string) => void;
}

interface DepthStreamOptions {
  levels?: number;
  snapshotIntervalMs?: number;
}

const STREAM_BASE = "wss://fstream.binance.com/stream?streams=";
const MAX_BACKOFF = 30_000;
const DEFAULT_SNAPSHOT_INTERVAL = 60_000;
const MAX_BUFFERED_DIFFS = 800;
const SNAPSHOT_BACKOFF_STEPS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class BinanceDepthStream {
  private ws: WebSocket | null = null;

  private readonly handlers: DepthStreamHandlers;

  private readonly levelLimit: number;

  private readonly snapshotIntervalMs: number;

  private shouldReconnect = true;

  private reconnectAttempts = 0;

  private reconnectTimer: number | null = null;

  private snapshotTimer: number | null = null;

  private status: ConnectionStatus = "connecting";

  private symbol: string;

  private url: string;

  private pendingDiffs: DepthStreamMessage[] = [];

  private lastUpdateId = 0;

  private synced = false;

  private fetchingSnapshot = false;

  private snapshotAttempts = 0;

  private nextSnapshotDue: number | null = null;

  constructor(symbol: string, handlers: DepthStreamHandlers, options?: DepthStreamOptions) {
    this.symbol = symbol.toUpperCase();
    this.handlers = handlers;
    this.levelLimit = clampDepthLimit(options?.levels);
    this.snapshotIntervalMs = Math.max(15_000, options?.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL);
    this.url = buildStreamUrl(this.symbol);
  }

  connect() {
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.snapshotAttempts = 0;
    this.nextSnapshotDue = null;
    this.openConnection();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.synced = false;
    this.snapshotAttempts = 0;
    this.nextSnapshotDue = null;
    this.setStatus("disconnected", { scope: "ws", attempts: this.reconnectAttempts });
  }

  updateSymbol(symbol: string) {
    const next = symbol.toUpperCase();
    if (next === this.symbol) {
      return;
    }
    this.symbol = next;
    this.url = buildStreamUrl(this.symbol);
    this.synced = false;
    this.lastUpdateId = 0;
    this.pendingDiffs = [];
    this.snapshotAttempts = 0;
    this.nextSnapshotDue = null;
    this.disconnect();
    this.connect();
  }

  private openConnection() {
    this.clearTimers();
    const phase: ConnectionStatus = this.reconnectAttempts === 0 ? "connecting" : "reconnecting";
    this.setStatus(phase, { attempts: this.reconnectAttempts, scope: "ws" });

    try {
      this.ws = new WebSocket(this.url);
    } catch (error) {
      this.scheduleReconnect();
      this.handlers.onError?.(toMessage(error));
      return;
    }

    this.ws.onopen = () => {
      const attempts = this.reconnectAttempts;
      this.reconnectAttempts = 0;
      this.setStatus("connected", { attempts, scope: "ws" });
      this.synced = false;
      this.lastUpdateId = 0;
      this.pendingDiffs = [];
      this.snapshotAttempts = 0;
      this.scheduleSnapshotFetch(0);
    };

    this.ws.onmessage = (event) => {
      const dispatch = (raw: string) => {
        const diff = parseDepthDiff(raw);
        if (!diff) {
          return;
        }
        this.handleDiff({ type: "diff", diff });
      };

      if (typeof event.data === "string") {
        dispatch(event.data);
      } else if (event.data instanceof Blob) {
        event.data.text().then(dispatch).catch((error) => {
          this.handlers.onError?.(toMessage(error));
        });
      }
    };

    this.ws.onerror = () => {
      this.setStatus("reconnecting", { attempts: this.reconnectAttempts, scope: "ws" });
      this.ws?.close();
    };

    this.ws.onclose = () => {
      this.clearSnapshotTimer();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected", { attempts: this.reconnectAttempts, scope: "ws" });
      }
    };
  }

  private scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(MAX_BACKOFF, 1_000 * 2 ** (this.reconnectAttempts - 1));
    this.setStatus("reconnecting", {
      attempts: this.reconnectAttempts,
      nextRetryMs: delay,
      scope: "ws",
    });
    this.clearTimers();
    this.reconnectTimer = window.setTimeout(() => this.openConnection(), delay);
  }

  private scheduleSnapshotFetch(delayMs: number) {
    const delay = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : this.snapshotIntervalMs;
    const now = Date.now();
    const due = now + delay;

    if (this.snapshotTimer !== null && this.nextSnapshotDue !== null) {
      if (due >= this.nextSnapshotDue) {
        return;
      }
      window.clearTimeout(this.snapshotTimer);
    }

    this.snapshotTimer = window.setTimeout(() => {
      this.snapshotTimer = null;
      this.nextSnapshotDue = null;
      void this.fetchSnapshot();
    }, delay);
    this.nextSnapshotDue = due;
  }

  private async fetchSnapshot() {
    if (this.fetchingSnapshot) {
      return;
    }

    this.fetchingSnapshot = true;

    try {
      const snapshot = await fetchDepthSnapshot(this.symbol, this.levelLimit);
      this.applySnapshot(snapshot);
      this.snapshotAttempts = 0;
      const refreshDelay = this.snapshotIntervalMs;
      this.emitSnapshotStatus({
        level: "success",
        message: `Depth snapshot OK — refresh in ${formatDuration(refreshDelay)}`,
        nextRetryMs: refreshDelay,
        attempts: this.snapshotAttempts,
      });
      this.scheduleSnapshotFetch(refreshDelay);
    } catch (error) {
      this.synced = false;
      const delay = this.nextSnapshotDelay();
      const attempts = this.snapshotAttempts;
      const statusCode = error instanceof DepthSnapshotError ? error.status : undefined;
      const message = statusCode
        ? `Depth snapshot error ${statusCode} — retry in ${formatDuration(delay)}`
        : `Depth snapshot failed — retry in ${formatDuration(delay)}`;
      this.logSnapshotWarning(message, error);
      this.emitSnapshotStatus({
        level: "error",
        message,
        nextRetryMs: delay,
        attempts,
        statusCode,
      });
      if (attempts === 1) {
        this.handlers.onError?.(message);
      }
      this.scheduleSnapshotFetch(delay);
    } finally {
      this.fetchingSnapshot = false;
    }
  }

  private nextSnapshotDelay(): number {
    const index = Math.min(this.snapshotAttempts, SNAPSHOT_BACKOFF_STEPS.length - 1);
    const delay = SNAPSHOT_BACKOFF_STEPS[index];
    this.snapshotAttempts += 1;
    return delay;
  }

  private emitSnapshotStatus(meta: Partial<StreamStatusMeta>) {
    this.setStatus(this.status, {
      scope: "snapshot",
      ...meta,
    });
  }

  private logSnapshotWarning(message: string, error?: unknown) {
    if (error instanceof Error) {
      if (error.message && error.message !== message) {
        console.warn(`[depth] ${message} (${error.message})`);
      } else {
        console.warn(`[depth] ${message}`);
      }
      return;
    }
    if (error !== undefined) {
      console.warn(`[depth] ${message}`, error);
      return;
    }
    console.warn(`[depth] ${message}`);
  }

  private ensureSnapshotScheduled() {
    if (this.fetchingSnapshot) {
      return;
    }
    if (this.snapshotAttempts > 0) {
      if (this.snapshotTimer === null) {
        const index = Math.min(this.snapshotAttempts, SNAPSHOT_BACKOFF_STEPS.length - 1);
        this.scheduleSnapshotFetch(SNAPSHOT_BACKOFF_STEPS[index]);
      }
      return;
    }
    this.scheduleSnapshotFetch(0);
  }

  private applySnapshot(snapshot: DepthSnapshot) {
    this.lastUpdateId = snapshot.lastUpdateId;
    this.synced = true;
    this.handlers.onMessage({ type: "snapshot", snapshot });
    this.flushPendingDiffs();
  }

  private flushPendingDiffs() {
    if (!this.synced || !this.pendingDiffs.length) {
      this.pendingDiffs = [];
      return;
    }
    const queued = this.pendingDiffs.slice().sort((a, b) => {
      if (a.type !== "diff" || b.type !== "diff") {
        return 0;
      }
      return a.diff.firstUpdateId - b.diff.firstUpdateId;
    });
    this.pendingDiffs = [];
    for (const message of queued) {
      if (message.type === "diff") {
        this.applyDiff(message.diff);
      }
    }
  }

  private handleDiff(message: DepthStreamMessage) {
    if (!this.synced) {
      this.pendingDiffs.push(message);
      if (this.pendingDiffs.length > MAX_BUFFERED_DIFFS) {
        this.pendingDiffs.splice(0, this.pendingDiffs.length - MAX_BUFFERED_DIFFS);
      }
      this.ensureSnapshotScheduled();
      return;
    }
    if (message.type === "diff") {
      this.applyDiff(message.diff);
    }
  }

  private applyDiff(diff: DepthStreamMessage["diff"]) {
    if (!this.synced) {
      return;
    }
    if (diff.finalUpdateId <= this.lastUpdateId) {
      return;
    }

    if (diff.firstUpdateId > this.lastUpdateId + 1) {
      this.triggerResync();
      return;
    }

    if (diff.finalUpdateId < this.lastUpdateId + 1) {
      return;
    }

    this.lastUpdateId = diff.finalUpdateId;
    this.handlers.onMessage({ type: "diff", diff });
  }

  private triggerResync() {
    this.synced = false;
    this.lastUpdateId = 0;
    this.pendingDiffs = [];
    this.ensureSnapshotScheduled();
  }

  private setStatus(status: ConnectionStatus, meta?: StreamStatusMeta) {
    if (this.status === status && !meta) {
      return;
    }
    this.status = status;
    this.handlers.onStatusChange?.(status, meta ?? { attempts: this.reconnectAttempts });
  }

  private clearTimers() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearSnapshotTimer();
  }

  private clearSnapshotTimer() {
    if (this.snapshotTimer !== null) {
      window.clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.nextSnapshotDue = null;
  }
}

function buildStreamUrl(symbol: string): string {
  const streamKey = `${symbol.toLowerCase()}@depth@100ms`;
  return `${STREAM_BASE}${streamKey}`;
}

function parseDepthDiff(raw: string): DepthStreamMessage["diff"] | null {
  try {
    const payload = JSON.parse(raw);
    const data = payload?.data ?? payload;
    if (!data || typeof data !== "object") {
      return null;
    }
    const firstUpdateId = Number(data.U ?? data.u ?? data.lastUpdateId);
    const finalUpdateId = Number(data.u ?? data.U ?? data.lastUpdateId);
    const eventTime = Number(data.E ?? Date.now());
    const transactionTime = Number(data.T ?? data.E ?? Date.now());
    const bids = Array.isArray(data.b)
      ? data.b
          .map((entry: unknown) => toDepthLevel(entry))
          .filter((level): level is { price: number; quantity: number } => level !== null)
      : [];
    const asks = Array.isArray(data.a)
      ? data.a
          .map((entry: unknown) => toDepthLevel(entry))
          .filter((level): level is { price: number; quantity: number } => level !== null)
      : [];

    if (!Number.isFinite(firstUpdateId) || !Number.isFinite(finalUpdateId)) {
      return null;
    }

    return {
      firstUpdateId: Math.trunc(firstUpdateId),
      finalUpdateId: Math.trunc(finalUpdateId),
      eventTime,
      transactionTime,
      bids,
      asks,
    };
  } catch (error) {
    console.warn("Failed to parse depth diff", error);
    return null;
  }
}

function toDepthLevel(entry: unknown): { price: number; quantity: number } | null {
  if (!Array.isArray(entry) || entry.length < 2) {
    return null;
  }
  const price = Number(entry[0]);
  const quantity = Number(entry[1]);
  if (!Number.isFinite(price) || !Number.isFinite(quantity)) {
    return null;
  }
  return { price, quantity };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    const minutes = ms / 60_000;
    return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
  }
  const hours = ms / 3_600_000;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { ConnectionStatus, DepthLevel, DepthSnapshot, SymbolMarketConfig, Trade } from "@/types";

const STREAM_BASE = "wss://fstream.binance.com/stream?streams=";
const REST_BASE = "https://fapi.binance.com/fapi/v1";
const MAX_BACKOFF = 30_000;
const MAX_AGG_TRADE_LIMIT = 1000;

export interface StreamStatusMeta {
  attempts?: number;
  nextRetryMs?: number;
}

export interface WSHandlers {
  onTrade?: (trade: Trade) => void;
  onDepth?: (payload: unknown) => void;
  onStatusChange?: (status: ConnectionStatus, meta?: StreamStatusMeta) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: (event?: CloseEvent) => void;
}

interface BinanceAggTradeStreamOptions {
  handlers?: WSHandlers;
}

export class BinanceAggTradeStream {
  private ws: WebSocket | null = null;

  private reconnectAttempts = 0;

  private reconnectTimer: number | null = null;

  private shouldReconnect = true;

  private currentStatus: ConnectionStatus = "connecting";

  private readonly url: string;

  private readonly handlers: WSHandlers;

  constructor(symbol: string, options?: BinanceAggTradeStreamOptions) {
    const opts = options ?? {};
    this.handlers = opts.handlers ? { ...opts.handlers } : {};
    const streamKey = `${symbol.toLowerCase()}@aggTrade`;
    this.url = `${STREAM_BASE}${streamKey}`;
  }

  connect() {
    this.clearTimer();
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.openConnection();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.clearTimer();
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected", { attempts: this.reconnectAttempts });
  }

  private openConnection() {
    this.clearTimer();
    const phase: ConnectionStatus = this.reconnectAttempts === 0 ? "connecting" : "reconnecting";
    this.setStatus(phase, { attempts: this.reconnectAttempts });

    try {
      this.ws = new WebSocket(this.url);
    } catch (error) {
      this.scheduleReconnect();
      this.emitError(error);
      return;
    }

    this.ws.onopen = () => {
      const attempts = this.reconnectAttempts;
      this.reconnectAttempts = 0;
      this.setStatus("connected", { attempts });
      this.handleOpen();
    };

    this.ws.onmessage = (event) => {
      const dispatch = (raw: string) => {
        this.dispatchMessage(raw);
      };

      if (typeof event.data === "string") {
        dispatch(event.data);
      } else if (event.data instanceof Blob) {
        event.data
          .text()
          .then(dispatch)
          .catch((error) => {
            this.emitError(error);
          });
      } else {
        devWarn("[binance] Received unsupported WebSocket message type", event.data);
      }
    };

    this.ws.onerror = (event) => {
      this.setStatus("reconnecting", { attempts: this.reconnectAttempts });
      const payload = event instanceof ErrorEvent ? event.error ?? event.message : event;
      this.emitError(payload);
      this.ws?.close();
    };

    this.ws.onclose = (event) => {
      this.handleClose(event);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected", { attempts: this.reconnectAttempts });
      }
    };
  }

  private dispatchMessage(raw: string) {
    dispatchStreamMessage(raw, this.handlers, (error) => this.emitError(error));
  }

  private scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** (this.reconnectAttempts - 1));
    this.clearTimer();
    this.setStatus("reconnecting", { attempts: this.reconnectAttempts, nextRetryMs: delay });
    this.reconnectTimer = window.setTimeout(() => this.openConnection(), delay);
  }

  private clearTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus, meta?: StreamStatusMeta) {
    const unchanged = this.currentStatus === status;
    this.currentStatus = status;

    if (unchanged && !meta) {
      return;
    }

    const payload: StreamStatusMeta | undefined = meta
      ? { ...meta }
      : { attempts: this.reconnectAttempts };

    if (payload && payload.attempts === undefined) {
      payload.attempts = this.reconnectAttempts;
    }

    const handler = this.handlers.onStatusChange;
    if (typeof handler === "function") {
      try {
        handler(status, payload);
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private handleOpen() {
    const handler = this.handlers.onOpen;
    if (typeof handler === "function") {
      try {
        handler();
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private handleClose(event?: CloseEvent) {
    const handler = this.handlers.onClose;
    if (typeof handler === "function") {
      try {
        handler(event);
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  private emitError(error: unknown) {
    const handler = this.handlers.onError;
    if (typeof handler === "function") {
      try {
        handler(error);
        return;
      } catch (handlerError) {
        devWarn("[binance] onError handler threw", handlerError);
      }
    }

    if (!isProduction()) {
      console.error("[binance] Stream error", error);
    }
  }
}

interface AggTradeResponse {
  a?: number | string;
  A?: number | string;
  t?: number | string;
  p?: string | number;
  q?: string | number;
  T?: number | string;
  E?: number | string;
  m?: boolean;
}

interface ExchangeInfoFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minPrice?: string;
  maxPrice?: string;
}

interface ExchangeInfoSymbol {
  symbol: string;
  filters: ExchangeInfoFilter[];
}

interface ExchangeInfoResponse {
  symbols?: ExchangeInfoSymbol[];
}

interface DepthSnapshotResponse {
  lastUpdateId?: number | string;
  E?: number | string;
  T?: number | string;
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
}

export interface FetchAggTradesParams {
  symbol: string;
  startTime?: number;
  endTime?: number;
  fromId?: number;
  limit?: number;
}

export async function fetchServerTime(): Promise<number> {
  ensureFetch();
  const response = await fetch(`${REST_BASE}/time`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Binance server time: ${response.status}`);
  }
  const payload = await response.json();
  const serverTime = safeNumber(payload?.serverTime);
  if (serverTime === null) {
    throw new Error("Invalid server time response from Binance");
  }
  return serverTime;
}

export async function fetchAggTrades(params: FetchAggTradesParams): Promise<Trade[]> {
  ensureFetch();
  const { symbol, startTime, endTime, fromId, limit = MAX_AGG_TRADE_LIMIT } = params;
  const url = new URL(`${REST_BASE}/aggTrades`);
  url.searchParams.set("symbol", symbol.toUpperCase());

  if (typeof fromId === "number" && Number.isFinite(fromId)) {
    url.searchParams.set("fromId", String(Math.max(0, Math.floor(fromId))));
  }
  if (typeof startTime === "number" && Number.isFinite(startTime)) {
    url.searchParams.set("startTime", String(Math.max(0, Math.floor(startTime))));
  }
  if (typeof endTime === "number" && Number.isFinite(endTime)) {
    url.searchParams.set("endTime", String(Math.max(0, Math.floor(endTime))));
  }

  const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_AGG_TRADE_LIMIT);
  url.searchParams.set("limit", String(cappedLimit));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch Binance aggTrades: ${response.status}`);
  }

  const payload = (await response.json()) as AggTradeResponse[];
  if (!Array.isArray(payload)) {
    return [];
  }

  const trades: Trade[] = [];

  for (const item of payload) {
    const trade = mapAggTrade(item);
    if (trade) {
      trades.push(trade);
    }
  }

  trades.sort((a, b) => (a.timestamp - b.timestamp) || (a.tradeId - b.tradeId));
  return trades;
}

export async function fetchSymbolMarketConfig(symbol: string): Promise<SymbolMarketConfig | null> {
  ensureFetch();
  const url = new URL(`${REST_BASE}/exchangeInfo`);
  url.searchParams.set("symbol", symbol.toUpperCase());
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch Binance exchangeInfo: ${response.status}`);
  }

  const payload = (await response.json()) as ExchangeInfoResponse;
  const info = payload.symbols?.find((item) => item.symbol === symbol.toUpperCase());
  if (!info) {
    return null;
  }

  const priceFilter = info.filters?.find((filter) => filter.filterType === "PRICE_FILTER");
  const lotSizeFilter = info.filters?.find((filter) => filter.filterType === "LOT_SIZE");

  const tickSize = sanitizeStep(safeNumber(priceFilter?.tickSize), 0.1);
  const stepSize = sanitizeStep(safeNumber(lotSizeFilter?.stepSize), tickSize);
  const minPriceStep = sanitizeStep(safeNumber(priceFilter?.minPrice), tickSize);
  const computedMax = safeNumber(priceFilter?.maxPrice);
  const maxCandidate =
    computedMax !== null && computedMax > 0 ? Math.min(computedMax, tickSize * 40) : tickSize * 40;
  const maxPriceStep = sanitizeStep(maxCandidate, tickSize * 40, tickSize);

  return {
    tickSize,
    stepSize,
    minPriceStep,
    maxPriceStep,
  };
}

export async function fetchDepthSnapshot(symbol: string, limit = 120): Promise<DepthSnapshot> {
  ensureFetch();
  const url = new URL(`${REST_BASE}/depth`);
  url.searchParams.set("symbol", symbol.toUpperCase());
  const depthLimit = Math.min(Math.max(Math.floor(limit), 5), 1000);
  url.searchParams.set("limit", String(depthLimit));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch Binance depth snapshot: ${response.status}`);
  }

  const payload = (await response.json()) as DepthSnapshotResponse;
  const lastUpdateId = safeNumber(payload.lastUpdateId);
  if (lastUpdateId === null) {
    throw new Error("Invalid depth snapshot response from Binance");
  }

  const bids = Array.isArray(payload.bids)
    ? payload.bids
        .map(mapDepthEntry)
        .filter((level): level is DepthLevel => level !== null)
        .slice(0, depthLimit)
    : [];
  const asks = Array.isArray(payload.asks)
    ? payload.asks
        .map(mapDepthEntry)
        .filter((level): level is DepthLevel => level !== null)
        .slice(0, depthLimit)
    : [];

  const timestampCandidate = safeNumber(payload.E ?? payload.T);
  const timestamp = Number.isFinite(timestampCandidate) ? (timestampCandidate as number) : Date.now();

  return {
    lastUpdateId: Math.trunc(lastUpdateId),
    bids,
    asks,
    timestamp,
  };
}

function mapDepthEntry(entry: [string, string]): DepthLevel | null {
  if (!Array.isArray(entry) || entry.length < 2) {
    return null;
  }
  const price = safeNumber(entry[0]);
  const quantity = safeNumber(entry[1]);
  if (price === null || quantity === null) {
    return null;
  }
  return { price, quantity };
}

function parseAggTrade(payload: unknown): Trade | null {
  if (!isRecord(payload)) {
    return null;
  }
  return mapAggTrade(payload as AggTradeResponse);
}

function mapAggTrade(data: AggTradeResponse): Trade | null {
  const price = safeNumber(data.p);
  const quantity = safeNumber(data.q);
  const timestamp = safeNumber(data.T ?? data.E);
  const tradeIdValue = safeNumber(data.a ?? data.A ?? data.t);
  const isBuyerMaker = Boolean(data.m);

  if (price === null || quantity === null || timestamp === null) {
    return null;
  }

  const tradeId = tradeIdValue !== null ? Math.trunc(tradeIdValue) : Math.trunc(timestamp);

  return {
    tradeId,
    price,
    quantity,
    timestamp,
    isBuyerMaker,
  };
}

function safeNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeStep(value: number | null, fallback: number, minimum?: number): number {
  const base = value !== null && value > 0 ? value : fallback;
  const min = minimum && minimum > 0 ? minimum : fallback;
  return Number(Math.max(min, base).toFixed(10));
}

function ensureFetch(): void {
  if (typeof fetch === "undefined") {
    throw new Error("Global fetch is not available in the current environment");
  }
}

function dispatchStreamMessage(raw: string, handlers: WSHandlers, emitError: (error: unknown) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    emitError(error);
    return;
  }

  const envelope = isRecord(parsed) ? parsed : null;
  const stream = typeof envelope?.["stream"] === "string" ? (envelope["stream"] as string) : undefined;
  const dataCandidate = envelope && "data" in envelope ? envelope["data"] : parsed;

  if (!isRecord(dataCandidate)) {
    return;
  }

  const record = dataCandidate;
  const eventType = typeof record["e"] === "string" ? (record["e"] as string) : undefined;

  if (eventType === "aggTrade" || (stream && stream.includes("@aggTrade"))) {
    const trade = parseAggTrade(record);
    if (!trade) {
      return;
    }
    const handler = handlers.onTrade;
    if (typeof handler === "function") {
      try {
        handler(trade);
      } catch (error) {
        emitError(error);
      }
    } else {
      devWarn("[binance] Dropped aggTrade message because onTrade handler is not a function.");
    }
    return;
  }

  if (eventType === "depthUpdate" || (stream && stream.includes("@depth"))) {
    const handler = handlers.onDepth;
    if (typeof handler === "function") {
      try {
        handler(record);
      } catch (error) {
        emitError(error);
      }
    } else {
      devWarn("[binance] Dropped depth message because onDepth handler is not a function.");
    }
  }
}

export function __testDispatchAggTradeMessage(
  raw: string,
  handlers?: WSHandlers,
  emitError?: (error: unknown) => void,
): void {
  dispatchStreamMessage(raw, handlers ?? {}, emitError ?? (() => {}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProduction(): boolean {
  return typeof process !== "undefined" && process.env?.NODE_ENV === "production";
}

function devWarn(message: string, ...args: unknown[]): void {
  if (isProduction()) {
    return;
  }
  if (args.length) {
    console.warn(message, ...args);
  } else {
    console.warn(message);
  }
}

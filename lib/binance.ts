import type { ConnectionStatus, Trade } from "@/types";

const STREAM_BASE = "wss://fstream.binance.com/stream?streams=";

export interface StreamHandlers {
  onTrade: (trade: Trade) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (message: string) => void;
}

const MAX_BACKOFF = 30_000;

export class BinanceAggTradeStream {
  private ws: WebSocket | null = null;

  private reconnectAttempts = 0;

  private reconnectTimer: number | null = null;

  private shouldReconnect = true;

  private currentStatus: ConnectionStatus = "connecting";

  private readonly url: string;

  constructor(symbol: string, private readonly handlers: StreamHandlers) {
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
    this.setStatus("disconnected");
  }

  private openConnection() {
    this.setStatus(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch (error) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
    };

    this.ws.onmessage = (event) => {
      const dispatch = (raw: string) => {
        const payload = parseAggTrade(raw);
        if (payload) {
          this.handlers.onTrade(payload);
        }
      };

      if (typeof event.data === "string") {
        dispatch(event.data);
      } else if (event.data instanceof Blob) {
        event.data
          .text()
          .then(dispatch)
          .catch((error) => {
            this.handlers.onError?.(error instanceof Error ? error.message : String(error));
          });
      }
    };

    this.ws.onerror = () => {
      this.setStatus("reconnecting");
      this.ws?.close();
    };

    this.ws.onclose = () => {
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected");
      }
    };
  }

  private scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** (this.reconnectAttempts - 1));
    this.clearTimer();
    this.setStatus("reconnecting");
    this.reconnectTimer = window.setTimeout(() => this.openConnection(), delay);
  }

  private clearTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus) {
    if (this.currentStatus === status) {
      return;
    }
    this.currentStatus = status;
    this.handlers.onStatusChange?.(status);
  }
}

function parseAggTrade(message: string): Trade | null {
  try {
    const parsed = JSON.parse(message);
    const data = parsed?.data;
    if (!data) {
      return null;
    }

    const price = Number(data.p);
    const quantity = Number(data.q);
    const timestamp = Number(data.T ?? data.E);
    const tradeId = Number(data.a ?? data.A ?? data.t);
    const isBuyerMaker = Boolean(data.m);

    if (!Number.isFinite(price) || !Number.isFinite(quantity) || !Number.isFinite(timestamp)) {
      return null;
    }

    return {
      tradeId: Number.isFinite(tradeId) ? tradeId : Date.now(),
      price,
      quantity,
      timestamp,
      isBuyerMaker,
    };
  } catch (error) {
    console.error("Failed to parse aggTrade", error);
    return null;
  }
}

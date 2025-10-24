import type {
  ConnectionDiagnostics,
  ConnectionStatus,
  FootprintMode,
  Timeframe,
} from "@/types";

interface StatusBarProps {
  status: ConnectionStatus;
  mode: FootprintMode;
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  barsCount: number;
  diagnostics: ConnectionDiagnostics;
  lastError?: string | null;
}

const STATUS_STYLES: Record<
  ConnectionStatus,
  { label: string; className: string }
> = {
  connecting: { label: "Connecting", className: "bg-yellow-400" },
  connected: { label: "Connected", className: "bg-emerald-500" },
  reconnecting: { label: "Reconnecting", className: "bg-orange-500" },
  disconnected: { label: "Disconnected", className: "bg-rose-500" },
};

export function StatusBar({
  status,
  mode,
  symbol,
  timeframe,
  priceStep,
  barsCount,
  diagnostics,
  lastError,
}: StatusBarProps) {
  const statusMeta = STATUS_STYLES[status];
  const offsetLabel = formatOffset(diagnostics.serverTimeOffsetMs);
  const modeLabel = mode === "replay" ? "Replay" : "Live";
  const modeClass = mode === "replay" ? "text-sky-200" : "text-emerald-200";
  const gapTimestamp = formatUtcTime(diagnostics.lastGapFillAt);
  const gapRange = formatRange(diagnostics.gapFrom, diagnostics.gapTo);
  const gapTrades = diagnostics.gapTradeCount;

  return (
    <footer className="flex flex-col gap-1 rounded-lg border border-white/5 bg-black/30 px-4 py-3 text-sm text-white/70">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 font-medium text-white">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${statusMeta.className}`}
            aria-hidden
          />
          {statusMeta.label}
        </span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Mode</span>
          <span className={`font-mono ${modeClass}`}>{modeLabel}</span>
        </span>
        <span className="hidden h-4 w-px bg-white/10 sm:block" aria-hidden />
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Symbol</span>
          <span className="font-mono uppercase text-white/60">{symbol}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">TF</span>
          <span className="font-mono text-white/60">{timeframe}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Step</span>
          <span className="font-mono text-white/60">
            {priceStep.toFixed(2)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Bars</span>
          <span className="font-mono text-white/60">{barsCount}</span>
        </span>
        <span className="hidden h-4 w-px bg-white/10 sm:block" aria-hidden />
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Offset</span>
          <span className="font-mono text-white/60">{offsetLabel}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Reconnects</span>
          <span className="font-mono text-white/60">
            {diagnostics.reconnectAttempts}
          </span>
        </span>
      </div>
      {gapTimestamp ? (
        <p className="text-xs text-emerald-300/80">
          Gap filled {gapTimestamp} UTC
          {gapRange ? ` • span ${gapRange}` : ""}
          {typeof gapTrades === "number"
            ? ` • ${gapTrades} trade${gapTrades === 1 ? "" : "s"}`
            : ""}
        </p>
      ) : null}
      {lastError ? (
        <p className="text-xs text-rose-300/80">{lastError}</p>
      ) : null}
    </footer>
  );
}

function formatOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs)) {
    return "--";
  }
  if (Math.abs(offsetMs) < 1) {
    return "0ms";
  }
  return `${offsetMs > 0 ? "+" : ""}${Math.round(offsetMs)}ms`;
}

function formatUtcTime(timestamp: number | null): string | null {
  if (!timestamp) {
    return null;
  }
  const iso = new Date(timestamp).toISOString();
  return iso.slice(11, 19);
}

function formatRange(from: number | null, to: number | null): string | null {
  if (from === null || to === null || to < from) {
    return null;
  }
  const ms = to - from;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
  }
  const minutes = ms / 60_000;
  if (minutes < 10) {
    return `${minutes.toFixed(1)}m`;
  }
  return `${Math.round(minutes)}m`;
}

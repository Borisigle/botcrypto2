import type { StreamStatusMeta } from "@/lib/binance";
import type {
  ConnectionDiagnostics,
  ConnectionStatus,
  FootprintMode,
  RiskGuardrailState,
  RiskGuardrailStatus,
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
  guardrails: RiskGuardrailState;
  depthStatus: ConnectionStatus;
  depthMeta?: StreamStatusMeta | null;
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

const GUARDRAIL_STATUS_META: Record<
  RiskGuardrailStatus,
  { label: string; className: string; reasonClass: string }
> = {
  ok: { label: "OK", className: "text-emerald-200", reasonClass: "text-emerald-200" },
  limited: { label: "Limitado", className: "text-sky-200", reasonClass: "text-sky-300/80" },
  cooldown: { label: "Cooldown", className: "text-amber-200", reasonClass: "text-amber-300/80" },
  locked: { label: "Bloqueado", className: "text-rose-300", reasonClass: "text-rose-300/80" },
};

export function StatusBar({
  status,
  mode,
  symbol,
  timeframe,
  priceStep,
  barsCount,
  diagnostics,
  guardrails,
  depthStatus,
  depthMeta,
  lastError,
}: StatusBarProps) {
  const statusMeta = STATUS_STYLES[status];
  const offsetLabel = formatOffset(diagnostics.serverTimeOffsetMs);
  const modeLabel = mode === "replay" ? "Replay" : "Live";
  const modeClass = mode === "replay" ? "text-sky-200" : "text-emerald-200";
  const gapTimestamp = formatUtcTime(diagnostics.lastGapFillAt);
  const gapRange = formatRange(diagnostics.gapFrom, diagnostics.gapTo);
  const gapTrades = diagnostics.gapTradeCount;
  const guardrailMeta = GUARDRAIL_STATUS_META[guardrails.status];
  const guardrailReason = guardrails.status === "ok"
    ? null
    : guardrails.activeBlocks[0]?.reason ?? guardrails.lastBlock?.reason ?? null;
  const depthStatusMetaResolved = depthMeta ?? null;
  const depthStatusInfo = STATUS_STYLES[depthStatus];
  const depthMessage = depthStatusMetaResolved?.message ?? null;
  const depthAttempts = depthStatusMetaResolved?.attempts ?? 0;
  const depthMessageClass = getDepthMessageClass(depthStatusMetaResolved?.level);

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
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Guardrails</span>
          <span className={`font-mono ${guardrailMeta.className}`}>{guardrailMeta.label}</span>
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
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Depth</span>
          <span className="flex items-center gap-1 font-medium text-white">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${depthStatusInfo.className}`}
              aria-hidden
            />
            <span className="font-mono text-white/60">{depthStatusInfo.label}</span>
          </span>
        </span>
      </div>
      {guardrailReason ? (
        <p className={`text-xs ${guardrailMeta.reasonClass}`}>Guardrail: {guardrailReason}</p>
      ) : null}
      {gapTimestamp ? (
        <p className="text-xs text-emerald-300/80">
          Gap filled {gapTimestamp} UTC
          {gapRange ? ` • span ${gapRange}` : ""}
          {typeof gapTrades === "number"
            ? ` • ${gapTrades} trade${gapTrades === 1 ? "" : "s"}`
            : ""}
        </p>
      ) : null}
      {depthMessage ? (
        <p className={`text-xs ${depthMessageClass}`}>
          {depthMessage}
          {depthAttempts > 1 ? ` (attempt ${depthAttempts})` : ""}
        </p>
      ) : null}
      {lastError ? (
        <p className="text-xs text-rose-300/80">{lastError}</p>
      ) : null}
    </footer>
  );
}

function getDepthMessageClass(level?: StreamStatusMeta["level"]): string {
  switch (level) {
    case "success":
      return "text-emerald-300/80";
    case "warning":
      return "text-amber-300/80";
    case "error":
      return "text-rose-300/80";
    default:
      return "text-sky-300/80";
  }
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

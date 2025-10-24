import type { ConnectionStatus, Timeframe } from "@/types";

interface StatusBarProps {
  status: ConnectionStatus;
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  barsCount: number;
  lastError?: string | null;
}

const STATUS_STYLES: Record<ConnectionStatus, { label: string; className: string }> = {
  connecting: { label: "Connecting", className: "bg-yellow-400" },
  connected: { label: "Connected", className: "bg-emerald-500" },
  reconnecting: { label: "Reconnecting", className: "bg-orange-500" },
  disconnected: { label: "Disconnected", className: "bg-rose-500" },
};

export function StatusBar({ status, symbol, timeframe, priceStep, barsCount, lastError }: StatusBarProps) {
  const statusMeta = STATUS_STYLES[status];

  return (
    <footer className="flex flex-col gap-1 rounded-lg border border-white/5 bg-black/30 px-4 py-3 text-sm text-white/70">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 font-medium text-white">
          <span className={`inline-flex h-2.5 w-2.5 rounded-full ${statusMeta.className}`} aria-hidden />
          {statusMeta.label}
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
          <span className="font-mono text-white/60">{priceStep.toFixed(2)}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-white/80">Bars</span>
          <span className="font-mono text-white/60">{barsCount}</span>
        </span>
      </div>
      {lastError ? (
        <p className="text-xs text-rose-300/80">{lastError}</p>
      ) : null}
    </footer>
  );
}

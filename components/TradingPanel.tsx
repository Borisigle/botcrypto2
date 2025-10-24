import { useMemo } from "react";

import { InvalidationPanel } from "@/components/InvalidationPanel";
import type { FootprintSignal, InvalidationActionType, PendingTrade, Position, TradingState } from "@/types";

interface TradingPanelProps {
  signals: FootprintSignal[];
  tradingState: TradingState;
  onTakeSignal: (signalId: string) => void;
  onCancelPending: (id: string) => void;
  onFlattenPosition: (id: string) => void;
  onInvalidationAction: (eventId: string, action: InvalidationActionType) => void;
}

export function TradingPanel({ signals, tradingState, onTakeSignal, onCancelPending, onFlattenPosition, onInvalidationAction }: TradingPanelProps) {
  const { pending, positions, closed, settings, daily } = tradingState;
  const retestWindowMs = Math.max(0, settings.retestWindowMinutes) * 60_000;
  const now = Date.now();

  const activeSignalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of pending) {
      ids.add(item.signalId);
    }
    for (const item of positions) {
      ids.add(item.signalId);
    }
    return ids;
  }, [pending, positions]);

  const availableSignals = signals
    .filter((signal) => !activeSignalIds.has(signal.id))
    .filter((signal) => now - signal.timestamp <= retestWindowMs)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 6);

  const sortedPending = useMemo(() => [...pending].sort((a, b) => b.createdAt - a.createdAt), [pending]);
  const sortedPositions = useMemo(() => [...positions].sort((a, b) => b.entryTime - a.entryTime), [positions]);
  const recentClosed = useMemo(() => [...closed].slice(-8).reverse(), [closed]);
  const sortedInvalidations = useMemo(() => [...tradingState.invalidations].sort((a, b) => b.timestamp - a.timestamp), [tradingState.invalidations]);

  return (
    <section className="flex flex-col gap-4">
      <SignalsCard
        signals={availableSignals}
        onTakeSignal={onTakeSignal}
        retestWindowMs={retestWindowMs}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <PendingCard pending={sortedPending} onCancelPending={onCancelPending} now={now} />
        <PositionsCard positions={sortedPositions} onFlattenPosition={onFlattenPosition} now={now} />
      </div>
      <InvalidationPanel events={sortedInvalidations} onAction={onInvalidationAction} />
      <ClosedTradesCard trades={recentClosed} />
      <DailySummaryCard daily={daily} riskPercent={settings.riskPerTradePercent} />
    </section>
  );
}

interface SignalsCardProps {
  signals: FootprintSignal[];
  onTakeSignal: (signalId: string) => void;
  retestWindowMs: number;
}

function SignalsCard({ signals, onTakeSignal, retestWindowMs }: SignalsCardProps) {
  return (
    <article className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/20">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white/80">Señales disponibles</h3>
          <p className="text-xs text-slate-400">Ventana de retest: {Math.round(retestWindowMs / 60_000)} min</p>
        </div>
      </header>
      {signals.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {signals.map((signal) => (
            <li
              key={signal.id}
              className="flex flex-col gap-1 rounded-md border border-white/10 bg-black/40 p-3 text-xs text-white/80 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className={`font-semibold uppercase ${signal.side === "long" ? "text-emerald-300" : "text-rose-300"}`}>
                  {signal.side === "long" ? "Long" : "Short"}
                </span>
                <span className="text-slate-300">{formatStrategy(signal.strategy)}</span>
                <span className="text-slate-400">{new Date(signal.timestamp).toLocaleTimeString()}</span>
                <span className="font-mono text-xs text-white/90">E: {signal.entry.toFixed(2)}</span>
                <span className="font-mono text-xs text-white/60">SL: {signal.stop.toFixed(2)}</span>
                <span className="font-mono text-xs text-white/60">T1: {signal.target1.toFixed(2)}</span>
              </div>
              <button
                type="button"
                className="mt-2 w-full rounded-md border border-emerald-400 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30 md:mt-0 md:w-auto"
                onClick={() => onTakeSignal(signal.id)}
              >
                Tomar señal
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-400">
          No hay señales pendientes dentro de la ventana de retest.
        </p>
      )}
    </article>
  );
}

interface PendingCardProps {
  pending: PendingTrade[];
  onCancelPending: (id: string) => void;
  now: number;
}

function PendingCard({ pending, onCancelPending, now }: PendingCardProps) {
  return (
    <article className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/20">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80">Trades pendientes</h3>
        <span className="text-xs text-slate-400">{pending.length} activos</span>
      </header>
      {pending.length ? (
        <ul className="mt-3 flex flex-col gap-2 text-xs text-white/80">
          {pending.map((trade) => {
            const remaining = trade.expiresAt - now;
            return (
              <li key={trade.id} className="flex flex-col gap-2 rounded-md border border-white/10 bg-black/40 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`font-semibold ${trade.side === "long" ? "text-emerald-300" : "text-rose-300"}`}>
                    {trade.side === "long" ? "Long" : "Short"}
                  </span>
                  <span className="text-slate-300">{formatStrategy(trade.strategy)}</span>
                  <span className="font-mono text-xs text-white/80">E: {trade.entry.toFixed(2)}</span>
                  <span className="font-mono text-xs text-white/60">SL: {trade.stop.toFixed(2)}</span>
                  <span className="font-mono text-xs text-white/60">T1: {trade.target1.toFixed(2)}</span>
                  <span className="font-mono text-xs text-white/60">T2: {trade.target2.toFixed(2)}</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>Expira en {formatDuration(remaining)}</span>
                  <button
                    type="button"
                    className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/70 transition hover:border-rose-400 hover:text-rose-200"
                    onClick={() => onCancelPending(trade.id)}
                  >
                    Cancelar
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-400">
          No hay trades pendientes.
        </p>
      )}
    </article>
  );
}

interface PositionsCardProps {
  positions: Position[];
  onFlattenPosition: (id: string) => void;
  now: number;
}

function PositionsCard({ positions, onFlattenPosition, now }: PositionsCardProps) {
  return (
    <article className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/20">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80">Posiciones abiertas</h3>
        <span className="text-xs text-slate-400">{positions.length} activas</span>
      </header>
      {positions.length ? (
        <ul className="mt-3 flex flex-col gap-2 text-xs text-white/80">
          {positions.map((position) => {
            const direction = position.side === "long" ? 1 : -1;
            const unrealized =
              position.riskAmount > 0
                ? ((position.lastPrice - position.entryFillPrice) * position.remainingSize * direction) / position.riskAmount
                : 0;
            const totalR = position.realizedR + unrealized;
            const hold = now - position.entryTime;
            return (
              <li key={position.id} className="flex flex-col gap-2 rounded-md border border-white/10 bg-black/40 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`font-semibold ${position.side === "long" ? "text-emerald-300" : "text-rose-300"}`}>
                    {position.side === "long" ? "Long" : "Short"}
                  </span>
                  <span className="text-slate-300">{formatStrategy(position.strategy)}</span>
                  <span className="font-mono text-xs text-white/80">E: {position.entryFillPrice.toFixed(2)}</span>
                  <span className="font-mono text-xs text-white/60">SL: {position.stopPrice.toFixed(2)}</span>
                  <span className="font-mono text-xs text-white/60">T2: {position.target2.toFixed(2)}</span>
                  {position.target1Hit ? <span className="text-emerald-200">TP1 ejecutado</span> : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                  <span>{`Hold: ${formatDuration(hold)}`}</span>
                  <span className={totalR >= 0 ? "text-emerald-300" : "text-rose-300"}>{formatR(totalR)}</span>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/70 transition hover:border-rose-400 hover:text-rose-200"
                    onClick={() => onFlattenPosition(position.id)}
                  >
                    Cerrar
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-400">
          No hay posiciones abiertas.
        </p>
      )}
    </article>
  );
}

interface ClosedTradesCardProps {
  trades: TradingState["closed"];
}

function ClosedTradesCard({ trades }: ClosedTradesCardProps) {
  return (
    <article className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/20">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80">Historial reciente</h3>
        <span className="text-xs text-slate-400">{trades.length} últimos</span>
      </header>
      {trades.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-xs text-white/80">
            <thead className="text-slate-400">
              <tr>
                <th className="px-2 py-1 font-medium">Hora</th>
                <th className="px-2 py-1 font-medium">Side</th>
                <th className="px-2 py-1 font-medium">Resultado</th>
                <th className="px-2 py-1 font-medium">First hit</th>
                <th className="px-2 py-1 font-medium text-right">RR</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id} className="odd:bg-black/30">
                  <td className="px-2 py-1 text-slate-300">{new Date(trade.exitTime).toLocaleTimeString()}</td>
                  <td className={`px-2 py-1 font-semibold ${trade.side === "long" ? "text-emerald-300" : "text-rose-300"}`}>
                    {trade.side === "long" ? "Long" : "Short"}
                  </td>
                  <td className="px-2 py-1 text-slate-300">{formatResult(trade.result)}</td>
                  <td className="px-2 py-1 text-slate-400">{formatFirstHit(trade.firstHit)}</td>
                  <td className={`px-2 py-1 text-right ${trade.realizedR >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    {formatR(trade.realizedR)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-400">
          Aún no hay operaciones cerradas hoy.
        </p>
      )}
    </article>
  );
}

interface DailySummaryCardProps {
  daily: TradingState["daily"];
  riskPercent: number;
}

function DailySummaryCard({ daily, riskPercent }: DailySummaryCardProps) {
  const totals = daily.totals;
  const expectancy = totals.expectancy;
  const netPercent = totals.netPercent * 100;

  return (
    <article className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/20">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white/80">Resumen diario</h3>
          <p className="text-xs text-slate-400">Risk {riskPercent.toFixed(2)}% · Expectancy {expectancy.toFixed(2)}R</p>
        </div>
        <div className="flex gap-3 text-xs text-white/80">
          <span>W: {totals.winners}</span>
          <span>L: {totals.losers}</span>
          <span>BE: {totals.breakeven}</span>
        </div>
      </header>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <SummaryStat label="Trades" value={totals.trades.toString()} />
        <SummaryStat label="Net R" value={totals.netR.toFixed(2)} accent={totals.netR >= 0} />
        <SummaryStat label="Net %" value={`${netPercent.toFixed(2)}%`} accent={netPercent >= 0} />
        <SummaryStat label="Win rate" value={`${(totals.winRate * 100).toFixed(1)}%`} />
        <SummaryStat label="Expectancy" value={`${expectancy.toFixed(2)}R`} accent={expectancy >= 0} />
        <SummaryStat label="Avg R" value={`${totals.avgR.toFixed(2)}R`} accent={totals.avgR >= 0} />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <SummaryTable title="Sesiones" data={daily.bySession} />
        <SummaryTable title="Estrategias" data={daily.byStrategy} />
      </div>
    </article>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  accent?: boolean;
}

function SummaryStat({ label, value, accent }: SummaryStatProps) {
  return (
    <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
      <span className="text-xs text-slate-400">{label}</span>
      <div className={`text-sm font-semibold ${accent === undefined ? "text-white" : accent ? "text-emerald-300" : "text-rose-300"}`}>
        {value}
      </div>
    </div>
  );
}

interface SummaryTableProps {
  title: string;
  data: Record<string, TradingState["daily"]["totals"]>;
}

function SummaryTable({ title, data }: SummaryTableProps) {
  const entries = Object.entries(data);
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-full text-left text-xs text-white/70">
          <thead className="text-slate-500">
            <tr>
              <th className="px-2 py-1 font-medium">Key</th>
              <th className="px-2 py-1 font-medium text-right">Trades</th>
              <th className="px-2 py-1 font-medium text-right">Net R</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="odd:bg-black/30">
                <td className="px-2 py-1 capitalize text-slate-300">{key.replace(/-/g, " ")}</td>
                <td className="px-2 py-1 text-right">{value.trades}</td>
                <td className={`px-2 py-1 text-right ${value.netR >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {value.netR.toFixed(2)}R
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatStrategy(strategy: FootprintSignal["strategy"]) {
  switch (strategy) {
    case "absorption-failure":
      return "Absorción";
    case "poc-migration":
      return "POC";
    case "delta-divergence":
      return "Divergencia";
    default:
      return strategy;
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "exp";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function formatR(value: number): string {
  const rounded = value.toFixed(2);
  return value > 0 ? `+${rounded}R` : `${rounded}R`;
}

function formatResult(result: string): string {
  switch (result) {
    case "win":
      return "Ganada";
    case "loss":
      return "Perdida";
    case "breakeven":
    default:
      return "BE";
  }
}

function formatFirstHit(firstHit: string): string {
  switch (firstHit) {
    case "tp1":
      return "TP1";
    case "tp2":
      return "TP2";
    case "stop":
      return "SL";
    case "time-stop":
      return "Time";
    case "invalidation":
      return "Inv";
    default:
      return "-";
  }
}

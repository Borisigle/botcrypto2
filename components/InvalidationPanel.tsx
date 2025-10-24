import { useMemo, useState } from "react";

import type { InvalidationActionType, InvalidationEvent, InvalidationSeverity } from "@/types";

interface InvalidationPanelProps {
  events: InvalidationEvent[];
  onAction: (eventId: string, action: InvalidationActionType) => void;
}

const SEVERITY_LABELS: Record<InvalidationSeverity, string> = {
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

const SEVERITY_COLORS: Record<InvalidationSeverity, string> = {
  high: "bg-rose-500/20 text-rose-200 border border-rose-400/60",
  medium: "bg-amber-500/20 text-amber-200 border border-amber-400/60",
  low: "bg-sky-500/20 text-sky-200 border border-sky-400/60",
};

const STRATEGY_LABELS: Record<string, string> = {
  "absorption-failure": "Absorción",
  "poc-migration": "POC",
  "delta-divergence": "Divergencia",
};

export function InvalidationPanel({ events, onAction }: InvalidationPanelProps) {
  const [severityFilter, setSeverityFilter] = useState<"all" | InvalidationSeverity>("all");
  const [strategyFilter, setStrategyFilter] = useState<"all" | keyof typeof STRATEGY_LABELS>("all");

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (severityFilter !== "all" && event.severity !== severityFilter) {
        return false;
      }
      if (strategyFilter !== "all" && event.strategy !== strategyFilter) {
        return false;
      }
      return true;
    });
  }, [events, severityFilter, strategyFilter]);

  return (
    <article className="rounded-lg border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/20">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white/80">Invalidaciones</h3>
          <p className="text-xs text-slate-400">Monitorea tesis activas y acciones sugeridas</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <select
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-white/80"
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value as typeof severityFilter)}
          >
            <option value="all">Severidad: Todas</option>
            <option value="high">Alta</option>
            <option value="medium">Media</option>
            <option value="low">Baja</option>
          </select>
          <select
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-white/80"
            value={strategyFilter}
            onChange={(event) => setStrategyFilter(event.target.value as typeof strategyFilter)}
          >
            <option value="all">Estrategia: Todas</option>
            <option value="absorption-failure">Absorción</option>
            <option value="poc-migration">POC</option>
            <option value="delta-divergence">Divergencia</option>
          </select>
        </div>
      </header>
      {filteredEvents.length ? (
        <ul className="mt-3 space-y-3">
          {filteredEvents.map((event) => (
            <li
              key={event.id}
              className="rounded-md border border-white/10 bg-black/40 p-3 text-xs text-white/80"
            >
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${SEVERITY_COLORS[event.severity]}`}>
                    {SEVERITY_LABELS[event.severity]}
                  </span>
                  <span className="font-semibold text-white">{event.triggerLabel}</span>
                  <span className="rounded-md border border-white/10 bg-black/30 px-2 py-0.5 text-[11px] uppercase text-slate-300">
                    {STRATEGY_LABELS[event.strategy] ?? event.strategy}
                  </span>
                  <span className="text-slate-400">Score {event.score}</span>
                  <span className="text-slate-500">
                    {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
                {event.autoClosed ? (
                  <span className="rounded-md border border-emerald-500/60 bg-emerald-500/20 px-2 py-1 text-[11px] font-semibold text-emerald-200">
                    Auto-cierre
                  </span>
                ) : event.resolved ? (
                  <span className="text-emerald-300">Acción: {formatAction(event.actionTaken)}</span>
                ) : null}
              </div>
              <p className="mt-2 text-slate-300">{event.recommendation}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400 md:grid-cols-3">
                {event.evidence.slice(0, 4).map((item) => (
                  <div key={`${event.id}-${item.label}`}>
                    <dt className="uppercase tracking-wide text-[10px] text-slate-500">{item.label}</dt>
                    <dd className="font-mono text-xs text-slate-200">{item.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                {event.actions.map((action) => {
                  const disabled = event.resolved && event.actionTaken === action.type;
                  return (
                    <button
                      key={`${event.id}-${action.type}`}
                      type="button"
                      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition ${disabled ? "cursor-not-allowed border-white/10 bg-black/20 text-slate-500" : "border-white/10 bg-white/5 text-white/80 hover:border-emerald-400/60 hover:bg-emerald-500/10 hover:text-emerald-200"}`}
                      onClick={() => onAction(event.id, action.type)}
                      disabled={disabled}
                    >
                      {action.label}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-400">
          No hay invalidaciones activas que coincidan con los filtros.
        </p>
      )}
    </article>
  );
}

function formatAction(action: InvalidationActionType | undefined): string {
  switch (action) {
    case "close":
      return "Cerrada";
    case "reduce":
      return "Reducida";
    case "tighten-stop":
      return "SL ajustado";
    case "hold":
      return "Mantener";
    default:
      return "-";
  }
}

import type { ChangeEvent } from "react";

import type { TradingSession, TradingSettings } from "@/types";

interface TradingControlsProps {
  settings: TradingSettings;
  onSettingsChange: (partial: Partial<TradingSettings>) => void;
  onResetDay: () => void;
  onExport: (format: "json" | "csv") => void;
}

const numberOrZero = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const SESSION_OPTIONS: Array<{ key: TradingSession; label: string }> = [
  { key: "asia", label: "Asia" },
  { key: "eu", label: "Europa" },
  { key: "us", label: "EE.UU." },
  { key: "other", label: "Otras" },
];

export function TradingControls({ settings, onSettingsChange, onResetDay, onExport }: TradingControlsProps) {
  const handleRiskChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ riskPerTradePercent: numberOrZero(event.target.value) });
  };

  const handleFeesChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ feesPercent: numberOrZero(event.target.value) });
  };

  const handleSlippageChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ slippageTicks: numberOrZero(event.target.value) });
  };

  const handlePartialChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ partialTakePercent: numberOrZero(event.target.value) / 100 });
  };

  const handleTimeStopChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = numberOrZero(event.target.value);
    onSettingsChange({ timeStopMinutes: value > 0 ? value : null });
  };

  const handleRetestChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ retestWindowMinutes: Math.max(0, numberOrZero(event.target.value)) });
  };

  const handleBeOffsetChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ beOffsetTicks: Math.max(0, numberOrZero(event.target.value)) });
  };

  const handleInvalidationChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({ invalidationBars: Math.max(0, Math.floor(numberOrZero(event.target.value))) });
  };

  const handleInvalidationsChange = (partial: Partial<TradingSettings["invalidations"]>) => {
    onSettingsChange({
      invalidations: {
        ...settings.invalidations,
        ...partial,
      },
    });
  };

  const handleAggressivenessChange = (event: ChangeEvent<HTMLSelectElement>) => {
    handleInvalidationsChange({ aggressiveness: event.target.value as TradingSettings["invalidations"]["aggressiveness"] });
  };

  const guardrails = settings.guardrails;
  const guardrailsDisabled = !guardrails.enabled;

  const handleGuardrailsChange = (partial: Partial<typeof guardrails>) => {
    onSettingsChange({
      guardrails: {
        ...guardrails,
        ...partial,
      },
    });
  };

  const handleGuardrailsToggle = (event: ChangeEvent<HTMLInputElement>) => {
    handleGuardrailsChange({ enabled: event.target.checked });
  };

  const handleMaxDailyLossChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = numberOrNull(event.target.value);
    handleGuardrailsChange({ maxDailyLossR: value !== null && value > 0 ? value : null });
  };

  const handleMaxTradesPerDayChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = numberOrNull(event.target.value);
    handleGuardrailsChange({ maxTradesPerDay: value !== null && value > 0 ? Math.floor(value) : null });
  };

  const handleMaxConsecutiveLossesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = numberOrNull(event.target.value);
    handleGuardrailsChange({ maxConsecutiveLosses: value !== null && value > 0 ? Math.floor(value) : null });
  };

  const handleLossCooldownTriggerChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(0, Math.floor(numberOrZero(event.target.value)));
    handleGuardrailsChange({ lossCooldownTrigger: value });
  };

  const handleLossCooldownMinutesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(0, Math.floor(numberOrZero(event.target.value)));
    handleGuardrailsChange({ lossCooldownMinutes: value });
  };

  const handleDailyStopCooldownChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(0, Math.floor(numberOrZero(event.target.value)));
    handleGuardrailsChange({ dailyStopCooldownMinutes: value });
  };

  const handleSessionMaxTradesChange = (session: TradingSession, event: ChangeEvent<HTMLInputElement>) => {
    const value = numberOrNull(event.target.value);
    const normalized = value !== null && value > 0 ? Math.floor(value) : null;
    handleGuardrailsChange({
      perSessionMaxTrades: {
        ...(guardrails.perSessionMaxTrades ?? {}),
        [session]: normalized,
      },
    });
  };

  const handleSessionMaxLossChange = (session: TradingSession, event: ChangeEvent<HTMLInputElement>) => {
    const value = numberOrNull(event.target.value);
    const normalized = value !== null && value > 0 ? value : null;
    handleGuardrailsChange({
      perSessionMaxLossR: {
        ...(guardrails.perSessionMaxLossR ?? {}),
        [session]: normalized,
      },
    });
  };

  const handleAllowedSessionToggle = (session: TradingSession, checked: boolean) => {
    if (checked) {
      const next = Array.from(new Set([...guardrails.allowedSessions, session]));
      handleGuardrailsChange({ allowedSessions: next });
    } else {
      handleGuardrailsChange({
        allowedSessions: guardrails.allowedSessions.filter((item) => item !== session),
      });
    }
  };

  const newsInputValue = guardrails.newsWindows
    .map((window) =>
      window.label ? `${window.start}|${window.end}|${window.label}` : `${window.start}|${window.end}`,
    )
    .join("\n");

  const handleNewsWindowsChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const lines = event.target.value.split("\n");
    const windows: typeof guardrails.newsWindows = [];
    const timestamp = Date.now();
    let index = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [startRaw, endRaw, labelRaw] = trimmed.split("|").map((part) => part.trim());
      if (!startRaw || !endRaw) {
        continue;
      }
      const base = guardrails.newsWindows[index];
      windows.push({
        id: base?.id ?? `manual-${timestamp}-${index}`,
        start: startRaw,
        end: endRaw,
        label: labelRaw ?? "",
      });
      index += 1;
    }
    handleGuardrailsChange({ newsWindows: windows });
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-white/10 bg-white/5 p-4 shadow-lg shadow-black/20 backdrop-blur">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/80">Trading automático</h2>
          <p className="text-xs text-slate-400">Gestiona entradas, parciales y stops BE</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-white/70">
          Auto-take
          <input
            type="checkbox"
            className="h-4 w-4 accent-emerald-500"
            checked={settings.autoTake}
            onChange={(event) => onSettingsChange({ autoTake: event.target.checked })}
          />
        </label>
      </header>

      <div className="grid grid-cols-1 gap-3">
        <LabeledNumber
          label="Riesgo por trade (%)"
          value={settings.riskPerTradePercent}
          step={0.1}
          min={0}
          onChange={handleRiskChange}
        />
        <LabeledNumber
          label="Fees (%)"
          value={settings.feesPercent}
          step={0.01}
          min={0}
          onChange={handleFeesChange}
        />
        <LabeledNumber
          label="Slippage (ticks)"
          value={settings.slippageTicks}
          step={0.1}
          min={0}
          onChange={handleSlippageChange}
        />
        <LabeledNumber
          label="Parcial en TP1 (%)"
          value={settings.partialTakePercent * 100}
          step={5}
          min={0}
          max={100}
          onChange={handlePartialChange}
        />
        <LabeledNumber
          label="Time stop (min, 0 = off)"
          value={settings.timeStopMinutes ?? 0}
          step={1}
          min={0}
          onChange={handleTimeStopChange}
        />
        <LabeledNumber
          label="Retest window (min)"
          value={settings.retestWindowMinutes}
          step={1}
          min={0}
          onChange={handleRetestChange}
        />
        <LabeledNumber
          label="Offset BE (ticks)"
          value={settings.beOffsetTicks}
          step={0.1}
          min={0}
          onChange={handleBeOffsetChange}
        />
        <LabeledNumber
          label="Invalidación (bars, 0 = off)"
          value={settings.invalidationBars}
          step={1}
          min={0}
          onChange={handleInvalidationChange}
        />
      </div>

      <div className="rounded-md border border-white/10 bg-black/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/70">Monitor de invalidaciones</h3>
          <label className="flex items-center gap-2 text-[11px] text-white/70">
            Auto-cierre alta severidad
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-500"
              checked={settings.invalidations.autoCloseHighSeverity}
              onChange={(event) => handleInvalidationsChange({ autoCloseHighSeverity: event.target.checked })}
            />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-white/70">
            <span className="font-semibold text-white/80">Agresividad</span>
            <select
              className="rounded-md border border-white/10 bg-black/40 px-3 py-2 text-xs text-white focus:border-emerald-400 focus:outline-none"
              value={settings.invalidations.aggressiveness}
              onChange={handleAggressivenessChange}
            >
              <option value="strict">Estricto</option>
              <option value="moderate">Moderado</option>
              <option value="relaxed">Suave</option>
            </select>
          </label>
          <LabeledNumber
            label="Señales contrarias (barras)"
            value={settings.invalidations.lookbackBars}
            step={1}
            min={1}
            onChange={(event) =>
              handleInvalidationsChange({ lookbackBars: Math.max(1, Math.floor(numberOrZero(event.target.value))) })
            }
          />
          <LabeledNumber
            label="Score mínimo señal opuesta"
            value={settings.invalidations.minOppositeSignalScore}
            step={1}
            min={0}
            max={100}
            onChange={(event) =>
              handleInvalidationsChange({ minOppositeSignalScore: clampNumber(numberOrZero(event.target.value), 0, 100) })
            }
          />
          <LabeledNumber
            label="Umbral auto-cierre"
            value={settings.invalidations.autoCloseThreshold}
            step={1}
            min={0}
            max={100}
            onChange={(event) =>
              handleInvalidationsChange({ autoCloseThreshold: clampNumber(numberOrZero(event.target.value), 0, 100) })
            }
          />
          <LabeledNumber
            label="Stack niveles"
            value={settings.invalidations.stackedImbalanceLevels}
            step={1}
            min={2}
            onChange={(event) =>
              handleInvalidationsChange({ stackedImbalanceLevels: Math.max(2, Math.floor(numberOrZero(event.target.value))) })
            }
          />
          <LabeledNumber
            label="Stack ratio mínimo"
            value={settings.invalidations.stackedImbalanceRatio}
            step={0.1}
            min={1}
            onChange={(event) =>
              handleInvalidationsChange({ stackedImbalanceRatio: Math.max(1, numberOrZero(event.target.value)) })
            }
          />
          <LabeledNumber
            label="Time-decay (min)"
            value={settings.invalidations.timeDecayMinutes}
            step={1}
            min={1}
            onChange={(event) =>
              handleInvalidationsChange({ timeDecayMinutes: Math.max(1, Math.floor(numberOrZero(event.target.value))) })
            }
          />
          <LabeledNumber
            label="Progreso mínimo (R)"
            value={settings.invalidations.minProgressR}
            step={0.1}
            min={0}
            onChange={(event) =>
              handleInvalidationsChange({ minProgressR: Math.max(0, numberOrZero(event.target.value)) })
            }
          />
        </div>
      </div>

      <div className="rounded-md border border-white/10 bg-black/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/70">Guardrails de riesgo</h3>
          <label className="flex items-center gap-2 text-[11px] text-white/70">
            Activo
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-500"
              checked={guardrails.enabled}
              onChange={handleGuardrailsToggle}
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Límites diarios y cooldowns. 0 o vacío desactivan cada parámetro.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <LabeledNumber
            label="Pérdida diaria máx (R)"
            value={guardrails.maxDailyLossR ?? 0}
            step={0.1}
            min={0}
            onChange={handleMaxDailyLossChange}
            disabled={guardrailsDisabled}
          />
          <LabeledNumber
            label="Trades diarios máx"
            value={guardrails.maxTradesPerDay ?? 0}
            step={1}
            min={0}
            onChange={handleMaxTradesPerDayChange}
            disabled={guardrailsDisabled}
          />
          <LabeledNumber
            label="Pérdidas consecutivas máx"
            value={guardrails.maxConsecutiveLosses ?? 0}
            step={1}
            min={0}
            onChange={handleMaxConsecutiveLossesChange}
            disabled={guardrailsDisabled}
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <LabeledNumber
            label="Cooldown tras pérdidas (n)"
            value={guardrails.lossCooldownTrigger}
            step={1}
            min={0}
            onChange={handleLossCooldownTriggerChange}
            disabled={guardrailsDisabled}
          />
          <LabeledNumber
            label="Cooldown pérdidas (min)"
            value={guardrails.lossCooldownMinutes}
            step={5}
            min={0}
            onChange={handleLossCooldownMinutesChange}
            disabled={guardrailsDisabled}
          />
          <LabeledNumber
            label="Cooldown daily stop (min)"
            value={guardrails.dailyStopCooldownMinutes}
            step={15}
            min={0}
            onChange={handleDailyStopCooldownChange}
            disabled={guardrailsDisabled}
          />
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Límites por sesión (trades)</h4>
            <div className="mt-2 grid gap-2">
              {SESSION_OPTIONS.map((option) => (
                <label
                  key={`session-trades-${option.key}`}
                  className="flex items-center justify-between gap-3 text-xs text-white/70"
                >
                  <span>{option.label}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={guardrails.perSessionMaxTrades?.[option.key] ?? ""}
                    onChange={(event) => handleSessionMaxTradesChange(option.key, event)}
                    disabled={guardrailsDisabled}
                    className="w-24 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white focus:border-emerald-400 focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Límites por sesión (pérdida R)</h4>
            <div className="mt-2 grid gap-2">
              {SESSION_OPTIONS.map((option) => (
                <label
                  key={`session-loss-${option.key}`}
                  className="flex items-center justify-between gap-3 text-xs text-white/70"
                >
                  <span>{option.label}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={guardrails.perSessionMaxLossR?.[option.key] ?? ""}
                    onChange={(event) => handleSessionMaxLossChange(option.key, event)}
                    disabled={guardrailsDisabled}
                    className="w-24 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white focus:border-emerald-400 focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sesiones permitidas</h4>
          <div className="mt-2 flex flex-wrap gap-3">
            {SESSION_OPTIONS.map((option) => {
              const checked = guardrails.allowedSessions.includes(option.key);
              return (
                <label key={`session-allow-${option.key}`} className="flex items-center gap-2 text-xs text-white/70">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-emerald-500"
                    checked={checked}
                    onChange={(event) => handleAllowedSessionToggle(option.key, event.target.checked)}
                    disabled={guardrailsDisabled}
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Sin selección: todas las sesiones permitidas.</p>
        </div>
        <div className="mt-4">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Ventanas de noticias</h4>
          <textarea
            rows={3}
            className="mt-2 w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-xs text-white focus:border-emerald-400 focus:outline-none"
            placeholder="2024-10-25T12:30:00Z|2024-10-25T13:00:00Z|Evento"
            value={newsInputValue}
            onChange={handleNewsWindowsChange}
            disabled={guardrailsDisabled}
          />
          <p className="mt-1 text-[11px] text-slate-500">Formato: inicio|fin|etiqueta opcional (UTC).</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">

          type="button"
          className="flex-1 rounded-md border border-emerald-400 bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30"
          onClick={() => onExport("json")}
        >
          Export JSON
        </button>
        <button
          type="button"
          className="flex-1 rounded-md border border-sky-400 bg-sky-500/20 px-3 py-2 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/30"
          onClick={() => onExport("csv")}
        >
          Export CSV
        </button>
      </div>
      <button
        type="button"
        className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs font-semibold text-white/70 transition hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-200"
        onClick={onResetDay}
      >
        Reset diario
      </button>
    </section>
  );
}

interface LabeledNumberProps {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function LabeledNumber({ label, value, step = 0.1, min, max, disabled, onChange }: LabeledNumberProps) {
  return (
    <label className="flex flex-col gap-1 text-xs text-white/70">
      <span className="font-semibold text-white/80">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={onChange}
        disabled={disabled}
        className="rounded-md border border-white/10 bg-black/40 px-3 py-2 text-xs text-white focus:border-emerald-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

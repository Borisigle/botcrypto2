'use client';

import { useMemo } from "react";

import { precisionFromStep } from "@/lib/aggregator";
import { MODE_PRESETS } from "@/lib/signals";
import type {
  DetectorOverrides,
  SignalControlState,
  SignalMode,
  SignalStats,
  SignalStrategy,
  Timeframe,
} from "@/types";

interface ControlsProps {
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  priceStepConfig: { min: number; max: number; step: number };
  showCumulativeDelta: boolean;
  signalControl: SignalControlState;
  signalStats: SignalStats;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onPriceStepChange: (step: number) => void;
  onToggleCumulativeDelta: () => void;
  onModeChange: (mode: SignalMode) => void;
  onToggleStrategy: (strategy: SignalStrategy) => void;
  onOverridesChange: (overrides: Partial<DetectorOverrides>) => void;
}

const TIMEFRAME_OPTIONS: Timeframe[] = ["1m", "5m"];

const STRATEGIES: Array<{ id: SignalStrategy; label: string }> = [
  { id: "absorption-failure", label: "Absorción + fallo" },
  { id: "poc-migration", label: "Migración de POC" },
  { id: "delta-divergence", label: "Divergencia delta" },
];

const SESSION_LABELS: Record<string, string> = {
  asia: "Asia",
  eu: "Europa",
  us: "EE.UU",
  other: "Otro",
};

export function Controls({
  symbol,
  timeframe,
  priceStep,
  priceStepConfig,
  showCumulativeDelta,
  signalControl,
  signalStats,
  onSymbolChange,
  onTimeframeChange,
  onPriceStepChange,
  onToggleCumulativeDelta,
  onModeChange,
  onToggleStrategy,
  onOverridesChange,
}: ControlsProps) {
  const { min: priceStepMin, max: priceStepMax, step: priceStepIncrement } = priceStepConfig;
  const normalizedIncrement = priceStepIncrement > 0 ? priceStepIncrement : 0.1;
  const stepPrecision = useMemo(() => precisionFromStep(normalizedIncrement), [normalizedIncrement]);
  const formattedStep = useMemo(
    () => priceStep.toFixed(stepPrecision).replace(/\.0+$/, ""),
    [priceStep, stepPrecision],
  );
  const modePreset = useMemo(() => MODE_PRESETS[signalControl.mode], [signalControl.mode]);
  const modeOptions = useMemo(() => Object.keys(MODE_PRESETS) as SignalMode[], []);
  const overrides = signalControl.overrides ?? {};
  const minScore = overrides.minScore ?? modePreset.minScore;
  const stackRatio = overrides.stackRatio ?? modePreset.stackRatio;
  const minDeltaPercentile = overrides.minDeltaPercentile ?? modePreset.minDeltaPercentile;
  const minVolumePercentile = overrides.minVolumePercentile ?? modePreset.minVolumePercentile;
  const estimatedPerDay = signalStats.estimatePerDay ?? 0;
  const sessionCounts = signalStats.sessionCount ?? { asia: 0, eu: 0, us: 0, other: 0 };

  const capsSummary = useMemo(() => {
    const parts: string[] = [];
    if (typeof modePreset.maxSignalsPerSession === "number") {
      parts.push(`Máx ${modePreset.maxSignalsPerSession} / sesión (EU/US)`);
    }
    if (typeof modePreset.maxSignalsPerDay === "number") {
      parts.push(`Máx ${modePreset.maxSignalsPerDay} / día`);
    }
    return parts.join(" · ") || "Sin topes";
  }, [modePreset.maxSignalsPerDay, modePreset.maxSignalsPerSession]);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-white/10 bg-white/5 p-4 shadow-lg shadow-black/20 backdrop-blur">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-semibold text-white/80" htmlFor="symbol">
          Symbol
        </label>
        <input
          id="symbol"
          value={symbol}
          onChange={(event) => onSymbolChange(event.target.value.toUpperCase())}
          className="rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm uppercase text-white focus:border-emerald-400 focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-white/80">Timeframe</span>
        <div className="flex gap-2">
          {TIMEFRAME_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onTimeframeChange(option)}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-all ${
                timeframe === option
                  ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                  : "border-white/10 bg-black/30 text-white/70 hover:border-white/20 hover:text-white"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm text-white/80">
          <span>Price step</span>
          <span className="font-mono text-emerald-200">{formattedStep} USD</span>
        </div>
        <input
          type="range"
          min={priceStepMin}
          max={priceStepMax}
          step={normalizedIncrement}
          value={priceStep}
          onChange={(event) => onPriceStepChange(Number(event.target.value))}
          className="w-full accent-emerald-500"
        />
      </div>

      <label className="flex items-center gap-3 text-sm text-white/80">
        <input
          type="checkbox"
          checked={showCumulativeDelta}
          onChange={onToggleCumulativeDelta}
          className="h-4 w-4 accent-emerald-500"
        />
        Show cumulative delta
      </label>

      <div className="mt-3 h-px bg-white/10" />

      <div className="flex flex-col gap-3 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white/80">Modo de señales</span>
          <span className="text-xs text-slate-400">≈ {estimatedPerDay.toFixed(1)} señales/día</span>
        </div>

        <select
          value={signalControl.mode}
          onChange={(event) => onModeChange(event.target.value as SignalMode)}
          className="rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white/80 focus:border-emerald-400 focus:outline-none"
        >
          {modeOptions.map((mode) => (
            <option key={mode} value={mode} className="text-black">
              {MODE_PRESETS[mode].label}
            </option>
          ))}
        </select>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Estrategias</span>
          <div className="flex flex-col gap-1">
            {STRATEGIES.map((strategy) => (
              <label
                key={strategy.id}
                className="flex items-center justify-between rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/70 hover:border-white/20"
              >
                <span>{strategy.label}</span>
                <input
                  type="checkbox"
                  checked={Boolean(signalControl.enabledStrategies[strategy.id])}
                  onChange={() => onToggleStrategy(strategy.id)}
                  className="h-4 w-4 accent-emerald-500"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-3">
          <ThresholdSlider
            label="Score mínimo"
            value={minScore}
            display={`${Math.round(minScore)}`}
            min={40}
            max={90}
            step={1}
            onChange={(value) => onOverridesChange({ minScore: value })}
          />
          <ThresholdSlider
            label="Stack ratio"
            value={stackRatio}
            display={`${stackRatio.toFixed(2)}×`}
            min={1.5}
            max={5}
            step={0.1}
            onChange={(value) => onOverridesChange({ stackRatio: value })}
          />
          <ThresholdSlider
            label="Percentil |delta|"
            value={Math.round(minDeltaPercentile * 100)}
            display={`P${Math.round(minDeltaPercentile * 100)}`}
            min={50}
            max={95}
            step={1}
            onChange={(value) => onOverridesChange({ minDeltaPercentile: value / 100 })}
          />
          <ThresholdSlider
            label="Percentil volumen"
            value={Math.round(minVolumePercentile * 100)}
            display={`P${Math.round(minVolumePercentile * 100)}`}
            min={50}
            max={95}
            step={1}
            onChange={(value) => onOverridesChange({ minVolumePercentile: value / 100 })}
          />
        </div>

        <div className="rounded-md border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/70">
          <div className="flex items-center justify-between">
            <span>Confluencia</span>
            <span className="text-emerald-200">{capsSummary}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <span className="text-slate-400">Diario</span>
              <div className="font-mono text-sm text-white">{signalStats.dailyCount}</div>
            </div>
            <div className="text-right">
              <span className="text-slate-400">EU</span>
              <div className="font-mono text-sm text-white">{sessionCounts.eu ?? 0}</div>
            </div>
            <div>
              <span className="text-slate-400">US</span>
              <div className="font-mono text-sm text-white">{sessionCounts.us ?? 0}</div>
            </div>
            <div className="text-right">
              <span className="text-slate-400">Asia</span>
              <div className="font-mono text-sm text-white">{sessionCounts.asia ?? 0}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface ThresholdSliderProps {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function ThresholdSlider({ label, value, display, min, max, step, onChange }: ThresholdSliderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm text-white/80">
        <span>{label}</span>
        <span className="font-mono text-emerald-200">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-emerald-500"
      />
    </div>
  );
}

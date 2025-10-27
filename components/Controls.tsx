"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { precisionFromStep } from "@/lib/aggregator";
import { MODE_PRESETS } from "@/lib/signals";
import type {
  DetectorOverrides,
  FootprintMode,
  KeyLevelStatus,
  KeyLevelVisibility,
  RecordingDatasetSummary,
  ReplayMetrics,
  ReplaySpeed,
  ReplayState,
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
  showGrid: boolean;
  showPriceAxis: boolean;
  keyLevelVisibility: KeyLevelVisibility;
  keyLevelSummaries: Record<keyof KeyLevelVisibility, KeyLevelStatus>;
  signalControl: SignalControlState;
  signalStats: SignalStats;
  mode: FootprintMode;
  recordingDataset: RecordingDatasetSummary | null;
  availableDatasets: RecordingDatasetSummary[];
  replayState: ReplayState;
  replayMetrics: ReplayMetrics;
  onStartReplay: (datasetId: string, speed?: ReplaySpeed) => void;
  onStopReplay: () => void;
  onReplaySpeedChange: (speed: ReplaySpeed) => void;
  onRefreshDatasets: () => void;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onPriceStepChange: (step: number) => void;
  onToggleCumulativeDelta: () => void;
  onToggleGrid: () => void;
  onTogglePriceAxis: () => void;
  onToggleKeyLevels: (group: keyof KeyLevelVisibility) => void;
  onModeChange: (mode: SignalMode) => void;
  onToggleStrategy: (strategy: SignalStrategy) => void;
  onOverridesChange: (overrides: Partial<DetectorOverrides>) => void;
}

const TIMEFRAME_OPTIONS: Timeframe[] = ["1m", "5m"];
const SPEED_OPTIONS: ReplaySpeed[] = [1, 2, 5, 10];

const STRATEGIES: Array<{ id: SignalStrategy; label: string }> = [
  { id: "absorption-failure", label: "Absorción + fallo" },
  { id: "poc-migration", label: "Migración de POC" },
  { id: "delta-divergence", label: "Divergencia delta" },
];

export function Controls({
  symbol,
  timeframe,
  priceStep,
  priceStepConfig,
  showCumulativeDelta,
  showGrid,
  showPriceAxis,
  keyLevelVisibility,
  keyLevelSummaries,
  signalControl,
  signalStats,
  mode,
  recordingDataset,
  availableDatasets,
  replayState,
  replayMetrics,
  onStartReplay,
  onStopReplay,
  onReplaySpeedChange,
  onRefreshDatasets,
  onSymbolChange,
  onTimeframeChange,
  onPriceStepChange,
  onToggleCumulativeDelta,
  onToggleGrid,
  onTogglePriceAxis,
  onToggleKeyLevels,
  onModeChange,
  onToggleStrategy,
  onOverridesChange,
}: ControlsProps) {
  const {
    min: priceStepMin,
    max: priceStepMax,
    step: priceStepIncrement,
  } = priceStepConfig;
  const normalizedIncrement = priceStepIncrement > 0 ? priceStepIncrement : 0.1;
  const stepPrecision = useMemo(
    () => precisionFromStep(normalizedIncrement),
    [normalizedIncrement],
  );
  const formattedStep = useMemo(
    () => priceStep.toFixed(stepPrecision).replace(/\.0+$/, ""),
    [priceStep, stepPrecision],
  );
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>("");
  useEffect(() => {
    if (!availableDatasets.length) {
      setSelectedDatasetId("");
      return;
    }
    if (
      !selectedDatasetId ||
      !availableDatasets.some((dataset) => dataset.id === selectedDatasetId)
    ) {
      setSelectedDatasetId(availableDatasets[0].id);
    }
  }, [availableDatasets, selectedDatasetId]);
  const selectedDataset = useMemo(
    () =>
      availableDatasets.find((dataset) => dataset.id === selectedDatasetId) ??
      null,
    [availableDatasets, selectedDatasetId],
  );
  const currentReplayDataset = useMemo(
    () =>
      replayState.datasetId
        ? (availableDatasets.find(
            (dataset) => dataset.id === replayState.datasetId,
          ) ?? null)
        : null,
    [availableDatasets, replayState.datasetId],
  );
  const replayProgress = Math.max(0, Math.min(1, replayState.progress ?? 0));
  const replayStatusLabel = replayState.status;
  const canStartReplay = Boolean(selectedDatasetId);
  const recordingSummary = recordingDataset
    ? summarizeDataset(recordingDataset)
    : "Recorder will automatically rotate chunks.";
  const selectedSummary = selectedDataset
    ? summarizeDataset(selectedDataset)
    : null;
  const modePreset = useMemo(
    () => MODE_PRESETS[signalControl.mode],
    [signalControl.mode],
  );
  const handleStartReplay = useCallback(() => {
    if (selectedDatasetId) {
      onStartReplay(selectedDatasetId, replayState.speed);
    }
  }, [onStartReplay, replayState.speed, selectedDatasetId]);
  const handleSpeedChange = useCallback(
    (speed: ReplaySpeed) => {
      onReplaySpeedChange(speed);
    },
    [onReplaySpeedChange],
  );
  const modeOptions = useMemo(
    () => Object.keys(MODE_PRESETS) as SignalMode[],
    [],
  );
  const overrides = signalControl.overrides ?? {};
  const minScore = overrides.minScore ?? modePreset.minScore;
  const stackRatio = overrides.stackRatio ?? modePreset.stackRatio;
  const minDeltaPercentile =
    overrides.minDeltaPercentile ?? modePreset.minDeltaPercentile;
  const minVolumePercentile =
    overrides.minVolumePercentile ?? modePreset.minVolumePercentile;
  const estimatedPerDay = signalStats.estimatePerDay ?? 0;
  const sessionCounts = signalStats.sessionCount ?? {
    asia: 0,
    eu: 0,
    us: 0,
    other: 0,
  };

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
      <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-black/40 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white/80">Playback</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              mode === "live"
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-sky-500/20 text-sky-200"
            }`}
          >
            {mode === "live" ? "Live" : "Replay"}
          </span>
        </div>
        {mode === "live" ? (
          <div className="flex flex-col gap-3 text-sm text-white/70">
            <div className="rounded-md border border-white/10 bg-black/30 p-3">
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Recorder
              </span>
              <div className="mt-1 font-mono text-sm text-white">
                {recordingDataset
                  ? recordingDataset.label
                  : "Recorder warming up"}
              </div>
              <div className="text-xs text-slate-400">{recordingSummary}</div>
            </div>
            <div className="flex flex-col gap-2">
              <label
                className="text-xs font-semibold uppercase tracking-wide text-slate-400"
                htmlFor="replayDataset"
              >
                Replay dataset
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  id="replayDataset"
                  value={selectedDatasetId}
                  onChange={(event) => setSelectedDatasetId(event.target.value)}
                  className="flex-1 rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white/80 focus:border-emerald-400 focus:outline-none"
                >
                  {availableDatasets.length ? null : (
                    <option value="">No datasets yet</option>
                  )}
                  {availableDatasets.map((dataset) => (
                    <option
                      key={dataset.id}
                      value={dataset.id}
                      className="text-black"
                    >
                      {dataset.label}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleStartReplay}
                    disabled={!canStartReplay}
                    className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                      canStartReplay
                        ? "bg-sky-600 text-white hover:bg-sky-500"
                        : "cursor-not-allowed bg-white/10 text-white/40"
                    }`}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={onRefreshDatasets}
                    className="rounded-md border border-white/10 px-3 py-2 text-sm text-slate-300 hover:border-white/20 hover:text-white"
                  >
                    Refresh
                  </button>
                </div>
              </div>
              {selectedSummary ? (
                <span className="text-xs text-slate-400">
                  {selectedSummary}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm text-white/80">
            <div className="rounded-md border border-white/10 bg-black/30 p-3">
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Dataset
              </span>
              <div className="mt-1 font-mono text-sm text-white">
                {currentReplayDataset
                  ? currentReplayDataset.label
                  : (replayState.datasetId ?? "--")}
              </div>
              <div className="text-xs text-slate-400">
                {currentReplayDataset
                  ? summarizeDataset(currentReplayDataset)
                  : "Select a dataset from live mode to replay."}
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>
                Status:{" "}
                <span className="text-white/80">{replayStatusLabel}</span>
              </span>
              <span>
                Progress:{" "}
                <span className="text-white/80">
                  {Math.round(replayProgress * 100)}%
                </span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-sky-500 transition-all"
                style={{
                  width: `${Math.min(100, Math.max(0, replayProgress * 100))}%`,
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {SPEED_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => handleSpeedChange(option)}
                  className={`rounded-md border px-3 py-1 text-xs transition ${
                    replayState.speed === option
                      ? "border-sky-400 bg-sky-500/20 text-sky-200"
                      : "border-white/10 text-white/70 hover:border-white/20"
                  }`}
                >
                  {option}×
                </button>
              ))}
            </div>
            {replayMetrics.perMode.length ? (
              <div className="rounded-md border border-white/10 bg-black/30 p-3 text-xs text-white/70">
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  Preset summary
                </span>
                <ul className="mt-2 space-y-1">
                  {replayMetrics.perMode.map((item) => (
                    <li
                      key={item.mode}
                      className="flex items-center justify-between"
                    >
                      <span>{MODE_PRESETS[item.mode].label}</span>
                      <span className="font-mono text-white/80">
                        {item.estimatePerDay.toFixed(1)} /day ·{" "}
                        {item.dailyCount} signals
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <button
              type="button"
              onClick={onStopReplay}
              className="rounded-md border border-white/10 px-4 py-2 text-sm font-medium text-white hover:border-white/20"
            >
              Back to live
            </button>
          </div>
        )}
      </div>
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
          <span className="font-mono text-emerald-200">
            {formattedStep} USD
          </span>
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

      <label className="flex items-center gap-3 text-sm text-white/80">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={onToggleGrid}
          className="h-4 w-4 accent-emerald-500"
        />
        Show grid
      </label>

      <label className="flex items-center gap-3 text-sm text-white/80">
        <input
          type="checkbox"
          checked={showPriceAxis}
          onChange={onTogglePriceAxis}
          className="h-4 w-4 accent-emerald-500"
        />
        Show price axis
      </label>

      <div className="mt-3 h-px bg-white/10" />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-white/80">Key levels</span>
        <div className="flex flex-col gap-2">
          {([
            { id: "previousDay" as const, label: "Previous day H/L" },
            { id: "sessionVwap" as const, label: "Session VWAP" },
            { id: "currentDay" as const, label: "Current day H/L" },
            { id: "priorDayPoc" as const, label: "Prior day POC" },
          ]).map((group) => (
            <label
              key={group.id}
              className="flex items-center justify-between rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/70 hover:border-white/20"
            >
              <div className="flex flex-col">
                <span>{group.label}</span>
                <span className={`text-xs ${keyLevelStatusClass(keyLevelSummaries[group.id])}`}>
                  {formatKeyLevelStatus(keyLevelSummaries[group.id])}
                </span>
              </div>
              <input
                type="checkbox"
                checked={keyLevelVisibility[group.id]}
                onChange={() => onToggleKeyLevels(group.id)}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="mt-3 h-px bg-white/10" />

      <div className="flex flex-col gap-3 pt-2">
        <span className="text-sm font-semibold text-white/80">
          Modo de señales
        </span>
        <span className="text-xs text-slate-400">
          ≈ {estimatedPerDay.toFixed(1)} señales/día
        </span>
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
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Estrategias
          </span>
          <div className="flex flex-col gap-1">
            {STRATEGIES.map((strategy) => (
              <label
                key={strategy.id}
                className="flex items-center justify-between rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/70 hover:border-white/20"
              >
                <span>{strategy.label}</span>
                <input
                  type="checkbox"
                  checked={Boolean(
                    signalControl.enabledStrategies[strategy.id],
                  )}
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
            onChange={(value) =>
              onOverridesChange({ minDeltaPercentile: value / 100 })
            }
          />
          <ThresholdSlider
            label="Percentil volumen"
            value={Math.round(minVolumePercentile * 100)}
            display={`P${Math.round(minVolumePercentile * 100)}`}
            min={50}
            max={95}
            step={1}
            onChange={(value) =>
              onOverridesChange({ minVolumePercentile: value / 100 })
            }
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
              <div className="font-mono text-sm text-white">
                {signalStats.dailyCount}
              </div>
            </div>
            <div className="text-right">
              <span className="text-slate-400">EU</span>
              <div className="font-mono text-sm text-white">
                {sessionCounts.eu ?? 0}
              </div>
            </div>
            <div>
              <span className="text-slate-400">US</span>
              <div className="font-mono text-sm text-white">
                {sessionCounts.us ?? 0}
              </div>
            </div>
            <div className="text-right">
              <span className="text-slate-400">Asia</span>
              <div className="font-mono text-sm text-white">
                {sessionCounts.asia ?? 0}
              </div>
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

function ThresholdSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: ThresholdSliderProps) {
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

function formatKeyLevelStatus(status: KeyLevelStatus): string {
  switch (status) {
    case "live":
      return "Live";
    case "mixed":
      return "Mixed";
    case "approximate":
      return "Approx";
    default:
      return "N/A";
  }
}

function keyLevelStatusClass(status: KeyLevelStatus): string {
  switch (status) {
    case "live":
      return "text-emerald-300";
    case "mixed":
      return "text-amber-300";
    case "approximate":
      return "text-sky-300";
    default:
      return "text-slate-500";
  }
}

function summarizeDataset(dataset: RecordingDatasetSummary | null): string {
  if (!dataset) {
    return "";
  }
  const parts: string[] = [];
  if (dataset.totalTrades) {
    parts.push(`${dataset.totalTrades.toLocaleString()} trades`);
  }
  if (dataset.durationMs) {
    parts.push(formatDuration(dataset.durationMs));
  }
  parts.push(
    `${dataset.chunkCount} chunk${dataset.chunkCount === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "0m";
  }
  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.floor((durationMs % 3_600_000) / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }
  if (hours) {
    return `${hours}h`;
  }
  if (minutes) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

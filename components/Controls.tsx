'use client';

import { useMemo } from "react";

import type { Timeframe } from "@/types";

interface ControlsProps {
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  showCumulativeDelta: boolean;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onPriceStepChange: (step: number) => void;
  onToggleCumulativeDelta: () => void;
}

const TIMEFRAME_OPTIONS: Timeframe[] = ["1m", "5m"];
const PRICE_STEP_MIN = 0.1;
const PRICE_STEP_MAX = 2.0;
const PRICE_STEP_INCREMENT = 0.1;

export function Controls({
  symbol,
  timeframe,
  priceStep,
  showCumulativeDelta,
  onSymbolChange,
  onTimeframeChange,
  onPriceStepChange,
  onToggleCumulativeDelta,
}: ControlsProps) {
  const formattedStep = useMemo(() => priceStep.toFixed(2).replace(/\.00$/, ""), [priceStep]);

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
          min={PRICE_STEP_MIN}
          max={PRICE_STEP_MAX}
          step={PRICE_STEP_INCREMENT}
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
    </section>
  );
}

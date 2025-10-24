'use client';

import { useMemo } from "react";

import type { FootprintBar } from "@/types";

interface CumDeltaChartProps {
  bars: FootprintBar[];
}

const HEIGHT = 120;

export function CumDeltaChart({ bars }: CumDeltaChartProps) {
  const { path, area, min, max } = useMemo(() => {
    if (!bars.length) {
      return { path: "", area: "", min: 0, max: 0 };
    }

    const values = bars.map((bar) => bar.cumulativeDelta);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const range = maxValue - minValue || 1;
    const width = Math.max(1, bars.length - 1);

    let linePath = "";
    let areaPath = "M 0 " + scaleY(values[0], minValue, range) + " ";

    values.forEach((value, index) => {
      const x = (index / width) * 100;
      const y = scaleY(value, minValue, range);
      if (index === 0) {
        linePath = `M ${x} ${y}`;
      } else {
        linePath += ` L ${x} ${y}`;
      }
      areaPath += `${index === 0 ? "" : "L"} ${x} ${y} `;
    });

    areaPath += `L 100 ${scaleY(0, minValue, range)} L 0 ${scaleY(0, minValue, range)} Z`;

    return { path: linePath, area: areaPath, min: minValue, max: maxValue };
  }, [bars]);

  const zeroY = useMemo(() => {
    if (!bars.length) {
      return HEIGHT / 2;
    }
    const values = bars.map((bar) => bar.cumulativeDelta);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 0);
    const range = maxValue - minValue || 1;
    return scaleY(0, minValue, range);
  }, [bars]);

  return (
    <div className="relative h-32 w-full overflow-hidden rounded-lg border border-white/10 bg-black/40">
      {path ? (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full">
          <rect width="100" height="100" fill="rgba(15, 23, 42, 0.8)" />
          <line x1="0" y1={zeroY} x2="100" y2={zeroY} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="0.4" />
          <path d={area} fill="rgba(16, 185, 129, 0.15)" />
          <path d={path} fill="none" stroke="rgba(16, 185, 129, 0.8)" strokeWidth="1.2" />
        </svg>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-white/40">Waiting for data…</div>
      )}
    </div>
  );
}

function scaleY(value: number, min: number, range: number) {
  const normalized = (value - min) / range;
  const clamped = Math.min(1, Math.max(0, normalized));
  return (1 - clamped) * 100;
}

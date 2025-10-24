'use client';

import { useEffect, useMemo, useRef, useState } from "react";

import type { FootprintBar, HoverInfo } from "@/types";
import { deltaToRgba } from "@/utils/color";
import { precisionFromStep } from "@/lib/aggregator";

interface FootprintChartProps {
  bars: FootprintBar[];
  priceStep: number;
  priceBounds: { min: number; max: number; maxVolume: number } | null;
  onHover: (hover: HoverInfo | null, position?: { x: number; y: number }) => void;
}

const BACKGROUND = "#020617"; // slate-950
const GRID_COLOR = "rgba(148, 163, 184, 0.06)";
const POC_STROKE = "rgba(254, 240, 138, 0.9)";

export function FootprintChart({ bars, priceStep, priceBounds, onHover }: FootprintChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const precision = useMemo(() => precisionFromStep(priceStep), [priceStep]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef.current) {
          const { width, height } = entry.contentRect;
          setSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });

    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height || !priceBounds) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = window.devicePixelRatio ?? 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    if (typeof context.resetTransform === "function") {
      context.resetTransform();
    } else {
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    context.scale(dpr, dpr);

    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, size.width, size.height);

    if (!bars.length) {
      return;
    }

    const { min, max, maxVolume } = priceBounds;
    const steps = Math.max(0, Math.round((max - min) / priceStep));
    const levelCount = Math.max(1, steps + 1);
    const cellWidth = Math.max(1, size.width / bars.length);
    const cellHeight = Math.max(1, size.height / levelCount);

    // Draw horizontal grid lines
    context.strokeStyle = GRID_COLOR;
    context.lineWidth = 0.5;
    context.beginPath();
    for (let i = 0; i <= levelCount; i += 1) {
      const y = size.height - i * cellHeight;
      context.moveTo(0, y);
      context.lineTo(size.width, y);
    }
    context.stroke();

    // Draw vertical grid lines
    context.beginPath();
    for (let i = 0; i <= bars.length; i += 1) {
      const x = i * cellWidth;
      context.moveTo(x, 0);
      context.lineTo(x, size.height);
    }
    context.stroke();

    for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
      const bar = bars[barIndex];
      const levelMap = new Map<number, FootprintBar["levels"][number]>();
      for (const level of bar.levels) {
        levelMap.set(level.price, level);
      }

      const x = barIndex * cellWidth;

      for (let idx = 0; idx < levelCount; idx += 1) {
        const price = Number((min + idx * priceStep).toFixed(precision));
        const level = levelMap.get(price);
        if (!level) {
          continue;
        }

        const y = size.height - (idx + 1) * cellHeight;
        context.fillStyle = deltaToRgba(level.delta, level.totalVolume, maxVolume);
        context.fillRect(x, y, cellWidth, cellHeight);
      }

      if (typeof bar.pocPrice === "number") {
        const pocIndexRaw = Math.round((bar.pocPrice - min) / priceStep);
        const pocIndex = Math.max(0, Math.min(levelCount - 1, pocIndexRaw));
        const y = size.height - (pocIndex + 1) * cellHeight;
        context.strokeStyle = POC_STROKE;
        context.lineWidth = Math.max(1, cellWidth * 0.08);
        context.strokeRect(x + 0.5, y + 0.5, Math.max(1, cellWidth - 1), Math.max(1, cellHeight - 1));
      }
    }
  }, [bars, priceBounds, priceStep, precision, size.height, size.width]);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!priceBounds || !bars.length) {
      onHover(null);
      return;
    }

    const { min, max } = priceBounds;
    const steps = Math.max(0, Math.round((max - min) / priceStep));
    const levelCount = Math.max(1, steps + 1);
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = event.clientX - rect.left;
    const relativeY = event.clientY - rect.top;
    if (relativeX < 0 || relativeY < 0 || relativeX > rect.width || relativeY > rect.height) {
      onHover(null);
      return;
    }

    const barWidth = rect.width / bars.length;
    const barIndex = Math.min(bars.length - 1, Math.max(0, Math.floor(relativeX / barWidth)));
    const cellHeight = rect.height / levelCount;
    const invertedIndex = levelCount - 1 - Math.floor(relativeY / cellHeight);

    if (invertedIndex < 0 || invertedIndex >= levelCount) {
      onHover(null);
      return;
    }

    const price = Number((min + invertedIndex * priceStep).toFixed(precision));
    const bar = bars[barIndex];
    const level = bar.levels.find((item) => Math.abs(item.price - price) < 1e-8);
    const hover: HoverInfo = {
      barIndex,
      levelIndex: invertedIndex,
      price,
      time: bar.startTime,
      askVol: level?.askVol ?? 0,
      bidVol: level?.bidVol ?? 0,
      delta: level?.delta ?? 0,
      totalVolume: level?.totalVolume ?? 0,
    };

    onHover(hover, { x: event.clientX, y: event.clientY });
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-lg border border-slate-700/30 bg-slate-950"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => onHover(null)}
    >
      <canvas ref={canvasRef} className="size-full" />
      {(!bars.length || !priceBounds) && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
          Waiting for trades…
        </div>
      )}
    </div>
  );
}

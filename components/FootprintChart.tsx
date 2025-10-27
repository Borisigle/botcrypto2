'use client';

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ChartKeyLevel,
  FootprintBar,
  FootprintSignal,
  HoverInfo,
  InvalidationEvent,
  InvalidationSeverity,
  KeyLevelStatus,
  PendingTrade,
  Position,
} from "@/types";
import { deltaToRgba } from "@/utils/color";
import { precisionFromStep } from "@/lib/aggregator";

interface FootprintChartProps {
  bars: FootprintBar[];
  signals: FootprintSignal[];
  positions: Position[];
  pendingTrades: PendingTrade[];
  invalidations: InvalidationEvent[];
  priceStep: number;
  priceBounds: { min: number; max: number; maxVolume: number } | null;
  keyLevels: ChartKeyLevel[];
  showGrid: boolean;
  showPriceAxis: boolean;
  tickSize: number;
  onHover: (hover: HoverInfo | null, position?: { x: number; y: number }) => void;
}

const BACKGROUND = "#020617"; // slate-950
const GRID_COLOR = "rgba(148, 163, 184, 0.06)";
const POC_STROKE = "rgba(254, 240, 138, 0.9)";
const INVALIDATION_COLORS: Record<InvalidationSeverity, { active: string; inactive: string }> = {
  high: { active: "rgba(248, 113, 113, 0.9)", inactive: "rgba(248, 113, 113, 0.35)" },
  medium: { active: "rgba(251, 191, 36, 0.9)", inactive: "rgba(251, 191, 36, 0.35)" },
  low: { active: "rgba(56, 189, 248, 0.9)", inactive: "rgba(56, 189, 248, 0.35)" },
};

const PRICE_AXIS_WIDTH = 72;
const CURRENT_PRICE_COLOR = "rgba(248, 250, 252, 0.92)";
const CURRENT_PRICE_BG = "rgba(59, 130, 246, 0.22)";
const AXIS_BACKGROUND = "rgba(10, 12, 23, 0.95)";
const AXIS_TICK_COLOR = "rgba(226, 232, 240, 0.72)";
const AXIS_TICK_MARK_COLOR = "rgba(148, 163, 184, 0.4)";

const KEY_LEVEL_STYLES: Record<ChartKeyLevel["type"], { stroke: string; label: string }> = {
  pdh: { stroke: "rgba(250, 204, 21, 1)", label: "rgba(250, 204, 21, 0.16)" },
  pdl: { stroke: "rgba(59, 130, 246, 1)", label: "rgba(59, 130, 246, 0.16)" },
  "session-vwap": { stroke: "rgba(192, 132, 252, 1)", label: "rgba(192, 132, 252, 0.18)" },
  "session-high": { stroke: "rgba(14, 165, 233, 1)", label: "rgba(14, 165, 233, 0.18)" },
  "session-low": { stroke: "rgba(34, 197, 94, 1)", label: "rgba(34, 197, 94, 0.18)" },
  "current-high": { stroke: "rgba(34, 197, 94, 1)", label: "rgba(34, 197, 94, 0.18)" },
  "current-low": { stroke: "rgba(239, 68, 68, 1)", label: "rgba(239, 68, 68, 0.18)" },
  "prior-day-poc": { stroke: "rgba(148, 163, 184, 1)", label: "rgba(148, 163, 184, 0.18)" },
};

const KEY_LEVEL_STATUS_ALPHA: Record<KeyLevelStatus, number> = {
  live: 0.95,
  mixed: 0.8,
  approximate: 0.6,
  unavailable: 0.3,
};

const KEY_LEVEL_STATUS_DASH: Record<KeyLevelStatus, number[] | undefined> = {
  live: undefined,
  mixed: [10, 4],
  approximate: [6, 4],
  unavailable: [2, 6],
};

function computeAxisTicks(min: number, max: number, tickSize: number, desired = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || tickSize <= 0) {
    return [];
  }
  const range = max - min;
  const baseStep = tickSize;
  const multipliers = [1, 2, 2.5, 5];
  let step = baseStep;
  let multiplierIndex = 0;

  while (range / step > desired && multiplierIndex < 32) {
    const factor = multipliers[multiplierIndex % multipliers.length];
    step *= factor;
    multiplierIndex += 1;
  }

  const precision = precisionFromStep(tickSize);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];

  for (let price = start; price <= max + step; price += step) {
    const value = Number(price.toFixed(precision));
    if (value >= min - step * 0.5 && value <= max + step * 0.5) {
      ticks.push(value);
    }
    if (ticks.length > desired + 8) {
      break;
    }
  }

  return ticks;
}

export function FootprintChart({
  bars,
  signals,
  positions,
  pendingTrades,
  invalidations,
  priceStep,
  priceBounds,
  keyLevels,
  showGrid,
  showPriceAxis,
  tickSize,
  onHover,
}: FootprintChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const signalPositionsRef = useRef<
    Array<{ id: string; x: number; y: number; radius: number; signal: FootprintSignal }>
  >([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const precision = useMemo(() => precisionFromStep(priceStep), [priceStep]);
  const tickPrecision = useMemo(() => precisionFromStep(tickSize), [tickSize]);
  const barIndexByTime = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = 0; i < bars.length; i += 1) {
      map.set(bars[i].startTime, i);
    }
    return map;
  }, [bars]);

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

    signalPositionsRef.current = [];

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

    if (signals.length) {
      for (const signal of signals) {
        const barIndex = barIndexByTime.get(signal.barTime) ?? signal.barIndex ?? -1;
        if (barIndex < 0 || barIndex >= bars.length) {
          continue;
        }

        const levelPosition = (signal.entry - min) / priceStep;
        if (!Number.isFinite(levelPosition) || levelPosition < 0 || levelPosition > levelCount - 1) {
          continue;
        }

        const x = barIndex * cellWidth + cellWidth / 2;
        const y = size.height - (levelPosition + 0.5) * cellHeight;
        const radius = Math.max(4, Math.min(cellWidth, cellHeight) * 0.35);
        const color = signal.side === "long" ? "rgba(16, 185, 129, 0.95)" : "rgba(248, 113, 113, 0.95)";

        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        context.strokeStyle = "rgba(15, 23, 42, 0.95)";
        context.lineWidth = 1.2;
        context.stroke();

        const tailLength = Math.max(6, cellHeight * 0.6);
        context.beginPath();
        if (signal.side === "long") {
          context.moveTo(x, y + radius);
          context.lineTo(x, y + radius + tailLength);
        } else {
          context.moveTo(x, y - radius);
          context.lineTo(x, y - radius - tailLength);
        }
        context.strokeStyle = color;
        context.lineWidth = 1.2;
        context.stroke();

        signalPositionsRef.current.push({ id: signal.id, x, y, radius: radius + 4, signal });
      }
    }

    const priceToY = (price: number) => {
      const levelPosition = (price - min) / priceStep;
      if (!Number.isFinite(levelPosition)) {
        return null;
      }
      const clamped = Math.max(0, Math.min(levelCount - 1, levelPosition));
      return size.height - (clamped + 0.5) * cellHeight;
    };

    const drawLine = (y: number, color: string, width: number, dash?: number[]) => {
      context.save();
      if (dash) {
        context.setLineDash(dash);
      }
      context.strokeStyle = color;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(size.width, y);
      context.stroke();
      context.restore();
    };

    if (pendingTrades.length) {
      for (const trade of pendingTrades) {
        const y = priceToY(trade.entry);
        if (y === null) {
          continue;
        }
        const color = trade.side === "long" ? "rgba(16, 185, 129, 0.4)" : "rgba(248, 113, 113, 0.4)";
        drawLine(y, color, 1, [6, 4]);
      }
    }

    if (positions.length) {
      for (const position of positions) {
        const entryY = priceToY(position.entryPrice);
        if (entryY !== null) {
          const entryColor = position.side === "long" ? "rgba(16, 185, 129, 0.75)" : "rgba(248, 113, 113, 0.75)";
          drawLine(entryY, entryColor, 1.6);
        }

        const stopY = priceToY(position.stopPrice);
        if (stopY !== null) {
          const nearBe = Math.abs(position.stopPrice - position.entryPrice) < priceStep * 0.25;
          const stopColor =
            nearBe && position.target1Hit
              ? "rgba(250, 204, 21, 0.7)"
              : position.side === "long"
                ? "rgba(248, 113, 113, 0.55)"
                : "rgba(16, 185, 129, 0.55)";
          drawLine(stopY, stopColor, 1.2, [4, 4]);
        }

        const target1Y = priceToY(position.target1);
        if (target1Y !== null) {
          drawLine(target1Y, "rgba(59, 130, 246, 0.45)", 1, [2, 4]);
        }

        const target2Y = priceToY(position.target2);
        if (target2Y !== null) {
          drawLine(target2Y, "rgba(59, 130, 246, 0.7)", 1.4);
        }
      }
    }

    if (invalidations.length) {
      for (const event of invalidations) {
        const colorSet = INVALIDATION_COLORS[event.severity];
        const color = event.positionOpen ? colorSet.active : colorSet.inactive;
        let barIndex = -1;
        if (typeof event.barIndex === "number" && event.barIndex >= 0) {
          barIndex = event.barIndex;
        } else if (event.barTime !== null) {
          barIndex = barIndexByTime.get(event.barTime) ?? -1;
        }
        if (barIndex < 0 || barIndex >= bars.length) {
          continue;
        }

        const levelPosition = (event.price - min) / priceStep;
        if (!Number.isFinite(levelPosition)) {
          continue;
        }

        const clampedLevel = Math.max(0, Math.min(levelCount - 1, levelPosition));
        const x = barIndex * cellWidth + cellWidth / 2;
        const y = size.height - (clampedLevel + 0.5) * cellHeight;
        const radius = Math.max(3, Math.min(cellWidth, cellHeight) * 0.25);

        context.beginPath();
        context.fillStyle = color;
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "rgba(2, 6, 23, 0.9)";
        context.lineWidth = 1;
        context.stroke();

        context.save();
        context.fillStyle = color;
        context.font = "10px 'Inter', sans-serif";
        context.textAlign = "center";
        context.fillText(event.triggerLabel.toUpperCase(), x, y - radius - 4);
        context.restore();
      }
    }
  }, [barIndexByTime, bars, invalidations, pendingTrades, positions, priceBounds, priceStep, precision, signals, size.height, size.width]);

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

    const pointerX = size.width > 0 ? (relativeX / rect.width) * size.width : relativeX;
    const pointerY = size.height > 0 ? (relativeY / rect.height) * size.height : relativeY;

    const barWidth = rect.width / bars.length;
    const cellHeight = rect.height / levelCount;
    const detectionThreshold = Math.max(6, Math.min(barWidth, cellHeight) * 0.5);

    let matchedSignal: { id: string; x: number; y: number; radius: number; signal: FootprintSignal } | null = null;
    let minDistance = Number.POSITIVE_INFINITY;
    for (const position of signalPositionsRef.current) {
      const dx = pointerX - position.x;
      const dy = pointerY - position.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= position.radius + detectionThreshold && distance < minDistance) {
        matchedSignal = position;
        minDistance = distance;
      }
    }

    if (matchedSignal) {
      const signal = matchedSignal.signal;
      const barIndex = barIndexByTime.get(signal.barTime) ?? signal.barIndex ?? 0;
      const levelIndex = Math.round((signal.entry - min) / priceStep);
      const hover: HoverInfo = {
        barIndex: Math.max(0, Math.min(bars.length - 1, barIndex)),
        levelIndex,
        price: signal.entry,
        time: signal.barTime,
        askVol: 0,
        bidVol: 0,
        delta: signal.score,
        totalVolume: 0,
        signalId: signal.id,
      };
      onHover(hover, { x: event.clientX, y: event.clientY });
      return;
    }

    const barIndex = Math.min(bars.length - 1, Math.max(0, Math.floor(relativeX / barWidth)));
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

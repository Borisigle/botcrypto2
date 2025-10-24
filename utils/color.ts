const POSITIVE = { r: 34, g: 197, b: 94 };
const NEGATIVE = { r: 239, g: 68, b: 68 };

const MIN_ALPHA = 0.1;
const MAX_ALPHA = 0.95;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function deltaToRgba(delta: number, volume: number, maxVolume: number): string {
  if (!Number.isFinite(volume) || volume <= 0 || !Number.isFinite(maxVolume) || maxVolume <= 0) {
    return "rgba(255, 255, 255, 0.04)";
  }

  const base = delta >= 0 ? POSITIVE : NEGATIVE;
  const intensity = Math.log10(1 + volume) / Math.log10(1 + maxVolume);
  const alpha = clamp(MIN_ALPHA + intensity * (MAX_ALPHA - MIN_ALPHA), MIN_ALPHA, MAX_ALPHA);

  return `rgba(${base.r}, ${base.g}, ${base.b}, ${alpha.toFixed(3)})`;
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

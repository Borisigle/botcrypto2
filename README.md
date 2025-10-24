# BTC Footprint Heatmap

A real-time BTCUSDT footprint (delta heatmap) web application built with Next.js 14, Tailwind CSS, and TypeScript. The app consumes Binance Futures aggregated trades over a public WebSocket, aggregates them inside a Web Worker, and renders a performant canvas-based footprint chart.

## Features

- 🔥 **Live aggTrade stream** from Binance Futures (no API key required)
- 🧮 **Web Worker aggregation** for 1m / 5m bars with configurable price-step
- 🎨 **Canvas footprint heatmap** with delta colouring and POC overlay per bar
- 📊 **Cumulative delta panel** that can be toggled on/off
- 🧰 **Controls** for symbol, timeframe, and price step (0.1 – 2.0 USD)
- 🔁 **Auto-reconnect** logic with exponential backoff and status indicators
- ✅ **Unit tests** for aggregation, binning, delta, and pruning logic (Vitest)

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application. The footprint will begin rendering as soon as live trades arrive from Binance.

### Available scripts

- `npm run dev` – start the development server
- `npm run build` – create an optimized production build
- `npm run start` – run the production build
- `npm run lint` – lint the codebase with ESLint
- `npm run test` – execute Vitest unit tests

## Project structure

```
app/                   # Next.js App Router entrypoints
  page.tsx             # Main UI composition
  layout.tsx           # Global layout + fonts
components/            # Reusable UI components (controls, charts, status)
hooks/useFootprint.ts  # Core hook combining WebSocket + worker state
lib/
  aggregator.ts        # Trade bucketing, delta, POC, pruning logic
  binance.ts           # Binance WebSocket helper with auto-reconnect
public/                # Static assets
utils/color.ts         # Colour helpers & time formatting
workers/aggregator.worker.ts  # Web Worker for heavy aggregation
tests/                 # Vitest unit tests for the aggregator
```

## Notes

- The default view streams `BTCUSDT` on the 1 minute timeframe with a 0.5 USD price step.
- Switching timeframe or price step resets aggregation to avoid mixing incompatible bins.
- The app keeps the most recent 400 bars in memory to remain performant.

## Testing

Run the Vitest suite:

```bash
npm run test
```

This covers aggregation edge cases, including price binning precision, delta polarity, POC detection, and cumulative delta pruning.

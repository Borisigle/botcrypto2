'use client';

import { useCallback, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { Controls } from "@/components/Controls";
import { CumDeltaChart } from "@/components/CumDeltaChart";
import { FootprintChart } from "@/components/FootprintChart";
import { StatusBar } from "@/components/StatusBar";
import { TradingControls } from "@/components/TradingControls";
import { TradingPanel } from "@/components/TradingPanel";
import { useFootprint } from "@/hooks/useFootprint";
import type { HoverInfo } from "@/types";
import { formatTimestamp } from "@/utils/color";

export default function Page() {
  const {
    bars,
    signals,
    signalStats,
    signalControl,
    settings,
    updateSettings,
    setTimeframe,
    setPriceStep,
    toggleCumulativeDelta,
    setSignalMode,
    toggleStrategy: toggleSignalStrategy,
    updateSignalOverrides,
    connectionStatus,
    priceBounds,
    lastError,
    tradingState,
    updateTradingSettings,
    takeSignal,
    cancelPendingTrade,
    flattenPosition,
    resetTradingDay,
    exportTradingHistory,
  } = useFootprint();

  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  const activeBarTime = useMemo(() => (hover ? formatTimestamp(hover.time) : null), [hover]);

  const handleExportHistory = useCallback(
    (format: "json" | "csv") => {
      const data = exportTradingHistory(format);
      if (!data) {
        return;
      }
      const blob = new Blob([data], {
        type: format === "json" ? "application/json" : "text/csv",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const dateStamp = new Date().toISOString().slice(0, 10);
      anchor.download = `trading-history-${dateStamp}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [exportTradingHistory],
  );

  return (
    <main className="flex min-h-screen flex-col gap-6 bg-slate-950 px-4 pb-8 pt-6 text-slate-100 md:px-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-white">BTC Footprint Heatmap</h1>
        <p className="text-sm text-slate-400">
          Real-time Binance Futures BTCUSDT footprint with delta heatmap and cumulative delta tracking.
        </p>
      </header>

      <section className="flex flex-col gap-6 lg:flex-row">
        <div className="flex flex-1 flex-col gap-4">
          <div className="relative flex-1 min-h-[400px] rounded-lg">
            <FootprintChart
              bars={bars}
              signals={signals}
              positions={tradingState.positions}
              pendingTrades={tradingState.pending}
              priceStep={settings.priceStep}
              priceBounds={priceBounds}
              onHover={(info, position) => {
                setHover(info);
                setTooltip(position ?? null);
              }}
            />
            {hover && tooltip ? (
              <Tooltip hover={hover} position={tooltip} formattedTime={activeBarTime} />
            ) : null}
          </div>
          {settings.showCumulativeDelta ? <CumDeltaChart bars={bars} /> : null}
          <TradingPanel
            signals={signals}
            tradingState={tradingState}
            onTakeSignal={takeSignal}
            onCancelPending={cancelPendingTrade}
            onFlattenPosition={flattenPosition}
          />
        </div>

        <aside className="w-full max-w-sm flex-none space-y-4">
          <Controls
            symbol={settings.symbol}
            timeframe={settings.timeframe}
            priceStep={settings.priceStep}
            showCumulativeDelta={settings.showCumulativeDelta}
            signalControl={signalControl}
            signalStats={signalStats}
            onSymbolChange={(symbol) => updateSettings({ symbol: symbol || "BTCUSDT" })}
            onTimeframeChange={setTimeframe}
            onPriceStepChange={setPriceStep}
            onToggleCumulativeDelta={toggleCumulativeDelta}
            onModeChange={setSignalMode}
            onToggleStrategy={toggleSignalStrategy}
            onOverridesChange={updateSignalOverrides}
          />
          <TradingControls
            settings={tradingState.settings}
            onSettingsChange={updateTradingSettings}
            onResetDay={resetTradingDay}
            onExport={handleExportHistory}
          />
        </aside>
      </section>

      <StatusBar
        status={connectionStatus}
        symbol={settings.symbol}
        timeframe={settings.timeframe}
        priceStep={settings.priceStep}
        barsCount={bars.length}
        lastError={lastError}
      />
    </main>
  );
}

interface TooltipProps {
  hover: HoverInfo;
  position: { x: number; y: number };
  formattedTime: string | null;
}

function Tooltip({ hover, position, formattedTime }: TooltipProps) {
  let left = position.x + 16;
  let top = position.y + 16;

  if (typeof window !== "undefined") {
    left = Math.min(left, window.innerWidth - 240);
    top = Math.min(top, window.innerHeight - 160);
  }

  const style: CSSProperties = {
    left,
    top,
  };

  return (
    <div
      className="pointer-events-none fixed z-50 min-w-[220px] rounded-lg border border-white/10 bg-slate-900/95 p-3 text-xs shadow-xl shadow-black/40"
      style={style}
    >
      <div className="flex items-center justify-between text-white/70">
        <span className="font-semibold text-white">{hover.price.toFixed(2)}</span>
        {formattedTime ? <span>{formattedTime}</span> : null}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <div>
          <dt className="text-slate-400">Ask Vol</dt>
          <dd className="font-mono text-emerald-300">{hover.askVol.toFixed(3)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Bid Vol</dt>
          <dd className="font-mono text-rose-300">{hover.bidVol.toFixed(3)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Delta</dt>
          <dd className={`font-mono ${hover.delta >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {hover.delta.toFixed(3)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Total</dt>
          <dd className="font-mono text-white/80">{hover.totalVolume.toFixed(3)}</dd>
        </div>
      </dl>
    </div>
  );
}

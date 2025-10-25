export type Timeframe = "1m" | "5m";

export interface Settings {
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  maxBars: number;
  showCumulativeDelta: boolean;
}

export type FootprintMode = "live" | "replay";

export type ReplaySpeed = 1 | 2 | 5 | 10;

export interface RecordingDatasetSummary {
  id: string;
  label: string;
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  createdAt: number;
  updatedAt: number;
  startTime: number | null;
  endTime: number | null;
  totalTrades: number;
  totalBytes: number;
  chunkCount: number;
  durationMs: number;
}

export interface RecordingChunkMeta {
  id: string;
  datasetId: string;
  index: number;
  startTime: number;
  endTime: number;
  tradeCount: number;
  byteLength: number;
  storedAt: number;
  compressed: boolean;
}

export type ReplayStatus = "idle" | "loading" | "playing" | "paused" | "complete" | "error";

export interface ReplayState {
  datasetId: string | null;
  speed: ReplaySpeed;
  status: ReplayStatus;
  progress: number;
  error?: string | null;
  durationMs?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ReplayModeSummary {
  mode: SignalMode;
  label: string;
  estimatePerDay: number;
  dailyCount: number;
}

export interface ReplayMetrics {
  perMode: ReplayModeSummary[];
}

export interface SymbolMarketConfig {
  tickSize: number;
  stepSize: number;
  minPriceStep: number;
  maxPriceStep: number;
}

export interface ConnectionDiagnostics {
  reconnectAttempts: number;
  serverTimeOffsetMs: number;
  lastGapFillAt: number | null;
  gapFrom: number | null;
  gapTo: number | null;
  gapTradeCount: number;
}

export interface Trade {
  tradeId: number;
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export interface DepthLevel {
  price: number;
  quantity: number;
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  timestamp: number;
}

export interface DepthDiff {
  firstUpdateId: number;
  finalUpdateId: number;
  eventTime: number;
  transactionTime: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export type DepthStreamMessage =
  | { type: "snapshot"; snapshot: DepthSnapshot }
  | { type: "diff"; diff: DepthDiff };

export interface LevelBin {
  price: number;
  askVol: number;
  bidVol: number;
  delta: number;
  totalVolume: number;
}

export interface FootprintBar {
  startTime: number;
  endTime: number;
  levels: LevelBin[];
  pocPrice: number | null;
  pocVolume: number;
  totalDelta: number;
  cumulativeDelta: number;
  totalVolume: number;
  highPrice: number;
  lowPrice: number;
  openPrice: number;
  closePrice: number;
  depth?: DepthBarMetrics | null;
}

export interface FootprintState {
  bars: FootprintBar[];
  signals: FootprintSignal[];
  signalStats: SignalStats;
  depth: DepthState | null;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface HoverInfo {
  barIndex: number;
  levelIndex: number;
  price: number;
  time: number;
  askVol: number;
  bidVol: number;
  delta: number;
  totalVolume: number;
  signalId?: string | null;
}

export type SignalStrategy = "absorption-failure" | "poc-migration" | "delta-divergence";

export type SignalSide = "long" | "short";

export interface DepthAbsorptionConfirmation {
  side: SignalSide;
  price: number;
  startTime: number;
  confirmedAt: number;
  durationMs: number;
  replenishmentFactor: number;
  ofi: number;
  status: "pending" | "confirmed" | "rejected";
  tradeCount?: number;
}

export interface DepthSweepEvent {
  direction: "up" | "down";
  levelsCleared: number;
  priceMoveTicks: number;
  deltaSpike: number;
  detectedAt: number;
}

export interface DepthSpoofingEvent {
  side: "bid" | "ask";
  price: number;
  size: number;
  addedAt: number;
  cancelledAt: number;
}

export interface DepthBarMetrics {
  avgOfi: number;
  netOfi: number;
  maxImbalance: number;
  minImbalance: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number;
  bestAskSize: number;
  queueDeltaBid: number;
  queueDeltaAsk: number;
  maxReplenishmentBid: number;
  maxReplenishmentAsk: number;
  absorptions: DepthAbsorptionConfirmation[];
  sweeps: DepthSweepEvent[];
  spoofEvents: DepthSpoofingEvent[];
}

export interface DepthState {
  timestamp: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number;
  bestAskSize: number;
  spread: number | null;
  imbalance: number;
  ofi: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  pendingAbsorptions: DepthAbsorptionConfirmation[];
  lastAbsorption: DepthAbsorptionConfirmation | null;
  lastSweep: DepthSweepEvent | null;
  lastSpoof: DepthSpoofingEvent | null;
}

export type SignalMode = "conservative" | "standard" | "aggressive";

export type TradingSession = "asia" | "eu" | "us" | "other";

export interface SignalEvidenceItem {
  label: string;
  value: string;
}

export type InvalidationTriggerId =
  | "opposite-signal"
  | "stacked-imbalance"
  | "delta-poc-flip"
  | "cumdelta-break"
  | "key-level-recapture"
  | "time-decay"
  | "liquidity-sweep";

export type InvalidationSeverity = "low" | "medium" | "high";

export type InvalidationActionType = "close" | "reduce" | "hold" | "tighten-stop";

export interface InvalidationActionOption {
  type: InvalidationActionType;
  label: string;
}

export interface InvalidationEvidenceItem {
  label: string;
  value: string;
}

export interface FootprintSignal {
  id: string;
  timestamp: number;
  barTime: number;
  barIndex: number;
  price: number;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  score: number;
  session: TradingSession;
  side: SignalSide;
  strategy: SignalStrategy;
  strategies: SignalStrategy[];
  levelLabel: string | null;
  evidence: SignalEvidenceItem[];
  l2?: {
    confirmed: boolean;
    confidence: number;
    reason?: string | null;
    absorption?: DepthAbsorptionConfirmation | null;
    sweep?: DepthSweepEvent | null;
    spoof?: DepthSpoofingEvent | null;
  } | null;
}

export interface SignalStats {
  dailyCount: number;
  sessionCount: Record<TradingSession, number>;
  estimatePerDay: number;
  lastReset: number;
}

export interface DetectorOverrides {
  stackRatio?: number;
  stackLevels?: number;
  minScore?: number;
  minDeltaPercentile?: number;
  minVolumePercentile?: number;
  keyLevelDistancePercent?: number;
  requireDepthConfirmation?: boolean;
  depthAbsorptionWindowSec?: number;
  depthAbsorptionMinDurationSec?: number;
  depthReplenishFactor?: number;
  depthMaxTickProgress?: number;
  depthSweepTickThreshold?: number;
  depthSweepDeltaThreshold?: number;
  depthSweepWindowSec?: number;
  depthSweepMinLevels?: number;
  depthSpoofWindowSec?: number;
  depthSpoofSizeThreshold?: number;
}

export interface SignalControlState {
  mode: SignalMode;
  enabledStrategies: Record<SignalStrategy, boolean>;
  overrides: DetectorOverrides;
}

export interface InvalidationSettings {
  aggressiveness: "strict" | "moderate" | "relaxed";
  lookbackBars: number;
  autoCloseHighSeverity: boolean;
  autoCloseThreshold: number;
  minOppositeSignalScore: number;
  stackedImbalanceLevels: number;
  stackedImbalanceRatio: number;
  stackedImbalanceWindowSeconds: number;
  minProgressR: number;
  deltaFlipWindow: number;
  cumDeltaLookback: number;
  timeDecayMinutes: number;
  liquiditySweepPercentile: number;
  liquidityRetracePercent: number;
  keyLevelDeltaThreshold: number;
}

export interface InvalidationEvent {
  id: string;
  positionId: string;
  positionSide: SignalSide;
  strategy: SignalStrategy;
  triggerId: InvalidationTriggerId;
  triggerLabel: string;
  triggers: Array<{ id: InvalidationTriggerId; severity: number }>;
  score: number;
  severity: InvalidationSeverity;
  evidence: InvalidationEvidenceItem[];
  recommendation: string;
  actions: InvalidationActionOption[];
  timestamp: number;
  session: TradingSession;
  price: number;
  barTime: number | null;
  barIndex?: number | null;
  autoClosed: boolean;
  resolved: boolean;
  actionTaken?: InvalidationActionType;
  positionOpen: boolean;
}

export interface TradingSettings {
  autoTake: boolean;
  riskPerTradePercent: number;
  feesPercent: number;
  slippageTicks: number;
  partialTakePercent: number;
  timeStopMinutes: number | null;
  retestWindowMinutes: number;
  beOffsetTicks: number;
  invalidationBars: number;
  invalidations: InvalidationSettings;
}

export type TradeExitReason = "tp2" | "stop" | "breakeven" | "time-stop" | "invalidation" | "cancelled";

export type TradeFirstHit = "tp1" | "tp2" | "stop" | "time-stop" | "invalidation" | "none";

export type TradeResult = "win" | "loss" | "breakeven";

export interface PendingTrade {
  id: string;
  signalId: string;
  side: SignalSide;
  strategy: SignalStrategy;
  session: TradingSession;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  createdAt: number;
  expiresAt: number;
  entryType: "touch";
  auto: boolean;
  barIndex: number;
}

export interface Position {
  id: string;
  signalId: string;
  side: SignalSide;
  strategy: SignalStrategy;
  session: TradingSession;
  entryPrice: number;
  entryFillPrice: number;
  originalStop: number;
  stopPrice: number;
  target1: number;
  target2: number;
  entryTime: number;
  entryBarIndex: number;
  size: number;
  remainingSize: number;
  partialSize: number;
  riskAmount: number;
  riskPerUnit: number;
  timeStopAt: number | null;
  target1Hit: boolean;
  firstHit: TradeFirstHit;
  realizedPnl: number;
  realizedR: number;
  feesPaid: number;
  mfe: number;
  mae: number;
  lastPrice: number;
}

export interface ClosedTrade {
  id: string;
  signalId: string;
  side: SignalSide;
  strategy: SignalStrategy;
  session: TradingSession;
  entryPrice: number;
  entryFillPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  holdMinutes: number;
  firstHit: TradeFirstHit;
  exitReason: TradeExitReason;
  result: TradeResult;
  realizedPnl: number;
  realizedR: number;
  feesPaid: number;
  mfe: number;
  mae: number;
  day: string;
}

export interface SummaryStats {
  trades: number;
  winners: number;
  losers: number;
  breakeven: number;
  netR: number;
  netPercent: number;
  avgR: number;
  expectancy: number;
  winRate: number;
  lossRate: number;
}

export interface DailyPerformance {
  day: string;
  totals: SummaryStats;
  bySession: Record<TradingSession, SummaryStats>;
  byStrategy: Record<SignalStrategy, SummaryStats>;
}

export interface TradingState {
  settings: TradingSettings;
  pending: PendingTrade[];
  positions: Position[];
  closed: ClosedTrade[];
  history: ClosedTrade[];
  daily: DailyPerformance;
  invalidations: InvalidationEvent[];
  version: number;
}

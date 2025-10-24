export type Timeframe = "1m" | "5m";

export interface Settings {
  symbol: string;
  timeframe: Timeframe;
  priceStep: number;
  maxBars: number;
  showCumulativeDelta: boolean;
}

export interface Trade {
  tradeId: number;
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

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
}

export interface FootprintState {
  bars: FootprintBar[];
  signals: FootprintSignal[];
  signalStats: SignalStats;
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

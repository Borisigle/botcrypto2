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

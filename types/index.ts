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
}

export interface FootprintState {
  bars: FootprintBar[];
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
}

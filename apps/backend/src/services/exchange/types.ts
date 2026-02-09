/** Per-exchange position (unified shape for Binance/Bybit). */
export interface ExchangePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  collateral: number;
  unrealizedPnl: number;
  /** Position update time in ms (for orphan age check). */
  timestamp?: number;
}

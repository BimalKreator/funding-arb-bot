/** Matches backend GET /api/screener response item */
export interface ScreenerResultEntry {
  symbol: string;
  interval: number;
  binanceRate: number;
  bybitRate: number;
  grossSpread: number;
  netSpread: number;
  binanceAction: 'LONG' | 'SHORT';
  bybitAction: 'LONG' | 'SHORT';
  binanceMarkPrice?: number;
  bybitMarkPrice?: number;
  isBlacklisted?: boolean;
  blacklistedUntil?: number;
}

/** Exchange status response for balances */
export interface ExchangeStatusResponse {
  exchanges: Array<{
    exchangeId: string;
    connected: boolean;
    error?: string;
    balances?: Array<{ asset: string; available: string; locked: string; total: string }>;
  }>;
  timestamp: string;
}

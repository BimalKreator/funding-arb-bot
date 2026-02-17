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
  /** Set only for mismatched (High Frequency) rows */
  binanceIntervalHours?: number;
  bybitIntervalHours?: number;
  fastExchange?: 'binance' | 'bybit';
  /** Execution spread %: (Bid_Short - Ask_Long) / MarkPrice * 100. For Entry Guard eligibility. */
  executionSpread?: number;
}

/** GET /api/screener response */
export interface ScreenerResponse {
  standard: ScreenerResultEntry[];
  mismatched: ScreenerResultEntry[];
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

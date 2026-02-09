import type { ExchangeId } from './exchange.js';

/** Normalized funding + mark price data from any exchange */
export interface UnifiedFundingData {
  symbol: string;
  exchange: ExchangeId;
  fundingRate: string;
  /** Next funding timestamp in ms (or last if only that is available) */
  fundingTime: number;
  markPrice: string;
  receivedAt: string;
  /** Last funding timestamp (ms), when available */
  lastFundingTime?: number;
  /** Next funding timestamp (ms), when available */
  nextFundingTime?: number;
  /** Funding interval in hours (e.g. 8 for Bybit) */
  fundingIntervalHours?: number;
}

/** Per-symbol interval and mismatch status for GET /api/funding/intervals */
export interface SymbolIntervalStatus {
  symbol: string;
  binanceIntervalHours: number | null;
  bybitIntervalHours: number | null;
  status: 'valid' | 'invalid_interval' | 'missing_on_exchange';
}

/** Response shape for GET /api/funding/intervals */
export interface FundingIntervalsResponse {
  intervals: SymbolIntervalStatus[];
  validArbitrageSymbols: string[];
  lastUpdated: string;
}

/** Single row for GET /api/screener (sorted by netSpread desc) */
export interface ScreenerResultEntry {
  symbol: string;
  interval: number;
  binanceRate: number;
  bybitRate: number;
  grossSpread: number;
  netSpread: number;
  binanceAction: 'LONG' | 'SHORT';
  bybitAction: 'LONG' | 'SHORT';
  /** Mark price (for TradeModal) */
  binanceMarkPrice?: number;
  bybitMarkPrice?: number;
}

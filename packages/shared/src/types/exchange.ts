/**
 * Standardized exchange types for read-only connectivity.
 * Used by backend exchange clients and API responses.
 */

export type ExchangeId = 'binance' | 'bybit';

/** Unified balance across exchanges */
export interface UnifiedBalance {
  asset: string;
  available: string;
  locked: string;
  total: string;
  /** Optional: used margin from exchange (e.g. Bybit totalInitialMargin). */
  usedMargin?: string;
}

/** Unified market (USDT-margined perps only) */
export interface UnifiedMarket {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

/** Standardized interface each exchange client must implement */
export interface ExchangeService {
  readonly id: ExchangeId;
  fetchBalance(): Promise<UnifiedBalance[]>;
  getMarkets(): Promise<UnifiedMarket[]>;
}

/** Per-exchange connection health and data for status endpoint */
export interface ExchangeConnectionStatus {
  exchangeId: ExchangeId;
  connected: boolean;
  error?: string;
  balances?: UnifiedBalance[];
  marketsCount?: number;
}

/** Response shape for GET /api/exchanges/status */
export interface ExchangesStatusResponse {
  exchanges: ExchangeConnectionStatus[];
  timestamp: string;
}

/** Result of a single order (for trade execution) */
export interface OrderResult {
  orderId: string;
  status: string;
  exchangeId: ExchangeId;
}

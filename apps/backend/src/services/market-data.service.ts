import { WebsocketClient } from 'binance';

export interface BookTicker {
  bestBid: number;
  bestAsk: number;
}

/** Per-exchange cache: symbol -> { bestBid, bestAsk }. */
const binanceCache = new Map<string, BookTicker>();
const bybitCache = new Map<string, BookTicker>();

let wsClient: WebsocketClient | null = null;
let started = false;

/**
 * Singleton Market Data Service: maintains real-time best bid/ask from WebSockets
 * to avoid REST API rate limits for Entry Guard and Screener execution spread.
 * Binance: All Book Tickers Stream (!bookTicker) for USDM.
 * Bybit: not yet subscribed (cache stays empty; use REST fallback).
 */
export class MarketDataService {
  /**
   * Start WebSocket subscriptions. Idempotent.
   * @param testnet - use Binance futures testnet WS when true
   */
  start(testnet: boolean = false): void {
    if (started) return;
    started = true;
    wsClient = new WebsocketClient({
      testnet,
      beautify: true,
    });
    wsClient.on('formattedMessage', (msg: unknown) => {
      const m = msg as { eventType?: string; symbol?: string; bidPrice?: number; askPrice?: number };
      if (m?.eventType === 'bookTicker' && m?.symbol != null) {
        const bid = typeof m.bidPrice === 'number' && Number.isFinite(m.bidPrice) ? m.bidPrice : 0;
        const ask = typeof m.askPrice === 'number' && Number.isFinite(m.askPrice) ? m.askPrice : 0;
        if (bid > 0 || ask > 0) {
          binanceCache.set(m.symbol, { bestBid: bid, bestAsk: ask });
        }
      }
    });
    wsClient.on('exception', (evt: { wsKey?: string; message?: string }) => {
      console.error('[MarketDataService] Binance WS exception:', evt?.message ?? evt);
    });
    wsClient.subscribeAllBookTickers('usdm').catch((err: unknown) => {
      console.error('[MarketDataService] subscribeAllBookTickers failed:', err);
    });
  }

  stop(): void {
    if (wsClient) {
      try {
        (wsClient as WebsocketClient & { closeAll?: () => void }).closeAll?.();
      } catch {
        // ignore
      }
      wsClient = null;
    }
    started = false;
    binanceCache.clear();
    bybitCache.clear();
  }

  /**
   * Get cached best bid/ask for a symbol per exchange.
   * Binance from WS cache; Bybit not yet from WS (always null).
   */
  getMarketPrice(symbol: string): {
    binance: BookTicker | null;
    bybit: BookTicker | null;
  } {
    const binance = binanceCache.get(symbol) ?? null;
    const bybit = bybitCache.get(symbol) ?? null;
    return { binance, bybit };
  }

  /**
   * Single-exchange getter for Binance. Returns null if not in cache (cold start).
   */
  getBinancePrice(symbol: string): BookTicker | null {
    return binanceCache.get(symbol) ?? null;
  }

  /**
   * Single-exchange getter for Bybit. Currently always null (no Bybit WS yet).
   */
  getBybitPrice(symbol: string): BookTicker | null {
    return bybitCache.get(symbol) ?? null;
  }

  /** Expose cache for Screener (read-only). */
  getBinanceCache(): Map<string, BookTicker> {
    return binanceCache;
  }

  getBybitCache(): Map<string, BookTicker> {
    return bybitCache;
  }
}

let singleton: MarketDataService | null = null;

export function getMarketDataService(): MarketDataService {
  if (!singleton) {
    singleton = new MarketDataService();
  }
  return singleton;
}

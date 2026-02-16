import type {
  ExchangeId,
  ExchangeService,
  ExchangeConnectionStatus,
  ExchangesStatusResponse,
  OrderResult,
} from '@funding-arb-bot/shared';
import type { ExchangePosition } from './types.js';
import { BinanceFuturesClient } from './BinanceFuturesClient.js';
import { BybitFuturesClient } from './BybitFuturesClient.js';
import type { InstrumentService } from '../InstrumentService.js';

/** Extract a readable error message from unknown throw (Axios/API or Error). */
export function getReadableErrorMessage(err: unknown): string {
  if (err === null || err === undefined) return 'Unknown error';

  const ax = err as { response?: { data?: { msg?: string; message?: string }; status?: number } };
  if (ax.response?.data) {
    const msg = ax.response.data.msg ?? ax.response.data.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    const status = ax.response.status;
    const body = typeof ax.response.data === 'object'
      ? JSON.stringify(ax.response.data)
      : String(ax.response.data);
    return status ? `API error ${status}: ${body}` : body;
  }

  if (err instanceof Error) {
    const m = err.message?.trim();
    if (m && m !== '[object Object]') return m;
  }

  if (typeof err === 'string') return err;
  if (typeof err === 'object') return JSON.stringify(err);
  return String(err);
}

export interface ExchangeManagerConfig {
  binance?: { apiKey: string; apiSecret: string; testnet?: boolean };
  bybit?: { apiKey: string; apiSecret: string; testnet?: boolean };
  instrumentService?: InstrumentService;
}

const ALL_EXCHANGE_IDS: ExchangeId[] = ['binance', 'bybit'];

export interface ExecuteSplitOrderOptions {
  /** Number of limit-order chunks; 1 = single limit then market fallback. */
  splitParts?: number;
  /** Ms to wait for each limit fill before cancel + market. */
  timeoutMs?: number;
}

const DEFAULT_STEP_SIZE = 0.001;
const MIN_CLEANUP_NOTIONAL_USD = 5;

/** Round down quantity to step size for exchange compliance. */
function formatQuantity(qty: number, stepSize: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return qty;
  const steps = Math.floor(qty / stepSize + 1e-9);
  return steps * stepSize;
}

export class ExchangeManager {
  private clients: Map<ExchangeId, ExchangeService> = new Map();

  constructor(config: ExchangeManagerConfig) {
    if (config.binance?.apiKey && config.binance?.apiSecret) {
      this.clients.set(
        'binance',
        new BinanceFuturesClient({
          apiKey: config.binance.apiKey,
          apiSecret: config.binance.apiSecret,
          testnet: config.binance.testnet,
        })
      );
    }
    if (config.bybit?.apiKey && config.bybit?.apiSecret) {
      const instrumentService = config.instrumentService;
      this.clients.set(
        'bybit',
        new BybitFuturesClient({
          apiKey: config.bybit.apiKey,
          apiSecret: config.bybit.apiSecret,
          testnet: config.bybit.testnet,
          onOrderError: instrumentService
            ? (symbol, err) => instrumentService.reportOrderFailure(symbol, err)
            : undefined,
          instrumentService,
        })
      );
    }
  }

  async getStatus(): Promise<ExchangesStatusResponse> {
    const exchanges: ExchangeConnectionStatus[] = await Promise.all(
      ALL_EXCHANGE_IDS.map(async (exchangeId) => {
        const client = this.clients.get(exchangeId);
        if (!client) {
          return {
            exchangeId,
            connected: false,
            error: 'Not configured (missing API keys)',
          };
        }
        try {
          const [balances, markets] = await Promise.all([
            client.fetchBalance(),
            client.getMarkets(),
          ]);
          return {
            exchangeId: client.id,
            connected: true,
            balances,
            marketsCount: markets.length,
          };
        } catch (err) {
          return {
            exchangeId: client.id,
            connected: false,
            error: getReadableErrorMessage(err),
          };
        }
      })
    );

    return {
      exchanges,
      timestamp: new Date().toISOString(),
    };
  }

  /** Set leverage on both Binance and Bybit for the symbol before placing orders. */
  async setLeverageOnBothExchanges(leverage: number, symbol: string): Promise<void> {
    const binance = this.clients.get('binance') as ExchangeService & { setLeverage?(leverage: number, symbol: string): Promise<void> };
    const bybit = this.clients.get('bybit') as ExchangeService & { setLeverage?(leverage: number, symbol: string): Promise<void> };
    const promises: Promise<void>[] = [];
    if (binance?.setLeverage) promises.push(binance.setLeverage(leverage, symbol));
    if (bybit?.setLeverage) promises.push(bybit.setLeverage(leverage, symbol));
    if (promises.length === 0) throw new Error('No exchange configured for leverage');
    await Promise.all(promises);
  }

  /** Place a market order on the given exchange (quantity in base asset). */
  async placeOrder(
    exchangeId: ExchangeId,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number
  ): Promise<OrderResult> {
    const client = this.clients.get(exchangeId);
    if (!client) throw new Error(`Exchange ${exchangeId} not configured`);
    const trading = client as ExchangeService & {
      placeOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number): Promise<OrderResult>;
    };
    if (typeof trading.placeOrder !== 'function') throw new Error(`${exchangeId} does not support placeOrder`);
    return trading.placeOrder(symbol, side, quantity);
  }

  /** Best bid and best ask from orderbook. For SELL use bestBid, for BUY use bestAsk. */
  async getOrderbookTop(
    exchangeId: ExchangeId,
    symbol: string
  ): Promise<{ bestBid: number; bestAsk: number }> {
    const client = this.clients.get(exchangeId);
    if (!client) throw new Error(`Exchange ${exchangeId} not configured`);
    const withBook = client as ExchangeService & {
      getOrderbookTop(symbol: string): Promise<{ bestBid: number; bestAsk: number }>;
    };
    if (typeof withBook.getOrderbookTop !== 'function') throw new Error(`${exchangeId} does not support getOrderbookTop`);
    return withBook.getOrderbookTop(symbol);
  }

  /** Place a limit order; returns orderId. */
  async placeLimitOrder(
    exchangeId: ExchangeId,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number
  ): Promise<{ orderId: string }> {
    const client = this.clients.get(exchangeId);
    if (!client) throw new Error(`Exchange ${exchangeId} not configured`);
    const trading = client as ExchangeService & {
      placeLimitOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number): Promise<{ orderId: string }>;
    };
    if (typeof trading.placeLimitOrder !== 'function') throw new Error(`${exchangeId} does not support placeLimitOrder`);
    return trading.placeLimitOrder(symbol, side, quantity, price);
  }

  /** Order status: FILLED, OPEN, PARTIALLY_FILLED, or CANCELED/REJECTED/EXPIRED. */
  async getOrderStatus(
    exchangeId: ExchangeId,
    symbol: string,
    orderId: string
  ): Promise<'FILLED' | 'OPEN' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'> {
    const client = this.clients.get(exchangeId);
    if (!client) throw new Error(`Exchange ${exchangeId} not configured`);
    const trading = client as ExchangeService & {
      getOrderStatus(symbol: string, orderId: string): Promise<'FILLED' | 'OPEN' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'>;
    };
    if (typeof trading.getOrderStatus !== 'function') throw new Error(`${exchangeId} does not support getOrderStatus`);
    return trading.getOrderStatus(symbol, orderId);
  }

  /** Cancel an open order by id. */
  async cancelOrderById(exchangeId: ExchangeId, symbol: string, orderId: string): Promise<void> {
    const client = this.clients.get(exchangeId);
    if (!client) throw new Error(`Exchange ${exchangeId} not configured`);
    const trading = client as ExchangeService & {
      cancelOrderById(symbol: string, orderId: string): Promise<void>;
    };
    if (typeof trading.cancelOrderById !== 'function') throw new Error(`${exchangeId} does not support cancelOrderById`);
    return trading.cancelOrderById(symbol, orderId);
  }

  /** Split limit order: try limit in chunks, fallback to market if stuck. Used by TradeService and PositionService. */
  async executeSplitOrder(
    exchangeId: ExchangeId,
    symbol: string,
    side: 'BUY' | 'SELL',
    totalQuantity: number,
    markPrice: number,
    options?: ExecuteSplitOrderOptions
  ): Promise<OrderResult> {
    const SPLIT_PARTS = options?.splitParts ?? 3;
    const ORDER_TIMEOUT_MS = options?.timeoutMs ?? 2000;
    const MIN_CHUNK_NOTIONAL_USD = 10;

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const getPriceForCheck = async (): Promise<number> => {
      if (markPrice > 0 && Number.isFinite(markPrice)) return markPrice;
      const top = await this.getOrderbookTop(exchangeId, symbol);
      return side === 'SELL' ? top.bestBid : top.bestAsk;
    };

    const runSingleLimitThenMarket = async (qty: number): Promise<OrderResult> => {
      const { bestBid, bestAsk } = await this.getOrderbookTop(exchangeId, symbol);
      const price = side === 'SELL' ? bestBid : bestAsk;
      if (!Number.isFinite(price) || price <= 0) {
        return this.placeOrder(exchangeId, symbol, side, qty);
      }
      const { orderId } = await this.placeLimitOrder(exchangeId, symbol, side, qty, price);
      await sleep(ORDER_TIMEOUT_MS);
      const status = await this.getOrderStatus(exchangeId, symbol, orderId);
      if (status === 'FILLED') return { orderId, status: 'FILLED', exchangeId };
      try {
        await this.cancelOrderById(exchangeId, symbol, orderId);
      } catch {
        // ignore
      }
      return this.placeOrder(exchangeId, symbol, side, qty);
    };

    if (SPLIT_PARTS <= 1) {
      return runSingleLimitThenMarket(totalQuantity);
    }

    const chunkQty = totalQuantity / SPLIT_PARTS;
    const priceForCheck = await getPriceForCheck();
    const chunkNotional = chunkQty * priceForCheck;
    const doSplit = Number.isFinite(chunkNotional) && chunkNotional >= MIN_CHUNK_NOTIONAL_USD;

    if (!doSplit) {
      return runSingleLimitThenMarket(totalQuantity);
    }

    let executedQty = 0;
    const chunkSize = totalQuantity / SPLIT_PARTS;
    let lastOrderId = '';

    for (let part = 0; part < SPLIT_PARTS; part++) {
      const remaining = totalQuantity - executedQty;
      if (remaining <= 0) break;

      const qty = part < SPLIT_PARTS - 1 ? chunkSize : remaining;

      try {
        const { bestBid, bestAsk } = await this.getOrderbookTop(exchangeId, symbol);
        const price = side === 'SELL' ? bestBid : bestAsk;
        if (!Number.isFinite(price) || price <= 0) {
          const res = await this.placeOrder(exchangeId, symbol, side, remaining);
          return res;
        }

        const { orderId } = await this.placeLimitOrder(exchangeId, symbol, side, qty, price);
        lastOrderId = orderId;
        await sleep(ORDER_TIMEOUT_MS);
        const status = await this.getOrderStatus(exchangeId, symbol, orderId);

        if (status === 'FILLED') {
          executedQty += qty;
          continue;
        }

        if (status === 'OPEN' || status === 'PARTIALLY_FILLED') {
          try {
            await this.cancelOrderById(exchangeId, symbol, orderId);
          } catch {
            // ignore
          }
          const toMarket = totalQuantity - executedQty;
          if (toMarket > 0) {
            await this.placeOrder(exchangeId, symbol, side, toMarket);
          }
          return { orderId: lastOrderId, status: 'FILLED', exchangeId };
        }
      } catch (err) {
        const toMarket = totalQuantity - executedQty;
        if (toMarket > 0) {
          try {
            await this.placeOrder(exchangeId, symbol, side, toMarket);
          } catch (marketErr) {
            console.error(`[ExchangeManager] executeSplitOrder market fallback failed:`, marketErr);
          }
        }
        throw err;
      }
    }

    // Mandatory market cleanup: ensure 100% of requested quantity is executed (catches rounding dust).
    const finalRemaining = totalQuantity - executedQty;
    if (finalRemaining > 0) {
      const cleanRem = formatQuantity(finalRemaining, DEFAULT_STEP_SIZE);
      if (cleanRem > 0) {
        const notional = cleanRem * priceForCheck;
        if (Number.isFinite(notional) && notional >= MIN_CLEANUP_NOTIONAL_USD) {
          console.log(`[ExchangeManager] Force closing remaining dust: ${cleanRem}`);
          await this.placeOrder(exchangeId, symbol, side, cleanRem);
        }
      }
    }

    return { orderId: lastOrderId || 'split-done', status: 'FILLED', exchangeId };
  }

  /** Total funding received for a symbol across both exchanges between openTime and closeTime (ms). */
  async getFundingBetween(symbol: string, openTime: number, closeTime: number): Promise<number> {
    const binance = this.clients.get('binance') as ExchangeService & {
      getFundingIncome?(symbol: string, startTime: number, endTime: number): Promise<number>;
    };
    const bybit = this.clients.get('bybit') as ExchangeService & {
      getFundingIncome?(symbol: string, startTime: number, endTime: number): Promise<number>;
    };
    const [binanceFunding, bybitFunding] = await Promise.all([
      binance?.getFundingIncome?.(symbol, openTime, closeTime) ?? Promise.resolve(0),
      bybit?.getFundingIncome?.(symbol, openTime, closeTime) ?? Promise.resolve(0),
    ]);
    return (binanceFunding ?? 0) + (bybitFunding ?? 0);
  }

  /** Get active positions for an exchange (optional symbol filter). */
  async getPositions(exchangeId: ExchangeId, symbol?: string): Promise<ExchangePosition[]> {
    const client = this.clients.get(exchangeId);
    if (!client) return [];
    const withPositions = client as ExchangeService & {
      getPositions(symbol?: string): Promise<ExchangePosition[]>;
    };
    if (typeof withPositions.getPositions !== 'function') return [];
    return withPositions.getPositions(symbol);
  }
}

import type {
  ExchangeId,
  ExchangeService,
  ExchangeConnectionStatus,
  ExchangesStatusResponse,
  OrderResult,
} from '@funding-arb-bot/shared';
import { BinanceFuturesClient } from './BinanceFuturesClient.js';
import { BybitFuturesClient } from './BybitFuturesClient.js';

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
}

const ALL_EXCHANGE_IDS: ExchangeId[] = ['binance', 'bybit'];

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
      this.clients.set(
        'bybit',
        new BybitFuturesClient({
          apiKey: config.bybit.apiKey,
          apiSecret: config.bybit.apiSecret,
          testnet: config.bybit.testnet,
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
}

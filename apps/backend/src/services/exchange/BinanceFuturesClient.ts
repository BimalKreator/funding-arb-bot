import { USDMClient } from 'binance';
import type {
  ExchangeService,
  ExchangeId,
  UnifiedBalance,
  UnifiedMarket,
  OrderResult,
} from '@funding-arb-bot/shared';
import type { ExchangePosition } from './types.js';

/** Ensure value is a valid numeric string for API; fallback to total then "0" to avoid NaN. */
function toValidBalance(value: string | number | undefined | null, fallback: string): string {
  const s = value === undefined || value === null ? '' : String(value).trim();
  const n = parseFloat(s);
  if (Number.isFinite(n) && n >= 0) return n.toFixed(8);
  const fb = parseFloat(fallback);
  if (Number.isFinite(fb) && fb >= 0) return fb.toFixed(8);
  return '0.00000000';
}

export class BinanceFuturesClient implements ExchangeService {
  readonly id: ExchangeId = 'binance';
  private client: USDMClient | null = null;

  constructor(options: { apiKey?: string; apiSecret?: string; testnet?: boolean }) {
    const { apiKey, apiSecret, testnet = false } = options;
    if (apiKey && apiSecret) {
      this.client = new USDMClient({ api_key: apiKey, api_secret: apiSecret, testnet });
    }
  }

  async fetchBalance(): Promise<UnifiedBalance[]> {
    if (!this.client) {
      throw new Error('Binance client not configured: set BINANCE_API_KEY and BINANCE_API_SECRET');
    }
    const raw = await this.client.getBalance();
    return raw.map((row) => {
      const total = toValidBalance(row.balance, '0');
      const available = toValidBalance(row.availableBalance, total);
      const lockedNum = parseFloat(total) - parseFloat(available);
      const locked = Number.isFinite(lockedNum) ? Math.max(0, lockedNum).toFixed(8) : '0.00000000';
      return {
        asset: row.asset,
        available,
        locked,
        total,
      };
    });
  }

  async getMarkets(): Promise<UnifiedMarket[]> {
    const client = this.client ?? new USDMClient();
    const info = await client.getExchangeInfo();
    return info.symbols
      .filter(
        (s) =>
          s.contractType === 'PERPETUAL' &&
          (s.quoteAsset === 'USDT' || s.marginAsset === 'USDT')
      )
      .map((s) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: String(s.status),
      }));
  }

  /** Set leverage for a symbol (USDT-margined futures). Must be called before placing orders. */
  async setLeverage(leverage: number, symbol: string): Promise<void> {
    if (!this.client) throw new Error('Binance client not configured');
    if (!Number.isInteger(leverage) || leverage < 1) throw new Error(`Invalid leverage: ${leverage}`);
    await this.client.setLeverage({ symbol, leverage });
  }

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number): Promise<OrderResult> {
    if (!this.client) throw new Error('Binance client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for ${symbol}`);
    const res = await this.client.submitNewOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity,
    });
    const orderId = String((res as { orderId?: number }).orderId ?? '');
    return { orderId, status: 'FILLED', exchangeId: 'binance' };
  }

  /** Best bid (index 0) and best ask (index 0) from orderbook. For SELL use bestBid, for BUY use bestAsk. */
  async getOrderbookTop(symbol: string): Promise<{ bestBid: number; bestAsk: number }> {
    const client = this.client ?? new USDMClient();
    const book = await client.getOrderBook({ symbol, limit: 5 });
    const bids = (book as { bids?: [string, string][] }).bids ?? [];
    const asks = (book as { asks?: [string, string][] }).asks ?? [];
    const bestBid = bids.length > 0 ? parseFloat(String(bids[0][0])) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(String(asks[0][0])) : 0;
    return { bestBid, bestAsk };
  }

  async placeLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number
  ): Promise<{ orderId: string }> {
    if (!this.client) throw new Error('Binance client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid quantity/price for ${symbol}`);
    }
    const res = await this.client.submitNewOrder({
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity,
      price,
    });
    const orderId = String((res as { orderId?: number }).orderId ?? '');
    return { orderId };
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<'FILLED' | 'OPEN' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'> {
    if (!this.client) throw new Error('Binance client not configured');
    const order = await this.client.getOrder({ symbol, orderId: parseInt(orderId, 10) });
    const status = String((order as { status?: string }).status ?? '').toUpperCase();
    if (status === 'FILLED') return 'FILLED';
    if (status === 'NEW') return 'OPEN';
    if (status === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED';
    if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') return status as 'CANCELED' | 'REJECTED' | 'EXPIRED';
    return 'OPEN';
  }

  async cancelOrderById(symbol: string, orderId: string): Promise<void> {
    if (!this.client) throw new Error('Binance client not configured');
    await this.client.cancelOrder({ symbol, orderId: parseInt(orderId, 10) });
  }

  /** Total funding fee income for a symbol between startTime and endTime (ms). */
  async getFundingIncome(symbol: string, startTime: number, endTime: number): Promise<number> {
    if (!this.client) return 0;
    try {
      const list = await this.client.getIncomeHistory({
        symbol,
        incomeType: 'FUNDING_FEE',
        startTime,
        endTime,
        limit: 100,
      });
      const arr = Array.isArray(list) ? list : [];
      return arr.reduce((sum, row) => {
        const income = parseFloat((row as { income?: string; asset?: string }).income ?? '0');
        return sum + (Number.isFinite(income) ? income : 0);
      }, 0);
    } catch {
      return 0;
    }
  }

  /** Fetch active positions (non-zero). */
  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    if (!this.client) throw new Error('Binance client not configured');
    const list = await this.client.getPositionsV3(symbol ? { symbol } : undefined);
    return list
      .filter((p) => {
        const amt = parseFloat(String(p.positionAmt ?? 0));
        return Number.isFinite(amt) && amt !== 0;
      })
      .map((p) => {
        const amt = parseFloat(String(p.positionAmt ?? 0));
        const side = amt > 0 ? 'LONG' as const : 'SHORT' as const;
        const quantity = Math.abs(amt);
        const entryPrice = parseFloat(String(p.entryPrice ?? 0));
        const markPrice = parseFloat(String(p.markPrice ?? 0));
        const liquidationPrice = parseFloat(String(p.liquidationPrice ?? 0));
        const collateral = parseFloat(String(p.initialMargin ?? 0));
        const unrealizedPnl = parseFloat(String(p.unRealizedProfit ?? 0));
        const updateTime = p.updateTime != null ? Number(p.updateTime) : undefined;
        const timestamp = Number.isFinite(updateTime) ? updateTime : undefined;
        return {
          symbol: p.symbol,
          side,
          quantity,
          entryPrice,
          markPrice,
          liquidationPrice,
          collateral,
          unrealizedPnl,
          timestamp,
        };
      });
  }
}

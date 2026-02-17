import { RestClientV5 } from 'bybit-api';
import type {
  ExchangeService,
  ExchangeId,
  UnifiedBalance,
  UnifiedMarket,
  OrderResult,
} from '@funding-arb-bot/shared';
import type { ExchangePosition } from './types.js';
import type { InstrumentService } from '../InstrumentService.js';

/** Ensure value is a valid numeric string for API; fallback to total then "0" to avoid NaN. */
function toValidBalance(value: string | number | undefined | null, fallback: string): string {
  const s = value === undefined || value === null ? '' : String(value).trim();
  const n = parseFloat(s);
  if (Number.isFinite(n) && n >= 0) return n.toFixed(8);
  const fb = parseFloat(fallback);
  if (Number.isFinite(fb) && fb >= 0) return fb.toFixed(8);
  return '0.00000000';
}

export type BybitOrderErrorCallback = (symbol: string, err: unknown) => void;

export class BybitFuturesClient implements ExchangeService {
  readonly id: ExchangeId = 'bybit';
  private client: RestClientV5 | null = null;
  private onOrderError: BybitOrderErrorCallback | undefined;

  private instrumentService: InstrumentService | undefined;

  constructor(options: {
    apiKey?: string;
    apiSecret?: string;
    testnet?: boolean;
    onOrderError?: BybitOrderErrorCallback;
    instrumentService?: InstrumentService;
  }) {
    const { apiKey, apiSecret, testnet = false, onOrderError, instrumentService } = options;
    this.onOrderError = onOrderError;
    this.instrumentService = instrumentService;
    if (apiKey && apiSecret) {
      this.client = new RestClientV5({
        key: apiKey,
        secret: apiSecret,
        testnet,
      });
    }
  }

  async fetchBalance(): Promise<UnifiedBalance[]> {
    if (!this.client) {
      throw new Error('Bybit client not configured: set BYBIT_API_KEY and BYBIT_API_SECRET');
    }
    const res = await this.client.getWalletBalance({ accountType: 'UNIFIED' });
    if (res.retCode !== 0) {
      throw new Error(res.retMsg ?? 'Failed to fetch Bybit wallet balance');
    }
    const list = (res.result?.list ?? []) as Array<{
      totalInitialMargin?: string;
      totalMarginBalance?: string;
      coin?: Array<{ coin: string; walletBalance?: string; availableToWithdraw?: string; free?: string }>;
    }>;
    const balances: UnifiedBalance[] = [];
    for (const account of list) {
      const usedMarginRaw = account.totalInitialMargin ?? account.totalMarginBalance ?? '0';
      const usedMarginNum = parseFloat(String(usedMarginRaw).trim());
      const usedMargin = Number.isFinite(usedMarginNum) && usedMarginNum >= 0 ? usedMarginNum : 0;

      for (const coin of account.coin ?? []) {
        const totalRaw = coin.walletBalance ?? '0';
        const totalNum = parseFloat(String(totalRaw).trim());
        const total = Number.isFinite(totalNum) && totalNum >= 0 ? totalNum.toFixed(8) : '0.00000000';

        let available: string;
        if (coin.coin === 'USDT') {
          const freeNum = totalNum - usedMargin;
          available = (Number.isFinite(freeNum) && freeNum >= 0 ? freeNum : 0).toFixed(8);
        } else {
          const availableRaw = coin.availableToWithdraw ?? coin.free ?? '';
          available = toValidBalance(availableRaw, total);
        }

        const lockedNum = totalNum - parseFloat(available);
        const locked = Number.isFinite(lockedNum) ? Math.max(0, lockedNum).toFixed(8) : '0.00000000';
        const usedMarginStr = usedMargin.toFixed(8);
        balances.push({
          asset: coin.coin,
          available,
          locked,
          total,
          ...(coin.coin === 'USDT' ? { usedMargin: usedMarginStr } : {}),
        });
      }
    }
    return balances;
  }

  async getMarkets(): Promise<UnifiedMarket[]> {
    const client = this.client ?? new RestClientV5({});
    const res = await client.getInstrumentsInfo({ category: 'linear' });
    if (res.retCode !== 0) {
      throw new Error(res.retMsg ?? 'Failed to fetch Bybit instruments');
    }
    const list = (res.result as { list?: Array<{ symbol: string; baseCoin: string; quoteCoin: string; status: string }> })?.list ?? [];
    return list.map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseCoin,
      quoteAsset: s.quoteCoin,
      status: s.status,
    }));
  }

  /** Set leverage for a symbol (linear/USDT perpetual). Must be called before placing orders. */
  async setLeverage(leverage: number, symbol: string): Promise<void> {
    if (!this.client) throw new Error('Bybit client not configured');
    if (!Number.isInteger(leverage) || leverage < 1) throw new Error(`Invalid leverage: ${leverage}`);
    const levStr = String(leverage);
    await this.client.setLeverage({
      category: 'linear',
      symbol,
      buyLeverage: levStr,
      sellLeverage: levStr,
    });
  }

  /** @param reduceOnly - true when closing (exit), false when opening (entry). Default true for backward compat. */
  async placeOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number, reduceOnly: boolean = true): Promise<OrderResult> {
    if (!this.client) throw new Error('Bybit client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for ${symbol}`);
    const qtyStr = this.formatQty(symbol, quantity);
    try {
      const orderRes = await this.client.submitOrder({
        category: 'linear',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: qtyStr,
        reduceOnly,
      });
      if (orderRes.retCode !== 0) {
        const err = Object.assign(new Error(orderRes.retMsg ?? 'Order failed'), {
          retCode: orderRes.retCode,
          retMsg: orderRes.retMsg,
        });
        this.onOrderError?.(symbol, err);
        throw err;
      }
      const orderId = (orderRes.result as { orderId?: string })?.orderId ?? '';
      return { orderId, status: 'FILLED', exchangeId: 'bybit' };
    } catch (err: unknown) {
      this.onOrderError?.(symbol, err);
      throw err;
    }
  }

  /**
   * Round down quantity to exchange qtyStep to avoid "Invalid Quantity" / dust errors.
   * Uses InstrumentService when available; otherwise a conservative step (0.001) to avoid excess decimals.
   */
  private formatQty(symbol: string, quantity: number): string {
    const info = this.instrumentService?.getInstrument(symbol);
    const step = info?.qtyStep != null && info.qtyStep > 0 ? info.qtyStep : 0.001;
    const steps = Math.floor(quantity / step + 1e-9);
    const totalQty = steps * step;
    const stepDecimals = step >= 1 ? 0 : Math.max(0, Math.ceil(-Math.log10(step)));
    const fixed = totalQty.toFixed(stepDecimals);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') || fixed : fixed;
  }

  /** Best bid and best ask from orderbook. For SELL use bestBid, for BUY use bestAsk. */
  async getOrderbookTop(symbol: string): Promise<{ bestBid: number; bestAsk: number }> {
    const client = this.client ?? new RestClientV5({});
    const res = await client.getOrderbook({ category: 'linear', symbol, limit: 5 });
    if (res.retCode !== 0) throw new Error(res.retMsg ?? 'Failed to get orderbook');
    const result = res.result as { b?: [string, string][]; a?: [string, string][] };
    const bids = result?.b ?? [];
    const asks = result?.a ?? [];
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
    if (!this.client) throw new Error('Bybit client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid quantity/price for ${symbol}`);
    }
    const qtyStr = this.formatQty(symbol, quantity);
    const priceStr = String(price);
    try {
      const orderRes = await this.client.submitOrder({
        category: 'linear',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        qty: qtyStr,
        price: priceStr,
        timeInForce: 'GTC',
        reduceOnly: true,
      });
      if (orderRes.retCode !== 0) {
        const err = Object.assign(new Error(orderRes.retMsg ?? 'Limit order failed'), {
          retCode: orderRes.retCode,
          retMsg: orderRes.retMsg,
        });
        this.onOrderError?.(symbol, err);
        throw err;
      }
      const orderId = (orderRes.result as { orderId?: string })?.orderId ?? '';
      return { orderId };
    } catch (err: unknown) {
      this.onOrderError?.(symbol, err);
      throw err;
    }
  }

  /**
   * Post-Only limit order (maker only). Uses timeInForce PostOnly.
   * @param reduceOnly - true for closing positions (exit), false for opening (entry).
   */
  async placeLimitOrderPostOnly(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
    reduceOnly: boolean = true
  ): Promise<{ orderId: string }> {
    if (!this.client) throw new Error('Bybit client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid quantity/price for ${symbol}`);
    }
    const qtyStr = this.formatQty(symbol, quantity);
    const priceStr = String(price);
    try {
      const orderRes = await this.client.submitOrder({
        category: 'linear',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        qty: qtyStr,
        price: priceStr,
        timeInForce: 'PostOnly',
        reduceOnly,
      });
      if (orderRes.retCode !== 0) {
        const err = Object.assign(new Error(orderRes.retMsg ?? 'PostOnly limit order failed'), {
          retCode: orderRes.retCode,
          retMsg: orderRes.retMsg,
        });
        this.onOrderError?.(symbol, err);
        throw err;
      }
      const orderId = (orderRes.result as { orderId?: string })?.orderId ?? '';
      return { orderId };
    } catch (err: unknown) {
      this.onOrderError?.(symbol, err);
      throw err;
    }
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<'FILLED' | 'OPEN' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'> {
    if (!this.client) throw new Error('Bybit client not configured');
    const res = await this.client.getActiveOrders({
      category: 'linear',
      symbol,
      orderId,
      limit: 1,
    });
    if (res.retCode !== 0) return 'OPEN';
    const list = (res.result as { list?: Array<{ orderStatus?: string }> })?.list ?? [];
    if (list.length === 0) return 'FILLED'; // not in active = filled or cancelled; treat as filled for flow
    const status = String(list[0]?.orderStatus ?? '').toLowerCase();
    if (status === 'filled') return 'FILLED';
    if (status === 'new') return 'OPEN';
    if (status === 'partiallyfilled') return 'PARTIALLY_FILLED';
    if (status === 'cancelled' || status === 'rejected') return status === 'cancelled' ? 'CANCELED' : 'REJECTED';
    return 'OPEN';
  }

  async cancelOrderById(symbol: string, orderId: string): Promise<void> {
    if (!this.client) throw new Error('Bybit client not configured');
    const res = await this.client.cancelOrder({ category: 'linear', symbol, orderId });
    if (res.retCode !== 0) throw new Error(res.retMsg ?? 'Cancel order failed');
  }

  /** True if there is at least one OPEN/PENDING order for the symbol (e.g. exit in progress). */
  async hasOpenOrders(symbol: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const res = await this.client.getActiveOrders({ category: 'linear', symbol, limit: 1 });
      if (res.retCode !== 0) return false;
      const list = (res.result as { list?: unknown[] })?.list ?? [];
      return list.length > 0;
    } catch {
      return false;
    }
  }

  /** Total funding received for a symbol between startTime and endTime (ms). Unified Transaction Log. */
  async getFundingIncome(symbol: string, startTime: number, endTime: number): Promise<number> {
    if (!this.client) return 0;
    try {
      const res = await this.client.getTransactionLog({
        accountType: 'UNIFIED',
        category: 'linear',
        startTime,
        endTime,
        limit: 100,
      });
      const list = (res.result as { list?: Array<{ symbol: string; funding?: string }> })?.list ?? [];
      return list
        .filter((row) => row.symbol === symbol)
        .reduce((sum, row) => {
          const funding = parseFloat(row.funding ?? '0');
          return sum + (Number.isFinite(funding) ? funding : 0);
        }, 0);
    } catch {
      return 0;
    }
  }

  /** Fetch active positions (non-zero). USDT Perpetual (linear) with settleCoin for Unified/Standard. */
  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    if (!this.client) throw new Error('Bybit client not configured');
    const res = await this.client.getPositionInfo({
      category: 'linear',
      settleCoin: 'USDT',
      ...(symbol ? { symbol } : {}),
    });
    if (res.retCode !== 0) throw new Error(res.retMsg ?? 'Failed to fetch positions');
    const list = (res.result as {
      list?: Array<{
        symbol: string;
        side: string;
        size: string;
        avgPrice: string;
        markPrice: string;
        liqPrice: string;
        positionIM?: string;
        unrealisedPnl: string;
        updatedTime?: string;
      }>;
    })?.list ?? [];
    return list
      .filter((p) => {
        const size = parseFloat(p.size ?? '0');
        return Number.isFinite(size) && size > 0;
      })
      .map((p) => {
        const side = String(p.side).toLowerCase() === 'buy' ? 'LONG' as const : 'SHORT' as const;
        const quantity = parseFloat(p.size ?? '0');
        const entryPrice = parseFloat(p.avgPrice ?? '0');
        const markPrice = parseFloat(p.markPrice ?? '0');
        const liquidationPrice = parseFloat(p.liqPrice ?? '0') || 0;
        const collateral = parseFloat(p.positionIM ?? '0') || 0;
        const unrealizedPnl = parseFloat(p.unrealisedPnl ?? '0');
        const updatedTime = p.updatedTime != null ? parseInt(String(p.updatedTime), 10) : NaN;
        const timestamp = Number.isFinite(updatedTime) ? updatedTime : undefined;
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

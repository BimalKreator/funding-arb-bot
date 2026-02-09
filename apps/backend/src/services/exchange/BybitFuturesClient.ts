import { RestClientV5 } from 'bybit-api';
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

export class BybitFuturesClient implements ExchangeService {
  readonly id: ExchangeId = 'bybit';
  private client: RestClientV5 | null = null;

  constructor(options: { apiKey?: string; apiSecret?: string; testnet?: boolean }) {
    const { apiKey, apiSecret, testnet = false } = options;
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
    const list = res.result?.list ?? [];
    const balances: UnifiedBalance[] = [];
    for (const account of list) {
      for (const coin of account.coin ?? []) {
        const totalRaw = coin.walletBalance ?? '0';
        const total = toValidBalance(totalRaw, '0');
        const availableRaw = coin.availableToWithdraw ?? coin.free ?? '';
        const available = toValidBalance(availableRaw, total);
        const lockedNum = parseFloat(total) - parseFloat(available);
        const locked = Number.isFinite(lockedNum) ? Math.max(0, lockedNum).toFixed(8) : '0.00000000';
        balances.push({
          asset: coin.coin,
          available,
          locked,
          total,
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

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number): Promise<OrderResult> {
    if (!this.client) throw new Error('Bybit client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for ${symbol}`);
    const qtyStr = quantity.toFixed(5);
    const orderRes = await this.client.submitOrder({
      category: 'linear',
      symbol,
      side: side === 'BUY' ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: qtyStr,
    });
    if (orderRes.retCode !== 0) throw new Error(orderRes.retMsg ?? 'Order failed');
    const orderId = (orderRes.result as { orderId?: string })?.orderId ?? '';
    return { orderId, status: 'FILLED', exchangeId: 'bybit' };
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

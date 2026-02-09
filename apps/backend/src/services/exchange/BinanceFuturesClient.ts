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

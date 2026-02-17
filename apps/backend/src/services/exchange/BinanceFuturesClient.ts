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

const DEFAULT_STEP_SIZE_BINANCE = 0.001;

function getBinanceErrorMsg(res: unknown): string {
  const r = res as { code?: number; msg?: string };
  if (r?.msg) return String(r.msg);
  if (r?.code != null) return `Code ${r.code}`;
  return res instanceof Error ? res.message : String(res);
}

/** Extract Binance API error code from response or thrown error. */
function getBinanceErrorCode(res: unknown): number | undefined {
  const r = res as { code?: number; response?: { data?: { code?: number } } };
  if (r?.code != null && Number.isFinite(r.code)) return r.code;
  if (r?.response?.data?.code != null && Number.isFinite(r.response.data.code)) return r.response.data.code;
  return undefined;
}

const BINANCE_POST_ONLY_TAKER_REJECT_CODE = -5022;

export class BinanceFuturesClient implements ExchangeService {
  readonly id: ExchangeId = 'binance';
  private client: USDMClient | null = null;
  private stepSizeCache = new Map<string, number>();

  constructor(options: { apiKey?: string; apiSecret?: string; testnet?: boolean }) {
    const { apiKey, apiSecret, testnet = false } = options;
    if (apiKey && apiSecret) {
      this.client = new USDMClient({ api_key: apiKey, api_secret: apiSecret, testnet });
    }
  }

  private async getStepSize(symbol: string): Promise<number> {
    const cached = this.stepSizeCache.get(symbol);
    if (cached != null && cached > 0) return cached;
    const client = this.client ?? new USDMClient();
    const info = await client.getExchangeInfo();
    const symbols = (info as { symbols?: Array<{ symbol: string; filters?: Array<{ filterType?: string; stepSize?: string }> }> }).symbols ?? [];
    const sym = symbols.find((s) => s.symbol === symbol);
    const lotSize = sym?.filters?.find((f) => f.filterType === 'LOT_SIZE');
    const step = lotSize?.stepSize != null ? parseFloat(String(lotSize.stepSize)) : DEFAULT_STEP_SIZE_BINANCE;
    const stepSize = Number.isFinite(step) && step > 0 ? step : DEFAULT_STEP_SIZE_BINANCE;
    this.stepSizeCache.set(symbol, stepSize);
    return stepSize;
  }

  private async formatQty(symbol: string, quantity: number): Promise<string> {
    const stepSize = await this.getStepSize(symbol);
    const steps = Math.floor(quantity / stepSize + 1e-9);
    const totalQty = steps * stepSize;
    const stepDecimals = stepSize >= 1 ? 0 : Math.max(0, Math.ceil(-Math.log10(stepSize)));
    const fixed = totalQty.toFixed(stepDecimals);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') || fixed : fixed;
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

  /** @param reduceOnly - true when closing/reducing position (exit), false when opening (entry). Default true for backward compat. */
  async placeOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number, reduceOnly: boolean = true): Promise<OrderResult> {
    if (!this.client) throw new Error('Binance client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for ${symbol}`);
    const qtyStr = await this.formatQty(symbol, quantity);
    try {
      const res = await this.client.submitNewOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity: parseFloat(qtyStr),
        reduceOnly: reduceOnly ? 'true' : 'false',
      } as unknown as Parameters<USDMClient['submitNewOrder']>[0]);
      const raw = res as { orderId?: number; code?: number; msg?: string };
      if (raw.code != null && raw.code !== 0) {
        const msg = getBinanceErrorMsg(raw);
        console.error('[BinanceFuturesClient] placeOrder rejected:', msg);
        throw new Error(msg);
      }
      const orderId = String(raw.orderId ?? '');
      return { orderId, status: 'FILLED', exchangeId: 'binance' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : getBinanceErrorMsg(err);
      console.error('[BinanceFuturesClient] placeOrder failed:', msg);
      throw err;
    }
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
    const qtyStr = await this.formatQty(symbol, quantity);
    const qtyNum = parseFloat(qtyStr);
    try {
      const res = await this.client.submitNewOrder({
        symbol,
        side,
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity: qtyNum,
        price,
        reduceOnly: 'true',
      } as unknown as Parameters<USDMClient['submitNewOrder']>[0]);
      const raw = res as { orderId?: number; code?: number; msg?: string };
      if (raw.code != null && raw.code !== 0) {
        const msg = getBinanceErrorMsg(raw);
        console.error('[BinanceFuturesClient] placeLimitOrder rejected:', msg);
        throw new Error(msg);
      }
      const orderId = String(raw.orderId ?? '');
      return { orderId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : getBinanceErrorMsg(err);
      console.error('[BinanceFuturesClient] placeLimitOrder failed:', msg);
      throw err;
    }
  }

  /**
   * Post-Only limit order (maker only). Uses GTX timeInForce when supported.
   * On -5022 (order would execute as taker), retries once as standard GTC limit so the trade can fill.
   * @param reduceOnly - true for closing positions (exit), false for opening (entry).
   */
  async placeLimitOrderPostOnly(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
    reduceOnly: boolean = true
  ): Promise<{ orderId: string }> {
    if (!this.client) throw new Error('Binance client not configured');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid quantity/price for ${symbol}`);
    }
    const qtyStr = await this.formatQty(symbol, quantity);
    const qtyNum = parseFloat(qtyStr);
    const reduceOnlyStr = reduceOnly ? 'true' : 'false';

    // Retry as standard limit (may fill as taker). Preserve reduceOnly: entry=false, exit=true.
    const submitStandardLimit = async (): Promise<{ orderId: string }> => {
      const res = await this.client!.submitNewOrder({
        symbol,
        side,
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity: qtyNum,
        price,
        reduceOnly: reduceOnlyStr,
      } as unknown as Parameters<USDMClient['submitNewOrder']>[0]);
      const raw = res as { orderId?: number; code?: number; msg?: string };
      if (raw.code != null && raw.code !== 0) {
        const msg = getBinanceErrorMsg(raw);
        console.error('[BinanceFuturesClient] placeLimitOrder (GTC) rejected:', msg);
        throw new Error(msg);
      }
      return { orderId: String(raw.orderId ?? '') };
    };

    try {
      const res = await this.client.submitNewOrder({
        symbol,
        side,
        type: 'LIMIT',
        timeInForce: 'GTX',
        quantity: qtyNum,
        price,
        reduceOnly: reduceOnlyStr,
      } as unknown as Parameters<USDMClient['submitNewOrder']>[0]);
      const raw = res as { orderId?: number; code?: number; msg?: string };
      if (raw.code != null && raw.code !== 0) {
        if (raw.code === BINANCE_POST_ONLY_TAKER_REJECT_CODE) {
          console.warn('[BinanceFuturesClient] Post-Only failed (-5022), retrying as standard Limit Order...');
          return submitStandardLimit();
        }
        const msg = getBinanceErrorMsg(raw);
        console.error('[BinanceFuturesClient] placeLimitOrderPostOnly rejected:', msg);
        throw new Error(msg);
      }
      const orderId = String(raw.orderId ?? '');
      return { orderId };
    } catch (err) {
      if (getBinanceErrorCode(err) === BINANCE_POST_ONLY_TAKER_REJECT_CODE) {
        console.warn('[BinanceFuturesClient] Post-Only failed (-5022), retrying as standard Limit Order...');
        return submitStandardLimit();
      }
      const msg = err instanceof Error ? err.message : getBinanceErrorMsg(err);
      console.error('[BinanceFuturesClient] placeLimitOrderPostOnly failed:', msg);
      throw err;
    }
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

  /** True if there is at least one OPEN/PENDING order for the symbol (e.g. exit in progress). */
  async hasOpenOrders(symbol: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const list = await this.client.getAllOpenOrders({ symbol });
      const arr = Array.isArray(list) ? list : [];
      return arr.length > 0;
    } catch {
      return false;
    }
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

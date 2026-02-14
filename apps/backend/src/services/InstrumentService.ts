import { RestClientV5 } from 'bybit-api';

const BYBIT_FETCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BLACKLIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Error codes that trigger 24h symbol blacklist. */
const BLACKLIST_RET_CODES = new Set([10001, 110001, 110006]);
const REDUCE_ONLY_KEYWORDS = ['ReduceOnly', 'Reduce Only', 'reduce-only'];

export interface BybitInstrumentInfo {
  symbol: string;
  minOrderQty: number;
  maxOrderQty: number;
  qtyStep: number;
  tickSize: number;
}

const instrumentsBySymbol = new Map<string, BybitInstrumentInfo>();
const blacklistedUntil = new Map<string, number>();

/** Parse Bybit API string to number (e.g. lotSizeFilter.qtyStep). Uses parseFloat for correct numeric value. */
function parseNum(s: string | undefined | null): number {
  if (s == null || s === '') return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Number of decimal places in step (for float-safe formatting).
 * Uses string form to avoid float representation issues (e.g. 0.1 → 0.100000001).
 */
function getStepDecimals(step: number): number {
  if (step <= 0 || !Number.isFinite(step)) return 0;
  const stepStr = String(step);
  const idx = stepStr.indexOf('.');
  return idx === -1 ? 0 : stepStr.length - idx - 1;
}

/**
 * Round down value to the nearest step: finalQty = floor(value / step) * step.
 * Uses toFixed(stepDecimals) so 600 doesn't become 599.999 due to floating point.
 */
function roundDownToStep(value: number, step: number): number {
  if (step <= 0 || !Number.isFinite(value)) return value;
  const stepDecimals = getStepDecimals(step);
  const steps = Math.floor(value / step);
  const finalQty = steps * step;
  return Number(finalQty.toFixed(stepDecimals));
}

/**
 * Format quantity string to satisfy Bybit lot size (no more decimals than qtyStep).
 * Uses toFixed to avoid floating point output like 599.999.
 */
function formatQty(qty: number, qtyStep: number): string {
  if (qtyStep <= 0) return String(qty);
  const decimals = getStepDecimals(qtyStep);
  return qty.toFixed(decimals);
}

export interface InstrumentServiceOptions {
  bybitTestnet?: boolean;
}

export class InstrumentService {
  private client: RestClientV5;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: InstrumentServiceOptions = {}) {
    this.client = new RestClientV5({
      testnet: options.bybitTestnet === true,
    });
  }

  /** Fetch and store instruments from Bybit (category=linear). Only keeps Trading, LinearPerpetual, USDT, maxLeverage > 0. */
  async fetchAndStoreInstruments(): Promise<void> {
    const all: BybitInstrumentInfo[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.client.getInstrumentsInfo({
        category: 'linear',
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });

      if (res.retCode !== 0) {
        throw new Error(res.retMsg ?? 'Failed to fetch Bybit instruments');
      }

      const result = res.result as {
        list?: Array<{
          symbol: string;
          status?: string;
          contractType?: string;
          settleCoin?: string;
          leverageFilter?: { maxLeverage?: string };
          lotSizeFilter?: {
            minOrderQty?: string;
            maxOrderQty?: string;
            qtyStep?: string;
          };
          priceFilter?: { tickSize?: string };
        }>;
        nextPageCursor?: string;
      };

      const list = result?.list ?? [];
      cursor = result?.nextPageCursor ?? '';

      for (const item of list) {
        if (item.status !== 'Trading') continue;
        if (item.contractType !== 'LinearPerpetual') continue;
        if (item.settleCoin !== 'USDT') continue;
        const maxLev = parseNum(item.leverageFilter?.maxLeverage);
        if (maxLev <= 0) continue;

        const lot = item.lotSizeFilter ?? {};
        const minOrderQty = parseNum(lot.minOrderQty);
        const maxOrderQty = parseNum(lot.maxOrderQty);
        // Bybit API returns qtyStep as string (e.g. "1", "0.1", "0.01"); parse to float for math.
        const qtyStep = parseFloat(String(lot.qtyStep ?? '').trim());
        const tickSize = parseNum(item.priceFilter?.tickSize);

        if (!Number.isFinite(qtyStep) || qtyStep <= 0) continue;

        all.push({
          symbol: item.symbol,
          minOrderQty,
          maxOrderQty,
          qtyStep,
          tickSize,
        });
      }
    } while (cursor && cursor.trim() !== '');

    instrumentsBySymbol.clear();
    for (const info of all) {
      instrumentsBySymbol.set(info.symbol, info);
    }
    console.log(`[InstrumentService] Loaded ${instrumentsBySymbol.size} Bybit linear USDT instruments.`);
  }

  /** Start fetching on init and then every hour. */
  start(): void {
    this.fetchAndStoreInstruments().catch((err) => {
      console.error('[InstrumentService] Initial fetch failed:', err instanceof Error ? err.message : err);
    });
    this.refreshTimer = setInterval(() => {
      this.fetchAndStoreInstruments().catch((err) => {
        console.error('[InstrumentService] Hourly refresh failed:', err instanceof Error ? err.message : err);
      });
    }, BYBIT_FETCH_INTERVAL_MS);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getInstrument(symbol: string): BybitInstrumentInfo | undefined {
    return instrumentsBySymbol.get(symbol);
  }

  /**
   * Calculate quantity from USDT amount and price, rounded down to qtyStep.
   * Uses finalQty = floor(amount/stepSize)*stepSize and float-safe formatting.
   * Returns null if below minOrderQty or instrument unknown.
   */
  calculateSafeQty(symbol: string, usdtAmount: number, price: number): string | null {
    if (!Number.isFinite(usdtAmount) || usdtAmount <= 0 || !Number.isFinite(price) || price <= 0) {
      return null;
    }
    const info = instrumentsBySymbol.get(symbol);
    if (!info) return null;

    const stepSize = info.qtyStep;
    const rawQty = usdtAmount / price;
    const finalQty = roundDownToStep(rawQty, stepSize);
    if (finalQty < info.minOrderQty) return null;
    if (info.maxOrderQty > 0 && finalQty > info.maxOrderQty) {
      const capped = roundDownToStep(info.maxOrderQty, stepSize);
      return formatQty(capped, stepSize);
    }
    return formatQty(finalQty, stepSize);
  }

  isBlacklisted(symbol: string): boolean {
    const until = blacklistedUntil.get(symbol);
    if (until == null) return false;
    if (Date.now() >= until) {
      blacklistedUntil.delete(symbol);
      return false;
    }
    return true;
  }

  /** Returns timestamp (ms) until which the symbol is blacklisted, or undefined if not blacklisted. */
  getBlacklistedUntil(symbol: string): number | undefined {
    const until = blacklistedUntil.get(symbol);
    if (until == null) return undefined;
    if (Date.now() >= until) {
      blacklistedUntil.delete(symbol);
      return undefined;
    }
    return until;
  }

  /** Call when a Bybit order fails; adds symbol to blacklist for 24h if error matches. */
  reportOrderFailure(symbol: string, err: unknown): void {
    let retCode: number | undefined;
    let retMsg = '';

    const obj = err as { retCode?: number; retMsg?: string; response?: { data?: { retCode?: number; retMsg?: string }; status?: number } };
    if (obj?.retCode != null) {
      retCode = obj.retCode;
      retMsg = String(obj.retMsg ?? '');
    } else if (obj?.response?.data) {
      retCode = obj.response.data.retCode;
      retMsg = String(obj.response.data.retMsg ?? '');
    }
    if (retCode == null) {
      const msg = err instanceof Error ? err.message : String(err);
      retMsg = msg;
      if (/10001|110001|110006/.test(msg)) retCode = 10001; // treat as params error
    }

    const shouldBlacklist =
      (retCode != null && BLACKLIST_RET_CODES.has(retCode)) ||
      REDUCE_ONLY_KEYWORDS.some((k) => retMsg.toLowerCase().includes(k.toLowerCase()));

    if (shouldBlacklist) {
      blacklistedUntil.set(symbol, Date.now() + BLACKLIST_TTL_MS);
      console.warn(`[InstrumentService] Blacklisted ${symbol} for 24h (retCode=${retCode}, retMsg=${retMsg?.slice(0, 80)}).`);
    }
  }
}

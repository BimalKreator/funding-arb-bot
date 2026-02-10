import { USDMClient, WebsocketClient as BinanceWsClient } from 'binance';
import { RestClientV5, WebsocketClient as BybitWsClient } from 'bybit-api';
import type {
  UnifiedFundingData,
  SymbolIntervalStatus,
  FundingIntervalsResponse,
} from '@funding-arb-bot/shared';

const BINANCE_FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8h
const REST_POLL_MS = 60 * 1000; // 1 minute
const INTERVAL_RESOLVE_MS = 5 * 60 * 1000; // 5 minutes
const BYBIT_WS_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']; // subset for WS stream
const DEFAULT_BINANCE_INTERVAL_HOURS = 8;

/** Latest funding rate and mark price per symbol per exchange (for ScreenerService) */
export type LatestFundingRates = Map<
  string,
  {
    binance?: { fundingRate: string; markPrice?: string };
    bybit?: { fundingRate: string; markPrice?: string };
  }
>;

function emitNormalized(data: UnifiedFundingData): void {
  console.log('[FundingData]', JSON.stringify(data));
}

export class FundingService {
  private binanceRest: USDMClient;
  private binanceWs: BinanceWsClient | null = null;
  private bybitRest: RestClientV5;
  private bybitWs: BybitWsClient | null = null;
  private binanceRestIntervalId: ReturnType<typeof setInterval> | null = null;
  private bybitRestIntervalId: ReturnType<typeof setInterval> | null = null;
  private intervalResolveIntervalId: ReturnType<typeof setInterval> | null = null;
  private bybitTestnet: boolean;

  /** Resolved intervals and valid arbitrage symbols (updated every 5 min) */
  private intervalsList: SymbolIntervalStatus[] = [];
  private validArbitrageSymbols: Set<string> = new Set();
  private lastIntervalsUpdated: Date = new Date(0);
  /** Cache nextFundingTime per symbol for Binance fallback interval deduction */
  private binanceNextFundingTimeBySymbol: Map<string, number> = new Map();
  /** Latest funding rate and mark price per symbol per exchange (updated on every REST/WS update) */
  private latestFundingBySymbol: Map<
    string,
    { binance?: { fundingRate: string; markPrice?: string }; bybit?: { fundingRate: string; markPrice?: string } }
  > = new Map();

  constructor(options?: { bybitTestnet?: boolean }) {
    this.binanceRest = new USDMClient();
    this.bybitRest = new RestClientV5({});
    this.bybitTestnet = options?.bybitTestnet ?? false;
  }

  start(): void {
    this.startBinanceRest();
    this.startBinanceWebSocket();
    this.startBybitRest();
    this.startBybitWebSocket();
    this.runIntervalResolver();
    this.intervalResolveIntervalId = setInterval(() => this.runIntervalResolver(), INTERVAL_RESOLVE_MS);
  }

  stop(): void {
    if (this.binanceRestIntervalId !== null) {
      clearInterval(this.binanceRestIntervalId);
      this.binanceRestIntervalId = null;
    }
    if (this.bybitRestIntervalId !== null) {
      clearInterval(this.bybitRestIntervalId);
      this.bybitRestIntervalId = null;
    }
    if (this.intervalResolveIntervalId !== null) {
      clearInterval(this.intervalResolveIntervalId);
      this.intervalResolveIntervalId = null;
    }
    this.binanceWs?.closeAll();
    this.binanceWs = null;
    this.bybitWs?.closeAll();
    this.bybitWs = null;
  }

  /** Returns latest funding rates and mark prices per symbol per exchange (for ScreenerService) */
  getLatestFundingRates(): LatestFundingRates {
    const copy = new Map<
      string,
      { binance?: { fundingRate: string; markPrice?: string }; bybit?: { fundingRate: string; markPrice?: string } }
    >();
    for (const [k, v] of this.latestFundingBySymbol) copy.set(k, { ...v });
    return copy;
  }

  /** Store latest rate and mark price when we emit funding data (called before emitNormalized) */
  private storeLatestFunding(data: UnifiedFundingData): void {
    let entry = this.latestFundingBySymbol.get(data.symbol);
    if (!entry) {
      entry = {};
      this.latestFundingBySymbol.set(data.symbol, entry);
    }
    if (data.exchange === 'binance') entry.binance = { fundingRate: data.fundingRate, markPrice: data.markPrice };
    else entry.bybit = { fundingRate: data.fundingRate, markPrice: data.markPrice };
  }

  /** Returns current intervals and valid arbitrage symbols for GET /api/funding/intervals */
  getIntervalsSnapshot(): FundingIntervalsResponse {
    return {
      intervals: [...this.intervalsList],
      validArbitrageSymbols: [...this.validArbitrageSymbols],
      lastUpdated: this.lastIntervalsUpdated.toISOString(),
    };
  }

  /** Resolve intervals from both exchanges and compute mismatch / validArbitrageSymbols */
  private async runIntervalResolver(): Promise<void> {
    try {
      const [binanceMap, bybitMap] = await Promise.all([
        this.fetchBinanceIntervals(),
        this.fetchBybitIntervals(),
      ]);
      const allSymbols = new Set<string>([...binanceMap.keys(), ...bybitMap.keys()]);
      const intervals: SymbolIntervalStatus[] = [];
      const valid = new Set<string>();

      for (const symbol of allSymbols) {
        const binanceH = binanceMap.get(symbol) ?? null;
        const bybitH = bybitMap.get(symbol) ?? null;

        if (binanceH === null && bybitH === null) continue;
        if (binanceH === null || bybitH === null) {
          intervals.push({
            symbol,
            binanceIntervalHours: binanceH,
            bybitIntervalHours: bybitH,
            status: 'missing_on_exchange',
          });
          continue;
        }

        if (binanceH !== bybitH) {
          intervals.push({
            symbol,
            binanceIntervalHours: binanceH,
            bybitIntervalHours: bybitH,
            status: 'invalid_interval',
          });
        } else {
          intervals.push({
            symbol,
            binanceIntervalHours: binanceH,
            bybitIntervalHours: bybitH,
            status: 'valid',
          });
          valid.add(symbol);
        }
      }

      intervals.sort((a, b) => a.symbol.localeCompare(b.symbol));
      this.intervalsList = intervals;
      this.validArbitrageSymbols = valid;
      this.lastIntervalsUpdated = new Date();
    } catch (err) {
      console.error('[FundingService] Interval resolver error:', err instanceof Error ? err.message : err);
    }
  }

  private async fetchBinanceIntervals(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const fundingInfo = await this.binanceRest.getFundingRates();
      const arr = Array.isArray(fundingInfo) ? fundingInfo : [];
      for (const row of arr) {
        const hours = Number((row as { symbol?: string; fundingIntervalHours?: number }).fundingIntervalHours);
        if (row.symbol && [1, 2, 4, 8].includes(hours)) map.set(row.symbol, hours);
        else if (row.symbol) map.set(row.symbol, DEFAULT_BINANCE_INTERVAL_HOURS);
      }
      const markPrices = await this.binanceRest.getMarkPrice();
      const markArr = Array.isArray(markPrices) ? markPrices : [markPrices];
      for (const row of markArr) {
        const next = Number((row as { symbol?: string; nextFundingTime?: number }).nextFundingTime);
        if (row.symbol && next) this.binanceNextFundingTimeBySymbol.set(row.symbol, next);
      }
      for (const row of markArr) {
        if (row.symbol && !map.has(row.symbol)) {
          const deduced = this.deduceBinanceIntervalFromNextFundingTime(row.symbol);
          map.set(row.symbol, deduced);
        }
      }
    } catch (_) {
      // Fallback: use cached nextFundingTime to deduce or default 8h
      for (const [symbol] of this.binanceNextFundingTimeBySymbol) {
        if (!map.has(symbol)) map.set(symbol, this.deduceBinanceIntervalFromNextFundingTime(symbol));
      }
    }
    return map;
  }

  /** Deduce interval from time-to-next funding when fundingInfo has no interval for this symbol */
  private deduceBinanceIntervalFromNextFundingTime(symbol: string): number {
    const next = this.binanceNextFundingTimeBySymbol.get(symbol);
    if (!next) return DEFAULT_BINANCE_INTERVAL_HOURS;
    const now = Date.now();
    const gapHours = (next - now) / (60 * 60 * 1000);
    if (gapHours >= 0.5 && gapHours <= 1.5) return 1;
    if (gapHours >= 1.5 && gapHours <= 2.5) return 2;
    if (gapHours >= 3 && gapHours <= 5) return 4;
    return DEFAULT_BINANCE_INTERVAL_HOURS;
  }

  private async fetchBybitIntervals(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const res = await this.bybitRest.getTickers({ category: 'linear' });
      if (res.retCode !== 0) return map;
      const list = (res.result as { list?: Array<{ symbol: string; fundingIntervalHour?: string; nextFundingTime?: string }> })?.list ?? [];
      for (const row of list) {
        const h = row.fundingIntervalHour ? parseInt(row.fundingIntervalHour, 10) : 8;
        if (row.symbol && h > 0) map.set(row.symbol, h);
      }
    } catch (_) {
      // ignore
    }
    return map;
  }

  private startBinanceRest(): void {
    const poll = async () => {
      try {
        const list = await this.binanceRest.getMarkPrice();
        const receivedAt = new Date().toISOString();
        const arr = Array.isArray(list) ? list : [list];
        for (const row of arr) {
          const nextFundingTime = Number(row.nextFundingTime);
          const lastFundingTime = nextFundingTime - BINANCE_FUNDING_INTERVAL_MS;
          const data: UnifiedFundingData = {
            symbol: row.symbol,
            exchange: 'binance',
            fundingRate: String(row.lastFundingRate ?? ''),
            fundingTime: nextFundingTime,
            markPrice: String(row.markPrice ?? ''),
            receivedAt,
            lastFundingTime,
            nextFundingTime,
            fundingIntervalHours: 8,
          };
          this.storeLatestFunding(data);
          emitNormalized(data);
        }
      } catch (err) {
        console.error('[FundingService] Binance REST error:', err instanceof Error ? err.message : err);
      }
    };
    poll();
    this.binanceRestIntervalId = setInterval(poll, REST_POLL_MS);
  }

  private startBinanceWebSocket(): void {
    try {
      this.binanceWs = new BinanceWsClient({ beautify: true });
      this.binanceWs.subscribeAllMarketMarkPrice('usdm', 1000);
      this.binanceWs.on('formattedMessage', (msg: unknown) => {
        const m = msg as Array<{ eventType?: string; symbol?: string; markPrice?: number; fundingRate?: number | string; nextFundingTime?: number }> | { eventType?: string; symbol?: string; markPrice?: number; fundingRate?: number | string; nextFundingTime?: number };
        const items = Array.isArray(m) ? m : [m];
        const receivedAt = new Date().toISOString();
        for (const row of items) {
          if (row?.eventType !== 'markPriceUpdate' || !row.symbol) continue;
          const nextFundingTime = row.nextFundingTime ?? 0;
          const lastFundingTime = nextFundingTime - BINANCE_FUNDING_INTERVAL_MS;
          const fundingRate = row.fundingRate !== undefined && row.fundingRate !== ''
            ? String(row.fundingRate)
            : '';
          const data: UnifiedFundingData = {
            symbol: row.symbol,
            exchange: 'binance',
            fundingRate,
            fundingTime: nextFundingTime,
            markPrice: String(row.markPrice ?? ''),
            receivedAt,
            lastFundingTime,
            nextFundingTime,
            fundingIntervalHours: 8,
          };
          this.storeLatestFunding(data);
          emitNormalized(data);
        }
      });
      (this.binanceWs as import('events').EventEmitter).on('error', (err: unknown) =>
        console.error('[FundingService] Binance WS error:', err)
      );
    } catch (err) {
      console.error('[FundingService] Binance WS setup error:', err instanceof Error ? err.message : err);
    }
  }

  private startBybitRest(): void {
    const poll = async () => {
      try {
        const res = await this.bybitRest.getTickers({ category: 'linear' });
        if (res.retCode !== 0) return;
        const list = (res.result as { list?: Array<{ symbol: string; markPrice: string; fundingRate: string; nextFundingTime: string; fundingIntervalHour?: string }> })?.list ?? [];
        const receivedAt = new Date().toISOString();
        const intervalHours = 8;
        for (const row of list) {
          const nextFundingTime = parseInt(row.nextFundingTime || '0', 10);
          const lastFundingTime = nextFundingTime ? nextFundingTime - intervalHours * 60 * 60 * 1000 : undefined;
          const data: UnifiedFundingData = {
            symbol: row.symbol,
            exchange: 'bybit',
            fundingRate: row.fundingRate ?? '',
            fundingTime: nextFundingTime || 0,
            markPrice: row.markPrice ?? '',
            receivedAt,
            lastFundingTime,
            nextFundingTime: nextFundingTime || undefined,
            fundingIntervalHours: row.fundingIntervalHour ? parseInt(row.fundingIntervalHour, 10) : intervalHours,
          };
          this.storeLatestFunding(data);
          emitNormalized(data);
        }
      } catch (err) {
        console.error('[FundingService] Bybit REST error:', err instanceof Error ? err.message : err);
      }
    };
    poll();
    this.bybitRestIntervalId = setInterval(poll, REST_POLL_MS);
  }

  private startBybitWebSocket(): void {
    try {
      this.bybitWs = new BybitWsClient({ testnet: this.bybitTestnet });
      const topics = BYBIT_WS_SYMBOLS.map((s) => `tickers.${s}`);
      this.bybitWs.subscribeV5(topics, 'linear');
      this.bybitWs.on('update', (msg: unknown) => {
        const m = msg as { topic?: string; data?: { symbol?: string; markPrice?: string; fundingRate?: string; nextFundingTime?: string; fundingIntervalHour?: string } };
        const dataObj = m?.data;
        if (!dataObj?.symbol) return;
        const receivedAt = new Date().toISOString();
        const nextFundingTime = parseInt(String(dataObj.nextFundingTime || '0'), 10);
        const intervalHours = dataObj.fundingIntervalHour ? parseInt(dataObj.fundingIntervalHour, 10) : 8;
        const lastFundingTime = nextFundingTime ? nextFundingTime - intervalHours * 60 * 60 * 1000 : undefined;
        const data: UnifiedFundingData = {
          symbol: dataObj.symbol,
          exchange: 'bybit',
          fundingRate: dataObj.fundingRate ?? '',
          fundingTime: nextFundingTime || 0,
          markPrice: dataObj.markPrice ?? '',
          receivedAt,
          lastFundingTime,
          nextFundingTime: nextFundingTime || undefined,
          fundingIntervalHours: intervalHours,
        };
        this.storeLatestFunding(data);
        emitNormalized(data);
      });
      (this.bybitWs as import('events').EventEmitter).on('error', (err: unknown) =>
        console.error('[FundingService] Bybit WS error:', err)
      );
    } catch (err) {
      console.error('[FundingService] Bybit WS setup error:', err instanceof Error ? err.message : err);
    }
  }
}

import type { BannedSymbolsService } from './banned-symbols.service.js';
import type { ConfigService } from './config.service.js';
import type { FundingService } from './funding.service.js';
import type { InstrumentService } from './InstrumentService.js';
import type { ExchangeManager } from './exchange/index.js';
import type { MarketDataService } from './market-data.service.js';
import type { ScreenerResultEntry, ScreenerResponse } from '@funding-arb-bot/shared';
import type { SymbolIntervalStatus } from '@funding-arb-bot/shared';
import { ALLOWED_INTERVAL_OPTIONS } from './config.service.js';

const DEFAULT_THRESHOLD = 0;

/**
 * Funding arbitrage screener: Standard (same interval) and High Frequency (mismatched intervals).
 * Includes blacklisted tokens with isBlacklisted/blacklistedUntil so UI can show them.
 * User-banned symbols (manual ban) are excluded entirely and not returned.
 * Results are filtered by allowedFundingIntervals (config) and netSpread > 0.
 * When ExchangeManager is provided, each entry is enriched with executionSpread % for Entry Guard display.
 * When MarketDataService is provided, Binance (and Bybit when cached) book data is read from WS cache to avoid REST.
 */
export class ScreenerService {
  constructor(
    private readonly fundingService: FundingService,
    private readonly instrumentService?: InstrumentService,
    private readonly bannedSymbolsService?: BannedSymbolsService,
    private readonly configService?: ConfigService,
    private readonly exchangeManager?: ExchangeManager,
    private readonly marketDataService?: MarketDataService
  ) {}

  /**
   * Returns screener results: standard (Interval_A == Interval_B) and mismatched (Interval_A != Interval_B).
   * Filtered by allowedFundingIntervals (config) and netSpread > 0. Standard: sorted by interval asc, then netSpread desc. Mismatched: sorted by netSpread desc.
   */
  async getResults(threshold: number = DEFAULT_THRESHOLD): Promise<ScreenerResponse> {
    const userBanned = new Set(
      (this.bannedSymbolsService?.getBanned() ?? []).map((s) => s.toUpperCase())
    );
    const snapshot = this.fundingService.getIntervalsSnapshot();
    const latest = this.fundingService.getLatestFundingRates();

    let standard = this.buildStandardList(snapshot, userBanned, latest, threshold);
    let mismatched = this.buildMismatchedList(snapshot, userBanned, latest, threshold);

    const allowedSet = await this.getAllowedIntervalsSet();
    standard = standard.filter(
      (e) => allowedSet.has(e.interval) && e.grossSpread > 0
    );
    mismatched = mismatched.filter(
      (e) =>
        allowedSet.has(e.binanceIntervalHours ?? e.interval) &&
        allowedSet.has(e.bybitIntervalHours ?? e.interval) &&
        e.grossSpread > 0
    );

    if (this.exchangeManager) {
      await this.enrichExecutionSpread(standard);
      await this.enrichExecutionSpread(mismatched);
    }

    return { standard, mismatched };
  }

  /**
   * Execution spread %: (Bid_ShortExchange - Ask_LongExchange) / MarkPrice * 100.
   * Short exchange = where we sell (use best bid); Long exchange = where we buy (use best ask).
   * Uses MarketDataService cache when available to avoid REST; falls back to ExchangeManager only for missing data.
   */
  private async enrichExecutionSpread(entries: ScreenerResultEntry[]): Promise<void> {
    const markPriceFor = (e: ScreenerResultEntry): number => {
      const bin = e.binanceMarkPrice;
      const byb = e.bybitMarkPrice;
      if (Number.isFinite(bin) && Number.isFinite(byb) && bin! > 0 && byb! > 0)
        return (bin! + byb!) / 2;
      return (Number.isFinite(bin) && bin! > 0 ? bin! : byb!) || 1;
    };
    await Promise.all(
      entries.map(async (e) => {
        try {
          const cachedBinance = this.marketDataService?.getBinancePrice(e.symbol);
          const cachedBybit = this.marketDataService?.getBybitPrice(e.symbol);
          let binTop: { bestBid: number; bestAsk: number };
          let bybTop: { bestBid: number; bestAsk: number };
          if (cachedBinance && (cachedBinance.bestBid > 0 || cachedBinance.bestAsk > 0)) {
            binTop = { bestBid: cachedBinance.bestBid, bestAsk: cachedBinance.bestAsk };
          } else {
            binTop = await this.exchangeManager!.getOrderbookTop('binance', e.symbol);
          }
          if (cachedBybit && (cachedBybit.bestBid > 0 || cachedBybit.bestAsk > 0)) {
            bybTop = { bestBid: cachedBybit.bestBid, bestAsk: cachedBybit.bestAsk };
          } else {
            bybTop = await this.exchangeManager!.getOrderbookTop('bybit', e.symbol);
          }
          const bidShort =
            e.binanceAction === 'SHORT' ? binTop.bestBid : bybTop.bestBid;
          const askLong =
            e.bybitAction === 'LONG' ? bybTop.bestAsk : binTop.bestAsk;
          const markPrice = markPriceFor(e);
          if (
            Number.isFinite(bidShort) &&
            Number.isFinite(askLong) &&
            markPrice > 0
          ) {
            e.executionSpread = ((bidShort - askLong) / markPrice) * 100;
          }
        } catch {
          // leave executionSpread undefined on orderbook fetch failure
        }
      })
    );
  }

  private async getAllowedIntervalsSet(): Promise<Set<number>> {
    if (!this.configService) {
      return new Set(ALLOWED_INTERVAL_OPTIONS);
    }
    const cfg = await this.configService.getConfig();
    const arr = cfg.allowedFundingIntervals;
    if (!Array.isArray(arr) || arr.length === 0) {
      return new Set(ALLOWED_INTERVAL_OPTIONS);
    }
    return new Set(arr.filter((n) => ALLOWED_INTERVAL_OPTIONS.includes(n as 1 | 2 | 4 | 8)));
  }

  /**
   * Standard list: symbols where Interval_A == Interval_B. Existing logic, sort by interval then netSpread.
   */
  private buildStandardList(
    snapshot: { intervals: SymbolIntervalStatus[]; validArbitrageSymbols: string[] },
    userBanned: Set<string>,
    latest: Map<string, { binance?: { fundingRate?: string; markPrice?: string }; bybit?: { fundingRate?: string; markPrice?: string } }>,
    threshold: number
  ): ScreenerResultEntry[] {
    const validSymbols = new Set(
      snapshot.validArbitrageSymbols.filter((s) => !userBanned.has(s.toUpperCase()))
    );
    const intervalsBySymbol = new Map(
      snapshot.intervals
        .filter((i) => i.status === 'valid')
        .map((i) => [i.symbol, i.binanceIntervalHours ?? i.bybitIntervalHours ?? 8])
    );
    const results: ScreenerResultEntry[] = [];

    for (const symbol of validSymbols) {
      const entry = latest.get(symbol);
      const binanceRateStr = entry?.binance?.fundingRate;
      const bybitRateStr = entry?.bybit?.fundingRate;
      if (binanceRateStr === undefined || bybitRateStr === undefined) continue;

      const binanceRateRaw = parseFloat(binanceRateStr);
      const bybitRateRaw = parseFloat(bybitRateStr);
      if (Number.isNaN(binanceRateRaw) || Number.isNaN(bybitRateRaw)) continue;

      const binanceRatePct = binanceRateRaw * 100;
      const bybitRatePct = bybitRateRaw * 100;
      const grossSpread = Math.abs(binanceRatePct - bybitRatePct);
      const netSpread = grossSpread - threshold;

      const { binanceAction, bybitAction } = this.getTradeDirection(binanceRateRaw, bybitRateRaw);
      const interval = intervalsBySymbol.get(symbol) ?? 8;
      const binanceMp = entry?.binance?.markPrice;
      const bybitMp = entry?.bybit?.markPrice;
      const binanceMarkPriceRaw = binanceMp != null ? parseFloat(binanceMp) : NaN;
      const bybitMarkPriceRaw = bybitMp != null ? parseFloat(bybitMp) : NaN;

      const isBlacklisted = this.instrumentService?.isBlacklisted(symbol) ?? false;
      const blacklistedUntil = this.instrumentService?.getBlacklistedUntil(symbol);

      results.push({
        symbol,
        interval,
        binanceRate: binanceRatePct,
        bybitRate: bybitRatePct,
        grossSpread,
        netSpread,
        binanceAction,
        bybitAction,
        binanceMarkPrice: Number.isFinite(binanceMarkPriceRaw) ? binanceMarkPriceRaw : undefined,
        bybitMarkPrice: Number.isFinite(bybitMarkPriceRaw) ? bybitMarkPriceRaw : undefined,
        isBlacklisted,
        ...(blacklistedUntil !== undefined && { blacklistedUntil }),
      });
    }

    results.sort((a, b) => {
      if (a.interval !== b.interval) return a.interval - b.interval;
      return b.netSpread - a.netSpread;
    });
    return results;
  }

  /**
   * Mismatched list: symbols where Interval_A != Interval_B.
   * Net spread = simple difference (no 24h yield).
   * "Dominant Fast Leg" rule: ALLOW only when the high-frequency exchange is the main profit driver.
   * - Yield_A = |rateA|, Yield_B = |rateB|. Dominant = exchange with higher yield.
   * - ALLOW iff Dominant_Exchange.interval < Other_Exchange.interval (profit from fast leg).
   * - REJECT if Dominant has the larger/slower interval (profit from slow leg).
   */
  private buildMismatchedList(
    snapshot: { intervals: SymbolIntervalStatus[] },
    userBanned: Set<string>,
    latest: Map<string, { binance?: { fundingRate?: string; markPrice?: string }; bybit?: { fundingRate?: string; markPrice?: string } }>,
    threshold: number
  ): ScreenerResultEntry[] {
    const mismatchedIntervals = snapshot.intervals.filter(
      (i) => i.status === 'invalid_interval' && i.binanceIntervalHours != null && i.bybitIntervalHours != null && !userBanned.has(i.symbol.toUpperCase())
    );
    const results: ScreenerResultEntry[] = [];

    for (const row of mismatchedIntervals) {
      const symbol = row.symbol;
      const binanceH = row.binanceIntervalHours!;
      const bybitH = row.bybitIntervalHours!;
      const fastExchange: 'binance' | 'bybit' = binanceH <= bybitH ? 'binance' : 'bybit';
      const fastInterval = Math.min(binanceH, bybitH);

      const entry = latest.get(symbol);
      const binanceRateStr = entry?.binance?.fundingRate;
      const bybitRateStr = entry?.bybit?.fundingRate;
      if (binanceRateStr === undefined || bybitRateStr === undefined) continue;

      const binanceRateRaw = parseFloat(binanceRateStr);
      const bybitRateRaw = parseFloat(bybitRateStr);
      if (Number.isNaN(binanceRateRaw) || Number.isNaN(bybitRateRaw)) continue;

      const binanceRatePct = binanceRateRaw * 100;
      const bybitRatePct = bybitRateRaw * 100;
      const grossSpread = Math.abs(binanceRatePct - bybitRatePct);
      const netSpread = grossSpread - threshold;

      const yieldA = Math.abs(binanceRatePct);
      const yieldB = Math.abs(bybitRatePct);
      const dominantIsBinance = yieldA >= yieldB;
      const dominantInterval = dominantIsBinance ? binanceH : bybitH;
      const otherInterval = dominantIsBinance ? bybitH : binanceH;
      if (dominantInterval >= otherInterval) continue;

      const { binanceAction, bybitAction } = this.getTradeDirection(binanceRateRaw, bybitRateRaw);

      const binanceMp = entry?.binance?.markPrice;
      const bybitMp = entry?.bybit?.markPrice;
      const binanceMarkPriceRaw = binanceMp != null ? parseFloat(binanceMp) : NaN;
      const bybitMarkPriceRaw = bybitMp != null ? parseFloat(bybitMp) : NaN;

      const isBlacklisted = this.instrumentService?.isBlacklisted(symbol) ?? false;
      const blacklistedUntil = this.instrumentService?.getBlacklistedUntil(symbol);

      results.push({
        symbol,
        interval: fastInterval,
        binanceRate: binanceRatePct,
        bybitRate: bybitRatePct,
        grossSpread,
        netSpread,
        binanceAction,
        bybitAction,
        binanceMarkPrice: Number.isFinite(binanceMarkPriceRaw) ? binanceMarkPriceRaw : undefined,
        bybitMarkPrice: Number.isFinite(bybitMarkPriceRaw) ? bybitMarkPriceRaw : undefined,
        isBlacklisted,
        ...(blacklistedUntil !== undefined && { blacklistedUntil }),
        binanceIntervalHours: binanceH,
        bybitIntervalHours: bybitH,
        fastExchange,
      });
    }

    results.sort((a, b) => {
      const minIntervalA = Math.min(a.binanceIntervalHours ?? a.interval, a.bybitIntervalHours ?? a.interval);
      const minIntervalB = Math.min(b.binanceIntervalHours ?? b.interval, b.bybitIntervalHours ?? b.interval);
      if (minIntervalA !== minIntervalB) return minIntervalA - minIntervalB;
      return b.netSpread - a.netSpread;
    });
    return results;
  }

  /**
   * Trade direction: which exchange to LONG vs SHORT to receive funding.
   * - Both negative: more negative rate → LONG (receive), other → SHORT.
   * - Both positive: more positive rate → SHORT (receive), other → LONG.
   * - Binance neg & Bybit pos: LONG Binance, SHORT Bybit.
   * - Binance pos & Bybit neg: SHORT Binance, LONG Bybit.
   */
  private getTradeDirection(
    binanceRate: number,
    bybitRate: number
  ): { binanceAction: 'LONG' | 'SHORT'; bybitAction: 'LONG' | 'SHORT' } {
    if (binanceRate <= 0 && bybitRate <= 0) {
      if (binanceRate <= bybitRate) return { binanceAction: 'LONG', bybitAction: 'SHORT' };
      return { binanceAction: 'SHORT', bybitAction: 'LONG' };
    }
    if (binanceRate >= 0 && bybitRate >= 0) {
      if (binanceRate >= bybitRate) return { binanceAction: 'SHORT', bybitAction: 'LONG' };
      return { binanceAction: 'LONG', bybitAction: 'SHORT' };
    }
    if (binanceRate < 0 && bybitRate > 0) return { binanceAction: 'LONG', bybitAction: 'SHORT' };
    return { binanceAction: 'SHORT', bybitAction: 'LONG' };
  }
}

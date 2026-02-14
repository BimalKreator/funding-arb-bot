import type { FundingService } from './funding.service.js';
import type { InstrumentService } from './InstrumentService.js';
import type { ScreenerResultEntry } from '@funding-arb-bot/shared';

const DEFAULT_THRESHOLD = 0;

/**
 * Funding arbitrage screener: only valid-interval symbols, spread and direction.
 * Includes blacklisted tokens with isBlacklisted/blacklistedUntil so UI can show them.
 */
export class ScreenerService {
  constructor(
    private readonly fundingService: FundingService,
    private readonly instrumentService?: InstrumentService
  ) {}

  /**
   * Returns screener results for symbols with status === 'valid'.
   * Sort: primary by funding interval ascending (shorter first), secondary by netSpread descending (higher first).
   */
  getResults(threshold: number = DEFAULT_THRESHOLD): ScreenerResultEntry[] {
    const snapshot = this.fundingService.getIntervalsSnapshot();
    const validSymbols = new Set(snapshot.validArbitrageSymbols);
    const intervalsBySymbol = new Map(
      snapshot.intervals
        .filter((i) => i.status === 'valid')
        .map((i) => [i.symbol, i.binanceIntervalHours ?? i.bybitIntervalHours ?? 8])
    );
    const latest = this.fundingService.getLatestFundingRates();

    const results: ScreenerResultEntry[] = [];

    for (const symbol of validSymbols) {
      const entry = latest.get(symbol);
      const binanceRateStr = entry?.binance?.fundingRate;
      const bybitRateStr = entry?.bybit?.fundingRate;
      if (binanceRateStr === undefined || bybitRateStr === undefined) continue;

      const binanceRateRaw = parseFloat(binanceRateStr);
      const bybitRateRaw = parseFloat(bybitRateStr);
      if (Number.isNaN(binanceRateRaw) || Number.isNaN(bybitRateRaw)) continue;

      // Convert to percentage before calculating spreads (e.g. 0.0001 → 0.01)
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

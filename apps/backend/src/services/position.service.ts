import type { ExchangeManager } from './exchange/index.js';
import type { FundingService } from './funding.service.js';
import { addClosedTrade } from './closed-trades.service.js';

/** Normalize symbol for grouping (e.g. BTC/USDT:USDT -> BTCUSDT, BTCUSDT -> BTCUSDT). */
function normalizeSymbolForGrouping(symbol: string): string {
  if (!symbol || typeof symbol !== 'string') return symbol;
  const s = symbol.trim();
  if (s.includes('/')) {
    const base = s.split('/')[0]?.trim();
    return base ? `${base}USDT` : s;
  }
  if (s.includes(':')) {
    const base = s.split(':')[0]?.trim();
    return base ? `${base}USDT` : s;
  }
  return s;
}

/** Single leg (Binance or Bybit position) with enriched data. */
export interface PositionLeg {
  exchange: 'binance' | 'bybit';
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  margin: number;
  unrealizedPnl: number;
  percentage: number;
  estFundingFee: number;
  /** Position update time in ms (for orphan age check). */
  timestamp?: number;
}

/** Group of positions by symbol (e.g. BTC) with two legs. */
export interface PositionGroup {
  symbol: string;
  totalPnl: number;
  netFundingFee: number;
  legs: PositionLeg[];
  /** True if binance and bybit quantities match within dust (< 1). */
  isHedged: boolean;
  /** True if net spread <= 0 and within 10 min of next funding. */
  isFundingFlipped: boolean;
  /** Next funding time (UTC slot) as timestamp in ms for countdown. */
  nextFundingTime?: number;
}

const HEDGE_DUST = 1;
const WINDOW_BEFORE_FUNDING_MS = 10 * 60 * 1000;

/** Ms from now until next funding for a given interval (1h, 2h, 4h, or 8h). Uses UTC slot alignment. */
function getMsUntilNextFundingForInterval(intervalHours: number): number {
  const now = new Date();
  const utcMin =
    now.getUTCHours() * 60 +
    now.getUTCMinutes() +
    now.getUTCSeconds() / 60 +
    now.getUTCMilliseconds() / 60000;
  const intervalMin = Math.max(1, Math.min(24, intervalHours)) * 60;
  let nextSlot = (Math.floor(utcMin / intervalMin) + 1) * intervalMin;
  if (nextSlot >= 24 * 60) nextSlot = 0;
  const minutesUntil = nextSlot === 0 ? 24 * 60 - utcMin : nextSlot - utcMin;
  return minutesUntil * 60 * 1000;
}

export class PositionService {
  constructor(
    private readonly exchangeManager: ExchangeManager,
    private readonly fundingService: FundingService
  ) {}

  async getPositions(): Promise<PositionGroup[]> {
    let binanceList: Awaited<ReturnType<ExchangeManager['getPositions']>> = [];
    let bybitList: Awaited<ReturnType<ExchangeManager['getPositions']>> = [];

    try {
      binanceList = await this.exchangeManager.getPositions('binance');
    } catch (err) {
      console.error('[PositionService] Binance getPositions failed:', err instanceof Error ? err.message : err);
    }
    try {
      bybitList = await this.exchangeManager.getPositions('bybit');
      console.log('Bybit Raw Positions:', bybitList.length);
    } catch (err) {
      console.error('[PositionService] Bybit getPositions failed:', err instanceof Error ? err.message : err);
    }

    const fundingRates = this.fundingService.getLatestFundingRates();
    const legsBySymbol = new Map<string, PositionLeg[]>();

    const addLeg = (exchange: 'binance' | 'bybit', p: {
      symbol: string;
      side: 'LONG' | 'SHORT';
      quantity: number;
      entryPrice: number;
      markPrice: number;
      liquidationPrice: number;
      collateral: number;
      unrealizedPnl: number;
      timestamp?: number;
    }) => {
      const groupKey = normalizeSymbolForGrouping(p.symbol);
      const funding = fundingRates.get(groupKey) ?? fundingRates.get(p.symbol);
      const rateStr = exchange === 'binance' ? funding?.binance?.fundingRate : funding?.bybit?.fundingRate;
      const fundingRate = rateStr != null ? parseFloat(rateStr) : 0;
      const positionValue = p.quantity * (p.markPrice || p.entryPrice);
      const estFundingFee = Number.isFinite(fundingRate) ? positionValue * fundingRate : 0;
      const percentage = p.collateral > 0 ? (p.unrealizedPnl / p.collateral) * 100 : 0;

      const leg: PositionLeg = {
        exchange,
        side: p.side,
        size: p.quantity,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        liquidationPrice: p.liquidationPrice,
        margin: p.collateral,
        unrealizedPnl: p.unrealizedPnl,
        percentage,
        estFundingFee,
        timestamp: p.timestamp,
      };
      const list = legsBySymbol.get(groupKey) ?? [];
      list.push(leg);
      legsBySymbol.set(groupKey, list);
    };

    for (const p of binanceList) {
      addLeg('binance', p);
    }
    for (const p of bybitList) {
      addLeg('bybit', p);
    }

    const snapshot = this.fundingService.getIntervalsSnapshot();
    const intervalsBySymbol = new Map(
      snapshot.intervals.map((i) => [
        i.symbol,
        i.binanceIntervalHours ?? i.bybitIntervalHours ?? 8,
      ])
    );

    const result: PositionGroup[] = [];

    for (const [symbol, legs] of legsBySymbol) {
      if (legs.length === 0) continue;
      const intervalHours = intervalsBySymbol.get(symbol) ?? 8;
      const msUntilFunding = getMsUntilNextFundingForInterval(intervalHours);
      const nextFundingTime = Date.now() + msUntilFunding;
      const withinFundingWindow = msUntilFunding <= WINDOW_BEFORE_FUNDING_MS && msUntilFunding >= 0;

      const totalPnl = legs.reduce((s, l) => s + l.unrealizedPnl, 0);
      const netFundingFee = legs.reduce((s, l) => s + l.estFundingFee, 0);
      const binanceLeg = legs.find((l) => l.exchange === 'binance');
      const bybitLeg = legs.find((l) => l.exchange === 'bybit');
      const binanceQty = binanceLeg?.size ?? 0;
      const bybitQty = bybitLeg?.size ?? 0;
      const isHedged =
        binanceLeg != null &&
        bybitLeg != null &&
        Math.abs(binanceQty - bybitQty) < HEDGE_DUST;

      let netSpread = 0;
      const entry = fundingRates.get(symbol);
      const binanceRateStr = entry?.binance?.fundingRate;
      const bybitRateStr = entry?.bybit?.fundingRate;
      if (
        binanceLeg &&
        bybitLeg &&
        binanceRateStr != null &&
        bybitRateStr != null
      ) {
        const binanceRate = parseFloat(binanceRateStr);
        const bybitRate = parseFloat(bybitRateStr);
        if (Number.isFinite(binanceRate) && Number.isFinite(bybitRate)) {
          netSpread =
            binanceLeg.side === 'LONG' ? bybitRate - binanceRate : binanceRate - bybitRate;
        }
      }
      const isFundingFlipped = withinFundingWindow && netSpread <= 0;

      result.push({
        symbol,
        totalPnl,
        netFundingFee,
        legs,
        isHedged,
        isFundingFlipped,
        nextFundingTime,
      });
    }

    return result.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async closePosition(symbol: string, reason: string = 'Manual'): Promise<{ closed: string[]; errors: string[] }> {
    let binanceList: Awaited<ReturnType<ExchangeManager['getPositions']>> = [];
    let bybitList: Awaited<ReturnType<ExchangeManager['getPositions']>> = [];

    try {
      binanceList = await this.exchangeManager.getPositions('binance', symbol);
    } catch (_) {}
    try {
      bybitList = await this.exchangeManager.getPositions('bybit', symbol);
    } catch (_) {}

    const bin = binanceList[0];
    const byb = bybitList[0];

    const closeTime = Date.now();
    const openTime =
      bin?.timestamp != null && byb?.timestamp != null
        ? Math.min(bin.timestamp, byb.timestamp)
        : closeTime - 7 * 24 * 60 * 60 * 1000;

    const size = bin?.quantity ?? byb?.quantity ?? 0;
    const entryPrice =
      bin != null && byb != null
        ? (bin.entryPrice + byb.entryPrice) / 2
        : (bin?.entryPrice ?? byb?.entryPrice ?? 0);
    const markPrice = bin?.markPrice ?? byb?.markPrice ?? entryPrice;
    const margin = (bin?.collateral ?? 0) + (byb?.collateral ?? 0);
    const pnl = (bin?.unrealizedPnl ?? 0) + (byb?.unrealizedPnl ?? 0);
    const roiPercent = margin > 0 ? (pnl / margin) * 100 : 0;

    const closeBin = bin
      ? this.exchangeManager.placeOrder('binance', symbol, bin.side === 'LONG' ? 'SELL' : 'BUY', bin.quantity)
      : Promise.resolve(null);
    const closeByb = byb
      ? this.exchangeManager.placeOrder('bybit', symbol, byb.side === 'LONG' ? 'SELL' : 'BUY', byb.quantity)
      : Promise.resolve(null);

    const [resBin, resByb] = await Promise.allSettled([closeBin, closeByb]);
    const closed: string[] = [];
    const errors: string[] = [];

    if (bin && resBin.status === 'fulfilled' && resBin.value != null) closed.push('binance');
    else if (bin && resBin.status === 'rejected') errors.push(`Binance: ${resBin.reason instanceof Error ? resBin.reason.message : String(resBin.reason)}`);
    if (byb && resByb.status === 'fulfilled' && resByb.value != null) closed.push('bybit');
    else if (byb && resByb.status === 'rejected') errors.push(`Bybit: ${resByb.reason instanceof Error ? resByb.reason.message : String(resByb.reason)}`);

    if (closed.length > 0 && size > 0) {
      let totalFundingReceived = 0;
      try {
        totalFundingReceived = await this.exchangeManager.getFundingBetween(symbol, openTime, closeTime);
      } catch (_) {}
      await addClosedTrade({
        closedAt: new Date(closeTime).toISOString(),
        symbol,
        size,
        entryPrice,
        markPrice,
        exitPrice: markPrice,
        pnl,
        roiPercent,
        margin,
        reason,
        exchangeFee: 0,
        totalFundingReceived,
      });
    }

    return { closed, errors };
  }
}

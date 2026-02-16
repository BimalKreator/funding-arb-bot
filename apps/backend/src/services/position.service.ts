import type { ExchangeManager } from './exchange/index.js';
import type { FundingService } from './funding.service.js';
import type { InstrumentService } from './InstrumentService.js';
import { addClosedTrade } from './closed-trades.service.js';
import { takeAccumulatedFundingForSymbol } from './position-funding-store.js';

const CLOSE_CHUNKS = 3;
const CHUNK_TIMEOUT_MS = 2000;

function formatQuantity(qty: number, stepSize: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return qty;
  const steps = Math.floor(qty / stepSize + 1e-9);
  return steps * stepSize;
}

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
  /** Running total of funding earned/paid for this leg (realized). */
  accumulatedFunding?: number;
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
  /** Funding interval in hours (1, 2, 4, 8) for this symbol. */
  fundingIntervalHours?: number;
  /** Running total of funding earned/paid across both legs (realized). */
  accumulatedFunding?: number;
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

/** For mismatched intervals use fast (smaller) interval for tracking; otherwise single interval or 8. */
function resolveIntervalForTracking(binanceH: number | null, bybitH: number | null): number {
  if (binanceH != null && bybitH != null && binanceH !== bybitH) return Math.min(binanceH, bybitH);
  return binanceH ?? bybitH ?? 8;
}

export class PositionService {
  constructor(
    private readonly exchangeManager: ExchangeManager,
    private readonly fundingService: FundingService,
    private readonly instrumentService?: InstrumentService
  ) {}

  private getStepSize(symbol: string): number {
    const bybitStep = this.instrumentService?.getInstrument(symbol)?.qtyStep;
    const step = Number.isFinite(bybitStep) && bybitStep! > 0 ? bybitStep! : 0.001;
    return Math.max(step, 0.001);
  }

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
        resolveIntervalForTracking(i.binanceIntervalHours, i.bybitIntervalHours),
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
        fundingIntervalHours: intervalHours,
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

    const chunkOpts = { splitParts: 1 as const, timeoutMs: CHUNK_TIMEOUT_MS };
    const closed: string[] = [];
    const errors: string[] = [];
    let binanceClosed = false;
    let bybitClosed = false;

    if (bin && byb && size > 0) {
      const effectiveStep = this.getStepSize(symbol);
      const chunkSize = formatQuantity(size / CLOSE_CHUNKS, effectiveStep);
      const binSide = bin.side === 'LONG' ? 'SELL' : 'BUY';
      const bybSide = byb.side === 'LONG' ? 'SELL' : 'BUY';

      for (let i = 0; i < CLOSE_CHUNKS; i++) {
        const isLastChunk = i === CLOSE_CHUNKS - 1;
        const remainingSize = size - chunkSize * (CLOSE_CHUNKS - 1);
        const chunkQty = isLastChunk
          ? formatQuantity(remainingSize, effectiveStep)
          : chunkSize;
        if (chunkQty <= 0) continue;

        try {
          const binanceOrder = this.exchangeManager.executeSplitOrder(
            'binance',
            symbol,
            binSide,
            chunkQty,
            markPrice,
            chunkOpts
          );
          const bybitOrder = this.exchangeManager.executeSplitOrder(
            'bybit',
            symbol,
            bybSide,
            chunkQty,
            markPrice,
            chunkOpts
          );
          await Promise.all([binanceOrder, bybitOrder]);
          binanceClosed = true;
          bybitClosed = true;
        } catch (e) {
          console.error(
            `[PositionService] closePosition chunk ${i + 1} failed:`,
            e instanceof Error ? e.message : e
          );
          errors.push(`Chunk ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
          break;
        }

        if (!isLastChunk) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (binanceClosed) closed.push('binance');
      if (bybitClosed) closed.push('bybit');
    }

    if (closed.length > 0 && size > 0) {
      const accumulatedFunding = await takeAccumulatedFundingForSymbol(symbol);
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
        totalFundingReceived: totalFundingReceived || 0,
        accumulatedFunding,
      });
    }

    return { closed, errors };
  }
}

import type { ExchangeManager } from './exchange/index.js';
import { getReadableErrorMessage } from './exchange/ExchangeManager.js';
import type { FundingService } from './funding.service.js';
import type { InstrumentService } from './InstrumentService.js';
import { addClosedTrade } from './closed-trades.service.js';
import { takeAccumulatedFundingForSymbol } from './position-funding-store.js';

const CLOSE_CHUNKS = 3;
const CHUNK_TIMEOUT_MS = 2000;
const CLOSE_RETRY_ATTEMPTS = 3;
const USE_PARALLEL_CHASE_EXIT = true;
const CHASE_TICK_MS = 2000;
const CHASE_MAX_ATTEMPTS = 3;

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

/** True if the error is a reduce-only / position-zero style rejection (retry with reduceOnly: false). */
function isReduceOnlyError(err: unknown): boolean {
  const msg = getReadableErrorMessage(err).toLowerCase();
  if (msg.includes('reduce-only') || msg.includes('reduce only')) return true;
  if (msg.includes('position is zero') || msg.includes('cannot fix reduce-only')) return true;
  const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
  if (code === -5022) return true; // Binance: "Reduce only order is rejected"
  return false;
}

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

    const closed: string[] = [];
    const errors: string[] = [];
    let binanceClosed = false;
    let bybitClosed = false;

    if (size <= 0 || (!bin && !byb)) {
      console.log(`[Orphan Exit] No position found for symbol ${symbol} (bin=${!!bin}, byb=${!!byb}, size=${size}).`);
      return { closed: [], errors: ['No position found'] };
    }

    // Orphan: single leg only — close with market order; on reduce-only error retry with reduceOnly=false.
    if ((bin && !byb) || (!bin && byb)) {
      const exchangeId = bin ? 'binance' : 'bybit';
      const leg = (bin ?? byb)!;
      const closeSide = leg.side === 'LONG' ? 'SELL' : 'BUY';
      const effectiveStep = this.getStepSize(symbol);
      const qty = formatQuantity(leg.quantity, effectiveStep);
      if (qty <= 0) {
        console.log(`[Orphan Exit] Symbol ${symbol}: formatted qty is 0 on ${exchangeId}, skipping.`);
        return { closed: [], errors: ['Invalid quantity'] };
      }
      console.log(`[Orphan Exit] Closing single leg on ${exchangeId} for ${symbol}, qty=${qty.toFixed(6)} (${reason}).`);
      try {
        await this.exchangeManager.placeOrder(exchangeId, symbol, closeSide, qty, true);
        closed.push(exchangeId);
        if (exchangeId === 'binance') binanceClosed = true;
        else bybitClosed = true;
      } catch (err) {
        const msg = getReadableErrorMessage(err);
        if (isReduceOnlyError(err)) {
          const freshPositions = await this.exchangeManager.getPositions(exchangeId, symbol);
          const currentSize = freshPositions[0]?.quantity ?? 0;
          if (currentSize <= 0) {
            console.log('[Orphan Exit] Position already closed (size=0), skipping reduceOnly=false retry.');
            closed.push(exchangeId);
            if (exchangeId === 'binance') binanceClosed = true;
            else bybitClosed = true;
          } else {
            const retryQty = formatQuantity(currentSize, effectiveStep);
            console.log('[Orphan Exit] Reduce-only error, retrying with reduceOnly=false (confirmed size>0):', msg);
            try {
              await this.exchangeManager.placeOrder(exchangeId, symbol, closeSide, retryQty, false);
              closed.push(exchangeId);
              if (exchangeId === 'binance') binanceClosed = true;
              else bybitClosed = true;
            } catch (retryErr) {
              const retryMsg = getReadableErrorMessage(retryErr);
              console.error('[Orphan Exit] Order rejected (retry with reduceOnly=false failed):', retryMsg);
              errors.push(retryMsg);
            }
          }
        } else {
          console.error('[Orphan Exit] Order rejected:', msg);
          errors.push(msg);
        }
      }
      if (closed.length > 0) {
        this.instrumentService?.setExitCooldown(symbol);
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
          size: leg.quantity,
          entryPrice: leg.entryPrice,
          markPrice: leg.markPrice ?? leg.entryPrice,
          exitPrice: markPrice,
          pnl: leg.unrealizedPnl ?? 0,
          roiPercent: margin > 0 ? ((leg.unrealizedPnl ?? 0) / margin) * 100 : 0,
          margin: leg.collateral ?? 0,
          reason,
          exchangeFee: 0,
          totalFundingReceived: totalFundingReceived || 0,
          accumulatedFunding,
        });
      }
      return { closed, errors };
    }

    if (bin && byb && size > 0) {
      const effectiveStep = this.getStepSize(symbol);
      const chunkSize = formatQuantity(size / CLOSE_CHUNKS, effectiveStep);
      const binSide = bin.side === 'LONG' ? 'SELL' : 'BUY';
      const bybSide = byb.side === 'LONG' ? 'SELL' : 'BUY';

      if (USE_PARALLEL_CHASE_EXIT) {
        try {
          console.log(`[Exit] Parallel Limit Chase for ${symbol} (qty=${size.toFixed(6)})`);
          await this.exchangeManager.executeParallelChase({
            symbol,
            binanceSide: binSide,
            bybitSide: bybSide,
            quantity: size,
            reduceOnly: true,
            chaseTickMs: CHASE_TICK_MS,
            maxChaseAttempts: CHASE_MAX_ATTEMPTS,
          });
          closed.push('binance');
          closed.push('bybit');
        } catch (err) {
          const msg = getReadableErrorMessage(err);
          console.error('[PositionService] Parallel Chase exit failed:', msg);
          if (isReduceOnlyError(err)) {
            const [binPositions, bybPositions] = await Promise.all([
              this.exchangeManager.getPositions('binance', symbol),
              this.exchangeManager.getPositions('bybit', symbol),
            ]);
            const binSize = binPositions[0]?.quantity ?? 0;
            const bybSize = bybPositions[0]?.quantity ?? 0;
            if (binSize > 0) {
              console.log('[Exit] Retrying Binance leg with market reduceOnly=false (confirmed size>0).');
              try {
                await this.exchangeManager.placeOrder('binance', symbol, binSide, formatQuantity(binSize, effectiveStep), false);
                closed.push('binance');
                binanceClosed = true;
              } catch (binErr) {
                console.error('[PositionService] Binance force-close failed:', getReadableErrorMessage(binErr));
                errors.push(getReadableErrorMessage(binErr));
              }
            } else {
              console.log('[Exit] Binance position already 0, skipping force-close.');
            }
            if (bybSize > 0) {
              console.log('[Exit] Retrying Bybit leg with market reduceOnly=false (confirmed size>0).');
              try {
                await this.exchangeManager.placeOrder('bybit', symbol, bybSide, formatQuantity(bybSize, effectiveStep), false);
                closed.push('bybit');
                bybitClosed = true;
              } catch (bybErr) {
                console.error('[PositionService] Bybit force-close failed:', getReadableErrorMessage(bybErr));
                errors.push(getReadableErrorMessage(bybErr));
              }
            } else {
              console.log('[Exit] Bybit position already 0, skipping force-close.');
            }
            this.instrumentService?.setExitCooldown(symbol);
          } else {
            errors.push(msg);
          }
        }
      } else {
      const chunkOpts = { splitParts: 1 as const, timeoutMs: CHUNK_TIMEOUT_MS };
      const executeChunk = async (): Promise<void> => {
        for (let i = 0; i < CLOSE_CHUNKS; i++) {
          const isLastChunk = i === CLOSE_CHUNKS - 1;
          const remainingSize = size - chunkSize * (CLOSE_CHUNKS - 1);
          const chunkQty = isLastChunk
            ? formatQuantity(remainingSize, effectiveStep)
            : chunkSize;
          if (chunkQty <= 0) continue;

          console.log(
            `[Exit] Attempting Parallel Chunk ${i + 1}/${CLOSE_CHUNKS} for ${symbol} (qty=${chunkQty.toFixed(6)}) — Binance and Bybit`
          );
          const binancePromise = this.exchangeManager.executeSplitOrder(
            'binance',
            symbol,
            binSide,
            chunkQty,
            markPrice,
            chunkOpts
          );
          const bybitPromise = this.exchangeManager.executeSplitOrder(
            'bybit',
            symbol,
            bybSide,
            chunkQty,
            markPrice,
            chunkOpts
          );
          const [binRes, bybRes] = await Promise.allSettled([binancePromise, bybitPromise]);

          let binanceOk = binRes.status === 'fulfilled';
          let bybitOk = bybRes.status === 'fulfilled';

          if (binRes.status === 'fulfilled') {
            console.log(`[Exit] Chunk ${i + 1}: Binance succeeded.`);
            binanceClosed = true;
          } else {
            console.error(
              `[Exit] Chunk ${i + 1}: Binance failed:`,
              binRes.reason instanceof Error ? binRes.reason.message : binRes.reason
            );
            try {
              await this.exchangeManager.executeSplitOrder(
                'binance',
                symbol,
                binSide,
                chunkQty,
                markPrice,
                chunkOpts
              );
              binanceOk = true;
              binanceClosed = true;
              console.log(`[Exit] Chunk ${i + 1}: Binance immediate retry succeeded.`);
            } catch (retryErr) {
              console.error(
                `[Exit] Chunk ${i + 1}: Binance immediate retry failed:`,
                retryErr instanceof Error ? retryErr.message : retryErr
              );
            }
          }

          if (bybRes.status === 'fulfilled') {
            console.log(`[Exit] Chunk ${i + 1}: Bybit succeeded.`);
            bybitClosed = true;
          } else {
            console.error(
              `[Exit] Chunk ${i + 1}: Bybit failed:`,
              bybRes.reason instanceof Error ? bybRes.reason.message : bybRes.reason
            );
            try {
              await this.exchangeManager.executeSplitOrder(
                'bybit',
                symbol,
                bybSide,
                chunkQty,
                markPrice,
                chunkOpts
              );
              bybitOk = true;
              bybitClosed = true;
              console.log(`[Exit] Chunk ${i + 1}: Bybit immediate retry succeeded.`);
            } catch (retryErr) {
              console.error(
                `[Exit] Chunk ${i + 1}: Bybit immediate retry failed:`,
                retryErr instanceof Error ? retryErr.message : retryErr
              );
            }
          }

          if (binanceOk && bybitOk) {
            if (!isLastChunk) await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          if (!binanceOk && !bybitOk) {
            const binReason = binRes.status === 'rejected' ? binRes.reason : 'unknown';
            const bybReason = bybRes.status === 'rejected' ? bybRes.reason : 'unknown';
            console.error(
              `[PositionService] closePosition chunk ${i + 1}: both legs failed after immediate retry. Binance: ${binReason instanceof Error ? binReason.message : binReason}; Bybit: ${bybReason instanceof Error ? bybReason.message : bybReason}`
            );
            errors.push(`Chunk ${i + 1}: both legs failed`);
            return;
          }

          const retryFailedLeg = async (
            exchangeId: 'binance' | 'bybit',
            side: 'BUY' | 'SELL'
          ): Promise<boolean> => {
            for (let attempt = 1; attempt <= CLOSE_RETRY_ATTEMPTS; attempt++) {
              try {
                await this.exchangeManager.executeSplitOrder(
                  exchangeId,
                  symbol,
                  side,
                  chunkQty,
                  markPrice,
                  chunkOpts
                );
                if (exchangeId === 'binance') binanceClosed = true;
                else bybitClosed = true;
                return true;
              } catch (err) {
                console.error(
                  `[PositionService] closePosition chunk ${i + 1} ${exchangeId} retry ${attempt}/${CLOSE_RETRY_ATTEMPTS}:`,
                  err instanceof Error ? err.message : err
                );
                if (attempt === CLOSE_RETRY_ATTEMPTS) return false;
                await new Promise((r) => setTimeout(r, 1000));
              }
            }
            return false;
          };

          if (!binanceOk && bybitOk) {
            const ok = await retryFailedLeg('binance', binSide);
            if (!ok) {
              console.error(
                `[PositionService] CRITICAL UNHEDGED: Bybit closed chunk ${i + 1}, Binance failed after ${CLOSE_RETRY_ATTEMPTS} retries. ${symbol}`
              );
              errors.push(`Chunk ${i + 1}: Binance failed after retries (UNHEDGED)`);
              return;
            }
            if (!isLastChunk) await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          if (binanceOk && !bybitOk) {
            const ok = await retryFailedLeg('bybit', bybSide);
            if (!ok) {
              console.error(
                `[PositionService] CRITICAL UNHEDGED: Binance closed chunk ${i + 1}, Bybit failed after ${CLOSE_RETRY_ATTEMPTS} retries. ${symbol}`
              );
              errors.push(`Chunk ${i + 1}: Bybit failed after retries (UNHEDGED)`);
              return;
            }
            if (!isLastChunk) await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
        }
      };

      await executeChunk();
      if (binanceClosed) closed.push('binance');
      if (bybitClosed) closed.push('bybit');
      }
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

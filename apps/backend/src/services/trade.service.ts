import type { ExchangeId, OrderResult } from '@funding-arb-bot/shared';
import type { ConfigService } from './config.service.js';
import type { ExchangeManager, ExecuteSplitOrderOptions, ParallelChaseResult } from './exchange/index.js';
import type { InstrumentService } from './InstrumentService.js';
import type { MarketDataService } from './market-data.service.js';
import type { NotificationService } from './notification.service.js';

export interface ArbitrageStrategy {
  binanceSide: 'BUY' | 'SELL';
  bybitSide: 'BUY' | 'SELL';
}

export interface ExecuteArbitrageResult {
  success: true;
  binanceOrder: OrderResult;
  bybitOrder: OrderResult;
}

const ROLLBACK_ERROR = 'Trade Failed - Rolled Back';
const MIN_NOTIONAL_USD = 5.1;
const REBALANCE_QTY_THRESHOLD = 1;
const REBALANCE_MIN_AGE_MS = 60_000; // 60 seconds
const PROBE_PCT = 0.01;
const PROBE_MIN_NOTIONAL_USD = 6;
const ENTRY_CHUNKS = 3;
const CHUNK_TIMEOUT_MS = 2000;
const CHASE_TICK_MS = 2000;
const CHASE_MAX_ATTEMPTS = 3;
const USE_PARALLEL_CHASE_ENTRY = true;

/** Round down quantity to exchange stepSize to avoid rejection. */
function formatQuantity(qty: number, stepSize: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return qty;
  const steps = Math.floor(qty / stepSize + 1e-9);
  return steps * stepSize;
}

export class TradeService {
  constructor(
    private readonly exchangeManager: ExchangeManager,
    private readonly notificationService?: NotificationService,
    private readonly instrumentService?: InstrumentService,
    private readonly configService?: ConfigService,
    private readonly marketDataService?: MarketDataService
  ) {}

  /** Step size for symbol on exchange (Bybit from InstrumentService, Binance default). */
  private getStepSize(exchangeId: ExchangeId, symbol: string): number {
    if (exchangeId === 'bybit') {
      const step = this.instrumentService?.getInstrument(symbol)?.qtyStep;
      return Number.isFinite(step) && step! > 0 ? step! : 0.001;
    }
    return 0.001;
  }

  /** Execute order via split limit strategy. Pass options for single-chunk or custom timeout. */
  async executeSplitOrder(
    exchangeId: ExchangeId,
    symbol: string,
    side: 'BUY' | 'SELL',
    totalQuantity: number,
    markPrice: number,
    options?: ExecuteSplitOrderOptions
  ): Promise<OrderResult> {
    return this.exchangeManager.executeSplitOrder(exchangeId, symbol, side, totalQuantity, markPrice, options);
  }

  async executeArbitrage(
    symbol: string,
    quantity: number,
    strategy: ArbitrageStrategy,
    leverage: number,
    markPrice?: number
  ): Promise<ExecuteArbitrageResult> {
    if (this.instrumentService?.isBlacklisted(symbol)) {
      throw new Error(`Symbol ${symbol} is blacklisted (24h).`);
    }
    if (this.instrumentService?.isOnExitCooldown(symbol)) {
      throw new Error(`Symbol ${symbol} is on exit cooldown (5 min).`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Invalid quantity');
    }
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error('Invalid leverage');
    }

    const price = markPrice ?? 0;
    const stepBinance = this.getStepSize('binance', symbol);
    const stepBybit = this.getStepSize('bybit', symbol);
    const effectiveStep = Math.max(stepBinance, stepBybit);
    const totalQty = formatQuantity(quantity, effectiveStep);
    if (totalQty <= 0) {
      throw new Error(`Quantity ${quantity} rounds to zero for symbol ${symbol} (step ${effectiveStep}).`);
    }

    const estimatedNotional = Number.isFinite(price) && price > 0 ? totalQty * price : 0;
    if (estimatedNotional > 0 && estimatedNotional < MIN_NOTIONAL_USD) {
      throw new Error(
        `Notional value $${estimatedNotional.toFixed(2)} is below $${MIN_NOTIONAL_USD} minimum.`
      );
    }

    console.log(`Setting leverage to ${leverage}x for ${symbol}...`);
    try {
      await this.exchangeManager.setLeverageOnBothExchanges(leverage, symbol);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Leverage Set Failed: ${message}`);
    }

    // Enforce correct side per exchange (hedge: opposite sides on Binance vs Bybit).
    const binanceSide = strategy.binanceSide;
    const bybitSide = strategy.bybitSide;

    // —— Real-Time Orderbook Profitability Check (when Entry Guard enabled) ——
    const cfg = await this.configService?.getConfig();
    const entryGuardEnabled = cfg?.isEntryGuardEnabled ?? true;
    const requiredSpread = cfg?.executionSpreadThreshold ?? 0.22;

    // Prefer WebSocket cache (zero API weight); fallback to REST when cache empty or invalid (e.g. cold start or zeros).
    const cached = this.marketDataService?.getMarketPrice(symbol) ?? { binance: null, bybit: null };
    const isValidTicker = (t: { bestBid: number; bestAsk: number } | null): t is { bestBid: number; bestAsk: number } =>
      t != null &&
      Number.isFinite(t.bestBid) &&
      Number.isFinite(t.bestAsk) &&
      t.bestBid > 0 &&
      t.bestAsk > 0;

    let binanceBid: number;
    let binanceAsk: number;
    let bybitBid: number;
    let bybitAsk: number;
    if (isValidTicker(cached.binance)) {
      binanceBid = cached.binance.bestBid;
      binanceAsk = cached.binance.bestAsk;
    } else {
      const binanceTop = await this.exchangeManager.getOrderbookTop('binance', symbol);
      binanceBid = binanceTop.bestBid;
      binanceAsk = binanceTop.bestAsk;
    }
    if (isValidTicker(cached.bybit)) {
      bybitBid = cached.bybit.bestBid;
      bybitAsk = cached.bybit.bestAsk;
    } else {
      const bybitTop = await this.exchangeManager.getOrderbookTop('bybit', symbol);
      bybitBid = bybitTop.bestBid;
      bybitAsk = bybitTop.bestAsk;
    }

    let sellPrice: number;
    let buyPrice: number;
    if (binanceSide === 'SELL' && bybitSide === 'BUY') {
      sellPrice = binanceBid;
      buyPrice = bybitAsk;
    } else if (binanceSide === 'BUY' && bybitSide === 'SELL') {
      buyPrice = binanceAsk;
      sellPrice = bybitBid;
    } else {
      throw new Error(`Invalid strategy sides: Binance ${binanceSide}, Bybit ${bybitSide}`);
    }

    if (!Number.isFinite(sellPrice) || !Number.isFinite(buyPrice) || buyPrice <= 0) {
      throw new Error(`Invalid orderbook prices for ${symbol}: Sell ${sellPrice}, Buy ${buyPrice}`);
    }
    const spreadAmount = sellPrice - buyPrice;
    const spreadPercent = (spreadAmount / buyPrice) * 100;

    // isEntryGuardEnabled ON: enforce min spread or abort. OFF: skip check and proceed regardless of spread.
    if (entryGuardEnabled) {
      console.log(
        `[TradeService] Checking Entry Profitability: Sell @ ${sellPrice}, Buy @ ${buyPrice}, Spread: ${spreadPercent.toFixed(4)}%, Required: ${requiredSpread}%`
      );
      if (spreadPercent <= requiredSpread) {
        console.log(
          `[TradeService] Entry Rejected: Realized spread ${spreadPercent.toFixed(4)}% is below cost threshold (${requiredSpread}%). Monitoring for better spread...`
        );
        throw new Error(
          `Entry Rejected: Realized spread ${spreadPercent.toFixed(4)}% is below cost threshold (${requiredSpread}%).`
        );
      }
    } else {
      console.log(
        `[TradeService] Entry Guard disabled — skipping spread check. Sell @ ${sellPrice}, Buy @ ${buyPrice}, Spread: ${spreadPercent.toFixed(4)}%`
      );
    }

    if (USE_PARALLEL_CHASE_ENTRY) {
      // —— Parallel Limit Chase (post-only limits, 2s tick, chase then market if one leg lags) ——
      console.log(`[TradeService] Entry via Parallel Limit Chase for ${symbol} (qty=${totalQty})`);
      const chaseResult: ParallelChaseResult = await this.exchangeManager.executeParallelChase({
        symbol,
        binanceSide,
        bybitSide,
        quantity: totalQty,
        reduceOnly: false,
        chaseTickMs: CHASE_TICK_MS,
        maxChaseAttempts: CHASE_MAX_ATTEMPTS,
      });
      this.notificationService?.add(
        'SUCCESS',
        'Trade Executed',
        `${symbol} — Chase filled both legs.`,
        { symbol, quantity: totalQty, binanceOrderId: chaseResult.binanceOrder.orderId, bybitOrderId: chaseResult.bybitOrder.orderId }
      );
      return {
        success: true,
        binanceOrder: chaseResult.binanceOrder,
        bybitOrder: chaseResult.bybitOrder,
      };
    }

    // —— Legacy: Probe then 3 chunks (limit then market) ——
    const chunkOpts: ExecuteSplitOrderOptions = { splitParts: 1, timeoutMs: CHUNK_TIMEOUT_MS };
    const probeMinQty = price > 0 ? PROBE_MIN_NOTIONAL_USD / price : 0;
    const probeQtyRaw = Math.max(totalQty * PROBE_PCT, probeMinQty);
    const probeQty = Math.min(formatQuantity(probeQtyRaw, effectiveStep), totalQty);
    if (probeQty <= 0) {
      throw new Error(`Probe quantity rounds to zero for ${symbol}.`);
    }

    try {
      await this.exchangeManager.executeSplitOrder(
        'binance',
        symbol,
        binanceSide,
        probeQty,
        price,
        chunkOpts
      );
    } catch (err) {
      console.error('[TradeService] Probe Leg A (Binance) failed:', err instanceof Error ? err.message : err);
      throw err;
    }

    try {
      await this.exchangeManager.executeSplitOrder(
        'bybit',
        symbol,
        bybitSide,
        probeQty,
        price,
        chunkOpts
      );
    } catch (err) {
      console.error('[TradeService] Probe Leg B (Bybit) failed; rolling back Leg A:', err instanceof Error ? err.message : err);
      await this.panicClose('binance', symbol, binanceSide, probeQty);
      throw new Error(ROLLBACK_ERROR);
    }

    const remainingQty = totalQty - probeQty;
    if (remainingQty <= 0) {
      this.notificationService?.add('SUCCESS', 'Trade Executed', `${symbol} — Probe filled both legs.`, { symbol, quantity: probeQty });
      return { success: true, binanceOrder: { orderId: 'probe', status: 'FILLED', exchangeId: 'binance' }, bybitOrder: { orderId: 'probe', status: 'FILLED', exchangeId: 'bybit' } };
    }

    const chunkSize = formatQuantity(remainingQty / ENTRY_CHUNKS, effectiveStep);
    let lastBinanceOrderId = 'chunk';
    let lastBybitOrderId = 'chunk';

    for (let i = 0; i < ENTRY_CHUNKS; i++) {
      const chunkQty = i < ENTRY_CHUNKS - 1 ? chunkSize : formatQuantity(remainingQty - chunkSize * (ENTRY_CHUNKS - 1), effectiveStep);
      if (chunkQty <= 0) continue;

      const resA = await this.exchangeManager.executeSplitOrder(
        'binance',
        symbol,
        binanceSide,
        chunkQty,
        price,
        chunkOpts
      );
      lastBinanceOrderId = resA.orderId;

      const resB = await this.exchangeManager.executeSplitOrder(
        'bybit',
        symbol,
        bybitSide,
        chunkQty,
        price,
        chunkOpts
      );
      lastBybitOrderId = resB.orderId;
    }

    this.notificationService?.add(
      'SUCCESS',
      'Trade Executed',
      `${symbol} — Binance ${lastBinanceOrderId}, Bybit ${lastBybitOrderId}`,
      { symbol, quantity: totalQty, binanceOrderId: lastBinanceOrderId, bybitOrderId: lastBybitOrderId }
    );
    return {
      success: true,
      binanceOrder: { orderId: lastBinanceOrderId, status: 'FILLED', exchangeId: 'binance' },
      bybitOrder: { orderId: lastBybitOrderId, status: 'FILLED', exchangeId: 'bybit' },
    };
  }

  private async panicClose(
    exchangeId: ExchangeId,
    symbol: string,
    originalSide: 'BUY' | 'SELL',
    quantity: number
  ): Promise<void> {
    const counterSide = originalSide === 'BUY' ? 'SELL' : 'BUY';
    try {
      await this.exchangeManager.placeOrder(exchangeId, symbol, counterSide, quantity, true /* reduceOnly: close */);
    } catch (err) {
      console.error(`Panic close failed on ${exchangeId}:`, err);
    }
  }

  /**
   * Auto-balancer: if Binance and Bybit quantities differ beyond threshold and position age > 60s,
   * reduce the larger side by the difference to match the smaller.
   */
  async rebalanceQuantities(): Promise<void> {
    try {
      const [binanceList, bybitList] = await Promise.all([
        this.exchangeManager.getPositions('binance'),
        this.exchangeManager.getPositions('bybit'),
      ]);
      const now = Date.now();
      const symbolsBinance = new Set(binanceList.map((p) => p.symbol));
      const symbolsBybit = new Set(bybitList.map((p) => p.symbol));

      for (const symbol of symbolsBinance) {
        if (!symbolsBybit.has(symbol)) continue;
        const binancePos = binanceList.find((p) => p.symbol === symbol);
        const bybitPos = bybitList.find((p) => p.symbol === symbol);
        if (!binancePos || !bybitPos) continue;

        const binanceQty = binancePos.quantity;
        const bybitQty = bybitPos.quantity;
        const diff = Math.abs(binanceQty - bybitQty);
        if (diff <= REBALANCE_QTY_THRESHOLD) continue;

        const oldestTimestamp = Math.min(
          binancePos.timestamp ?? 0,
          bybitPos.timestamp ?? 0
        );
        if (oldestTimestamp <= 0 || now - oldestTimestamp < REBALANCE_MIN_AGE_MS) continue;

        const reduceQty = Math.round(diff * 100000) / 100000;
        if (reduceQty <= 0) continue;

        const markPrice = binancePos.markPrice && binancePos.markPrice > 0
          ? binancePos.markPrice
          : bybitPos.markPrice && bybitPos.markPrice > 0
            ? bybitPos.markPrice
            : 0;
        const rebalanceNotional = markPrice > 0 ? reduceQty * markPrice : 0;

        if (rebalanceNotional > 0 && rebalanceNotional < MIN_NOTIONAL_USD) {
          console.log(
            `Skipping rebalance for ${symbol}: Rebalance notional $${rebalanceNotional.toFixed(2)} is below $${MIN_NOTIONAL_USD} limit.`
          );
          continue;
        }

        // Prefer increasing the smaller side (Binance fails on small decreases).
        if (binanceQty < bybitQty) {
          const side = binancePos.side === 'LONG' ? 'BUY' : 'SELL';
          console.log(
            `Auto-Balancing ${symbol}: Increasing Binance by ${reduceQty} (notional $${rebalanceNotional.toFixed(2)}) to match Bybit.`
          );
          await this.exchangeManager.placeOrder('binance', symbol, side, reduceQty, false /* reduceOnly: open/add */);
        } else if (bybitQty < binanceQty) {
          const side = bybitPos.side === 'LONG' ? 'BUY' : 'SELL';
          console.log(
            `Auto-Balancing ${symbol}: Increasing Bybit by ${reduceQty} (notional $${rebalanceNotional.toFixed(2)}) to match Binance.`
          );
          await this.exchangeManager.placeOrder('bybit', symbol, side, reduceQty, false /* reduceOnly: open/add */);
        } else {
          // Equal (shouldn't hit due to diff check)
        }
      }
    } catch (err) {
      console.error(
        '[TradeService] rebalanceQuantities error:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

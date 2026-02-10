import type { ExchangeId, OrderResult } from '@funding-arb-bot/shared';
import type { ExchangeManager } from './exchange/index.js';
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

export class TradeService {
  constructor(
    private readonly exchangeManager: ExchangeManager,
    private readonly notificationService?: NotificationService
  ) {}

  async executeArbitrage(
    symbol: string,
    quantity: number,
    strategy: ArbitrageStrategy,
    leverage: number,
    markPrice?: number
  ): Promise<ExecuteArbitrageResult> {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Invalid quantity');
    }
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error('Invalid leverage');
    }

    const estimatedNotional = Number.isFinite(markPrice) && markPrice > 0 ? quantity * markPrice : 0;
    if (estimatedNotional > 0 && estimatedNotional < MIN_NOTIONAL_USD) {
      console.log(
        `Skipping trade for ${symbol}: Notional value $${estimatedNotional.toFixed(2)} is below $${MIN_NOTIONAL_USD} limit.`
      );
      throw new Error(
        `Notional value $${estimatedNotional.toFixed(2)} is below $${MIN_NOTIONAL_USD} minimum.`
      );
    }

    console.log(`Setting leverage to ${leverage}x for ${symbol}...`);
    try {
      await this.exchangeManager.setLeverageOnBothExchanges(leverage, symbol);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: Failed to set leverage. Check max leverage limits. Error: ${message}`);
      throw new Error(`Leverage Set Failed: ${message}`);
    }
    console.log(`Leverage synced to ${leverage}x on both exchanges.`);

    const orderA = this.exchangeManager.placeOrder(
      'binance',
      symbol,
      strategy.binanceSide,
      quantity
    );
    const orderB = this.exchangeManager.placeOrder(
      'bybit',
      symbol,
      strategy.bybitSide,
      quantity
    );

    const [resultA, resultB] = await Promise.allSettled([orderA, orderB]);
    const aOk = resultA.status === 'fulfilled';
    const bOk = resultB.status === 'fulfilled';

    if (aOk && bOk) {
      this.notificationService?.add(
        'SUCCESS',
        'Trade Executed',
        `${symbol} — Binance ${resultA.value.orderId}, Bybit ${resultB.value.orderId}`,
        { symbol, quantity, binanceOrderId: resultA.value.orderId, bybitOrderId: resultB.value.orderId }
      );
      return {
        success: true,
        binanceOrder: resultA.value,
        bybitOrder: resultB.value,
      };
    }

    if (aOk && !bOk) {
      const err = resultB.status === 'rejected' ? resultB.reason : null;
      console.error('Trade Failed Details:', err instanceof Error ? err.message : err);
      await this.panicClose('binance', symbol, strategy.binanceSide, quantity);
      throw new Error(ROLLBACK_ERROR);
    }
    if (!aOk && bOk) {
      const err = resultA.status === 'rejected' ? resultA.reason : null;
      console.error('Trade Failed Details:', err instanceof Error ? err.message : err);
      await this.panicClose('bybit', symbol, strategy.bybitSide, quantity);
      throw new Error(ROLLBACK_ERROR);
    }

    const errA = resultA.status === 'rejected' ? resultA.reason : null;
    const errB = resultB.status === 'rejected' ? resultB.reason : null;
    const msg = [errA, errB].map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
    throw new Error(`Both orders failed: ${msg}`);
  }

  private async panicClose(
    exchangeId: ExchangeId,
    symbol: string,
    originalSide: 'BUY' | 'SELL',
    quantity: number
  ): Promise<void> {
    const counterSide = originalSide === 'BUY' ? 'SELL' : 'BUY';
    try {
      await this.exchangeManager.placeOrder(exchangeId, symbol, counterSide, quantity);
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
          await this.exchangeManager.placeOrder('binance', symbol, side, reduceQty);
        } else if (bybitQty < binanceQty) {
          const side = bybitPos.side === 'LONG' ? 'BUY' : 'SELL';
          console.log(
            `Auto-Balancing ${symbol}: Increasing Bybit by ${reduceQty} (notional $${rebalanceNotional.toFixed(2)}) to match Binance.`
          );
          await this.exchangeManager.placeOrder('bybit', symbol, side, reduceQty);
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

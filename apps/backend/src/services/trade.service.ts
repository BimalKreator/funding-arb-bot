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

export class TradeService {
  constructor(
    private readonly exchangeManager: ExchangeManager,
    private readonly notificationService?: NotificationService
  ) {}

  async executeArbitrage(
    symbol: string,
    quantity: number,
    strategy: ArbitrageStrategy,
    leverage: number
  ): Promise<ExecuteArbitrageResult> {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Invalid quantity');
    }
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error('Invalid leverage');
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
}

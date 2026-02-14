import type { ConfigService } from './config.service.js';
import type { ExchangeManager } from './exchange/index.js';
import type { InstrumentService } from './InstrumentService.js';
import type { NotificationService } from './notification.service.js';
import type { PositionService } from './position.service.js';
import type { ScreenerService } from './screener.service.js';
import type { TradeService } from './trade.service.js';

const INTERVAL_MS = 4000;
const MIN_FINAL_SIZE_USDT = 6;
const COOLDOWN_MS = 15 * 60 * 1000;

export class AutoEntryService {
  private failedTokens = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly exchangeManager: ExchangeManager,
    private readonly positionService: PositionService,
    private readonly screenerService: ScreenerService,
    private readonly tradeService: TradeService,
    private readonly notificationService?: NotificationService,
    private readonly instrumentService?: InstrumentService
  ) {}

  startMonitoring(): void {
    setInterval(() => this.runCycle(), INTERVAL_MS);
  }

  private async runCycle(): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.autoEntryEnabled) return;

    // Step 1: Checks — max active trades limit
    const positions = await this.positionService.getPositions();
    const activeCount = positions.length;
    const maxActiveTrades = cfg.maxActiveTrades ?? 3;
    if (activeCount >= maxActiveTrades) {
      console.log(
        `[AutoEntry] Skipping trade: Max active trades limit (${maxActiveTrades}) reached (${activeCount} active).`
      );
      return;
    }
    const activeSymbols = new Set(positions.map((p) => p.symbol));

    // Step 2: Opportunity hunting (top tokens by Net Spread DESC)
    const results = this.screenerService.getResults(0);
    const sorted = [...results].sort((a, b) => b.netSpread - a.netSpread);

    // Prune expired cooldowns
    const now = Date.now();
    for (const [sym, expiry] of this.failedTokens) {
      if (now >= expiry) this.failedTokens.delete(sym);
    }

    const allowedIntervals = (cfg.allowedFundingIntervals?.length ?? 0) > 0
      ? new Set(cfg.allowedFundingIntervals)
      : new Set([1, 2, 4, 8]);

    let candidate: typeof sorted[0] | null = null;
    for (const entry of sorted) {
      if (entry.netSpread <= 0) continue;
      if (!allowedIntervals.has(entry.interval)) continue;
      if (activeSymbols.has(entry.symbol)) continue;
      const cooldownUntil = this.failedTokens.get(entry.symbol);
      if (cooldownUntil != null && now < cooldownUntil) {
        console.log('Skipping ' + entry.symbol + ' due to cooldown');
        continue;
      }
      candidate = entry;
      break;
    }
    if (!candidate) return;

    const symbol = candidate.symbol;
    const markPrice =
      candidate.binanceMarkPrice ?? candidate.bybitMarkPrice ??
      (candidate.binanceMarkPrice != null && candidate.bybitMarkPrice != null
        ? (candidate.binanceMarkPrice + candidate.bybitMarkPrice) / 2
        : 0);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;

    // Step 3: Capital (total vs available) & quantity
    const status = await this.exchangeManager.getStatus();
    let binanceTotal = 0;
    let bybitTotal = 0;
    let binanceFree = 0;
    let bybitFree = 0;
    for (const ex of status.exchanges) {
      if (!ex.connected || !ex.balances) continue;
      const usdt = ex.balances.find((b) => b.asset.toUpperCase() === 'USDT');
      const total = usdt ? parseFloat(usdt.total) : 0;
      const available = usdt ? parseFloat(usdt.available) : 0;
      if (ex.exchangeId === 'binance') {
        binanceTotal = total;
        binanceFree = available;
      }
      if (ex.exchangeId === 'bybit') {
        bybitTotal = total;
        bybitFree = available;
      }
    }
    const baseCapital = Math.min(binanceTotal, bybitTotal);
    const targetSize = baseCapital * cfg.capitalPercent;
    const maxAffordable = Math.min(binanceFree, bybitFree);
    const finalSize = Math.min(targetSize, maxAffordable);

    if (finalSize < MIN_FINAL_SIZE_USDT) {
      console.log(
        'Insufficient funds for 3rd trade on ' + symbol + '. Need $6, have $' + finalSize.toFixed(2)
      );
      this.notificationService?.add(
        'ERROR',
        'Insufficient funds',
        'Insufficient funds for auto-entry on ' + symbol + '. Need $6, have $' + finalSize.toFixed(2),
        { symbol, finalSize, required: MIN_FINAL_SIZE_USDT }
      );
      return;
    }

    const usdtNotional = finalSize * cfg.autoLeverage;
    let quantity: number;
    if (this.instrumentService) {
      const qtyStr = this.instrumentService.calculateSafeQty(symbol, usdtNotional, markPrice);
      if (qtyStr == null) {
        console.log(`Skipping ${symbol}: Below Min Qty`);
        return;
      }
      quantity = parseFloat(qtyStr);
    } else {
      quantity = usdtNotional / markPrice;
      quantity = Math.floor(quantity * 10) / 10;
    }
    if (quantity <= 0) return;

    // Step 4: Execution (one trade per cycle)
    const strategy = {
      binanceSide: (candidate.binanceAction === 'LONG' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      bybitSide: (candidate.bybitAction === 'LONG' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    };
    try {
      const leverage = Math.max(1, Math.floor(cfg.autoLeverage)) || 1;
      await this.tradeService.executeArbitrage(symbol, quantity, strategy, leverage, markPrice);
      console.log(`Auto-Entry Triggered for ${symbol} with ${quantity} @ ${leverage}x`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Auto-Entry failed for ${symbol}:`, errMsg);
      this.failedTokens.set(symbol, Date.now() + COOLDOWN_MS);
      this.notificationService?.add(
        'ERROR',
        'Trade Failed & Paused',
        'Failed to execute ' + symbol + '. Pausing this token for 15 mins to save fees. Error: ' + errMsg,
        { symbol, cooldownMinutes: 15 }
      );
    }
  }
}

import type { ConfigService } from './config.service.js';
import type { ExchangeManager } from './exchange/index.js';
import type { PositionService } from './position.service.js';
import type { ScreenerService } from './screener.service.js';
import type { TradeService } from './trade.service.js';

const MAX_ACTIVE_TRADES = 3;
const INTERVAL_MS = 4000;

export class AutoEntryService {
  constructor(
    private readonly configService: ConfigService,
    private readonly exchangeManager: ExchangeManager,
    private readonly positionService: PositionService,
    private readonly screenerService: ScreenerService,
    private readonly tradeService: TradeService
  ) {}

  startMonitoring(): void {
    setInterval(() => this.runCycle(), INTERVAL_MS);
  }

  private async runCycle(): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.autoEntryEnabled) return;

    // Step 1: Checks
    const positions = await this.positionService.getPositions();
    const activeSymbols = new Set(positions.map((p) => p.symbol));
    if (activeSymbols.size >= MAX_ACTIVE_TRADES) return;

    // Step 2: Opportunity hunting (top tokens by Net Spread DESC)
    const results = this.screenerService.getResults(0);
    const sorted = [...results].sort((a, b) => b.netSpread - a.netSpread);

    let candidate: typeof sorted[0] | null = null;
    for (const entry of sorted) {
      if (entry.netSpread <= 0) continue;
      if (activeSymbols.has(entry.symbol)) continue;
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

    // Step 3: Capital & quantity
    const status = await this.exchangeManager.getStatus();
    let binanceFree = 0;
    let bybitFree = 0;
    for (const ex of status.exchanges) {
      if (!ex.connected || !ex.balances) continue;
      const usdt = ex.balances.find((b) => b.asset.toUpperCase() === 'USDT');
      const available = usdt ? parseFloat(usdt.available) : 0;
      if (ex.exchangeId === 'binance') binanceFree = available;
      if (ex.exchangeId === 'bybit') bybitFree = available;
    }
    const lowerBalance = Math.min(binanceFree, bybitFree);
    const allocatedCapital = lowerBalance * cfg.capitalPercent;
    let quantity = (allocatedCapital * cfg.autoLeverage) / markPrice;
    quantity = Math.floor(quantity * 10) / 10;
    if (quantity <= 0) return;

    // Step 4: Execution (one trade per cycle)
    const strategy = {
      binanceSide: (candidate.binanceAction === 'LONG' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      bybitSide: (candidate.bybitAction === 'LONG' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    };
    try {
      await this.tradeService.executeArbitrage(symbol, quantity, strategy);
      console.log(`Auto-Entry Triggered for ${symbol} with ${quantity}`);
    } catch (err) {
      console.error(`Auto-Entry failed for ${symbol}:`, err instanceof Error ? err.message : err);
    }
  }
}

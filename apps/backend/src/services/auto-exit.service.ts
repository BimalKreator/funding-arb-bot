import type { ConfigService } from './config.service.js';
import type { PositionService } from './position.service.js';
import type { NotificationService } from './notification.service.js';
import type { FundingService } from './funding.service.js';
import {
  setMonitoringStatus,
  clearMonitoringStatus,
} from './position-monitoring-state.js';

const RUN_INTERVAL_MS = 30_000; // 30 seconds for spread threshold check
const GRACE_PERIOD_MS = 60_000;
const FUNDING_FLIP_INTERVAL_MS = 60_000; // 1 minute
/** Only close when within this window of next funding; otherwise just mark "Monitoring". */
const CRITICAL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes before next funding

/** Next funding times UTC: 00:00, 08:00, 16:00 (8h intervals). Returns ms from now until next. */
function getMsUntilNextFundingUTC(): number {
  const now = new Date();
  const utcMin =
    now.getUTCHours() * 60 +
    now.getUTCMinutes() +
    now.getUTCSeconds() / 60 +
    now.getUTCMilliseconds() / 60000;
  const slots = [0, 8 * 60, 16 * 60]; // 0:00, 8:00, 16:00
  for (const slot of slots) {
    if (slot > utcMin) return (slot - utcMin) * 60 * 1000;
  }
  return (24 * 60 - utcMin) * 60 * 1000;
}

export class AutoExitService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private fundingFlipIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly positionService: PositionService,
    private readonly notificationService?: NotificationService,
    private readonly fundingService?: FundingService
  ) {}

  start(): void {
    if (this.intervalId != null) return;
    this.intervalId = setInterval(() => this.run(), RUN_INTERVAL_MS);
    this.fundingFlipIntervalId = setInterval(() => this.checkFundingFlips(), FUNDING_FLIP_INTERVAL_MS);
    console.log('[AutoExitService] Started (orphan/Spread check 30s, funding flip 1m)');
  }

  stop(): void {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.fundingFlipIntervalId != null) {
      clearInterval(this.fundingFlipIntervalId);
      this.fundingFlipIntervalId = null;
    }
    console.log('[AutoExitService] Stopped');
  }

  private async run(): Promise<void> {
    try {
      const cfg = await this.configService.getConfig();
      if (!cfg.autoExitEnabled) return;

      await this.checkNegativeSpreads();

      const groups = await this.positionService.getPositions();
      const now = Date.now();

      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;

        const hasBinance = legs.some((l) => l.exchange === 'binance');
        const hasBybit = legs.some((l) => l.exchange === 'bybit');

        if (hasBinance && !hasBybit) {
          const binanceLeg = legs.find((l) => l.exchange === 'binance');
          if (binanceLeg?.timestamp != null && now - binanceLeg.timestamp >= GRACE_PERIOD_MS) {
            const reason = 'Orphan Position detected > 60s on Binance';
            console.log(`[AutoExit] Auto-Exit triggered for ${group.symbol} on Binance (Orphan)`);
            this.notificationService?.add(
              'WARNING',
              'Auto-Exit Triggered',
              `${group.symbol}: ${reason}`,
              { symbol: group.symbol, exchange: 'binance', reason }
            );
            await this.positionService.closePosition(group.symbol, 'Auto-Exit: Orphan (Binance)');
          }
        } else if (hasBybit && !hasBinance) {
          const bybitLeg = legs.find((l) => l.exchange === 'bybit');
          if (bybitLeg?.timestamp != null && now - bybitLeg.timestamp >= GRACE_PERIOD_MS) {
            const reason = 'Orphan Position detected > 60s on Bybit';
            console.log(`[AutoExit] Auto-Exit triggered for ${group.symbol} on Bybit (Orphan)`);
            this.notificationService?.add(
              'WARNING',
              'Auto-Exit Triggered',
              `${group.symbol}: ${reason}`,
              { symbol: group.symbol, exchange: 'bybit', reason }
            );
            await this.positionService.closePosition(group.symbol, 'Auto-Exit: Orphan (Bybit)');
          }
        }
      }
    } catch (err) {
      console.error('[AutoExitService] Run error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Spread threshold: if net spread drops below screenerMinSpread:
   * - Time to funding > 10 min: set status "⚠️ Monitoring: Low Spread", do NOT close.
   * - Time to funding <= 10 min: re-check; if still below threshold, close immediately.
   */
  private async checkNegativeSpreads(): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.autoExitEnabled) return;
    if (!this.fundingService) return;
    const threshold = Number.isFinite(cfg.screenerMinSpread) ? cfg.screenerMinSpread : 0;
    const msUntilFunding = getMsUntilNextFundingUTC();

    try {
      const groups = await this.positionService.getPositions();
      const rates = this.fundingService.getLatestFundingRates();

      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;
        const binanceLeg = legs.find((l) => l.exchange === 'binance');
        const bybitLeg = legs.find((l) => l.exchange === 'bybit');
        if (!binanceLeg || !bybitLeg) continue;

        const entry = rates.get(group.symbol);
        const binanceRateStr = entry?.binance?.fundingRate;
        const bybitRateStr = entry?.bybit?.fundingRate;
        if (binanceRateStr === undefined || bybitRateStr === undefined) continue;

        const binanceRate = parseFloat(binanceRateStr);
        const bybitRate = parseFloat(bybitRateStr);
        if (!Number.isFinite(binanceRate) || !Number.isFinite(bybitRate)) continue;

        const currentNetSpread =
          binanceLeg.side === 'LONG'
            ? (bybitRate - binanceRate) * 100
            : (binanceRate - bybitRate) * 100;

        if (currentNetSpread >= threshold) {
          clearMonitoringStatus(group.symbol);
          continue;
        }

        if (msUntilFunding > CRITICAL_WINDOW_MS || msUntilFunding < 0) {
          setMonitoringStatus(group.symbol, '⚠️ Monitoring: Low Spread');
          console.log(
            `[AutoExit] Spread ${currentNetSpread.toFixed(4)}% below threshold ${threshold}%; time to funding ${(msUntilFunding / 60000).toFixed(1)} min. Not closing — monitoring.`
          );
          continue;
        }

        console.log(
          `[AutoExit] Auto-Exit: Spread ${currentNetSpread.toFixed(4)}% still below threshold ${threshold}% within 10 min of funding. Closing.`
        );
        this.notificationService?.add(
          'WARNING',
          'Spread Threshold Exit',
          `Auto-Exit: Spread ${currentNetSpread.toFixed(4)}% below threshold ${threshold}% for ${group.symbol} (within critical window).`,
          { symbol: group.symbol, currentNetSpread, threshold, reason: 'screenerMinSpread' }
        );
        await this.positionService.closePosition(group.symbol, 'Auto-Exit: Negative Spread');
        clearMonitoringStatus(group.symbol);
      }
    } catch (err) {
      console.error(
        '[AutoExitService] checkNegativeSpreads error:',
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Funding flip: if net funding rate becomes negative:
   * - Time to funding > 10 min: set status "⚠️ Monitoring: Funding Flipped", do NOT close.
   * - Time to funding <= 10 min: re-check; if still <= 0, close immediately.
   */
  async checkFundingFlips(): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.autoExitEnabled) return;
    if (!this.fundingService) return;
    try {
      const msUntilFunding = getMsUntilNextFundingUTC();
      const groups = await this.positionService.getPositions();
      const rates = this.fundingService.getLatestFundingRates();

      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;
        const binanceLeg = legs.find((l) => l.exchange === 'binance');
        const bybitLeg = legs.find((l) => l.exchange === 'bybit');
        if (!binanceLeg || !bybitLeg) continue;

        const entry = rates.get(group.symbol);
        const binanceRateStr = entry?.binance?.fundingRate;
        const bybitRateStr = entry?.bybit?.fundingRate;
        if (binanceRateStr === undefined || bybitRateStr === undefined) continue;

        const binanceRate = parseFloat(binanceRateStr);
        const bybitRate = parseFloat(bybitRateStr);
        if (!Number.isFinite(binanceRate) || !Number.isFinite(bybitRate)) continue;

        const netSpread =
          binanceLeg.side === 'LONG' ? bybitRate - binanceRate : binanceRate - bybitRate;

        if (netSpread > 0) {
          clearMonitoringStatus(group.symbol);
          continue;
        }

        if (msUntilFunding > CRITICAL_WINDOW_MS || msUntilFunding < 0) {
          setMonitoringStatus(group.symbol, '⚠️ Monitoring: Funding Flipped');
          console.log(
            `[AutoExit] Funding flipped for ${group.symbol} (netSpread=${netSpread.toFixed(6)}); time to funding ${(msUntilFunding / 60000).toFixed(1)} min. Not closing — monitoring.`
          );
          continue;
        }

        console.log(
          `[AutoExit] Funding flip exit for ${group.symbol}: netSpread=${netSpread.toFixed(6)} (within critical window).`
        );
        this.notificationService?.add(
          'WARNING',
          'Funding Flip Exit',
          `Exited ${group.symbol} due to negative spread before funding.`,
          { symbol: group.symbol, netSpread, reason: 'Sync Exit triggered' }
        );
        await this.positionService.closePosition(group.symbol, 'Auto-Exit: Funding Flip');
        clearMonitoringStatus(group.symbol);
      }
    } catch (err) {
      console.error(
        '[AutoExitService] checkFundingFlips error:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

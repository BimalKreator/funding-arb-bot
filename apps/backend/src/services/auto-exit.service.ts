import type { PositionService } from './position.service.js';
import type { NotificationService } from './notification.service.js';

const RUN_INTERVAL_MS = 10_000;
const GRACE_PERIOD_MS = 60_000;

export class AutoExitService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly positionService: PositionService,
    private readonly notificationService?: NotificationService
  ) {}

  start(): void {
    if (this.intervalId != null) return;
    this.intervalId = setInterval(() => this.run(), RUN_INTERVAL_MS);
    console.log('[AutoExitService] Started (every 10s, grace 60s)');
  }

  stop(): void {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[AutoExitService] Stopped');
    }
  }

  private async run(): Promise<void> {
    try {
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
            await this.positionService.closePosition(group.symbol);
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
            await this.positionService.closePosition(group.symbol);
          }
        }
      }
    } catch (err) {
      console.error('[AutoExitService] Run error:', err instanceof Error ? err.message : err);
    }
  }
}

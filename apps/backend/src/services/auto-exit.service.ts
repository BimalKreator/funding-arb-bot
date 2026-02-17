import type { ConfigService } from './config.service.js';
import type { ExchangeManager } from './exchange/index.js';
import type { PositionService } from './position.service.js';
import type { NotificationService } from './notification.service.js';
import type { FundingService } from './funding.service.js';
import {
  setMonitoringStatus,
  clearMonitoringStatus,
} from './position-monitoring-state.js';

const RUN_INTERVAL_MS = 1_000; // 1 second for fast take-profit / spread / funding reaction
const GRACE_PERIOD_MS = 60_000;
const FUNDING_FLIP_INTERVAL_MS = 1_000; // run funding-flip check every second
/** Only close when within this window of next funding; otherwise just set UI label "Monitoring" (trade stays OPEN). */
const CRITICAL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes before next funding
/** Estimated exit fee as fraction of notional (e.g. 0.0004 = 4 bps total for both legs). */
const ESTIMATED_EXIT_FEE_RATE = 0.0004;

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

/** Estimated exit fees (both legs) from notional. */
function estimatedExitFees(legs: { size: number; markPrice: number }[]): number {
  const notional = legs.reduce((s, l) => s + l.size * (l.markPrice || 0), 0);
  return notional * ESTIMATED_EXIT_FEE_RATE;
}

export class AutoExitService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private fundingFlipIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly positionService: PositionService,
    private readonly notificationService?: NotificationService,
    private readonly fundingService?: FundingService,
    private readonly exchangeManager?: ExchangeManager
  ) {}

  start(): void {
    if (this.intervalId != null) return;
    this.intervalId = setInterval(() => this.run(), RUN_INTERVAL_MS);
    this.fundingFlipIntervalId = setInterval(() => this.checkFundingFlips(), FUNDING_FLIP_INTERVAL_MS);
    console.log('[AutoExitService] Started (orphan/Spread/take-profit/funding check every 1s)');
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

      await this.checkTakeProfit();
      await this.checkNegativeSpreads();

      const groups = await this.positionService.getPositions();
      const now = Date.now();

      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;

        const hasBinance = legs.some((l) => l.exchange === 'binance');
        const hasBybit = legs.some((l) => l.exchange === 'bybit');

        if (hasBinance && !hasBybit) {
          const exchangeId = 'binance';
          const hasPending = this.exchangeManager ? await this.exchangeManager.hasOpenOrders(exchangeId, group.symbol) : false;
          if (hasPending) {
            console.log(`[Orphan Exit] Skipping because an exit order is already pending for ${group.symbol}.`);
            continue;
          }
          const binanceLeg = legs.find((l) => l.exchange === 'binance');
          const ts = binanceLeg?.timestamp;
          const ageMs = ts != null ? now - ts : null;
          const trigger = ts == null || (ageMs !== null && ageMs >= GRACE_PERIOD_MS);
          if (ts == null) {
            console.log(`[Orphan Exit] Orphan check: ${group.symbol} — Binance only, timestamp missing; triggering exit.`);
          } else if (!trigger) {
            console.log(`[Orphan Exit] Orphan check: ${group.symbol} — Binance only, age ${Math.round(ageMs! / 1000)}s < 60s, skipping.`);
            continue;
          } else {
            console.log(`[Orphan Exit] Orphan check: ${group.symbol} — Binance only, age ${Math.round(ageMs! / 1000)}s >= 60s, triggering exit.`);
          }
          const reason = 'Orphan Position detected > 60s on Binance';
          this.notificationService?.add(
            'WARNING',
            'Auto-Exit Triggered',
            `${group.symbol}: ${reason}`,
            { symbol: group.symbol, exchange: 'binance', reason }
          );
          const result = await this.positionService.closePosition(group.symbol, 'Auto-Exit: Orphan (Binance)');
          console.log(`[Orphan Exit] closePosition result for ${group.symbol}: closed=[${result.closed.join(', ')}], errors=[${result.errors.join(', ')}]`);
        } else if (hasBybit && !hasBinance) {
          const exchangeId = 'bybit';
          const hasPending = this.exchangeManager ? await this.exchangeManager.hasOpenOrders(exchangeId, group.symbol) : false;
          if (hasPending) {
            console.log(`[Orphan Exit] Skipping because an exit order is already pending for ${group.symbol}.`);
            continue;
          }
          const bybitLeg = legs.find((l) => l.exchange === 'bybit');
          const ts = bybitLeg?.timestamp;
          const ageMs = ts != null ? now - ts : null;
          const trigger = ts == null || (ageMs !== null && ageMs >= GRACE_PERIOD_MS);
          if (ts == null) {
            console.log(`[Orphan Exit] Orphan check: ${group.symbol} — Bybit only, timestamp missing; triggering exit.`);
          } else if (!trigger) {
            console.log(`[Orphan Exit] Orphan check: ${group.symbol} — Bybit only, age ${Math.round(ageMs! / 1000)}s < 60s, skipping.`);
            continue;
          } else {
            console.log(`[Orphan Exit] Orphan check: ${group.symbol} — Bybit only, age ${Math.round(ageMs! / 1000)}s >= 60s, triggering exit.`);
          }
          const reason = 'Orphan Position detected > 60s on Bybit';
          this.notificationService?.add(
            'WARNING',
            'Auto-Exit Triggered',
            `${group.symbol}: ${reason}`,
            { symbol: group.symbol, exchange: 'bybit', reason }
          );
          const result = await this.positionService.closePosition(group.symbol, 'Auto-Exit: Orphan (Bybit)');
          console.log(`[Orphan Exit] closePosition result for ${group.symbol}: closed=[${result.closed.join(', ')}], errors=[${result.errors.join(', ')}]`);
        }
      }
    } catch (err) {
      console.error('[AutoExitService] Run error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Early take profit: if position ROI >= minTakeProfitPercent, close immediately.
   */
  private async checkTakeProfit(): Promise<void> {
    const cfg = await this.configService.getConfig();
    const minRoi = Number.isFinite(cfg.minTakeProfitPercent) ? cfg.minTakeProfitPercent : 0;
    if (minRoi <= 0) return;

    try {
      const groups = await this.positionService.getPositions();
      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;
        const totalMargin = legs.reduce((s, l) => s + l.margin, 0);
        if (totalMargin <= 0) continue;
        const roi = (group.totalPnl / totalMargin) * 100;
        if (roi >= minRoi) {
          console.log(
            `[AutoExit] Take Profit Hit! ROI: ${roi.toFixed(2)}% >= Threshold: ${minRoi}%. Closing ${group.symbol}.`
          );
          this.notificationService?.add(
            'INFO',
            'Take Profit',
            `${group.symbol}: ROI ${roi.toFixed(2)}% reached target ${minRoi}%. Closing position.`,
            { symbol: group.symbol, roi, threshold: minRoi }
          );
          await this.positionService.closePosition(group.symbol, 'Auto-Exit: Take Profit');
        }
      }
    } catch (err) {
      console.error(
        '[AutoExitService] checkTakeProfit error:',
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Spread threshold: if net spread drops below screenerMinSpread:
   * - Time to funding > 10 min: if bad -> set UI label "⚠️ Monitoring: Low Spread" (do not close). If good -> clear label.
   * - Time to funding <= 10 min: if bad (currently) -> CLOSE. If good (recovered) -> do NOT close; clear label.
   */
  private async checkNegativeSpreads(): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.autoExitEnabled) return;
    if (!this.fundingService) return;
    const threshold = Number.isFinite(cfg.screenerMinSpread) ? cfg.screenerMinSpread : 0;

    try {
      const groups = await this.positionService.getPositions();
      const rates = this.fundingService.getLatestFundingRates();
      const snapshot = this.fundingService.getIntervalsSnapshot();
      const intervalsBySymbol = new Map(
        snapshot.intervals.map((i) => [
          i.symbol,
          i.binanceIntervalHours ?? i.bybitIntervalHours ?? 8,
        ])
      );

      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;
        const binanceLeg = legs.find((l) => l.exchange === 'binance');
        const bybitLeg = legs.find((l) => l.exchange === 'bybit');
        if (!binanceLeg || !bybitLeg) continue;

        const intervalHours = intervalsBySymbol.get(group.symbol) ?? 8;
        const msUntilFunding = getMsUntilNextFundingForInterval(intervalHours);

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

        // Net funding rate (decimal): positive = we receive money. Only care about Low Spread when funding is negative.
        const netFundingRate =
          binanceLeg.side === 'LONG' ? bybitRate - binanceRate : binanceRate - bybitRate;

        if (netFundingRate > 0) {
          clearMonitoringStatus(group.symbol);
          continue;
        }

        const isBadSpread = currentNetSpread < threshold;

        if (!isBadSpread) {
          clearMonitoringStatus(group.symbol);
          continue;
        }

        // Opportunistic Breakeven: exit early if recovered, else force at deadline.
        const exitFees = estimatedExitFees(group.legs);
        const netPnl = group.totalPnl - exitFees;

        if (netPnl >= 0) {
          console.log(
            `[AutoExit] Opportunistic Exit: Position recovered to breakeven/profit (Net PnL ${netPnl.toFixed(2)}). Exiting early. ${group.symbol}`
          );
          this.notificationService?.add(
            'INFO',
            'Opportunistic Exit',
            `${group.symbol}: Position recovered to breakeven/profit. Exiting early.`,
            { symbol: group.symbol, netPnl, reason: 'Low Spread recovered' }
          );
          await this.positionService.closePosition(group.symbol, 'Auto-Exit: Opportunistic (Low Spread recovered)');
          clearMonitoringStatus(group.symbol);
          continue;
        }

        if (msUntilFunding <= CRITICAL_WINDOW_MS && msUntilFunding >= 0) {
          console.log(
            `[AutoExit] Deadline Hit: Exiting to avoid funding fee (PNL didn't recover). ${group.symbol}`
          );
          this.notificationService?.add(
            'WARNING',
            'Spread Threshold Exit',
            `Auto-Exit: Spread ${currentNetSpread.toFixed(4)}% below threshold ${threshold}% for ${group.symbol} (within critical window).`,
            { symbol: group.symbol, currentNetSpread, threshold, reason: 'screenerMinSpread' }
          );
          await this.positionService.closePosition(group.symbol, 'Auto-Exit: Negative Spread');
          clearMonitoringStatus(group.symbol);
          continue;
        }

        setMonitoringStatus(group.symbol, '⏳ Waiting for Break-even (Low Spread)');
        console.log(
          `[AutoExit] Holding position. Waiting for PnL >= 0 or Deadline. Spread ${currentNetSpread.toFixed(4)}%; time to funding ${(msUntilFunding / 60000).toFixed(1)} min. ${group.symbol}`
        );
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
   * - Time to funding > 10 min: if bad -> set UI label "⚠️ Monitoring: Funding Flipped" (do not close). If good -> clear label.
   * - Time to funding <= 10 min: if bad (currently) -> CLOSE. If good (recovered) -> do NOT close; clear label.
   */
  async checkFundingFlips(): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.autoExitEnabled) return;
    if (!this.fundingService) return;
    try {
      const groups = await this.positionService.getPositions();
      const rates = this.fundingService.getLatestFundingRates();
      const snapshot = this.fundingService.getIntervalsSnapshot();
      const intervalsBySymbol = new Map(
        snapshot.intervals.map((i) => [
          i.symbol,
          resolveIntervalForTracking(i.binanceIntervalHours, i.bybitIntervalHours),
        ])
      );

      for (const group of groups) {
        const legs = group.legs;
        if (legs.length === 0) continue;
        const binanceLeg = legs.find((l) => l.exchange === 'binance');
        const bybitLeg = legs.find((l) => l.exchange === 'bybit');
        if (!binanceLeg || !bybitLeg) continue;

        const intervalHours = intervalsBySymbol.get(group.symbol) ?? 8;
        const msUntilFunding = getMsUntilNextFundingForInterval(intervalHours);

        const entry = rates.get(group.symbol);
        const binanceRateStr = entry?.binance?.fundingRate;
        const bybitRateStr = entry?.bybit?.fundingRate;
        if (binanceRateStr === undefined || bybitRateStr === undefined) continue;

        const binanceRate = parseFloat(binanceRateStr);
        const bybitRate = parseFloat(bybitRateStr);
        if (!Number.isFinite(binanceRate) || !Number.isFinite(bybitRate)) continue;

        const netSpread =
          binanceLeg.side === 'LONG' ? bybitRate - binanceRate : binanceRate - bybitRate;

        const isBadFlip = netSpread <= 0;

        if (!isBadFlip) {
          clearMonitoringStatus(group.symbol);
          continue;
        }

        // Opportunistic Breakeven: exit early if recovered, else force at deadline.
        const exitFees = estimatedExitFees(group.legs);
        const netPnl = group.totalPnl - exitFees;

        if (netPnl >= 0) {
          console.log(
            `[AutoExit] Opportunistic Exit: Position recovered to breakeven/profit (Net PnL ${netPnl.toFixed(2)}). Exiting early. ${group.symbol}`
          );
          this.notificationService?.add(
            'INFO',
            'Opportunistic Exit',
            `${group.symbol}: Position recovered to breakeven/profit. Exiting early.`,
            { symbol: group.symbol, netPnl, reason: 'Funding Flip recovered' }
          );
          await this.positionService.closePosition(group.symbol, 'Auto-Exit: Opportunistic (Funding Flip recovered)');
          clearMonitoringStatus(group.symbol);
          continue;
        }

        if (msUntilFunding <= CRITICAL_WINDOW_MS && msUntilFunding >= 0) {
          console.log(
            `[AutoExit] Deadline Hit: Exiting to avoid funding fee (PNL didn't recover). ${group.symbol}`
          );
          this.notificationService?.add(
            'WARNING',
            'Funding Flip Exit',
            `Exited ${group.symbol} due to negative spread before funding.`,
            { symbol: group.symbol, netSpread, reason: 'Sync Exit triggered' }
          );
          await this.positionService.closePosition(group.symbol, 'Auto-Exit: Funding Flip');
          clearMonitoringStatus(group.symbol);
          continue;
        }

        setMonitoringStatus(group.symbol, '⏳ Waiting for Break-even (Funding Flip)');
        console.log(
          `[AutoExit] Holding position. Waiting for PnL >= 0 or Deadline. Funding flipped (netSpread=${netSpread.toFixed(6)}); time to funding ${(msUntilFunding / 60000).toFixed(1)} min. ${group.symbol}`
        );
      }
    } catch (err) {
      console.error(
        '[AutoExitService] checkFundingFlips error:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

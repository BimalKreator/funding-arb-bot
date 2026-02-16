import type { FundingService } from './funding.service.js';
import type { PositionService } from './position.service.js';
import {
  getOrInitPositionFundingState,
  setPositionFundingState,
  takeAndRemovePositionFundingState,
  type SymbolFundingState,
} from './position-funding-store.js';

const RUN_INTERVAL_MS = 60 * 1000; // 1 minute

/** Ms from now until next funding for a given interval (1h, 2h, 4h, 8h). UTC slot alignment. */
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

/**
 * Simulates funding payments every minute: when now >= nextFundingTime,
 * applies payment per leg (Long/Short + rate sign logic) and advances nextFundingTime.
 */
export class FundingFeeService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly positionService: PositionService,
    private readonly fundingService: FundingService
  ) {}

  start(): void {
    if (this.intervalId != null) return;
    this.intervalId = setInterval(() => this.run(), RUN_INTERVAL_MS);
    console.log('[FundingFeeService] Started (1 min interval).');
  }

  stop(): void {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async run(): Promise<void> {
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

      const now = Date.now();

      for (const group of groups) {
        if (group.legs.length === 0) continue;
        const intervalHours = intervalsBySymbol.get(group.symbol) ?? 8;
        const nextFundingTimeMs =
          now + getMsUntilNextFundingForInterval(intervalHours);

        let state = await getOrInitPositionFundingState(
          group.symbol,
          intervalHours,
          nextFundingTimeMs
        );

        if (now < state.nextFundingTime) continue;

        const binanceLeg = group.legs.find((l) => l.exchange === 'binance');
        const bybitLeg = group.legs.find((l) => l.exchange === 'bybit');
        const entry = rates.get(group.symbol);
        const binanceRateStr = entry?.binance?.fundingRate;
        const bybitRateStr = entry?.bybit?.fundingRate;

        let updated = false;

        if (binanceLeg && binanceRateStr != null) {
          const fundingRate = parseFloat(binanceRateStr);
          if (Number.isFinite(fundingRate)) {
            const payment =
              binanceLeg.size * binanceLeg.markPrice * fundingRate;
            const delta =
              binanceLeg.side === 'LONG'
                ? fundingRate <= 0
                  ? Math.abs(payment)
                  : -payment
                : fundingRate >= 0
                  ? payment
                  : -Math.abs(payment);
            state = {
              ...state,
              binance: {
                accumulatedFunding: state.binance.accumulatedFunding + delta,
              },
            };
            updated = true;
          }
        }

        if (bybitLeg && bybitRateStr != null) {
          const fundingRate = parseFloat(bybitRateStr);
          if (Number.isFinite(fundingRate)) {
            const payment =
              bybitLeg.size * bybitLeg.markPrice * fundingRate;
            const delta =
              bybitLeg.side === 'LONG'
                ? fundingRate <= 0
                  ? Math.abs(payment)
                  : -payment
                : fundingRate >= 0
                  ? payment
                  : -Math.abs(payment);
            state = {
              ...state,
              bybit: {
                accumulatedFunding: state.bybit.accumulatedFunding + delta,
              },
            };
            updated = true;
          }
        }

        if (updated) {
          const intervalMs = state.fundingIntervalHours * 60 * 60 * 1000;
          state = {
            ...state,
            nextFundingTime: state.nextFundingTime + intervalMs,
          };
          await setPositionFundingState(group.symbol, state);
        }
      }
    } catch (err) {
      console.error(
        '[FundingFeeService] Run error:',
        err instanceof Error ? err.message : err
      );
    }
  }

}

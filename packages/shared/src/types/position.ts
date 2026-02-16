/**
 * Position and closed-trade types for funding fee tracking.
 * Supports variable funding intervals (1h, 2h, 4h, 8h) per token.
 */

/** Single leg of an active position (exchange-level). */
export interface ActivePositionLeg {
  exchange: 'binance' | 'bybit';
  side: 'LONG' | 'SHORT';
  size: number;
  markPrice: number;
  /** Running total of funding earned/paid for this leg (realized). */
  accumulatedFunding?: number;
}

/** Active position group (symbol-level) with funding metadata. */
export interface ActivePosition {
  symbol: string;
  legs: ActivePositionLeg[];
  /** Next funding settlement timestamp (ms). */
  nextFundingTime?: number;
  /** Funding interval in hours (e.g. 1, 4, 8). */
  fundingIntervalHours?: number;
  /** Sum of accumulatedFunding across legs (convenience). */
  accumulatedFunding?: number;
}

/** Closed trade record with final funding. */
export interface ClosedTrade {
  id: string;
  closedAt: string;
  symbol: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  roiPercent: number;
  margin: number;
  reason: string;
  exchangeFee: number;
  /** Total accumulated funding earned/paid over the life of the trade. */
  accumulatedFunding?: number;
  /** @deprecated Use accumulatedFunding when available. */
  totalFundingReceived?: number;
}

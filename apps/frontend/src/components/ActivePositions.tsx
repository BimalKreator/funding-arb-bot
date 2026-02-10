import { useEffect, useState, useCallback, Fragment } from 'react';
import { RefreshCw, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';

const POLL_MS = 3000;

export interface PositionLeg {
  exchange: 'binance' | 'bybit';
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  margin: number;
  unrealizedPnl: number;
  percentage: number;
  estFundingFee: number;
}

export interface PositionGroup {
  symbol: string;
  totalPnl: number;
  netFundingFee: number;
  legs: PositionLeg[];
  isHedged: boolean;
  isFundingFlipped: boolean;
  /** Next funding time (UTC) as timestamp in ms for countdown. */
  nextFundingTime?: number;
}

function symbolShort(symbol: string): string {
  return symbol.replace(/USDT$/i, '') || symbol;
}

const TEN_MIN_MS = 10 * 60 * 1000;

function formatCountdown(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function FundingCountdown({ nextFundingTime }: { nextFundingTime?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (nextFundingTime == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextFundingTime]);
  if (nextFundingTime == null) return null;
  const timeLeft = nextFundingTime - now;
  if (timeLeft <= 0) return <span className="rounded bg-zinc-600/50 px-1.5 py-0.5 text-xs text-zinc-400">—</span>;
  const isWarning = timeLeft < TEN_MIN_MS;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-mono font-medium ${
        isWarning ? 'bg-red-500/20 text-red-500' : 'bg-white/10 text-zinc-300'
      }`}
      title="Time until next funding"
    >
      {formatCountdown(timeLeft)}
    </span>
  );
}

function ColoredNumber({ value, decimals = 2 }: { value: number; decimals?: number }) {
  const isPositive = value > 0;
  const isNegative = value < 0;
  return (
    <span
      className={
        isPositive ? 'text-[#22c55e]' : isNegative ? 'text-[#ef4444]' : 'text-zinc-400'
      }
    >
      {value.toFixed(decimals)}
    </span>
  );
}

export function ActivePositions() {
  const [data, setData] = useState<PositionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set());

  const fetchPositions = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/positions`);
      if (!res.ok) throw new Error(res.statusText);
      const json: PositionGroup[] = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch positions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchPositions();
    const id = setInterval(fetchPositions, POLL_MS);
    return () => clearInterval(id);
  }, [fetchPositions]);

  const toggleExpand = (symbol: string) => {
    setExpandedSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const totalPnl = data.reduce((s, g) => s + g.totalPnl, 0);

  const handleClose = async (symbol: string) => {
    setClosingSymbol(symbol);
    try {
      const res = await apiFetch(`${API_BASE}/positions/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(result?.error ?? `Error ${res.status}`);
        return;
      }
      if (result.errors?.length) {
        alert(result.errors.join('; '));
      }
      await fetchPositions();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setClosingSymbol(null);
    }
  };

  return (
    <div className="font-sans">
      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-6">
            <h1 className="text-xl font-semibold text-white sm:text-2xl">Active Positions</h1>
            {data.length > 0 && (
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-zinc-400">Total P&L:</span>
                <span
                  className={`text-2xl font-bold sm:text-3xl ${
                    totalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'
                  }`}
                >
                  {totalPnl >= 0 ? '+' : ''}
                  {totalPnl.toFixed(2)}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              fetchPositions();
            }}
            className="flex items-center gap-2 rounded-lg bg-electric px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-xl backdrop-blur-sm">
          {error && (
            <div className="border-b border-white/10 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-zinc-400">
                  <th className="w-10 px-2 py-3" aria-label="Expand" />
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium">Total Size</th>
                  <th className="px-4 py-3 font-medium">Total Net PnL</th>
                  <th className="px-4 py-3 font-medium">Est. Funding Fee</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {loading && data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                      Loading…
                    </td>
                  </tr>
                ) : data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                      No active positions.
                    </td>
                  </tr>
                ) : (
                  data.map((group) => {
                    const isExpanded = expandedSymbols.has(group.symbol);
                    return (
                      <Fragment key={group.symbol}>
                        <tr
                          key={group.symbol}
                          className="border-b border-white/5 transition-colors hover:bg-white/5"
                        >
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              onClick={() => toggleExpand(group.symbol)}
                              className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
                              aria-label={isExpanded ? 'Collapse' : 'Show details'}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          </td>
                          <td className="px-4 py-3 font-medium text-white">
                            <div className="flex flex-wrap items-center gap-2">
                              <span>{symbolShort(group.symbol)}</span>
                              <span
                                className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                  group.isHedged ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                }`}
                              >
                                {group.isHedged ? 'Hedged' : 'Unhedged'}
                              </span>
                              <FundingCountdown nextFundingTime={group.nextFundingTime} />
                              {group.isFundingFlipped && (
                                <span className="animate-pulse rounded bg-red-500/30 px-1.5 py-0.5 text-xs font-medium text-red-400">
                                  Funding Flipped
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-zinc-300">
                            {group.legs.length > 0
                              ? group.legs[0].size.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 6,
                                })
                              : '—'}
                          </td>
                          <td className="px-4 py-3 font-semibold">
                            <ColoredNumber value={group.totalPnl} />
                          </td>
                          <td className="px-4 py-3">
                            <ColoredNumber value={group.netFundingFee} />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleClose(group.symbol)}
                              disabled={closingSymbol === group.symbol}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              {closingSymbol === group.symbol ? 'Closing…' : 'Close Group'}
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${group.symbol}-details`} className="border-b border-white/5 bg-black/20">
                            <td colSpan={6} className="p-0">
                              <div className="border-t border-white/5 px-4 py-3">
                                <table className="w-full text-left text-xs">
                                  <thead>
                                    <tr className="text-zinc-500">
                                      <th className="pb-2 pr-4 font-medium">Exchange</th>
                                      <th className="pb-2 pr-4 font-medium">Side</th>
                                      <th className="pb-2 pr-4 font-medium">Size</th>
                                      <th className="pb-2 pr-4 font-medium">Entry Price</th>
                                      <th className="pb-2 pr-4 font-medium">Mark Price</th>
                                      <th className="pb-2 pr-4 font-medium">Liq. Price</th>
                                      <th className="pb-2 pr-4 font-medium">Margin (USDT)</th>
                                      <th className="pb-2 pr-4 font-medium">PnL (USDT)</th>
                                      <th className="pb-2 pr-4 font-medium">ROI %</th>
                                      <th className="pb-2 font-medium">Est. Funding Fee</th>
                                    </tr>
                                  </thead>
                                  <tbody className="text-zinc-300">
                                    {group.legs.map((leg) => (
                                      <tr key={`${group.symbol}-${leg.exchange}`} className="border-t border-white/5">
                                        <td className="py-2 pr-4 capitalize">{leg.exchange}</td>
                                        <td className="py-2 pr-4">{leg.side}</td>
                                        <td className="py-2 pr-4">
                                          {leg.size.toLocaleString(undefined, {
                                            minimumFractionDigits: 2,
                                            maximumFractionDigits: 6,
                                          })}
                                        </td>
                                        <td className="py-2 pr-4">{leg.entryPrice.toFixed(2)}</td>
                                        <td className="py-2 pr-4">{leg.markPrice.toFixed(2)}</td>
                                        <td className="py-2 pr-4">
                                          {leg.liquidationPrice > 0 ? leg.liquidationPrice.toFixed(2) : '—'}
                                        </td>
                                        <td className="py-2 pr-4">{leg.margin.toFixed(2)}</td>
                                        <td className="py-2 pr-4">
                                          <ColoredNumber value={leg.unrealizedPnl} />
                                        </td>
                                        <td className="py-2 pr-4">
                                          <ColoredNumber value={leg.percentage} />
                                        </td>
                                        <td className="py-2">
                                          <ColoredNumber value={leg.estFundingFee} />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-zinc-500">
          Positions update every 3s. Expand a row to see leg details. PnL and funding fee use green/red.
        </p>
      </div>
    </div>
  );
}

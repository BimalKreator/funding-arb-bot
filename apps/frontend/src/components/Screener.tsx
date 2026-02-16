import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, TrendingUp, Circle } from 'lucide-react';
import type { ScreenerResultEntry, ScreenerResponse } from '../types/screener';
import { API_BASE } from '../config';
import { apiFetch } from '../api';
import { TradeModal } from './TradeModal';

const POLL_MS = 3000;
const PAGE_SIZE = 10;

export interface ScreenerProps {
  threshold?: number;
}

export interface BotConfig {
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  manualEntryEnabled: boolean;
  capitalPercent: number;
  autoLeverage: number;
  screenerMinSpread: number;
  allowedFundingIntervals?: number[];
  maxActiveTrades?: number;
}

/** Rates and spreads from API are already in percentage (e.g. 0.01 = 0.01%) */
function formatPct(rate: number): string {
  return `${rate.toFixed(4)}%`;
}

function RateCell({
  rate,
  isFast,
}: {
  rate: number;
  isFast?: boolean;
}) {
  const isPositive = rate > 0;
  const isNegative = rate < 0;
  return (
    <span
      className={
        isFast
          ? 'font-bold text-[#22c55e]'
          : isPositive
            ? 'text-[#22c55e]'
            : isNegative
              ? 'text-[#ef4444]'
              : 'text-zinc-400'
      }
    >
      {formatPct(rate)}
    </span>
  );
}

function formatStrategy(entry: ScreenerResultEntry): string {
  const bin = entry.binanceAction === 'LONG' ? 'Long' : 'Short';
  const byb = entry.bybitAction === 'LONG' ? 'Long' : 'Short';
  return `${bin} Bin / ${byb} Byb`;
}

function symbolShort(symbol: string): string {
  return symbol.replace(/USDT$/i, '') || symbol;
}

/** Format ms until timestamp as "Xh Ym Zs" or "Avail in 14m 20s". */
function formatAvailIn(untilMs: number, nowMs: number): string {
  const rem = Math.max(0, untilMs - nowMs);
  const s = Math.floor((rem / 1000) % 60);
  const m = Math.floor((rem / 60_000) % 60);
  const h = Math.floor(rem / 3_600_000);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return 'Avail in ' + parts.join(' ');
}

const INTERVAL_OPTIONS = [1, 2, 4, 8] as const;

type ScreenerTab = 'standard' | 'mismatched';

export const Screener: React.FC<ScreenerProps> = ({ threshold = 0 }) => {
  const [screenerData, setScreenerData] = useState<ScreenerResponse>({ standard: [], mismatched: [] });
  const [activeTab, setActiveTab] = useState<ScreenerTab>('standard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [tradeRow, setTradeRow] = useState<ScreenerResultEntry | null>(null);
  const [activePositionSymbols, setActivePositionSymbols] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [allowedIntervals, setAllowedIntervals] = useState<Set<number>>(new Set(INTERVAL_OPTIONS));
  const [searchQuery, setSearchQuery] = useState('');
  const [banningSymbol, setBanningSymbol] = useState<string | null>(null);

  const minSpread = config?.screenerMinSpread ?? threshold;

  // Sync allowed intervals from config on load / poll
  useEffect(() => {
    if (config?.allowedFundingIntervals === undefined || config?.allowedFundingIntervals === null) {
      setAllowedIntervals(new Set(INTERVAL_OPTIONS));
      return;
    }
    setAllowedIntervals(new Set(config.allowedFundingIntervals));
  }, [config?.allowedFundingIntervals]);

  // Update banned countdown every second
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/positions`);
      if (!res.ok) return;
      const json: Array<{ symbol: string }> = await res.json();
      setActivePositionSymbols(new Set(json.map((p) => p.symbol)));
    } catch {
      // ignore
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/config`);
      if (!res.ok) return;
      const json: BotConfig = await res.json();
      setConfig(json);
    } catch {
      // ignore
    }
  }, []);

  const fetchScreener = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/screener?threshold=${encodeURIComponent(String(minSpread))}`);
      if (!res.ok) throw new Error(res.statusText);
      const json: ScreenerResponse = await res.json();
      setScreenerData({
        standard: json.standard ?? [],
        mismatched: json.mismatched ?? [],
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [minSpread]);

  useEffect(() => {
    setLoading(true);
    fetchScreener();
    const id = setInterval(fetchScreener, POLL_MS);
    return () => clearInterval(id);
  }, [fetchScreener]);

  useEffect(() => {
    fetchPositions();
    fetchConfig();
    const id = setInterval(() => {
      fetchPositions();
      fetchConfig();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchPositions, fetchConfig]);

  const searchLower = searchQuery.trim().toLowerCase();
  const data = activeTab === 'standard' ? screenerData.standard : screenerData.mismatched;
  const filteredData = data.filter(
    (row) =>
      allowedIntervals.has(row.interval) &&
      (searchLower === '' || row.symbol.toLowerCase().includes(searchLower))
  );
  const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const slice = filteredData.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const nextSymbol = filteredData.find((row) => !activePositionSymbols.has(row.symbol) && row.netSpread > 0)?.symbol ?? null;

  const switchTab = useCallback((tab: ScreenerTab) => {
    setActiveTab(tab);
    setPage(0);
  }, []);
  const manualEntryEnabled = config?.manualEntryEnabled ?? true;

  const setIntervalAllowed = useCallback(async (interval: number, enabled: boolean) => {
    const next = new Set(allowedIntervals);
    if (enabled) next.add(interval);
    else next.delete(interval);
    setAllowedIntervals(next);
    const arr = Array.from(next).sort((a, b) => a - b);
    try {
      const res = await apiFetch(`${API_BASE}/settings/intervals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedFundingIntervals: arr }),
      });
      if (res.ok) {
        const json: BotConfig = await res.json();
        setConfig((c) => (c ? { ...c, allowedFundingIntervals: json.allowedFundingIntervals } : null));
      }
    } catch {
      setAllowedIntervals(allowedIntervals);
    }
  }, [allowedIntervals]);

  const handleBan = useCallback(
    async (symbol: string) => {
      setBanningSymbol(symbol);
      try {
        const res = await apiFetch(`${API_BASE}/instruments/ban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol }),
        });
        if (res.ok) fetchScreener();
      } finally {
        setBanningSymbol(null);
      }
    },
    [fetchScreener]
  );

  return (
    <div className="font-sans">
      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white sm:text-2xl">Funding Arbitrage Screener</h1>
            <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-400 backdrop-blur-sm">
              <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
              Live
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm text-zinc-400">
              Min spread: {typeof minSpread === 'number' && Number.isFinite(minSpread) ? minSpread.toFixed(2) : minSpread}% (set in Settings)
            </span>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                fetchScreener();
              }}
              className="flex items-center gap-2 rounded-lg bg-electric px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
          <input
            type="text"
            placeholder="Search Token (e.g. BTC)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-52 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-electric focus:outline-none focus:ring-1 focus:ring-electric"
          />
          <span className="text-sm font-medium text-zinc-400">Funding intervals (trade):</span>
          {INTERVAL_OPTIONS.map((h) => {
            const enabled = allowedIntervals.has(h);
            return (
              <button
                key={h}
                type="button"
                onClick={() => setIntervalAllowed(h, !enabled)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  enabled
                    ? 'border-electric bg-electric/20 text-white'
                    : 'border-white/20 bg-white/5 text-zinc-500 hover:bg-white/10'
                }`}
              >
                {h}h
              </button>
            );
          })}
          <span className="text-xs text-zinc-500">Uncheck to hide from table and disable bot trading.</span>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-xl backdrop-blur-sm">
          {error && (
            <div className="border-b border-white/10 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex border-b border-white/10">
            <button
              type="button"
              onClick={() => switchTab('standard')}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'standard'
                  ? 'border-b-2 border-electric text-white'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-300'
              }`}
            >
              Standard (Same Interval)
            </button>
            <button
              type="button"
              onClick={() => switchTab('mismatched')}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'mismatched'
                  ? 'border-b-2 border-electric text-white'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-300'
              }`}
            >
              High Frequency (Mismatched)
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-zinc-400">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium">Binance</th>
                  <th className="px-4 py-3 font-medium">Bybit</th>
                  <th className="px-4 py-3 font-medium">Gross Spread</th>
                  <th className="px-4 py-3 font-medium">Net Spread</th>
                  <th className="px-4 py-3 font-medium">Strategy</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {loading && data.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                      Loading…
                    </td>
                  </tr>
                ) : slice.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                      No results. Enable interval toggles above or wait for data.
                    </td>
                  </tr>
                ) : (
                  slice.map((row) => {
                    const isActive = activePositionSymbols.has(row.symbol);
                    const isNext = nextSymbol === row.symbol;
                    const isBlacklisted = row.isBlacklisted === true && row.blacklistedUntil != null;
                    const availIn = isBlacklisted && row.blacklistedUntil ? formatAvailIn(row.blacklistedUntil, now) : null;
                    const canTrade = manualEntryEnabled && !isBlacklisted;
                    return (
                    <tr
                      key={row.symbol}
                      className={`border-b border-white/5 transition-colors hover:bg-white/5 ${
                        isActive ? 'bg-green-500/10' : isBlacklisted ? 'bg-red-500/5' : ''
                      }`}
                    >
                      <td className="px-4 py-3 font-medium text-white">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{symbolShort(row.symbol)}</span>
                          {isActive && (
                            <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-xs font-medium text-green-400">
                              Active
                            </span>
                          )}
                          {isNext && (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-400">
                              Next
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RateCell
                          rate={row.binanceRate}
                          isFast={activeTab === 'mismatched' && row.fastExchange === 'binance'}
                        />
                        {' '}
                        ({row.binanceIntervalHours != null ? row.binanceIntervalHours : row.interval}h)
                      </td>
                      <td className="px-4 py-3">
                        <RateCell
                          rate={row.bybitRate}
                          isFast={activeTab === 'mismatched' && row.fastExchange === 'bybit'}
                        />
                        {' '}
                        ({row.bybitIntervalHours != null ? row.bybitIntervalHours : row.interval}h)
                      </td>
                      <td className="px-4 py-3">{formatPct(row.grossSpread)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-semibold ${
                            row.netSpread < 0 ? 'text-red-500' : 'text-green-500'
                          }`}
                        >
                          {formatPct(row.netSpread)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-300">{formatStrategy(row)}</td>
                      <td className="px-4 py-3">
                        {isBlacklisted ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex w-fit items-center gap-1 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-medium text-red-400">
                              🚫 Banned
                            </span>
                            {availIn && (
                              <span className="text-xs text-zinc-500">{availIn}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleBan(row.symbol)}
                            disabled={banningSymbol === row.symbol}
                            title="Ban token (hide from screener and disable trading)"
                            className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                          >
                            🚫 Ban
                          </button>
                          <button
                            type="button"
                            onClick={() => canTrade && setTradeRow(row)}
                            disabled={!canTrade}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-electric px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <TrendingUp className="h-3.5 w-3.5" />
                            Trade
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {filteredData.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
              <span className="text-sm text-zinc-500">
                {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filteredData.length)}{' '}
                of {filteredData.length}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white backdrop-blur-sm disabled:opacity-50 hover:enabled:bg-white/10"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={currentPage >= totalPages - 1}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white backdrop-blur-sm disabled:opacity-50 hover:enabled:bg-white/10"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-zinc-500">
          {activeTab === 'standard'
            ? 'Table updates every 3s. Standard: same funding interval on both exchanges.'
            : 'Table updates every 3s. High Frequency: mismatched intervals; fast exchange must be receiving.'}
        </p>

        {tradeRow && (
          <TradeModal
            onClose={() => setTradeRow(null)}
            symbol={tradeRow.symbol}
            binancePrice={tradeRow.binanceMarkPrice}
            bybitPrice={tradeRow.bybitMarkPrice}
            strategy={formatStrategy(tradeRow)}
            binanceAction={tradeRow.binanceAction}
            bybitAction={tradeRow.bybitAction}
            fundingIntervalHours={tradeRow.interval}
          />
        )}
      </div>
    </div>
  );
}

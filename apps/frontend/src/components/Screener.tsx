import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, TrendingUp, Circle } from 'lucide-react';
import type { ScreenerResultEntry } from '../types/screener';
import { API_BASE } from '../config';
import { apiFetch } from '../api';
import { TradeModal } from './TradeModal';

const POLL_MS = 3000;
const PAGE_SIZE = 10;

export interface BotConfig {
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  manualEntryEnabled: boolean;
  capitalPercent: number;
  autoLeverage: number;
  screenerMinSpread: number;
}

/** Rates and spreads from API are already in percentage (e.g. 0.01 = 0.01%) */
function formatPct(rate: number): string {
  return `${rate.toFixed(4)}%`;
}

function RateCell({ rate }: { rate: number }) {
  const isPositive = rate > 0;
  const isNegative = rate < 0;
  return (
    <span
      className={
        isPositive
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

export function Screener() {
  const [data, setData] = useState<ScreenerResultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [tradeRow, setTradeRow] = useState<ScreenerResultEntry | null>(null);
  const [activePositionSymbols, setActivePositionSymbols] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<BotConfig | null>(null);

  const screenerMinSpread = config?.screenerMinSpread ?? 0;

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
      const res = await apiFetch(`${API_BASE}/screener?threshold=${screenerMinSpread}`);
      if (!res.ok) throw new Error(res.statusText);
      const json: ScreenerResultEntry[] = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [screenerMinSpread]);

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

  const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const slice = data.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const nextSymbol = data.find((row) => !activePositionSymbols.has(row.symbol) && row.netSpread > 0)?.symbol ?? null;
  const manualEntryEnabled = config?.manualEntryEnabled ?? true;

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
              Min spread: {screenerMinSpread}% (set in Settings)
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

        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-xl backdrop-blur-sm">
          {error && (
            <div className="border-b border-white/10 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

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
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {loading && data.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                      Loading…
                    </td>
                  </tr>
                ) : slice.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                      No results. Adjust threshold or wait for data.
                    </td>
                  </tr>
                ) : (
                  slice.map((row) => {
                    const isActive = activePositionSymbols.has(row.symbol);
                    const isNext = nextSymbol === row.symbol;
                    return (
                    <tr
                      key={row.symbol}
                      className={`border-b border-white/5 transition-colors hover:bg-white/5 ${
                        isActive ? 'bg-green-500/10' : ''
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
                        <RateCell rate={row.binanceRate} /> ({row.interval}h)
                      </td>
                      <td className="px-4 py-3">
                        <RateCell rate={row.bybitRate} /> ({row.interval}h)
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
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => manualEntryEnabled && setTradeRow(row)}
                          disabled={!manualEntryEnabled}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-electric px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <TrendingUp className="h-3.5 w-3.5" />
                          Trade
                        </button>
                      </td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {data.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
              <span className="text-sm text-zinc-500">
                {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, data.length)}{' '}
                of {data.length}
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
          Table updates every 3s. Only symbols with matching funding intervals are shown.
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
          />
        )}
      </div>
    </div>
  );
}

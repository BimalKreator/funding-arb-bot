import { useEffect, useState, useCallback } from 'react';
import { Info } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';

export interface ClosedTradeRecord {
  id: string;
  closedAt: string;
  symbol: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  exitPrice: number;
  pnl: number;
  roiPercent: number;
  margin: number;
  reason: string;
  exchangeFee: number;
  totalFundingReceived: number;
}

function symbolShort(symbol: string): string {
  return symbol.replace(/USDT$/i, '') || symbol;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function PnlCell({ value, roiPercent }: { value: number; roiPercent: number }) {
  const isPositive = value >= 0;
  const isNegative = value < 0;
  return (
    <span
      className={
        isPositive ? 'font-semibold text-green-500' : isNegative ? 'font-semibold text-red-500' : 'text-zinc-400'
      }
    >
      {value.toFixed(2)} ({roiPercent >= 0 ? '+' : ''}{roiPercent.toFixed(2)}%)
    </span>
  );
}

export function ClosedTrades() {
  const [list, setList] = useState<ClosedTradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/positions/history`);
      if (!res.ok) throw new Error(res.statusText);
      const json: ClosedTradeRecord[] = await res.json();
      setList(Array.isArray(json) ? json : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load closed trades');
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return (
    <div className="font-sans">
      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
        <h2 className="mb-4 text-lg font-semibold text-white">Closed Trades History</h2>

        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-xl backdrop-blur-sm">
          {error && (
            <div className="border-b border-white/10 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-zinc-400">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium">Size</th>
                  <th className="px-4 py-3 font-medium">Entry Price</th>
                  <th className="px-4 py-3 font-medium">Exit Price</th>
                  <th className="px-4 py-3 font-medium">Margin</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium">Exchange Fee</th>
                  <th className="px-4 py-3 font-medium">Funding Received</th>
                  <th className="px-4 py-3 font-medium">PNL (ROI %)</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">
                      Loading…
                    </td>
                  </tr>
                ) : list.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">
                      No closed trades yet.
                    </td>
                  </tr>
                ) : (
                  list.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-white/5 transition-colors hover:bg-white/5"
                    >
                      <td className="px-4 py-3 font-medium text-white">
                        {symbolShort(row.symbol)}
                      </td>
                      <td className="px-4 py-3">
                        {row.size.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 6,
                        })}
                      </td>
                      <td className="px-4 py-3">{row.entryPrice.toFixed(4)}</td>
                      <td className="px-4 py-3">{row.exitPrice.toFixed(4)}</td>
                      <td className="px-4 py-3">
                        {row.margin.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex items-center gap-1"
                          title={row.reason}
                        >
                          <span className="max-w-[140px] truncate" title={row.reason}>
                            {row.reason}
                          </span>
                          <span title={row.reason}>
                            <Info
                              className="h-3.5 w-3.5 shrink-0 text-zinc-500"
                              aria-label="Details"
                            />
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3">{row.exchangeFee.toFixed(2)}</td>
                      <td className="px-4 py-3 text-zinc-300">
                        {row.totalFundingReceived.toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <PnlCell value={row.pnl} roiPercent={row.roiPercent} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="border-t border-white/10 px-4 py-3 text-xs text-zinc-500">
            Last 50 closed trades. Closed at: {list[0] ? formatDate(list[0].closedAt) : '—'}
          </p>
        </div>
      </div>
    </div>
  );
}

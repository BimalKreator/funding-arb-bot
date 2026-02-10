import { useEffect, useState, useCallback } from 'react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';

const POLL_MS = 5000; // 5s for realtime balance and growth

export interface StatsData {
  currentBalance: number;
  openingBalance: number;
  totalDeposits: number;
  totalWithdrawals: number;
  growthAmt: number;
  growthPercent: number;
  dailyAvgRoi: number;
  monthlyAvgRoi: number;
  breakdown: {
    binance: { bal: number; margin: number; free: number };
    bybit: { bal: number; margin: number; free: number };
  };
}

export function DashboardStats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/stats`);
      if (!res.ok) throw new Error(res.statusText);
      const json: StatsData = await res.json();
      setStats(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStats]);

  if (loading && !stats) {
    return (
      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
        <div className="text-sm text-zinc-500">Loading stats…</div>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
        <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      </div>
    );
  }

  const s = stats!;
  const totalBal = s.breakdown.binance.bal + s.breakdown.bybit.bal;
  const totalMargin = s.breakdown.binance.margin + s.breakdown.bybit.margin;
  const totalFree = s.breakdown.binance.free + s.breakdown.bybit.free;
  const currentBalance = s.currentBalance;
  const openingBalance = s.openingBalance;
  const OPENING_BALANCE_BASE = 260;
  const todayGrowthPercent =
    openingBalance > 0
      ? ((currentBalance - openingBalance) / openingBalance) * 100
      : 0;
  const totalGrowthPercent =
    OPENING_BALANCE_BASE > 0
      ? ((currentBalance - OPENING_BALANCE_BASE) / OPENING_BALANCE_BASE) * 100
      : 0;
  const growthPositive = todayGrowthPercent >= 0;
  const totalGrowthPositive = totalGrowthPercent >= 0;

  return (
    <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur-sm">
          <div className="text-sm text-zinc-400">Total Balance</div>
          <div className="mt-1 text-2xl font-bold text-white sm:text-3xl">
            ${s.currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            Today&apos;s Opening: ${s.openingBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-0.5 text-xs text-[#22c55e]">
            Today&apos;s Deposits: +${s.totalDeposits.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-0.5 text-xs text-[#ef4444]">
            Today&apos;s Withdrawals: -${s.totalWithdrawals.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur-sm">
          <div className="text-sm text-zinc-400">Growth & ROI</div>
          <div className="mt-1 text-xs text-zinc-500">Today&apos;s Growth %</div>
          <div
            className={`text-2xl font-bold sm:text-3xl ${
              growthPositive ? 'text-[#22c55e]' : 'text-[#ef4444]'
            }`}
          >
            {growthPositive ? '+' : ''}
            {todayGrowthPercent.toFixed(2)}%
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            Today&apos;s Growth Amt: {s.growthAmt >= 0 ? '+' : ''}$
            {s.growthAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="text-xs text-zinc-500">Total Growth % (vs 260)</div>
            <div
              className={`text-lg font-semibold ${
                totalGrowthPositive ? 'text-[#22c55e]' : 'text-[#ef4444]'
              }`}
            >
              {totalGrowthPositive ? '+' : ''}
              {totalGrowthPercent.toFixed(2)}%
            </div>
          </div>
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="text-xs text-zinc-400">Daily Avg ROI: {s.dailyAvgRoi.toFixed(2)}%</div>
            <div className="mt-0.5 text-xs text-zinc-400">Monthly Avg ROI: {s.monthlyAvgRoi.toFixed(2)}%</div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur-sm">
          <div className="mb-3 text-sm text-zinc-400">Exchange Breakdown</div>
          <div className="overflow-hidden rounded-lg border border-white/5 text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 bg-white/5 text-zinc-400">
                  <th className="px-3 py-2 text-left font-medium">Exchange</th>
                  <th className="px-3 py-2 text-right font-medium">Bal</th>
                  <th className="px-3 py-2 text-right font-medium">Margin</th>
                  <th className="px-3 py-2 text-right font-medium">Available</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                <tr className="border-b border-white/5">
                  <td className="px-3 py-2">Binance</td>
                  <td className="px-3 py-2 text-right">{s.breakdown.binance.bal.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{s.breakdown.binance.margin.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{s.breakdown.binance.free.toFixed(2)}</td>
                </tr>
                <tr className="border-b border-white/5">
                  <td className="px-3 py-2">Bybit</td>
                  <td className="px-3 py-2 text-right">{s.breakdown.bybit.bal.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{s.breakdown.bybit.margin.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{s.breakdown.bybit.free.toFixed(2)}</td>
                </tr>
                <tr className="bg-white/5 font-medium text-white">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right">{totalBal.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{totalMargin.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{totalFree.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

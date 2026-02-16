import { useEffect, useState, useCallback } from 'react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';

export function BannedTokens() {
  const [list, setList] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unbanning, setUnbanning] = useState<string | null>(null);

  const fetchBanned = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/instruments/banned`);
      if (!res.ok) return;
      const json: string[] = await res.json();
      setList(Array.isArray(json) ? json : []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBanned();
    const id = setInterval(fetchBanned, 5000);
    return () => clearInterval(id);
  }, [fetchBanned]);

  const handleUnban = useCallback(
    async (symbol: string) => {
      setUnbanning(symbol);
      try {
        const res = await apiFetch(`${API_BASE}/instruments/unban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol }),
        });
        if (res.ok) {
          setList((prev) => prev.filter((s) => s.toUpperCase() !== symbol.toUpperCase()));
        }
      } finally {
        setUnbanning(null);
      }
    },
    []
  );

  if (loading && list.length === 0) {
    return (
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6">
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-500">
          Loading banned tokens…
        </div>
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6">
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
          <p className="text-sm font-medium text-zinc-400">Banned tokens (manual)</p>
          <p className="mt-1 text-xs text-zinc-500">No tokens banned. Use “Ban” in the Screener to hide a token from the table and disable trading.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6">
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
        <p className="mb-3 text-sm font-medium text-zinc-400">Banned tokens (manual)</p>
        <div className="flex flex-wrap gap-2">
          {list.map((symbol) => (
            <span
              key={symbol}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-sm text-zinc-300"
            >
              <span>{symbol.replace(/USDT$/i, '') || symbol}</span>
              <button
                type="button"
                onClick={() => handleUnban(symbol)}
                disabled={unbanning === symbol}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-green-400 hover:bg-green-500/20 disabled:opacity-50"
              >
                Unban
              </button>
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">Unban to show the token in the Screener again and allow trading.</p>
      </div>
    </div>
  );
}

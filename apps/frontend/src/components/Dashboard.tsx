import { useEffect, useState } from 'react';
import type { HealthResponse } from '@funding-arb-bot/shared';

const API_BASE = '/api';

export function Dashboard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: HealthResponse) => {
        setHealth(data);
        setError(null);
      })
      .catch((err) => {
        setError(err.message || 'Failed to reach API');
        setHealth(null);
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-medium text-zinc-100 sm:text-2xl">Dashboard</h2>
        <p className="mt-1 text-sm text-zinc-500">
          WebSocket and trading logic will be added later.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:p-6">
        <h3 className="text-sm font-medium text-zinc-400">API Status</h3>
        {error && (
          <p className="mt-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        {health && (
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-zinc-500">Status</dt>
              <dd className="text-sm font-medium text-emerald-400">{health.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Version</dt>
              <dd className="text-sm font-medium text-zinc-300">{health.version}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-zinc-500">Timestamp</dt>
              <dd className="text-sm text-zinc-400">{health.timestamp}</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:p-6">
        <h3 className="text-sm font-medium text-zinc-400">WebSocket</h3>
        <p className="mt-2 text-sm text-zinc-500">
          WebSocket support is planned. Connect endpoint will be available at <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">/ws</code>.
        </p>
      </div>
    </div>
  );
}

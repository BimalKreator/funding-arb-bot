import { useEffect, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';

export interface BotConfig {
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  manualEntryEnabled: boolean;
  capitalPercent: number;
  autoLeverage: number;
  screenerMinSpread: number;
}

const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10];
const CAPITAL_MIN = 0.05;
const CAPITAL_MAX = 0.5;

export function SettingsPanel() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/config`);
      if (!res.ok) throw new Error(res.statusText);
      const json: BotConfig = await res.json();
      setConfig(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateBackend = useCallback(async (partial: Partial<BotConfig>) => {
    setSaving('updating');
    try {
      const res = await apiFetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? res.statusText);
      }
      const updated: BotConfig = await res.json();
      setConfig(updated);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setSaving(null);
    }
  }, []);

  const toggle = (key: keyof BotConfig, value: boolean) => {
    if (!config) return;
    const next = { ...config, [key]: value };
    setConfig(next);
    updateBackend({ [key]: value });
  };

  const setCapital = (value: number) => {
    const clamped = Math.max(CAPITAL_MIN, Math.min(CAPITAL_MAX, value));
    if (!config) return;
    setConfig((c) => (c ? { ...c, capitalPercent: clamped } : null));
  };

  const applyCapitalToBackend = useCallback(() => {
    if (config) updateBackend({ capitalPercent: config.capitalPercent });
  }, [config, updateBackend]);

  const setLeverage = (value: number) => {
    if (!config) return;
    setConfig((c) => (c ? { ...c, autoLeverage: value } : null));
    updateBackend({ autoLeverage: value });
  };

  const setScreenerMinSpread = (value: number) => {
    if (!config) return;
    const clamped = Math.max(-100, Math.min(100, Number.isFinite(value) ? value : 0));
    setConfig((c) => (c ? { ...c, screenerMinSpread: clamped } : null));
  };

  const applyScreenerMinSpreadToBackend = useCallback(() => {
    if (config) updateBackend({ screenerMinSpread: config.screenerMinSpread });
  }, [config, updateBackend]);

  if (loading && !config) {
    return (
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6">
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-zinc-500">
          Loading settings…
        </div>
      </div>
    );
  }

  const c = config!;

  return (
    <div className="font-sans">
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-xl backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-zinc-300 hover:bg-white/5"
          >
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-zinc-400" />
              <span className="font-semibold text-white">Settings</span>
            </div>
            {collapsed ? (
              <ChevronRight className="h-5 w-5 shrink-0 text-zinc-400" />
            ) : (
              <ChevronDown className="h-5 w-5 shrink-0 text-zinc-400" />
            )}
          </button>

          {!collapsed && (
            <div className="border-t border-white/10 px-4 py-4">
              {error && (
                <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                  {error}
                </div>
              )}
              {saving && (
                <p className="mb-2 text-xs text-zinc-500">Saving…</p>
              )}

              <div className="flex flex-wrap gap-x-8 gap-y-6">
                <div className="space-y-4">
                  <p className="text-sm font-medium text-zinc-400">Toggles</p>
                  <div className="flex flex-col gap-3">
                    <label className="flex cursor-pointer items-center justify-between gap-4">
                      <span className="text-sm text-zinc-300">Auto Entry</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.autoEntryEnabled}
                        onClick={() => toggle('autoEntryEnabled', !c.autoEntryEnabled)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                          c.autoEntryEnabled ? 'bg-electric' : 'bg-white/20'
                        }`}
                      >
                        <span
                          className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${
                            c.autoEntryEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </label>
                    <label className="flex cursor-pointer items-center justify-between gap-4">
                      <span className="text-sm text-zinc-300">Auto Exit</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.autoExitEnabled}
                        onClick={() => toggle('autoExitEnabled', !c.autoExitEnabled)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                          c.autoExitEnabled ? 'bg-electric' : 'bg-white/20'
                        }`}
                      >
                        <span
                          className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${
                            c.autoExitEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </label>
                    <label className="flex cursor-pointer items-center justify-between gap-4">
                      <span className="text-sm text-zinc-300">Manual Entry</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.manualEntryEnabled}
                        onClick={() => toggle('manualEntryEnabled', !c.manualEntryEnabled)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                          c.manualEntryEnabled ? 'bg-electric' : 'bg-white/20'
                        }`}
                      >
                        <span
                          className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${
                            c.manualEntryEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </label>
                  </div>
                </div>

                <div className="space-y-4">
                  <p className="text-sm font-medium text-zinc-400">Capital & Leverage</p>
                  <div className="flex flex-col gap-4">
                    <div>
                      <label className="mb-1 block text-sm text-zinc-300">
                        Capital %: {(c.capitalPercent * 100).toFixed(0)}%
                      </label>
                      <input
                        type="range"
                        min={CAPITAL_MIN * 100}
                        max={CAPITAL_MAX * 100}
                        step={1}
                        value={c.capitalPercent * 100}
                        onChange={(e) => setCapital(Number(e.target.value) / 100)}
                        onMouseUp={applyCapitalToBackend}
                        onTouchEnd={applyCapitalToBackend}
                        className="h-2 w-40 max-w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-electric"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm text-zinc-300">Leverage</label>
                      <select
                        value={c.autoLeverage}
                        onChange={(e) => setLeverage(Number(e.target.value))}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-electric focus:outline-none focus:ring-1 focus:ring-electric"
                      >
                        {LEVERAGE_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}x
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm text-zinc-300">Screener Min Spread %</label>
                      <input
                        type="number"
                        step="0.001"
                        min={-100}
                        max={100}
                        value={c.screenerMinSpread ?? 0}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v)) setScreenerMinSpread(v);
                        }}
                        onBlur={applyScreenerMinSpreadToBackend}
                        className="w-24 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-electric focus:outline-none focus:ring-1 focus:ring-electric"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

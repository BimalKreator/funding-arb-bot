import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';
import type { ExchangeStatusResponse } from '../types/screener';

export interface TradeModalProps {
  onClose: () => void;
  symbol: string;
  binancePrice: number | undefined;
  bybitPrice: number | undefined;
  strategy: string;
  /** Used for API: Long Bin / Short Byb -> binanceSide BUY, bybitSide SELL */
  binanceAction?: 'LONG' | 'SHORT';
  bybitAction?: 'LONG' | 'SHORT';
}

function getUsdtAvailable(exchanges: ExchangeStatusResponse['exchanges']): { binance: number; bybit: number } {
  let binance = 0;
  let bybit = 0;
  for (const ex of exchanges) {
    const usdt = ex.balances?.find((b) => b.asset.toUpperCase() === 'USDT');
    if (!usdt) continue;
    const available = parseFloat(usdt.available);
    const total = parseFloat(usdt.total);
    const value = Number.isFinite(available) && available >= 0 ? available : (Number.isFinite(total) && total >= 0 ? total : 0);
    if (ex.exchangeId === 'binance') binance = value;
    if (ex.exchangeId === 'bybit') bybit = value;
  }
  return { binance, bybit };
}

export function TradeModal({ onClose, symbol, binancePrice, bybitPrice, strategy, binanceAction = 'LONG', bybitAction = 'SHORT' }: TradeModalProps) {
  const [balances, setBalances] = useState<{ binance: number; bybit: number }>({ binance: 0, bybit: 0 });
  const [balancesLoading, setBalancesLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [leverage, setLeverage] = useState(1);
  const [quantityInput, setQuantityInput] = useState('');
  const quantity = parseFloat(quantityInput) || 0;

  const markPrice =
    binancePrice != null && bybitPrice != null
      ? (binancePrice + bybitPrice) / 2
      : binancePrice ?? bybitPrice ?? null;
  const estValue = markPrice != null && quantity > 0 ? quantity * markPrice : 0;
  const marginRequired = leverage > 0 ? estValue / leverage : 0;

  const MIN_NOTIONAL = 5.1;
  const belowMinNotional = estValue > 0 && estValue < MIN_NOTIONAL;
  const insufficientBinance = marginRequired > balances.binance && marginRequired > 0;
  const insufficientBybit = marginRequired > balances.bybit && marginRequired > 0;
  const hasInsufficientMargin = insufficientBinance || insufficientBybit;
  const hasPrices = binancePrice != null && bybitPrice != null;
  const canConfirm = !hasInsufficientMargin && !belowMinNotional && quantity > 0 && leverage >= 1 && !executing && hasPrices;

  useEffect(() => {
    let cancelled = false;
    setBalancesLoading(true);
    apiFetch(`${API_BASE}/exchanges/status`)
      .then((res) => res.json())
      .then((data: ExchangeStatusResponse) => {
        if (cancelled) return;
        setBalances(getUsdtAvailable(data.exchanges));
      })
      .catch(() => {
        if (!cancelled) setBalances({ binance: 0, bybit: 0 });
      })
      .finally(() => {
        if (!cancelled) setBalancesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setExecuting(true);
    const binanceSide = binanceAction === 'LONG' ? 'BUY' : 'SELL';
    const bybitSide = bybitAction === 'LONG' ? 'BUY' : 'SELL';
    try {
      const res = await apiFetch(`${API_BASE}/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          quantity,
          strategy: { binanceSide, bybitSide },
          leverage,
          markPrice: markPrice ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data?.error ?? `Error ${res.status}`);
        return;
      }
      alert('Trade executed successfully.');
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setExecuting(false);
    }
  };

  const symbolShort = symbol.replace(/USDT$/i, '') || symbol;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        className="relative w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-modal-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="trade-modal-title" className="text-lg font-semibold text-white">
            Trade {symbolShort}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-sm text-zinc-400">Strategy: {strategy}</p>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="text-zinc-400">Binance Mark Price</div>
              <div className="font-medium text-white">
                {binancePrice != null ? binancePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="text-zinc-400">Bybit Mark Price</div>
              <div className="font-medium text-white">
                {bybitPrice != null ? bybitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—'}
              </div>
            </div>
          </div>

          {balancesLoading ? (
            <p className="text-sm text-zinc-500">Loading balances…</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <div className="text-zinc-400">Available USDT (Binance)</div>
                <div className="font-medium text-white">{balances.binance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <div className="text-zinc-400">Available USDT (Bybit)</div>
                <div className="font-medium text-white">{balances.bybit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm text-zinc-400">Leverage</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={20}
                value={leverage}
                onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                className="flex-1 accent-electric"
              />
              <span className="w-10 text-right font-medium text-white">{leverage}x</span>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm text-zinc-400">
              Quantity (e.g. 100 {symbolShort})
            </label>
            <input
              type="number"
              min={0}
              step="any"
              value={quantityInput}
              onChange={(e) => setQuantityInput(e.target.value)}
              placeholder="Number of tokens"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white placeholder-zinc-500 focus:border-electric focus:outline-none focus:ring-1 focus:ring-electric"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Approx. Value: ${estValue.toFixed(2)}
            </p>
            {belowMinNotional && (
              <p className="mt-1 text-sm text-amber-400">
                Value must be &gt; $5.1
              </p>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="text-sm text-zinc-400">Margin required</div>
            <div
              className={`font-semibold ${hasInsufficientMargin ? 'text-red-500' : 'text-white'}`}
            >
              {marginRequired > 0
                ? `${marginRequired.toFixed(2)} USDT`
                : '—'}
            </div>
          </div>

          {hasInsufficientMargin && (
            <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {insufficientBinance && <p>Insufficient Margin on Binance</p>}
              {insufficientBybit && <p>Insufficient Margin on Bybit</p>}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-white/10 bg-white/5 py-2.5 text-sm font-medium text-white hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="flex-1 rounded-lg bg-electric py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {executing ? 'Executing...' : 'Confirm Trade'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

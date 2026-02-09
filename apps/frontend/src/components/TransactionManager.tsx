import { useEffect, useState, useCallback } from 'react';
import { API_BASE } from '../config';

export interface TransactionItem {
  id: string;
  date: string;
  exchange: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  remark: string;
}

function todayLocal(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function TransactionManager() {
  const [list, setList] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<TransactionItem>>({});
  const [addForm, setAddForm] = useState({
    date: todayLocal(),
    exchange: 'binance',
    type: 'DEPOSIT' as 'DEPOSIT' | 'WITHDRAWAL',
    amount: 0 as number,
    remark: '',
  });

  const today = todayLocal();

  const fetchTransactions = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/transactions`);
      if (!res.ok) throw new Error(res.statusText);
      const json: TransactionItem[] = await res.json();
      setList(json);
    } catch (_) {
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const todayList = list.filter((t) => t.date === today);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = addForm.amount;
    if (!Number.isFinite(amount) || amount < 0) return;
    try {
      const res = await fetch(`${API_BASE}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: addForm.date,
          exchange: addForm.exchange,
          type: addForm.type,
          amount,
          remark: addForm.remark,
        }),
      });
      if (!res.ok) throw new Error(res.statusText);
      setAddForm({ ...addForm, amount: 0, remark: '' });
      await fetchTransactions();
    } catch (_) {
      // ignore
    }
  };

  const handleEdit = (tx: TransactionItem) => {
    setEditingId(tx.id);
    setEditForm({ date: tx.date, exchange: tx.exchange, type: tx.type, amount: tx.amount, remark: tx.remark });
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const amount = typeof editForm.amount === 'number' ? editForm.amount : parseFloat(String(editForm.amount));
    try {
      const res = await fetch(`${API_BASE}/transactions/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: editForm.date,
          exchange: editForm.exchange,
          type: editForm.type,
          amount: Number.isFinite(amount) ? amount : undefined,
          remark: editForm.remark,
        }),
      });
      if (!res.ok) throw new Error(res.statusText);
      setEditingId(null);
      await fetchTransactions();
    } catch (_) {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this transaction?')) return;
    try {
      const res = await fetch(`${API_BASE}/transactions/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(res.statusText);
      await fetchTransactions();
    } catch (_) {
      // ignore
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">
      <h2 className="mb-4 text-lg font-semibold text-white">Transaction Manager</h2>

      <div className="mb-8 rounded-xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur-sm">
        <h3 className="mb-4 text-sm font-medium text-zinc-400">Add New</h3>
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm text-zinc-400">
            Date
            <input
              type="date"
              value={addForm.date}
              onChange={(e) => setAddForm((f) => ({ ...f, date: e.target.value }))}
              className="rounded border border-white/10 bg-white/5 px-3 py-2 text-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-zinc-400">
            Exchange
            <select
              value={addForm.exchange}
              onChange={(e) => setAddForm((f) => ({ ...f, exchange: e.target.value }))}
              className="rounded border border-white/10 bg-white/5 px-3 py-2 text-white"
            >
              <option value="binance">Binance</option>
              <option value="bybit">Bybit</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-zinc-400">
            Type
            <select
              value={addForm.type}
              onChange={(e) => setAddForm((f) => ({ ...f, type: e.target.value as 'DEPOSIT' | 'WITHDRAWAL' }))}
              className="rounded border border-white/10 bg-white/5 px-3 py-2 text-white"
            >
              <option value="DEPOSIT">Deposit</option>
              <option value="WITHDRAWAL">Withdrawal</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-zinc-400">
            Amount
            <input
              type="number"
              step="0.01"
              min="0"
              value={addForm.amount === 0 ? '' : addForm.amount}
              onChange={(e) =>
                setAddForm((f) => ({
                  ...f,
                  amount: e.target.value === '' ? 0 : parseFloat(e.target.value),
                }))
              }
              className="w-28 rounded border border-white/10 bg-white/5 px-3 py-2 text-white"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-zinc-400">
            Remark
            <input
              type="text"
              value={addForm.remark}
              onChange={(e) => setAddForm((f) => ({ ...f, remark: e.target.value }))}
              placeholder="Optional"
              className="min-w-[120px] rounded border border-white/10 bg-white/5 px-3 py-2 text-white placeholder-zinc-500"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-electric px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Add
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 shadow-xl backdrop-blur-sm">
        <h3 className="border-b border-white/10 px-4 py-3 text-sm font-medium text-zinc-400">
          Today&apos;s Transactions
        </h3>
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">Loading…</div>
        ) : todayList.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">No transactions today.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-zinc-400">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Exchange</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Remark</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {todayList.map((tx) =>
                  editingId === tx.id ? (
                    <tr key={tx.id} className="border-b border-white/5 bg-white/5">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="date"
                            value={editForm.date ?? ''}
                            onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))}
                            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-white text-xs"
                          />
                          <select
                            value={editForm.exchange ?? ''}
                            onChange={(e) => setEditForm((f) => ({ ...f, exchange: e.target.value }))}
                            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-white text-xs"
                          >
                            <option value="binance">Binance</option>
                            <option value="bybit">Bybit</option>
                          </select>
                          <select
                            value={editForm.type ?? ''}
                            onChange={(e) => setEditForm((f) => ({ ...f, type: e.target.value as 'DEPOSIT' | 'WITHDRAWAL' }))}
                            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-white text-xs"
                          >
                            <option value="DEPOSIT">Deposit</option>
                            <option value="WITHDRAWAL">Withdrawal</option>
                          </select>
                          <input
                            type="number"
                            step="0.01"
                            value={editForm.amount ?? ''}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                amount: e.target.value === '' ? 0 : parseFloat(e.target.value),
                              }))
                            }
                            className="w-24 rounded border border-white/10 bg-white/5 px-2 py-1 text-white text-xs"
                          />
                          <input
                            type="text"
                            value={editForm.remark ?? ''}
                            onChange={(e) => setEditForm((f) => ({ ...f, remark: e.target.value }))}
                            className="min-w-[80px] rounded border border-white/10 bg-white/5 px-2 py-1 text-white text-xs"
                          />
                          <button
                            type="button"
                            onClick={handleSaveEdit}
                            className="rounded bg-electric px-2 py-1 text-xs text-white"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-400"
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={tx.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="px-4 py-3">{tx.date}</td>
                      <td className="px-4 py-3 capitalize">{tx.exchange}</td>
                      <td className="px-4 py-3">{tx.type}</td>
                      <td className="px-4 py-3">{tx.amount.toFixed(2)}</td>
                      <td className="px-4 py-3 text-zinc-500">{tx.remark || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleEdit(tx)}
                          className="mr-2 rounded border border-white/10 px-2 py-1 text-xs text-zinc-400 hover:bg-white/10"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(tx.id)}
                          className="rounded border border-red-500/50 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

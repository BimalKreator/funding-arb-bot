import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { ExchangeManager } from './exchange/index.js';

const DATA_DIR = join(process.cwd(), 'data');
const TRANSACTIONS_FILE = join(DATA_DIR, 'transactions.json');
const BALANCE_HISTORY_FILE = join(DATA_DIR, 'balance_history.json');

/** Hardcoded opening balance for this date (restart accounting from today). */
const HARDCODED_OPENING_DATE = '2026-02-13';
const HARDCODED_OPENING_BALANCE = 265;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface Transaction {
  id: string;
  date: string;
  exchange: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  remark: string;
}

export interface StatsResponse {
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

function getTodayIST(): string {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** True if we're in the first hour of the day in IST (00:00–00:59). */
function isFirstHourOfDayIST(): boolean {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return ist.getUTCHours() === 0;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

export class BalanceService {
  private lastMidnightCheck = 0;
  private lastSnapshotDateIST: string | null = null;

  constructor(private readonly exchangeManager: ExchangeManager) {}

  async getTransactions(): Promise<Transaction[]> {
    const list = await readJson<Transaction[]>(TRANSACTIONS_FILE, []);
    return Array.isArray(list) ? list : [];
  }

  private async saveTransactions(list: Transaction[]): Promise<void> {
    await writeJson(TRANSACTIONS_FILE, list);
  }

  private async getBalanceHistory(): Promise<Record<string, number>> {
    const obj = await readJson<Record<string, number>>(BALANCE_HISTORY_FILE, {});
    return obj && typeof obj === 'object' ? obj : {};
  }

  private async setOpeningBalance(date: string, balance: number): Promise<void> {
    const hist = await this.getBalanceHistory();
    hist[date] = balance;
    await writeJson(BALANCE_HISTORY_FILE, hist);
  }

  /**
   * Returns opening balance for the given date (YYYY-MM-DD in IST).
   * If we have a snapshot for that date (taken at 12 AM IST), use it.
   * Otherwise use the most recent previous day's balance so we never show 0
   * when the server missed the midnight snapshot (e.g. was down at 12 AM IST).
   */
  async getOpeningBalance(date: string): Promise<number> {
    if (date === HARDCODED_OPENING_DATE) return HARDCODED_OPENING_BALANCE;
    const hist = await this.getBalanceHistory();
    const exact = Number(hist[date]);
    if (exact > 0) return exact;
    const sortedDates = Object.keys(hist).filter((d) => d && hist[d] != null && hist[d] > 0).sort();
    const prevDates = sortedDates.filter((d) => d < date);
    if (prevDates.length === 0) return 0;
    const lastPrev = prevDates[prevDates.length - 1];
    return Number(hist[lastPrev]) || 0;
  }

  /** Returns latest balance and stats. Fetches live from exchanges on every call (no cache). Frontend should poll every 5s for realtime updates. */
  async getStats(): Promise<StatsResponse> {
    const status = await this.exchangeManager.getStatus();
    let binanceBal = 0,
      binanceFree = 0,
      binanceMargin = 0;
    let bybitBal = 0,
      bybitFree = 0,
      bybitMargin = 0;

    for (const ex of status.exchanges) {
      const usdt = ex.balances?.find((b) => b.asset.toUpperCase() === 'USDT');
      const total = usdt ? parseFloat(usdt.total) : 0;
      const available = usdt ? parseFloat(usdt.available) : 0;
      if (ex.exchangeId === 'binance') {
        binanceBal = total;
        binanceFree = available;
        binanceMargin = total - available;
      }
      if (ex.exchangeId === 'bybit') {
        bybitBal = total;
        bybitFree = available;
        if (usdt?.usedMargin != null && usdt.usedMargin !== '') {
          const v = parseFloat(usdt.usedMargin);
          bybitMargin = Number.isFinite(v) ? v : total - available;
        } else {
          bybitMargin = total - available;
        }
      }
    }

    const currentBalance = binanceBal + bybitBal;
    const today = getTodayIST();
    const openingBalance = await this.getOpeningBalance(today);

    const transactions = await this.getTransactions();
    const todayTx = transactions.filter((t) => t.date === today);
    const totalDeposits = todayTx
      .filter((t) => t.type === 'DEPOSIT')
      .reduce((s, t) => s + t.amount, 0);
    const totalWithdrawals = todayTx
      .filter((t) => t.type === 'WITHDRAWAL')
      .reduce((s, t) => s + t.amount, 0);

    const growthAmt =
      currentBalance - openingBalance - totalDeposits + totalWithdrawals;
    const growthPercent =
      openingBalance > 0 ? (growthAmt * 100) / openingBalance : 0;

    const hist = await this.getBalanceHistory();
    const dates = Object.keys(hist).filter((d) => d && hist[d] != null).sort();
    let dailyAvgRoi = 0;
    let monthlyAvgRoi = 0;
    if (dates.length >= 2) {
      const rois: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        const openVal = Number(hist[dates[i - 1]]) || 0;
        const closeVal = Number(hist[dates[i]]) || 0;
        if (openVal > 0) rois.push(((closeVal - openVal) / openVal) * 100);
      }
      dailyAvgRoi = rois.length > 0 ? rois.reduce((a, b) => a + b, 0) / rois.length : 0;
      monthlyAvgRoi = dailyAvgRoi * 30;
    }

    return {
      currentBalance,
      openingBalance,
      totalDeposits,
      totalWithdrawals,
      growthAmt,
      growthPercent,
      dailyAvgRoi,
      monthlyAvgRoi,
      breakdown: {
        binance: {
          bal: binanceBal,
          margin: binanceMargin,
          free: binanceFree,
        },
        bybit: {
          bal: bybitBal,
          margin: bybitMargin,
          free: bybitFree,
        },
      },
    };
  }

  async addTransaction(
    date: string,
    exchange: string,
    type: 'DEPOSIT' | 'WITHDRAWAL',
    amount: number,
    remark: string
  ): Promise<Transaction> {
    const list = await this.getTransactions();
    const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const tx: Transaction = { id, date, exchange, type, amount, remark };
    list.push(tx);
    await this.saveTransactions(list);
    return tx;
  }

  async updateTransaction(
    id: string,
    updates: Partial<Omit<Transaction, 'id'>>
  ): Promise<Transaction | null> {
    const list = await this.getTransactions();
    const idx = list.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...updates };
    await this.saveTransactions(list);
    return list[idx];
  }

  async deleteTransaction(id: string): Promise<boolean> {
    const list = await this.getTransactions();
    const filtered = list.filter((t) => t.id !== id);
    if (filtered.length === list.length) return false;
    await this.saveTransactions(filtered);
    return true;
  }

  /**
   * In the first hour of day IST (00:00–00:59), snapshot current balance and save as
   * opening for that day ( = "closing balance of 12 AM IST" for the new day).
   * Call this every few minutes so we don't miss the window (e.g. if server restarts).
   */
  async runMidnightSnapshotIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMidnightCheck < 5 * 60 * 1000) return; // debounce 5 min to avoid hammering
    this.lastMidnightCheck = now;

    const today = getTodayIST();
    if (!isFirstHourOfDayIST() || this.lastSnapshotDateIST === today) return;

    try {
      const status = await this.exchangeManager.getStatus();
      let total = 0;
      for (const ex of status.exchanges) {
        const usdt = ex.balances?.find((b) => b.asset.toUpperCase() === 'USDT');
        if (usdt) total += parseFloat(usdt.total);
      }
      await this.setOpeningBalance(today, total);
      this.lastSnapshotDateIST = today;
      console.log(`[BalanceService] Opening balance for ${today} set to ${total}`);
    } catch (err) {
      console.error('[BalanceService] Midnight snapshot failed:', err);
    }
  }
}

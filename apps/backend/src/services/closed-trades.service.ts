import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const CLOSED_TRADES_FILE = join(DATA_DIR, 'closed_trades.json');

const MAX_HISTORY = 200;

export interface ClosedTradeRecord {
  id: string;
  closedAt: string; // ISO
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

let inMemory: ClosedTradeRecord[] | null = null;

async function load(): Promise<ClosedTradeRecord[]> {
  if (inMemory) return inMemory;
  try {
    const raw = await readFile(CLOSED_TRADES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    inMemory = Array.isArray(parsed) ? parsed : [];
    return inMemory;
  } catch {
    inMemory = [];
    return inMemory;
  }
}

async function save(list: ClosedTradeRecord[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CLOSED_TRADES_FILE, JSON.stringify(list, null, 2), 'utf-8');
  inMemory = list;
}

export async function addClosedTrade(record: Omit<ClosedTradeRecord, 'id'>): Promise<ClosedTradeRecord> {
  const list = await load();
  const id = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const full: ClosedTradeRecord = { ...record, id };
  const next = [full, ...list].slice(0, MAX_HISTORY);
  await save(next);
  return full;
}

export async function getClosedTrades(limit: number = 50): Promise<ClosedTradeRecord[]> {
  const list = await load();
  return list.slice(0, limit);
}

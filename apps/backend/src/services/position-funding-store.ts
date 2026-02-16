import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'position_funding.json');

export interface SymbolFundingState {
  nextFundingTime: number;
  fundingIntervalHours: number;
  binance: { accumulatedFunding: number };
  bybit: { accumulatedFunding: number };
}

let cache: Record<string, SymbolFundingState> = {};

async function load(): Promise<Record<string, SymbolFundingState>> {
  try {
    const raw = await readFile(FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cache = parsed;
      return cache;
    }
  } catch {
    // ignore
  }
  cache = {};
  return cache;
}

async function save(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

export async function getPositionFundingState(
  symbol: string
): Promise<SymbolFundingState | undefined> {
  await load();
  return cache[symbol];
}

export async function setPositionFundingState(
  symbol: string,
  state: SymbolFundingState
): Promise<void> {
  await load();
  cache[symbol] = state;
  await save();
}

export async function getAllPositionFundingStates(): Promise<Record<string, SymbolFundingState>> {
  await load();
  return { ...cache };
}

/** Remove state for a symbol (after position closed). Returns the state that was removed. */
export async function takeAndRemovePositionFundingState(
  symbol: string
): Promise<SymbolFundingState | undefined> {
  await load();
  const key = symbol.toUpperCase();
  const state = cache[key];
  if (state != null) {
    delete cache[key];
    await save();
  }
  return state;
}

/** Get total accumulated funding for a symbol and remove its state (call on close). */
export async function takeAccumulatedFundingForSymbol(symbol: string): Promise<number> {
  const state = await takeAndRemovePositionFundingState(symbol);
  if (state == null) return 0;
  return state.binance.accumulatedFunding + state.bybit.accumulatedFunding;
}

/** Initialize or get state for a symbol. Pass nextFundingTime (ms) when creating so it matches exchange slots. */
export async function getOrInitPositionFundingState(
  symbol: string,
  fundingIntervalHours: number,
  nextFundingTimeMs?: number
): Promise<SymbolFundingState> {
  await load();
  const key = symbol.toUpperCase();
  const existing = cache[key];
  if (existing != null) {
    return existing;
  }
  const nextFundingTime =
    nextFundingTimeMs != null && Number.isFinite(nextFundingTimeMs)
      ? nextFundingTimeMs
      : Date.now() + fundingIntervalHours * 60 * 60 * 1000;
  const state: SymbolFundingState = {
    nextFundingTime,
    fundingIntervalHours,
    binance: { accumulatedFunding: 0 },
    bybit: { accumulatedFunding: 0 },
  };
  cache[key] = state;
  await save();
  return state;
}

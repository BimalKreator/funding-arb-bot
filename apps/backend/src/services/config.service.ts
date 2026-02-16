import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

export const ALLOWED_INTERVAL_OPTIONS = [1, 2, 4, 8] as const;

const MAX_ACTIVE_TRADES_MIN = 1;
const MAX_ACTIVE_TRADES_MAX = 20;

export interface BotConfig {
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  manualEntryEnabled: boolean;
  capitalPercent: number;
  autoLeverage: number;
  screenerMinSpread: number;
  /** Min realized orderbook spread % required to enter a trade (entry guard). Default 0.22. */
  executionSpreadThreshold: number;
  /** Funding intervals (hours) allowed for trading; e.g. [1, 4, 8]. Empty or missing = all. */
  allowedFundingIntervals: number[];
  /** Max number of active trades (auto-entry stops when reached). */
  maxActiveTrades: number;
  /** Early take profit: close when position ROI >= this %. 0 = disabled. */
  minTakeProfitPercent: number;
}

const DEFAULTS: BotConfig = {
  autoEntryEnabled: false,
  autoExitEnabled: true,
  manualEntryEnabled: true,
  capitalPercent: 0.25,
  autoLeverage: 1,
  screenerMinSpread: 0,
  executionSpreadThreshold: 0.22,
  allowedFundingIntervals: [...ALLOWED_INTERVAL_OPTIONS],
  maxActiveTrades: 3,
  minTakeProfitPercent: 0,
};

function clampCapitalPercent(v: number): number {
  if (!Number.isFinite(v)) return DEFAULTS.capitalPercent;
  return Math.max(0.05, Math.min(1, v));
}

const VALID_LEVERAGES = [1, 2, 3, 5, 10];
function clampLeverage(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULTS.autoLeverage;
  if (VALID_LEVERAGES.includes(v)) return v;
  const best = VALID_LEVERAGES.reduce((prev, cur) =>
    Math.abs(cur - v) < Math.abs(prev - v) ? cur : prev
  );
  return best;
}

function clampScreenerMinSpread(v: number): number {
  if (!Number.isFinite(v)) return DEFAULTS.screenerMinSpread;
  return Math.max(-100, Math.min(100, v));
}

function clampExecutionSpreadThreshold(v: number): number {
  if (!Number.isFinite(v)) return DEFAULTS.executionSpreadThreshold;
  return Math.max(0, Math.min(10, v));
}

function normalizeAllowedFundingIntervals(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [...DEFAULTS.allowedFundingIntervals];
  const valid = arr
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && ALLOWED_INTERVAL_OPTIONS.includes(n as 1 | 2 | 4 | 8));
  return [...new Set(valid)].sort((a, b) => a - b);
}

function clampMaxActiveTrades(v: number): number {
  if (!Number.isFinite(v) || v < MAX_ACTIVE_TRADES_MIN) return DEFAULTS.maxActiveTrades;
  return Math.min(MAX_ACTIVE_TRADES_MAX, Math.max(MAX_ACTIVE_TRADES_MIN, Math.floor(v)));
}

const TAKE_PROFIT_MAX = 100;
function clampMinTakeProfitPercent(v: number): number {
  if (!Number.isFinite(v) || v < 0) return DEFAULTS.minTakeProfitPercent;
  return Math.min(TAKE_PROFIT_MAX, v);
}

export class ConfigService {
  private cache: BotConfig | null = null;

  async getConfig(): Promise<BotConfig> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BotConfig>;
      this.cache = {
        autoEntryEnabled: typeof parsed.autoEntryEnabled === 'boolean' ? parsed.autoEntryEnabled : DEFAULTS.autoEntryEnabled,
        autoExitEnabled: typeof parsed.autoExitEnabled === 'boolean' ? parsed.autoExitEnabled : DEFAULTS.autoExitEnabled,
        manualEntryEnabled: typeof parsed.manualEntryEnabled === 'boolean' ? parsed.manualEntryEnabled : DEFAULTS.manualEntryEnabled,
        capitalPercent: clampCapitalPercent(Number(parsed.capitalPercent)),
        autoLeverage: clampLeverage(Number(parsed.autoLeverage)),
        screenerMinSpread: clampScreenerMinSpread(Number(parsed.screenerMinSpread)),
        executionSpreadThreshold: clampExecutionSpreadThreshold(Number(parsed.executionSpreadThreshold)),
        allowedFundingIntervals: normalizeAllowedFundingIntervals(parsed.allowedFundingIntervals),
        maxActiveTrades: clampMaxActiveTrades(Number(parsed.maxActiveTrades)),
        minTakeProfitPercent: clampMinTakeProfitPercent(Number(parsed.minTakeProfitPercent)),
      };
      return this.cache;
    } catch {
      this.cache = { ...DEFAULTS };
      return this.cache;
    }
  }

  async updateConfig(partial: Partial<BotConfig>): Promise<BotConfig> {
    const current = await this.getConfig();
    const next: BotConfig = {
      autoEntryEnabled: typeof partial.autoEntryEnabled === 'boolean' ? partial.autoEntryEnabled : current.autoEntryEnabled,
      autoExitEnabled: typeof partial.autoExitEnabled === 'boolean' ? partial.autoExitEnabled : current.autoExitEnabled,
      manualEntryEnabled: typeof partial.manualEntryEnabled === 'boolean' ? partial.manualEntryEnabled : current.manualEntryEnabled,
      capitalPercent: partial.capitalPercent !== undefined ? clampCapitalPercent(Number(partial.capitalPercent)) : current.capitalPercent,
      autoLeverage: partial.autoLeverage !== undefined ? clampLeverage(Number(partial.autoLeverage)) : current.autoLeverage,
      screenerMinSpread: partial.screenerMinSpread !== undefined ? clampScreenerMinSpread(Number(partial.screenerMinSpread)) : current.screenerMinSpread,
      executionSpreadThreshold:
        partial.executionSpreadThreshold !== undefined
          ? clampExecutionSpreadThreshold(Number(partial.executionSpreadThreshold))
          : current.executionSpreadThreshold,
      allowedFundingIntervals:
        partial.allowedFundingIntervals !== undefined
          ? normalizeAllowedFundingIntervals(partial.allowedFundingIntervals)
          : current.allowedFundingIntervals,
      maxActiveTrades:
        partial.maxActiveTrades !== undefined
          ? clampMaxActiveTrades(Number(partial.maxActiveTrades))
          : current.maxActiveTrades,
      minTakeProfitPercent:
        partial.minTakeProfitPercent !== undefined
          ? clampMinTakeProfitPercent(Number(partial.minTakeProfitPercent))
          : current.minTakeProfitPercent,
    };
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
    this.cache = next;
    return next;
  }
}

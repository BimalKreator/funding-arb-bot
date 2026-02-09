import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

export interface BotConfig {
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  manualEntryEnabled: boolean;
  capitalPercent: number;
  autoLeverage: number;
}

const DEFAULTS: BotConfig = {
  autoEntryEnabled: false,
  autoExitEnabled: true,
  manualEntryEnabled: true,
  capitalPercent: 0.25,
  autoLeverage: 1,
};

function clampCapitalPercent(v: number): number {
  if (!Number.isFinite(v)) return DEFAULTS.capitalPercent;
  return Math.max(0.05, Math.min(0.5, v));
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
    };
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
    this.cache = next;
    return next;
  }
}

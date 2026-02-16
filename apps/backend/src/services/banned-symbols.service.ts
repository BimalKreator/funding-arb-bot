import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const BANNED_FILE = join(DATA_DIR, 'banned-symbols.json');

/**
 * Persistent list of user-banned symbols (manual ban).
 * Distinct from InstrumentService blacklist (system temporary ban after rollback/error).
 */
export class BannedSymbolsService {
  private list: string[] = [];
  private loaded = false;

  /** Load from disk. Call once at startup. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(BANNED_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      this.list = Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === 'string') : [];
    } catch {
      this.list = [];
    }
    this.loaded = true;
  }

  /** Sync: returns copy of current list. Ensure load() was called at startup. */
  getBanned(): string[] {
    return [...this.list];
  }

  isBanned(symbol: string): boolean {
    const upper = symbol.toUpperCase();
    return this.list.some((s) => s.toUpperCase() === upper);
  }

  async ban(symbol: string): Promise<void> {
    const trimmed = String(symbol).trim();
    if (!trimmed) return;
    const upper = trimmed.toUpperCase();
    if (this.list.some((s) => s.toUpperCase() === upper)) return;
    this.list.push(trimmed);
    await this.save();
  }

  async unban(symbol: string): Promise<void> {
    const upper = String(symbol).trim().toUpperCase();
    this.list = this.list.filter((s) => s.toUpperCase() !== upper);
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(BANNED_FILE, JSON.stringify(this.list, null, 2), 'utf-8');
  }
}

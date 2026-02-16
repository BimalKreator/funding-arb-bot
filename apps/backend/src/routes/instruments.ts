import { Router, Request, Response } from 'express';
import type { BannedSymbolsService } from '../services/banned-symbols.service.js';

export function createInstrumentsRouter(bannedSymbolsService: BannedSymbolsService): Router {
  const router = Router();

  router.get('/banned', (_req: Request, res: Response) => {
    try {
      const list = bannedSymbolsService.getBanned();
      res.json(list);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get banned list',
      });
    }
  });

  router.post('/ban', async (req: Request, res: Response) => {
    try {
      const body = req.body as { symbol?: string };
      const symbol = body?.symbol != null ? String(body.symbol).trim() : '';
      if (!symbol) {
        res.status(400).json({ error: 'Missing or empty symbol' });
        return;
      }
      await bannedSymbolsService.ban(symbol);
      res.json({ ok: true, symbol });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to ban symbol',
      });
    }
  });

  router.post('/unban', async (req: Request, res: Response) => {
    try {
      const body = req.body as { symbol?: string };
      const symbol = body?.symbol != null ? String(body.symbol).trim() : '';
      if (!symbol) {
        res.status(400).json({ error: 'Missing or empty symbol' });
        return;
      }
      await bannedSymbolsService.unban(symbol);
      res.json({ ok: true, symbol });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to unban symbol',
      });
    }
  });

  return router;
}

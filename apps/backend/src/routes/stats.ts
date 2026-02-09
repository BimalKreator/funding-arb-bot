import { Router, Request, Response } from 'express';
import type { BalanceService } from '../services/balance.service.js';

export function createStatsRouter(balanceService: BalanceService): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const stats = await balanceService.getStats();
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get stats';
      res.status(500).json({ error: message });
    }
  });

  return router;
}

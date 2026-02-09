import { Router, Request, Response } from 'express';
import type { ExchangeManager } from '../services/exchange/ExchangeManager.js';
import { getReadableErrorMessage } from '../services/exchange/ExchangeManager.js';

export function createExchangesRouter(manager: ExchangeManager): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const status = await manager.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({
        error: getReadableErrorMessage(err) || 'Failed to get exchange status',
      });
    }
  });

  return router;
}

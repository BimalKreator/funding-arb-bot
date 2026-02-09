import { Router, Request, Response } from 'express';
import { PositionService } from '../services/position.service.js';

export function createPositionsRouter(positionService: PositionService): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const list = await positionService.getPositions();
      res.json(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch positions';
      res.status(500).json({ error: message });
    }
  });

  router.post('/close', async (req: Request, res: Response) => {
    try {
      const { symbol } = req.body ?? {};
      if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
        res.status(400).json({ error: 'Missing or invalid symbol' });
        return;
      }
      const result = await positionService.closePosition(symbol.trim());
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to close position';
      res.status(500).json({ error: message });
    }
  });

  return router;
}

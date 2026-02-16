import { Router, Request, Response } from 'express';
import type { ScreenerService } from '../services/screener.service.js';

const DEFAULT_THRESHOLD = 0;

export function createScreenerRouter(screenerService: ScreenerService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const thresholdParam = req.query.threshold;
      const threshold =
        thresholdParam !== undefined ? parseFloat(String(thresholdParam)) : DEFAULT_THRESHOLD;
      const numThreshold = Number.isNaN(threshold) ? DEFAULT_THRESHOLD : threshold;

      const result = await screenerService.getResults(numThreshold);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get screener results',
      });
    }
  });

  return router;
}

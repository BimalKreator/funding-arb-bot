import { Router, Request, Response } from 'express';
import type { FundingService } from '../services/funding.service.js';

export function createFundingRouter(fundingService: FundingService): Router {
  const router = Router();

  router.get('/intervals', (_req: Request, res: Response) => {
    try {
      const snapshot = fundingService.getIntervalsSnapshot();
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to get funding intervals',
      });
    }
  });

  return router;
}

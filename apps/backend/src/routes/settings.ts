import { Router, Request, Response } from 'express';
import type { ConfigService } from '../services/config.service.js';

export function createSettingsRouter(configService: ConfigService): Router {
  const router = Router();

  /** POST /api/settings/intervals — update allowed funding intervals (e.g. [1, 4, 8]). */
  router.post('/intervals', async (req: Request, res: Response) => {
    try {
      const body = req.body as { allowedFundingIntervals?: number[] };
      const allowedFundingIntervals: number[] | undefined = body?.allowedFundingIntervals;
      const config = await configService.updateConfig({
        allowedFundingIntervals,
      });
      res.json(config);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update allowed intervals',
      });
    }
  });

  return router;
}

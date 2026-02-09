import { Router } from 'express';
import type { ConfigService } from '../services/config.service.js';

export function createConfigRouter(configService: ConfigService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const config = await configService.getConfig();
      res.json(config);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load config',
      });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const partial = req.body as Record<string, unknown>;
      if (!partial || typeof partial !== 'object') {
        res.status(400).json({ error: 'Body must be a JSON object' });
        return;
      }
      const config = await configService.updateConfig(partial);
      res.json(config);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update config',
      });
    }
  });

  return router;
}

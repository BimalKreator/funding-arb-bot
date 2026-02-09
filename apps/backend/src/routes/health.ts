import { Router } from 'express';
import type { HealthResponse } from '@funding-arb-bot/shared';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  };
  res.json(body);
});

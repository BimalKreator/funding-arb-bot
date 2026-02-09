import { Router, Request, Response } from 'express';
import type { NotificationService } from '../services/notification.service.js';

export function createNotificationsRouter(notificationService: NotificationService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const list = notificationService.getAll();
    res.json(list);
  });

  return router;
}

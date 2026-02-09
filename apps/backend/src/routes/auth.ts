import { Router } from 'express';
import { login } from '../services/auth.service.js';

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/login', (req, res) => {
    const email = req.body?.email;
    const password = req.body?.password;
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }
    const result = login(email, password);
    if (!result) {
      res.status(401).json({ error: 'Invalid Credentials' });
      return;
    }
    res.json(result);
  });

  return router;
}

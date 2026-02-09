import { Router } from 'express';
import { login } from '../services/auth.service.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'Bad Request', message: 'email and password required' });
    return;
  }
  const result = login(String(email).trim(), String(password));
  if (!result) {
    res.status(401).json({ error: 'Invalid Credentials', message: 'Invalid Credentials' });
    return;
  }
  res.json(result);
});

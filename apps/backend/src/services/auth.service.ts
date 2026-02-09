import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { ALLOWED_USERS } from '../config/users.js';

export interface LoginResult {
  token: string;
  user: { email: string };
}

/**
 * Check credentials against ALLOWED_USERS and return a signed JWT if valid.
 */
export function login(email: string, password: string): LoginResult | null {
  const normalizedEmail = email.trim().toLowerCase();
  const user = ALLOWED_USERS.find(
    (u) => u.email.toLowerCase() === normalizedEmail && u.password === password
  );
  if (!user) return null;

  const token = jwt.sign(
    { email: user.email, sub: user.email },
    config.jwtSecret,
    { expiresIn: '7d' }
  );
  return { token, user: { email: user.email } };
}

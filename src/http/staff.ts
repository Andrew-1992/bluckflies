import express, { type Router } from 'express';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { StaffAuthService, StaffPrincipal } from '../services/StaffAuthService.js';
import type { RateLimiter } from '../lib/rateLimiter.js';
import { parseBody, rateLimit } from './middleware.js';

/**
 * Staff sign-in for the support desk: /api/staff/login, /logout, /me,
 * /password and two-step login setup (/2fa/start, /2fa/confirm).
 */

const Login = z.object({
  email: z.string().trim().max(200),
  password: z.string().max(200),
  code: z.string().trim().regex(/^\d{6}$/).optional(),
});

export function staffRouter(staff: StaffAuthService, limits: RateLimiter): Router {
  const r = express.Router();
  // Guessing passwords: per address, on top of the per-account lockout.
  const loginLimiter = rateLimit(limits, { windowMs: 15 * 60_000, max: 20, key: (req) => `staff-login:${req.ip}` });

  r.post('/login', loginLimiter, async (req, res) => {
    const { email, password, code } = parseBody(Login, req.body);
    const result = await staff.login(email, password, code, req.ip);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });

  r.use(rateLimit(limits, { windowMs: 60_000, max: 120, key: (req) => `staff:${req.ip}` }));
  r.use(async (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const p = header.startsWith('Bearer ') ? await staff.authenticate(header.slice(7).trim()) : undefined;
    if (!p) throw new AppError('UNAUTHENTICATED', 'Sign in to the support desk.');
    res.locals['staff'] = p;
    next();
  });
  const me = (res: express.Response) => res.locals['staff'] as StaffPrincipal;

  r.get('/me', async (_req, res) => {
    res.json({ staff: await staff.me(me(res)) });
  });
  r.post('/logout', async (_req, res) => {
    await staff.logout(me(res));
    res.status(204).end();
  });
  r.post('/password', async (req, res) => {
    const { current, next } = parseBody(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
    await staff.changePassword(me(res), current, next);
    res.status(204).end();
  });
  r.post('/2fa/start', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await staff.start2fa(me(res)));
  });
  r.post('/2fa/confirm', async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
    await staff.confirm2fa(me(res), code);
    res.status(204).end();
  });
  return r;
}

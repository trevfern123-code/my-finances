import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';

/**
 * Verifies the Supabase-issued JWT sent by the frontend and attaches the
 * authenticated user to the request. Every Plaid route sits behind this —
 * the frontend never talks to Plaid or Supabase directly, only to us,
 * authenticated as a specific user.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email ?? null };
  next();
}

import type { NextFunction, Request, Response } from 'express';
import { decodeJwt } from 'jose';
import { supabaseAdmin } from '../config/supabase';

/**
 * The `sub` and `session_id` claims of a bearer token that Supabase has ALREADY verified (see
 * requireAuth). Decoding without verifying is only sound because of that: this never runs on a
 * token Supabase rejected.
 */
function readVerifiedClaims(token: string): { sub: string | null; sessionId: string | null } {
  try {
    const claims = decodeJwt(token);
    return {
      sub: typeof claims.sub === 'string' ? claims.sub : null,
      sessionId: typeof claims.session_id === 'string' && claims.session_id.trim() !== '' ? claims.session_id : null,
    };
  } catch {
    return { sub: null, sessionId: null };
  }
}

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

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const { sub, sessionId } = readVerifiedClaims(token);
    if (sub !== null && sub !== data.user.id) {
      // Cannot happen for a genuine Supabase token; refuse rather than guess whose request it is.
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = { id: data.user.id, email: data.user.email ?? null, sessionId };
    next();
  } catch (err) {
    // Express 4 doesn't catch rejected promises from middleware on its own — an uncaught
    // rejection here (e.g. a network blip reaching Supabase) crashes the whole process.
    next(err);
  }
}

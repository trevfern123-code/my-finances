import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Frontend/backend compatibility contract (service-worker/version-compatibility work, phase 1).
 *
 * A browser tab — or an installed PWA window — can keep running an older frontend bundle after a
 * new backend is deployed. This contract lets the backend tell such a client, explicitly, that it
 * must update, instead of the client silently misbehaving against a response shape it doesn't
 * understand.
 *
 * - The client sends `X-Client-Api-Level: <non-negative integer>` on every app API request. A
 *   request without it is a legacy client (every bundle released before this contract): level 0.
 * - Every response on a covered route carries `X-Api-Level` (this backend's level) and
 *   `X-Min-Client-Api-Level` (the oldest client level it still serves), including error responses.
 * - A client below the minimum gets HTTP 409 `{ code: 'client_update_required' }` before any
 *   route handler runs, so nothing is read or written on its behalf.
 * - A malformed value is rejected with HTTP 400 `{ code: 'invalid_client_api_level' }` rather than
 *   being guessed at.
 *
 * This is compatibility metadata only. It never replaces authentication, session ownership,
 * item/loan ownership or financial validation — a supported client still goes through all of them.
 *
 * Release rule: raise API_LEVEL when a backend change alters a request or response contract an
 * older client depends on; raise MIN_CLIENT_API_LEVEL only in a release that must refuse older
 * clients (for example, when retiring the legacy routes kept for pre-contract bundles). Both are
 * deliberately code constants, not configuration: changing them is a reviewed release decision.
 */
export const API_LEVEL = 1;
export const MIN_CLIENT_API_LEVEL = 0;

export const CLIENT_API_LEVEL_HEADER = 'X-Client-Api-Level';
export const API_LEVEL_HEADER = 'X-Api-Level';
export const MIN_CLIENT_API_LEVEL_HEADER = 'X-Min-Client-Api-Level';

export const CLIENT_UPDATE_REQUIRED = 'client_update_required';
export const INVALID_CLIENT_API_LEVEL = 'invalid_client_api_level';

export type ParsedClientApiLevel = { kind: 'missing' } | { kind: 'valid'; level: number } | { kind: 'invalid' };

/** A canonical non-negative integer: no sign, no leading zeros, no whitespace, no decimal or
 *  exponent, at most six digits. Anything else — including a header sent twice, which Node joins
 *  as "1, 1" — is invalid rather than coerced (`Number(' 1')`, `parseInt('1abc')` and friends would
 *  all quietly accept garbage). */
const CANONICAL_LEVEL = /^(0|[1-9][0-9]{0,5})$/;

export function parseClientApiLevel(raw: string | undefined): ParsedClientApiLevel {
  if (raw === undefined) return { kind: 'missing' };
  if (!CANONICAL_LEVEL.test(raw)) return { kind: 'invalid' };
  return { kind: 'valid', level: Number(raw) };
}

export interface ClientApiLevelPolicy {
  apiLevel: number;
  minClientApiLevel: number;
}

export const DEFAULT_CLIENT_API_LEVEL_POLICY: ClientApiLevelPolicy = {
  apiLevel: API_LEVEL,
  minClientApiLevel: MIN_CLIENT_API_LEVEL,
};

/**
 * Mounted in front of the app API routers (see app.ts for the exact list). Sets the two response
 * headers first, so they survive onto every response that follows — a handler's 2xx, a 401 from
 * requireAuth, a 404, or the global error handler's 500 — then rejects an invalid or unsupported
 * client level before the request reaches authentication or any route handler.
 *
 * OPTIONS is passed through untouched: a CORS preflight is answered by the cors middleware before
 * this runs, and a browser never attaches custom headers to a preflight anyway.
 */
export function requireSupportedClientApiLevel(
  policy: ClientApiLevelPolicy = DEFAULT_CLIENT_API_LEVEL_POLICY
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader(API_LEVEL_HEADER, String(policy.apiLevel));
    res.setHeader(MIN_CLIENT_API_LEVEL_HEADER, String(policy.minClientApiLevel));

    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    const parsed = parseClientApiLevel(req.get(CLIENT_API_LEVEL_HEADER));
    if (parsed.kind === 'invalid') {
      res.status(400).json({ error: `Invalid ${CLIENT_API_LEVEL_HEADER} header`, code: INVALID_CLIENT_API_LEVEL });
      return;
    }

    const level = parsed.kind === 'missing' ? 0 : parsed.level;
    if (level < policy.minClientApiLevel) {
      res.status(409).json({
        error: 'This version of the app is out of date. Reload the page to update.',
        code: CLIENT_UPDATE_REQUIRED,
      });
      return;
    }

    next();
  };
}

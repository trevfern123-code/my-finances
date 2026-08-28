import type { NextFunction, Request, Response } from 'express';
import { summarizeErrorSafely } from '../services/errorSanitizer';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // Never log the raw error object — this is the global catch-all for every unhandled error
  // from every controller, including real Plaid/Axios errors whose `.config` carries the full
  // outgoing request (access_token/client_id/secret for Plaid calls). summarizeErrorSafely
  // extracts only known-safe fields (see errorSanitizer.ts for why the raw object is unsafe).
  console.error(summarizeErrorSafely(err));

  const message = err instanceof Error ? err.message : 'Unexpected error';
  res.status(500).json({ error: message });
}

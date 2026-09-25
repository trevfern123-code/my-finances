import type { NextFunction, Request, Response } from 'express';
import { summarizeErrorSafely } from '../services/errorSanitizer';

/**
 * The request-body failures express.json() (body-parser) reports as the CLIENT's fault, mapped to
 * a fixed, generic message and a machine-readable code. The parser's own message is never sent:
 * it can quote the offending input (e.g. `Unexpected token } in JSON at position 12`). Its
 * internal stream failures (`stream.encoding.set`, `stream.not.readable`) are server faults and
 * stay on the ordinary 500 path, as does every other error.
 */
const BODY_PARSER_CLIENT_ERRORS: Record<string, { code: string; message: string }> = {
  'entity.parse.failed': { code: 'malformed_json', message: 'The request body is not valid JSON' },
  'entity.too.large': { code: 'payload_too_large', message: 'The request body is too large' },
  'request.size.invalid': { code: 'invalid_request_body', message: 'The request body did not match its declared size' },
  'request.aborted': { code: 'invalid_request_body', message: 'The request body was not received completely' },
  'encoding.unsupported': { code: 'unsupported_request_body', message: 'The request body uses an unsupported content encoding' },
  'charset.unsupported': { code: 'unsupported_request_body', message: 'The request body uses an unsupported charset' },
};

/** The status and response for a body-parser client error, or null for anything else. Only a
 *  known body-parser `type` that carries its own 4xx status qualifies. */
export function bodyParserClientError(err: unknown): { status: number; code: string; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return null;
  const mapped = Object.prototype.hasOwnProperty.call(BODY_PARSER_CLIENT_ERRORS, type) ? BODY_PARSER_CLIENT_ERRORS[type] : undefined;
  if (!mapped || status < 400 || status > 499) return null;
  return { status, ...mapped };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // Headers already set on `res` earlier in the pipeline (CORS, and the client-API-level headers
  // on covered routes) are kept: this only chooses the status and body.
  const clientError = bodyParserClientError(err);
  if (clientError) {
    // A malformed or oversized body is the caller's mistake, not a server fault: log its type only
    // — never the body or the parser's message, which can quote it.
    console.warn(`Rejected request body: ${(err as { type: string }).type}`);
    res.status(clientError.status).json({ error: clientError.message, code: clientError.code });
    return;
  }

  // Never log the raw error object — this is the global catch-all for every unhandled error
  // from every controller, including real Plaid/Axios errors whose `.config` carries the full
  // outgoing request (access_token/client_id/secret for Plaid calls). summarizeErrorSafely
  // extracts only known-safe fields (see errorSanitizer.ts for why the raw object is unsafe).
  console.error(summarizeErrorSafely(err));

  const message = err instanceof Error ? err.message : 'Unexpected error';
  res.status(500).json({ error: message });
}

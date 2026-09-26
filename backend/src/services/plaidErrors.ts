interface PlaidApiErrorShape {
  response?: { status?: unknown; data?: { error_code?: unknown; error_type?: unknown } };
}

/** Plaid's own `error_code` when the error is a Plaid API answer, otherwise null. */
export function plaidErrorCode(err: unknown): string | null {
  const code = (err as PlaidApiErrorShape | null)?.response?.data?.error_code;
  return typeof code === 'string' ? code : null;
}

/** Plaid errors that mean "try again later", never "this request is wrong". */
const TRANSIENT_PLAID_ERROR_CODES = new Set(['RATE_LIMIT_EXCEEDED', 'INTERNAL_SERVER_ERROR', 'PLANNED_MAINTENANCE']);

export type ItemRemoveErrorClass =
  | { outcome: 'already_removed'; code: string }
  | { outcome: 'retryable'; code: string | null }
  | { outcome: 'needs_attention'; code: string };

/**
 * Linked Institution Management: what a failed `/item/remove` call means for the removal operation.
 *
 * - `already_removed`: Plaid answered ITEM_NOT_FOUND, i.e. the Item no longer exists there. This is
 *   what a retry sees after an earlier removal whose success response was lost (a timeout that in
 *   fact succeeded), so it confirms removal exactly like a success. It is the ONLY error treated as
 *   "removed": INVALID_ACCESS_TOKEN (e.g. a token from another environment) says nothing about
 *   whether the Item still exists — and keeps billing — at Plaid.
 * - `retryable`: no answer at all (network error, timeout), a 5xx, or a transient Plaid code. The
 *   outcome is unknown; the removal stays requested and nothing local is deleted.
 * - `needs_attention`: Plaid definitively refused for another reason. Retrying the same request
 *   will not help; the removal stays requested (see README "Linked institution management").
 */
export function classifyItemRemoveError(err: unknown): ItemRemoveErrorClass {
  const response = (err as PlaidApiErrorShape | null)?.response;
  const code = plaidErrorCode(err);
  if (code === 'ITEM_NOT_FOUND') return { outcome: 'already_removed', code };
  const status = response?.status;
  const answered = typeof status === 'number';
  if (!answered || (status as number) >= 500 || (code !== null && TRANSIENT_PLAID_ERROR_CODES.has(code))) {
    return { outcome: 'retryable', code };
  }
  if (code === null) return { outcome: 'retryable', code: null };
  return { outcome: 'needs_attention', code };
}

/** True for Plaid errors that mean the item's access token is no longer usable and the user must re-link. */
export function isReauthRequiredError(err: unknown): boolean {
  const code = (err as PlaidApiErrorShape)?.response?.data?.error_code;
  return code === 'ITEM_LOGIN_REQUIRED' || code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN';
}

/**
 * True only when Plaid itself ANSWERED a request with an error (HTTP 4xx carrying a Plaid
 * `error_code`, e.g. INVALID_PUBLIC_TOKEN) — so the request definitively did not succeed. Anything
 * else (no response: network error or timeout; a 5xx) leaves the outcome unknown: Plaid may have
 * completed the request without us hearing back. Wave 1 Hosted Link uses this to tell "the
 * exchange was rejected" apart from "the exchange's outcome is unknown", which must never be
 * retried (Plaid does not document re-exchanging a public token as safe).
 */
export function isDefinitivePlaidRejection(err: unknown): boolean {
  const response = (err as { response?: { status?: unknown; data?: { error_code?: unknown } } } | null)?.response;
  return (
    typeof response?.status === 'number' &&
    response.status >= 400 &&
    response.status < 500 &&
    typeof response.data?.error_code === 'string'
  );
}

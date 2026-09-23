interface PlaidApiErrorShape {
  response?: { data?: { error_code?: string } };
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

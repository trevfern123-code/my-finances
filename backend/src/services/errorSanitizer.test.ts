import { describe, expect, it } from 'vitest';
import { summarizeErrorSafely } from './errorSanitizer';

const SENTINEL_ACCESS_TOKEN = 'access-sandbox-SENTINEL-DO-NOT-LEAK-abc123';
const SENTINEL_CLIENT_ID = 'plaid-client-id-SENTINEL-xyz789';
const SENTINEL_SECRET = 'plaid-secret-SENTINEL-shhh456';
const SENTINEL_AUTH_HEADER = 'Bearer SENTINEL-jwt-should-not-leak';

/** Mimics a real rejected-Plaid-API-call AxiosError as closely as this repo's actual installed
 *  axios constructs one (verified against node_modules/axios/dist/esm/axios.js) — `.config` is
 *  the full outgoing request (Plaid calls send access_token/client_id/secret in the JSON body),
 *  `.request`/`.response` carry their own references, and `.cause` wraps the original error,
 *  which could itself carry a request reference too. */
function fakeAxiosPlaidError(overrides: { status?: number; errorCode?: string; errorType?: string } = {}): Error {
  const status = overrides.status ?? 400;
  const err = new Error(`Request failed with status code ${status}`);
  err.name = 'AxiosError';

  const requestBody = JSON.stringify({
    client_id: SENTINEL_CLIENT_ID,
    secret: SENTINEL_SECRET,
    access_token: SENTINEL_ACCESS_TOKEN,
  });

  Object.assign(err, {
    config: {
      url: 'https://sandbox.plaid.com/accounts/get',
      method: 'post',
      data: requestBody,
      headers: { Authorization: SENTINEL_AUTH_HEADER, 'Content-Type': 'application/json' },
    },
    request: { path: '/accounts/get', _header: `Authorization: ${SENTINEL_AUTH_HEADER}` },
    response: {
      status,
      data: {
        error_code: overrides.errorCode ?? 'INVALID_ACCESS_TOKEN',
        error_type: overrides.errorType ?? 'INVALID_INPUT',
        // Plaid error responses also sometimes echo back request context.
        request_id: 'req-abc',
      },
    },
  });
  // AxiosError's real `.cause` is non-enumerable but still a real own property a naive
  // "log every property including non-enumerable ones" approach (or JSON.stringify with a
  // replacer that walks getOwnPropertyNames) could still surface.
  Object.defineProperty(err, 'cause', {
    value: { message: `underlying error, token=${SENTINEL_ACCESS_TOKEN}` },
    enumerable: false,
    configurable: true,
  });

  return err;
}

describe('summarizeErrorSafely', () => {
  it('extracts only the safe fields from a realistic Plaid/Axios error', () => {
    const err = fakeAxiosPlaidError();
    const summary = summarizeErrorSafely(err);

    expect(summary).toEqual({
      name: 'AxiosError',
      message: 'Request failed with status code 400',
      plaidErrorCode: 'INVALID_ACCESS_TOKEN',
      plaidErrorType: 'INVALID_INPUT',
      httpStatus: 400,
    });
  });

  it('never includes the sentinel access token, client id, secret, or auth header anywhere in the summary', () => {
    const err = fakeAxiosPlaidError();
    const summary = summarizeErrorSafely(err);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain(SENTINEL_ACCESS_TOKEN);
    expect(serialized).not.toContain(SENTINEL_CLIENT_ID);
    expect(serialized).not.toContain(SENTINEL_SECRET);
    expect(serialized).not.toContain(SENTINEL_AUTH_HEADER);
  });

  it('never includes the sentinel values even when every own property (including non-enumerable) is considered', () => {
    // Belt-and-suspenders: prove the summary object itself carries none of the dangerous
    // properties at all (not just that they're absent from a JSON.stringify), so a different
    // serialization strategy downstream couldn't resurrect them either.
    const err = fakeAxiosPlaidError();
    const summary = summarizeErrorSafely(err);

    expect(Object.getOwnPropertyNames(summary)).toEqual(
      expect.arrayContaining(['name', 'message', 'plaidErrorCode', 'plaidErrorType', 'httpStatus'])
    );
    expect(summary).not.toHaveProperty('config');
    expect(summary).not.toHaveProperty('request');
    expect(summary).not.toHaveProperty('response');
    expect(summary).not.toHaveProperty('cause');
  });

  it('extracts a different Plaid error code/type/status correctly (not hardcoded to the default fixture)', () => {
    const err = fakeAxiosPlaidError({ status: 500, errorCode: 'INTERNAL_SERVER_ERROR', errorType: 'API_ERROR' });
    const summary = summarizeErrorSafely(err);

    expect(summary.httpStatus).toBe(500);
    expect(summary.plaidErrorCode).toBe('INTERNAL_SERVER_ERROR');
    expect(summary.plaidErrorType).toBe('API_ERROR');
  });

  it('handles a plain Error with no Plaid/Axios shape at all — no crash, no sensitive fields assumed present', () => {
    const summary = summarizeErrorSafely(new Error('a plain database error'));
    expect(summary).toEqual({ name: 'Error', message: 'a plain database error' });
  });

  it('handles a non-Error thrown value without crashing or fabricating fields', () => {
    expect(summarizeErrorSafely('a raw string throw')).toEqual({
      name: 'UnknownThrownValue',
      message: 'A non-Error value was thrown.',
    });
    expect(summarizeErrorSafely(undefined)).toEqual({
      name: 'UnknownThrownValue',
      message: 'A non-Error value was thrown.',
    });
    expect(summarizeErrorSafely({ access_token: SENTINEL_ACCESS_TOKEN })).toEqual({
      name: 'UnknownThrownValue',
      message: 'A non-Error value was thrown.',
    });
  });

  it('ignores a response.data.error_code/error_type that is not actually a string (defensive against a malformed/unexpected shape)', () => {
    const err = new Error('weird shape');
    Object.assign(err, { response: { status: 400, data: { error_code: 12345, error_type: null } } });
    const summary = summarizeErrorSafely(err);

    expect(summary.plaidErrorCode).toBeUndefined();
    expect(summary.plaidErrorType).toBeUndefined();
    expect(summary.httpStatus).toBe(400);
  });
});

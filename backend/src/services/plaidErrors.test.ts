import { describe, expect, it } from 'vitest';
import { classifyItemRemoveError, isDefinitivePlaidRejection, isReauthRequiredError, plaidErrorCode } from './plaidErrors';

function plaidError(errorCode: string) {
  return { response: { data: { error_code: errorCode } } };
}

describe('isReauthRequiredError', () => {
  it.each(['ITEM_LOGIN_REQUIRED', 'ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'])(
    'is true for %s',
    (code) => {
      expect(isReauthRequiredError(plaidError(code))).toBe(true);
    }
  );

  it('is false for an unrelated Plaid error code', () => {
    expect(isReauthRequiredError(plaidError('RATE_LIMIT_EXCEEDED'))).toBe(false);
  });

  it('is false for a plain Error with no Plaid response shape', () => {
    expect(isReauthRequiredError(new Error('boom'))).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isReauthRequiredError(null)).toBe(false);
    expect(isReauthRequiredError(undefined)).toBe(false);
  });

  it('is false for a malformed error shape missing nested fields', () => {
    expect(isReauthRequiredError({ response: {} })).toBe(false);
    expect(isReauthRequiredError({})).toBe(false);
  });
});

describe('isDefinitivePlaidRejection (Wave 1)', () => {
  const answered = (status: number, errorCode?: string) => ({ response: { status, data: errorCode ? { error_code: errorCode } : {} } });

  it.each([
    [400, 'INVALID_PUBLIC_TOKEN'],
    [400, 'INVALID_INPUT'],
    [429, 'RATE_LIMIT_EXCEEDED'],
  ])('is true when Plaid answered %i with error code %s — the request definitively did not succeed', (status, code) => {
    expect(isDefinitivePlaidRejection(answered(status, code))).toBe(true);
  });

  it.each([
    ['a 5xx', answered(500, 'INTERNAL_SERVER_ERROR')],
    ['a 4xx without a Plaid error code (e.g. from a proxy)', answered(404)],
    ['no response at all (network error / timeout)', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
    ['a non-numeric status', { response: { status: '400', data: { error_code: 'X' } } }],
    ['null', null],
    ['undefined', undefined],
  ])('is false (outcome unknown) for %s', (_label, err) => {
    expect(isDefinitivePlaidRejection(err)).toBe(false);
  });
});

describe('classifyItemRemoveError (Linked Institution Management)', () => {
  const answered = (status: number, errorCode?: string) => ({ response: { status, data: errorCode ? { error_code: errorCode } : {} } });

  it('ITEM_NOT_FOUND means the Item is already gone at Plaid', () => {
    expect(classifyItemRemoveError(answered(400, 'ITEM_NOT_FOUND'))).toEqual({ outcome: 'already_removed', code: 'ITEM_NOT_FOUND' });
  });

  it.each([
    ['a timeout (no response)', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
    ['a network error', new Error('socket hang up')],
    ['a 500', answered(500, 'INTERNAL_SERVER_ERROR')],
    ['a 502 without a Plaid body', answered(502)],
    ['rate limiting', answered(429, 'RATE_LIMIT_EXCEEDED')],
    ['planned maintenance', answered(400, 'PLANNED_MAINTENANCE')],
    ['a 4xx with no Plaid error code', answered(400)],
    ['null', null],
  ])('%s is retryable (outcome unknown or transient)', (_label, err) => {
    expect(classifyItemRemoveError(err).outcome).toBe('retryable');
  });

  it.each(['INVALID_ACCESS_TOKEN', 'INVALID_API_KEYS', 'INVALID_INPUT', 'ITEM_LOGIN_REQUIRED'])(
    '%s needs attention — and is never treated as removed',
    (code) => {
      expect(classifyItemRemoveError(answered(400, code))).toEqual({ outcome: 'needs_attention', code });
    }
  );
});

describe('plaidErrorCode', () => {
  it('reads Plaid error codes and nothing else', () => {
    expect(plaidErrorCode({ response: { data: { error_code: 'ITEM_NOT_FOUND' } } })).toBe('ITEM_NOT_FOUND');
    expect(plaidErrorCode(new Error('x'))).toBeNull();
    expect(plaidErrorCode({ response: { data: { error_code: 5 } } })).toBeNull();
  });
});

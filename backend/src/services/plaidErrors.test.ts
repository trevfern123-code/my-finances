import { describe, expect, it } from 'vitest';
import { isDefinitivePlaidRejection, isReauthRequiredError } from './plaidErrors';

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

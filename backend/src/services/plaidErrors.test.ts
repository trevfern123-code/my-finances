import { describe, expect, it } from 'vitest';
import { isReauthRequiredError } from './plaidErrors';

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

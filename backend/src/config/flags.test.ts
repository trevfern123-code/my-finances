import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOptInFlag } from './flags';

// env.ts imports dotenv/config; stub it so a developer's own backend/.env can never refill a variable a
// test deliberately removed (the "absent" case below).
vi.mock('dotenv/config', () => ({}));

describe('parseOptInFlag', () => {
  it('is off when the variable is absent or empty', () => {
    expect(parseOptInFlag(undefined)).toBe(false);
    expect(parseOptInFlag('')).toBe(false);
    expect(parseOptInFlag('   ')).toBe(false);
  });

  it('is off for "false" in any casing — the string "false" never enables a feature', () => {
    expect(parseOptInFlag('false')).toBe(false);
    expect(parseOptInFlag('FALSE')).toBe(false);
    expect(parseOptInFlag(' False ')).toBe(false);
  });

  it('is off for every other value, including other truthy-looking spellings and typos', () => {
    for (const value of ['0', '1', 'yes', 'on', 'enabled', 'ture', 'true1', 't', '"true"']) {
      expect(parseOptInFlag(value)).toBe(false);
    }
  });

  it('is on only for "true" (case-insensitive, surrounding whitespace ignored)', () => {
    expect(parseOptInFlag('true')).toBe(true);
    expect(parseOptInFlag('TRUE')).toBe(true);
    expect(parseOptInFlag(' True\n')).toBe(true);
  });
});

describe('env.cardPaymentSyncEvaluationEnabled (CARD_PAYMENT_SYNC_EVALUATION_ENABLED)', () => {
  const saved = process.env.CARD_PAYMENT_SYNC_EVALUATION_ENABLED;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (saved === undefined) delete process.env.CARD_PAYMENT_SYNC_EVALUATION_ENABLED;
    else process.env.CARD_PAYMENT_SYNC_EVALUATION_ENABLED = saved;
    vi.resetModules();
  });

  async function loadEnvWith(value: string | undefined) {
    vi.resetModules();
    // The variables env.ts requires, with the same safe placeholders CI uses.
    vi.stubEnv('FRONTEND_URL', 'http://localhost:5173');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    vi.stubEnv('PLAID_CLIENT_ID', 'test-client-id');
    vi.stubEnv('PLAID_SECRET', 'test-secret');
    if (value === undefined) {
      delete process.env.CARD_PAYMENT_SYNC_EVALUATION_ENABLED;
    } else {
      vi.stubEnv('CARD_PAYMENT_SYNC_EVALUATION_ENABLED', value);
    }
    return (await import('./env')).env;
  }

  it('defaults to OFF when the variable is absent', async () => {
    expect((await loadEnvWith(undefined)).cardPaymentSyncEvaluationEnabled).toBe(false);
  });

  it('is OFF for "false"', async () => {
    expect((await loadEnvWith('false')).cardPaymentSyncEvaluationEnabled).toBe(false);
  });

  it('is ON for "true"', async () => {
    expect((await loadEnvWith('true')).cardPaymentSyncEvaluationEnabled).toBe(true);
  });
});

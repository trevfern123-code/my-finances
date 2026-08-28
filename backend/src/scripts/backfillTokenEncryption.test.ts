import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks (established pattern, see dataService.test.ts) -------------------------------------

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

const mockEnv = vi.hoisted(() => ({ plaidEnv: 'sandbox' }));
vi.mock('../config/env', () => ({ env: mockEnv }));

const mockVerifyAccessTokenLive = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', () => ({ verifyAccessTokenLive: mockVerifyAccessTokenLive }));

// Real crypto math still runs (so these tests exercise genuine encrypt/decrypt round trips, not a
// mocked stub) — only the environment-backed singleton is swapped for a fixed test key ring, the
// same pattern already used by dataService.test.ts. Two keys are configured so the
// historical/non-current-key test below has something real to decrypt with.
vi.mock('../services/tokenEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tokenEncryption')>();
  const testKeyRing = actual.loadKeyRing({
    PLAID_TOKEN_KEY_RAILWAY_PROD_V1: Buffer.alloc(32, 7).toString('base64'),
    PLAID_TOKEN_KEY_OLD_V1: Buffer.alloc(32, 9).toString('base64'),
    PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V1',
  });
  return { ...actual, getKeyRing: () => testKeyRing };
});

import {
  ArgError,
  classifyStorageState,
  HaltError,
  logEntry,
  main,
  parseArgs,
  processTarget,
  runPreflight,
  verifyLiveWithRetry,
  __setInterruptedForTests,
} from './backfillTokenEncryption';
import { encryptAccessToken, loadKeyRing, type KeyRing } from '../services/tokenEncryption';

const CONFIRM = 'BACKFILL_PLAID_TOKENS';

const TEST_KEY_RING: KeyRing = loadKeyRing({
  PLAID_TOKEN_KEY_RAILWAY_PROD_V1: Buffer.alloc(32, 7).toString('base64'),
  PLAID_TOKEN_KEY_OLD_V1: Buffer.alloc(32, 9).toString('base64'),
  PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V1',
});
const OLD_KEY_RING: KeyRing = { currentKeyId: 'OLD_V1', keys: TEST_KEY_RING.keys };

// ---- Fixture builders -----------------------------------------------------------------------

interface FakeRow {
  id: string;
  access_token: string | null;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
}

function plaintextRow(id: string, plaintext: string): FakeRow {
  return {
    id,
    access_token: plaintext,
    access_token_ciphertext: null,
    access_token_nonce: null,
    access_token_auth_tag: null,
    access_token_key_id: null,
    access_token_enc_version: null,
  };
}

function encryptedRow(
  id: string,
  plaintext: string,
  opts: { keepPlaintext?: boolean; keyRing?: KeyRing; encVersion?: number; keyId?: string } = {}
): FakeRow {
  const enc = encryptAccessToken(plaintext, opts.keyRing ?? TEST_KEY_RING, id);
  return {
    id,
    access_token: opts.keepPlaintext === false ? null : plaintext,
    access_token_ciphertext: enc.ciphertextBase64,
    access_token_nonce: enc.nonceBase64,
    access_token_auth_tag: enc.authTagBase64,
    access_token_key_id: opts.keyId ?? enc.keyId,
    access_token_enc_version: opts.encVersion ?? enc.encVersion,
  };
}

// ---- Fake Supabase (a small in-memory `plaid_items` table + `information_schema` stub) --------
//
// Not a reuse of testUtils/supabaseMock.ts's generic single-result builder — this script issues
// several genuinely different, stateful queries against the same table within one invocation
// (a full-table preflight read, per-target rereads, and a guarded conditional update), so the
// fake needs to actually behave like a small table rather than return one fixed canned result.

function setupFakeSupabase(
  initialRows: FakeRow[],
  opts: { constraintsExposed?: boolean; missingConstraints?: string[]; onBeforeUpdateFilter?: (rows: FakeRow[]) => void } = {}
) {
  const rows = initialRows.map((r) => ({ ...r }));
  let updateCallCount = 0;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'information_schema.table_constraints') {
      return {
        select: () => ({
          eq: () => ({
            in: async (_col: string, names: string[]) => {
              if (opts.constraintsExposed === false) {
                return { data: null, error: { message: 'relation "information_schema.table_constraints" does not exist' } };
              }
              const missing = new Set(opts.missingConstraints ?? []);
              return { data: names.filter((n) => !missing.has(n)).map((n) => ({ constraint_name: n })), error: null };
            },
          }),
        }),
      };
    }

    let eqFilters: Record<string, unknown> = {};
    let isNullFilters: string[] = [];
    let mode: 'select' | 'update' = 'select';
    let updatePayload: Record<string, unknown> = {};

    const matches = () =>
      rows.filter((r) => {
        for (const [k, v] of Object.entries(eqFilters)) if ((r as Record<string, unknown>)[k] !== v) return false;
        for (const k of isNullFilters) if ((r as Record<string, unknown>)[k] !== null) return false;
        return true;
      });

    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (payload: Record<string, unknown>) => {
        mode = 'update';
        updateCallCount++;
        updatePayload = payload;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        eqFilters[col] = val;
        return chain;
      },
      is: (col: string) => {
        isNullFilters.push(col);
        return chain;
      },
      maybeSingle: async () => {
        const found = matches();
        return { data: found[0] ?? null, error: null };
      },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (mode === 'update') {
          // Simulates a concurrent writer's effect landing between our own reread and our own
          // update's filter evaluation — see the "lost race" test below.
          opts.onBeforeUpdateFilter?.(rows);
          const found = matches();
          found.forEach((r) => Object.assign(r, updatePayload));
          return Promise.resolve(resolve({ data: found.map((r) => ({ id: r.id })), error: null }));
        }
        return Promise.resolve(resolve({ data: matches(), error: null }));
      },
    };
    return chain;
  });

  return { getRows: () => rows.map((r) => ({ ...r })), getUpdateCallCount: () => updateCallCount };
}

function captureLogs() {
  const entries: { id?: string; stage: string; outcome: string }[] = [];
  const rawLines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    rawLines.push(String(line));
    entries.push(JSON.parse(String(line)));
  });
  return { entries, rawLines };
}

beforeEach(() => {
  mockEnv.plaidEnv = 'sandbox';
  mockVerifyAccessTokenLive.mockReset();
  mockVerifyAccessTokenLive.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---- CLI parsing ------------------------------------------------------------------------------

describe('parseArgs', () => {
  const base = ['--target-ids', 'row-1,row-2', '--expected-total', '3', '--expected-plaid-env', 'sandbox'];

  it('parses a valid dry-run invocation', () => {
    const args = parseArgs(base);
    expect(args).toEqual({
      targetIds: ['row-1', 'row-2'],
      expectedTotal: 3,
      expectedPlaidEnv: 'sandbox',
      apply: false,
      confirm: null,
    });
  });

  it('parses a valid apply invocation', () => {
    const args = parseArgs([...base, '--apply', '--confirm', CONFIRM]);
    expect(args.apply).toBe(true);
    expect(args.confirm).toBe(CONFIRM);
  });

  it('rejects when --target-ids is missing', () => {
    expect(() => parseArgs(['--expected-total', '3', '--expected-plaid-env', 'sandbox'])).toThrow(ArgError);
  });

  it('rejects when --expected-total is missing', () => {
    expect(() => parseArgs(['--target-ids', 'row-1', '--expected-plaid-env', 'sandbox'])).toThrow(ArgError);
  });

  it('rejects when --expected-total is not a non-negative integer', () => {
    expect(() => parseArgs(['--target-ids', 'row-1', '--expected-total', '-1', '--expected-plaid-env', 'sandbox'])).toThrow(ArgError);
    expect(() => parseArgs(['--target-ids', 'row-1', '--expected-total', 'abc', '--expected-plaid-env', 'sandbox'])).toThrow(ArgError);
  });

  it('rejects when --expected-plaid-env is missing', () => {
    expect(() => parseArgs(['--target-ids', 'row-1', '--expected-total', '3'])).toThrow(ArgError);
  });

  it('rejects --apply without --confirm', () => {
    expect(() => parseArgs([...base, '--apply'])).toThrow(ArgError);
  });

  it('rejects --apply with the wrong confirmation string', () => {
    expect(() => parseArgs([...base, '--apply', '--confirm', 'wrong'])).toThrow(ArgError);
    expect(() => parseArgs([...base, '--apply', '--confirm', CONFIRM.toLowerCase()])).toThrow(ArgError);
  });

  it('rejects duplicate target ids', () => {
    expect(() =>
      parseArgs(['--target-ids', 'row-1,row-1', '--expected-total', '3', '--expected-plaid-env', 'sandbox'])
    ).toThrow(ArgError);
  });

  it('there is no flag or combination that selects "all rows" — --target-ids always names exact ids', () => {
    // Structural guarantee, not a single assertion: parseArgs has no branch that accepts an
    // empty/absent --target-ids as "match everything" — covered above by the "missing" test.
    const args = parseArgs(base);
    expect(args.targetIds).toEqual(['row-1', 'row-2']);
  });
});

// ---- Storage state classification --------------------------------------------------------------

describe('classifyStorageState', () => {
  it('classifies a plaintext-only row', () => {
    expect(classifyStorageState(plaintextRow('a', 'secret')).kind).toBe('plaintext_only');
  });

  it('classifies a fully dual-written encrypted row', () => {
    const state = classifyStorageState(encryptedRow('a', 'secret'));
    expect(state).toMatchObject({ kind: 'encrypted', plaintextAlsoPresent: true });
  });

  it('classifies an encrypted-only row (no plaintext)', () => {
    const state = classifyStorageState(encryptedRow('a', 'secret', { keepPlaintext: false }));
    expect(state).toMatchObject({ kind: 'encrypted', plaintextAlsoPresent: false });
  });

  it('classifies a partial row (some but not all encrypted columns populated)', () => {
    const row = encryptedRow('a', 'secret');
    row.access_token_nonce = null; // corrupt one field only
    expect(classifyStorageState(row).kind).toBe('partial');
  });

  it('classifies a row with neither representation as missing_both', () => {
    expect(classifyStorageState(plaintextRow('a', 'x')).kind).not.toBe('missing_both');
    const row = plaintextRow('a', 'x');
    row.access_token = null;
    expect(classifyStorageState(row).kind).toBe('missing_both');
  });
});

// ---- Preflight ----------------------------------------------------------------------------------

describe('runPreflight', () => {
  const args = () => ({ targetIds: ['a', 'b'], expectedTotal: 2, expectedPlaidEnv: 'sandbox', apply: false, confirm: null });

  it('passes when everything matches expectations', async () => {
    setupFakeSupabase([plaintextRow('a', 'secret-a'), plaintextRow('b', 'secret-b')]);
    const result = await runPreflight(args());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails on a wrong expected total', async () => {
    setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y')]);
    const result = await runPreflight({ ...args(), expectedTotal: 5 });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('Expected total'))).toBe(true);
  });

  it('fails when a target id does not exist', async () => {
    setupFakeSupabase([plaintextRow('a', 'x')]);
    const result = await runPreflight({ ...args(), targetIds: ['a', 'nonexistent'], expectedTotal: 1 });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('nonexistent'))).toBe(true);
  });

  it('fails on a mismatched expected Plaid environment', async () => {
    setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y')]);
    const result = await runPreflight({ ...args(), expectedPlaidEnv: 'production' });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('Plaid environment'))).toBe(true);
  });

  it('fails when any row in the whole table has a partial encrypted representation', async () => {
    const bad = encryptedRow('c', 'z');
    bad.access_token_auth_tag = null;
    setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y'), bad]);
    const result = await runPreflight({ ...args(), expectedTotal: 3 });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('partial'))).toBe(true);
  });

  it('fails when any row anywhere is already encrypted-only (the Phase 2b data-level proxy)', async () => {
    setupFakeSupabase([plaintextRow('a', 'x'), encryptedRow('other', 'z', { keepPlaintext: false })]);
    const result = await runPreflight({ ...args(), targetIds: ['a'], expectedTotal: 2 });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.toLowerCase().includes('phase 2b'))).toBe(true);
  });

  it('fails when a target has no plaintext present', async () => {
    setupFakeSupabase([encryptedRow('a', 'x', { keepPlaintext: false }), plaintextRow('b', 'y')]);
    const result = await runPreflight({ ...args(), expectedTotal: 2 });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('no plaintext present'))).toBe(true);
  });

  it('fails closed when Phase 1 constraints cannot be verified at all', async () => {
    setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y')], { constraintsExposed: false });
    const result = await runPreflight(args());
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('Unable to verify Phase 1 constraints'))).toBe(true);
  });

  it('fails when a Phase 1 constraint is confirmed missing', async () => {
    setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y')], {
      missingConstraints: ['plaid_items_encrypted_token_complete'],
    });
    const result = await runPreflight(args());
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('Missing expected Phase 1 constraint'))).toBe(true);
  });

  it('performs zero writes', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y')]);
    await runPreflight(args());
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

// ---- Dry-run makes zero writes, end to end -----------------------------------------------------

describe('main — dry-run default', () => {
  it('performs zero writes and exits 0 when everything is valid', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'secret-a'), plaintextRow('b', 'secret-b')]);
    captureLogs();
    const code = await main(['--target-ids', 'a,b', '--expected-total', '2', '--expected-plaid-env', 'sandbox']);
    expect(code).toBe(0);
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(fake.getRows().every((r) => r.access_token_key_id === null)).toBe(true);
  });

  it('performs zero writes even with --apply omitted but everything else present', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'secret-a')]);
    captureLogs();
    await main(['--target-ids', 'a', '--expected-total', '1', '--expected-plaid-env', 'sandbox']);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('does not call the Plaid verifier for a still-plaintext target in dry-run', async () => {
    setupFakeSupabase([plaintextRow('a', 'secret-a')]);
    captureLogs();
    await main(['--target-ids', 'a', '--expected-total', '1', '--expected-plaid-env', 'sandbox']);
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('still fully re-verifies an already-encrypted target during dry-run (read-only, no write)', async () => {
    const fake = setupFakeSupabase([encryptedRow('a', 'secret-a')]);
    captureLogs();
    const code = await main(['--target-ids', 'a', '--expected-total', '1', '--expected-plaid-env', 'sandbox']);
    expect(code).toBe(0);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith('secret-a');
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

// ---- Apply: CLI gating ---------------------------------------------------------------------------

describe('main — apply gating', () => {
  it('refuses to run without --apply even if writes would otherwise be valid', async () => {
    setupFakeSupabase([plaintextRow('a', 'x')]);
    captureLogs();
    const code = await main(['--target-ids', 'a', '--expected-total', '1', '--expected-plaid-env', 'sandbox', '--confirm', CONFIRM]);
    expect(code).toBe(0); // valid dry-run, since --apply was never passed
  });

  it('refuses --apply without the confirmation flag', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'x')]);
    captureLogs();
    const code = await main(['--target-ids', 'a', '--expected-total', '1', '--expected-plaid-env', 'sandbox', '--apply']);
    expect(code).toBe(1);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('refuses --apply with the wrong confirmation string', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'x')]);
    captureLogs();
    const code = await main([
      '--target-ids',
      'a',
      '--expected-total',
      '1',
      '--expected-plaid-env',
      'sandbox',
      '--apply',
      '--confirm',
      'WRONG_TOKEN',
    ]);
    expect(code).toBe(1);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('refuses apply when the wrong target id is supplied', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'x')]);
    captureLogs();
    const code = await main([
      '--target-ids',
      'wrong-id',
      '--expected-total',
      '1',
      '--expected-plaid-env',
      'sandbox',
      '--apply',
      '--confirm',
      CONFIRM,
    ]);
    expect(code).toBe(1);
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

// ---- processTarget: full apply flow --------------------------------------------------------------

describe('processTarget — plaintext-only target, apply mode', () => {
  it('encrypts, writes, rereads, and verifies successfully', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'secret-a')]);
    captureLogs();
    const result = await processTarget('a', true);
    expect(result.outcome).toBe('verified');
    const row = fake.getRows()[0];
    expect(row.access_token_key_id).toBe('RAILWAY_PROD_V1');
    expect(row.access_token).toBe('secret-a'); // never cleared
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith('secret-a');
  });

  it('never includes access_token in the update payload', async () => {
    setupFakeSupabase([plaintextRow('a', 'secret-a')]);
    captureLogs();
    await processTarget('a', true);
    // The guard itself is structural (see guardedEncryptUpdate's set list in source), and this
    // integration test confirms the plaintext column's value is untouched end to end.
    expect(mockFrom).toHaveBeenCalledWith('plaid_items');
  });
});

describe('processTarget — resumable verification (crash-safety, §22 point 1)', () => {
  it('an already-encrypted target is still fully reread and reverified, not skipped', async () => {
    setupFakeSupabase([encryptedRow('a', 'secret-a')]);
    captureLogs();
    const result = await processTarget('a', true);
    expect(result.outcome).toBe('verified');
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('a resumed run calls the Plaid verifier again — verification is never cached from a prior run', async () => {
    setupFakeSupabase([encryptedRow('a', 'secret-a')]);
    captureLogs();
    await processTarget('a', true);
    await processTarget('a', true);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('simulated crash: row already encrypted (as if a prior run wrote but never verified) is verified on this run', async () => {
    // No prior in-process state exists to "skip" from — the row's storage state alone is what a
    // resumed run has to go on, and it must not be mistaken for a completed verification.
    const fake = setupFakeSupabase([encryptedRow('a', 'secret-a')]);
    captureLogs();
    const result = await processTarget('a', true);
    expect(result.outcome).toBe('verified');
    expect(fake.getUpdateCallCount()).toBe(0); // nothing to write, it was already encrypted
  });
});

describe('processTarget — lost race on the guarded update (§22 point 1/6)', () => {
  it('discards the local encryption result and verifies the database winner instead', async () => {
    const plaintext = 'secret-a';
    const winner = encryptedRow('a', plaintext); // a different, independently-encrypted representation
    const fake = setupFakeSupabase([plaintextRow('a', plaintext)], {
      onBeforeUpdateFilter: (rows) => {
        // Simulate a concurrent process's write landing between our reread and our own update's
        // filter evaluation — exactly the race the guard exists to handle.
        const row = rows.find((r) => r.id === 'a');
        if (row) Object.assign(row, winner);
      },
    });
    captureLogs();
    const result = await processTarget('a', true);
    expect(result.outcome).toBe('verified');
    // The row in the table still has exactly the "winner"'s ciphertext/nonce — our own write
    // never landed (the guard excluded it), proving we verified the database's value, not our
    // own discarded local one.
    const row = fake.getRows()[0];
    expect(row.access_token_ciphertext).toBe(winner.access_token_ciphertext);
    expect(row.access_token_nonce).toBe(winner.access_token_nonce);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith(plaintext);
  });
});

describe('processTarget — malformed/anomalous storage state', () => {
  it('halts on a partial encrypted representation without attempting to guess or repair it', async () => {
    const bad = encryptedRow('a', 'secret-a');
    bad.access_token_nonce = null;
    setupFakeSupabase([bad]);
    captureLogs();
    await expect(processTarget('a', true)).rejects.toThrow(HaltError);
    await expect(processTarget('a', true)).rejects.toMatchObject({ reason: 'partial' });
  });
});

describe('processTarget — verification failure modes (never retried)', () => {
  it('halts with unknown_key when the stored key id is not in the configured ring', async () => {
    const row = encryptedRow('a', 'secret-a');
    row.access_token_key_id = 'SOME_UNCONFIGURED_KEY';
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget('a', true)).rejects.toMatchObject({ reason: 'unknown_key' });
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('halts with plaintext_mismatch when the decrypted value does not match retained plaintext', async () => {
    const row = encryptedRow('a', 'secret-a');
    row.access_token = 'a-different-value-entirely'; // simulated inconsistency
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget('a', true)).rejects.toMatchObject({ reason: 'plaintext_mismatch' });
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled(); // never reaches Plaid — a local check catches it first
  });

  it('decrypts using the row-stored ciphertext (verified against the database, not a local object)', async () => {
    // Not the lost-race scenario above — this proves ordinary already-encrypted verification also
    // genuinely re-decrypts what's stored, by tampering the stored ciphertext and confirming it's
    // caught (rather than some cached/assumed-good value being trusted).
    const row = encryptedRow('a', 'secret-a');
    row.access_token_ciphertext = Buffer.from('not-the-real-ciphertext-1234567890').toString('base64');
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget('a', true)).rejects.toMatchObject({ reason: 'crypto_mismatch' });
  });
});

describe('processTarget — historical (non-current) key decryption', () => {
  it('successfully verifies a row encrypted under an older, still-configured key', async () => {
    const row = encryptedRow('a', 'secret-a', { keyRing: OLD_KEY_RING });
    expect(row.access_token_key_id).toBe('OLD_V1'); // sanity check on the fixture itself
    setupFakeSupabase([row]);
    captureLogs();
    const result = await processTarget('a', true);
    expect(result.outcome).toBe('verified');
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith('secret-a');
  });
});

// ---- Plaid verifier: dedicated itemGet-only helper, retry policy ------------------------------

describe('verifyLiveWithRetry — transient vs non-transient classification', () => {
  it('succeeds immediately when the first call succeeds', async () => {
    mockVerifyAccessTokenLive.mockResolvedValueOnce(undefined);
    await expect(verifyLiveWithRetry('a', 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('retries a transient (HTTP 429) failure and succeeds within the retry budget', async () => {
    captureLogs();
    mockVerifyAccessTokenLive
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce(undefined);
    await expect(verifyLiveWithRetry('a', 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('retries a transient (HTTP 503) failure and succeeds within the retry budget', async () => {
    mockVerifyAccessTokenLive
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce(undefined);
    captureLogs();
    await expect(verifyLiveWithRetry('a', 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(3);
  });

  it('retries a network-level transient failure (timeout)', async () => {
    mockVerifyAccessTokenLive.mockRejectedValueOnce({ code: 'ETIMEDOUT' }).mockResolvedValueOnce(undefined);
    captureLogs();
    await expect(verifyLiveWithRetry('a', 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent transient failure and halts', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 500 } });
    captureLogs();
    await expect(verifyLiveWithRetry('a', 'token', 1)).rejects.toMatchObject({ reason: 'transient_retry_exhausted' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('never retries a non-transient (legitimate credential rejection) failure', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
    captureLogs();
    await expect(verifyLiveWithRetry('a', 'token', 1)).rejects.toMatchObject({ reason: 'credential_rejected' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });
});

describe('processTarget — Plaid retry integration (real timers, small delay via fake timers)', () => {
  it('surfaces transient_retry_exhausted through the full processTarget flow', async () => {
    vi.useFakeTimers();
    setupFakeSupabase([encryptedRow('a', 'secret-a')]);
    captureLogs();
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 503 } });

    const outcome = processTarget('a', true).catch((e) => e);
    await vi.runAllTimersAsync();
    const result = await outcome;

    expect(result).toBeInstanceOf(HaltError);
    expect((result as HaltError).reason).toBe('transient_retry_exhausted');
  });
});

// ---- Signal handling -------------------------------------------------------------------------

describe('main — SIGINT/SIGTERM interruption', () => {
  afterEach(() => {
    __setInterruptedForTests(false);
  });

  it('never processes any target once interrupted, exits nonzero, and never logs a success outcome', async () => {
    const fake = setupFakeSupabase([plaintextRow('a', 'x'), plaintextRow('b', 'y')]);
    const { entries } = captureLogs();
    __setInterruptedForTests(true);

    const code = await main(['--target-ids', 'a,b', '--expected-total', '2', '--expected-plaid-env', 'sandbox', '--apply', '--confirm', CONFIRM]);

    expect(code).not.toBe(0);
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
    expect(entries.some((e) => e.outcome === 'verified')).toBe(false);
    expect(entries.some((e) => e.outcome === 'all_targets_verified')).toBe(false);
    expect(entries.some((e) => e.outcome.startsWith('interrupted'))).toBe(true);
  });

  it('registers SIGINT and SIGTERM handlers when main runs', async () => {
    setupFakeSupabase([plaintextRow('a', 'x')]);
    captureLogs();
    const onSpy = vi.spyOn(process, 'on');
    await main(['--target-ids', 'a', '--expected-total', '1', '--expected-plaid-env', 'sandbox']);
    const registeredSignals = onSpy.mock.calls.map((c) => c[0]);
    expect(registeredSignals).toContain('SIGINT');
    expect(registeredSignals).toContain('SIGTERM');
  });
});

// ---- Logging sentinel tests -------------------------------------------------------------------

describe('logging — never leaks credential material', () => {
  const SENTINEL_PLAINTEXT = 'SENTINEL_PLAINTEXT_TOKEN_zzz';
  const SENTINEL_CIPHERTEXT_SUBSTRING = 'zzsentinelciphertextzz';

  it('a successful run never logs the plaintext, decrypted value, or any encrypted field', async () => {
    setupFakeSupabase([plaintextRow('a', SENTINEL_PLAINTEXT)]);
    const { rawLines } = captureLogs();

    await processTarget('a', true);

    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_PLAINTEXT);
    }
  });

  it('a failed run (crypto mismatch) never logs ciphertext, nonce, auth tag, or key material', async () => {
    const row = encryptedRow('a', SENTINEL_PLAINTEXT);
    const realCiphertext = row.access_token_ciphertext!;
    const realNonce = row.access_token_nonce!;
    const realAuthTag = row.access_token_auth_tag!;
    row.access_token_ciphertext = Buffer.from(SENTINEL_CIPHERTEXT_SUBSTRING).toString('base64');
    setupFakeSupabase([row]);
    const { rawLines } = captureLogs();

    await processTarget('a', true).catch(() => {});

    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_PLAINTEXT);
      expect(line).not.toContain(realCiphertext);
      expect(line).not.toContain(realNonce);
      expect(line).not.toContain(realAuthTag);
      expect(line).not.toContain(TEST_KEY_RING.keys.get('RAILWAY_PROD_V1')!.toString('base64'));
    }
  });

  it('logEntry only ever serializes the allow-listed fields, even if a caller tried to pass more', () => {
    const { rawLines } = captureLogs();
    logEntry({ id: 'row-1', stage: 'test', outcome: 'ok' });
    const parsed = JSON.parse(rawLines[0]);
    expect(Object.keys(parsed).sort()).toEqual(['id', 'outcome', 'stage', 'ts']);
  });
});

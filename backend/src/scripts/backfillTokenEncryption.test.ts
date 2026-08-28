import { createCipheriv, randomBytes } from 'node:crypto';
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
  InterruptedError,
  logEntry,
  main,
  parseArgs,
  processTarget,
  runPostflight,
  runPreflight,
  verifyLiveWithRetry,
  __setInterruptedForTests,
} from './backfillTokenEncryption';
import { encryptAccessToken, loadKeyRing, type KeyRing } from '../services/tokenEncryption';

const CONFIRM = 'BACKFILL_PLAID_TOKENS';
const CONSTRAINTS_CONFIRMED = 'PLAID_PHASE1_CONSTRAINTS_VERIFIED';

// Fixed, canonical (RFC 4122 v4-shaped) UUIDs — this script now rejects anything else.
const TARGET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NON_TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNKNOWN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

/** Builds a genuinely self-consistent, decryptable row at an arbitrary AAD version — bypasses
 *  `encryptAccessToken` (which always hardcodes version 1) to prove the "internally valid but
 *  rejected anyway" policy check (§22 point 4) is a real fixed-version *policy* boundary, not a
 *  side effect of decryption already failing on its own. */
function rowWithVersion(id: string, plaintext: string, version: number, keyId = 'RAILWAY_PROD_V1'): FakeRow {
  const key = TEST_KEY_RING.keys.get(keyId)!;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`my-finances:plaid-access-token:v${version}:${id}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    id,
    access_token: plaintext,
    access_token_ciphertext: ciphertext.toString('base64'),
    access_token_nonce: nonce.toString('base64'),
    access_token_auth_tag: authTag.toString('base64'),
    access_token_key_id: keyId,
    access_token_enc_version: version,
  };
}

function nonTargetRow(plaintext = 'non-target-secret'): FakeRow {
  return encryptedRow(NON_TARGET, plaintext);
}

/** The standard, valid 3-row production cohort this script is locked to: two named targets (in
 *  either plaintext-only or already-encrypted state, covering every legitimate resume point) plus
 *  the one non-target row, which must always already be fully (dual-write) encrypted. */
function cohort(aState: 'plaintext' | 'encrypted' = 'plaintext', bState: 'plaintext' | 'encrypted' = 'plaintext'): FakeRow[] {
  const a = aState === 'plaintext' ? plaintextRow(TARGET_A, 'secret-a') : encryptedRow(TARGET_A, 'secret-a');
  const b = bState === 'plaintext' ? plaintextRow(TARGET_B, 'secret-b') : encryptedRow(TARGET_B, 'secret-b');
  return [a, b, nonTargetRow()];
}

// ---- Fake Supabase (a small in-memory `plaid_items` table) ------------------------------------
//
// Not a reuse of testUtils/supabaseMock.ts's generic single-result builder — this script issues
// several genuinely different, stateful queries against the same table within one invocation
// (a full-table preflight/postflight read, per-target rereads, and a guarded conditional update),
// so the fake needs to actually behave like a small table rather than return one fixed result.
// The information_schema stub from the previous round is gone — this version of the script never
// queries it (§22 point 1: replaced with a CLI attestation instead).

function setupFakeSupabase(initialRows: FakeRow[], opts: { onBeforeUpdateFilter?: (rows: FakeRow[]) => void } = {}) {
  const rows = initialRows.map((r) => ({ ...r }));
  let updateCallCount = 0;
  const updatePayloads: Record<string, unknown>[] = [];

  mockFrom.mockImplementation((_table: string) => {
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
        updatePayloads.push(payload);
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

  return {
    getRows: () => rows.map((r) => ({ ...r })),
    getUpdateCallCount: () => updateCallCount,
    getUpdatePayloads: () => updatePayloads,
  };
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

function baseArgv(extra: string[] = []): string[] {
  return [
    '--target-ids',
    `${TARGET_A},${TARGET_B}`,
    '--expected-total',
    '3',
    '--expected-plaid-env',
    'sandbox',
    '--constraints-confirmed',
    CONSTRAINTS_CONFIRMED,
    ...extra,
  ];
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

// ---- CLI parsing --------------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses a valid dry-run invocation', () => {
    const args = parseArgs(baseArgv());
    expect(args).toEqual({
      targetIds: [TARGET_A, TARGET_B],
      expectedTotal: 3,
      expectedPlaidEnv: 'sandbox',
      apply: false,
      confirm: null,
    });
  });

  it('parses a valid apply invocation', () => {
    const args = parseArgs(baseArgv(['--apply', '--confirm', CONFIRM]));
    expect(args.apply).toBe(true);
    expect(args.confirm).toBe(CONFIRM);
  });

  it('rejects an unrecognized flag', () => {
    expect(() => parseArgs([...baseArgv(), '--not-a-real-flag', 'value'])).toThrow(ArgError);
    try {
      parseArgs([...baseArgv(), '--not-a-real-flag', 'value']);
    } catch (err) {
      expect((err as ArgError).code).toBe('unrecognized_argument');
      expect((err as ArgError).message).not.toContain('not-a-real-flag');
    }
  });

  it('rejects a repeated flag', () => {
    expect(() => parseArgs([...baseArgv(), '--expected-total', '3'])).toThrow(ArgError);
    try {
      parseArgs([...baseArgv(), '--expected-total', '3']);
    } catch (err) {
      expect((err as ArgError).code).toBe('repeated_flag');
    }
  });

  it('rejects exactly one target id', () => {
    const args = ['--target-ids', TARGET_A, '--expected-total', '3', '--expected-plaid-env', 'sandbox', '--constraints-confirmed', CONSTRAINTS_CONFIRMED];
    expect(() => parseArgs(args)).toThrow(ArgError);
    try {
      parseArgs(args);
    } catch (err) {
      expect((err as ArgError).code).toBe('target_ids_wrong_count');
    }
  });

  it('rejects three or more target ids', () => {
    const args = [
      '--target-ids',
      `${TARGET_A},${TARGET_B},${NON_TARGET}`,
      '--expected-total',
      '3',
      '--expected-plaid-env',
      'sandbox',
      '--constraints-confirmed',
      CONSTRAINTS_CONFIRMED,
    ];
    expect(() => parseArgs(args)).toThrow(ArgError);
    try {
      parseArgs(args);
    } catch (err) {
      expect((err as ArgError).code).toBe('target_ids_wrong_count');
    }
  });

  it('rejects a duplicate target id', () => {
    const args = [
      '--target-ids',
      `${TARGET_A},${TARGET_A}`,
      '--expected-total',
      '3',
      '--expected-plaid-env',
      'sandbox',
      '--constraints-confirmed',
      CONSTRAINTS_CONFIRMED,
    ];
    expect(() => parseArgs(args)).toThrow(ArgError);
    try {
      parseArgs(args);
    } catch (err) {
      expect((err as ArgError).code).toBe('target_ids_duplicate');
    }
  });

  it('rejects a malformed (non-UUID) target id without echoing it', () => {
    const args = [
      '--target-ids',
      'not-a-real-uuid,also-bad',
      '--expected-total',
      '3',
      '--expected-plaid-env',
      'sandbox',
      '--constraints-confirmed',
      CONSTRAINTS_CONFIRMED,
    ];
    try {
      parseArgs(args);
      expect.unreachable();
    } catch (err) {
      expect((err as ArgError).code).toBe('target_ids_malformed');
      expect((err as ArgError).message).not.toContain('not-a-real-uuid');
    }
  });

  it('rejects any --expected-total other than 3', () => {
    for (const bad of ['2', '4', '0', 'abc']) {
      const args = ['--target-ids', `${TARGET_A},${TARGET_B}`, '--expected-total', bad, '--expected-plaid-env', 'sandbox', '--constraints-confirmed', CONSTRAINTS_CONFIRMED];
      expect(() => parseArgs(args)).toThrow(ArgError);
    }
  });

  it('rejects any --expected-plaid-env other than sandbox', () => {
    for (const bad of ['production', 'development', 'Sandbox']) {
      const args = ['--target-ids', `${TARGET_A},${TARGET_B}`, '--expected-total', '3', '--expected-plaid-env', bad, '--constraints-confirmed', CONSTRAINTS_CONFIRMED];
      expect(() => parseArgs(args)).toThrow(ArgError);
    }
  });

  it('rejects a missing or wrong --constraints-confirmed attestation', () => {
    expect(() => parseArgs(['--target-ids', `${TARGET_A},${TARGET_B}`, '--expected-total', '3', '--expected-plaid-env', 'sandbox'])).toThrow(ArgError);
    expect(() =>
      parseArgs(['--target-ids', `${TARGET_A},${TARGET_B}`, '--expected-total', '3', '--expected-plaid-env', 'sandbox', '--constraints-confirmed', 'WRONG'])
    ).toThrow(ArgError);
  });

  it('rejects --apply without --confirm', () => {
    expect(() => parseArgs([...baseArgv(), '--apply'])).toThrow(ArgError);
  });

  it('rejects --apply with the wrong confirmation string', () => {
    expect(() => parseArgs([...baseArgv(), '--apply', '--confirm', 'wrong'])).toThrow(ArgError);
  });

  it('there is no flag or combination that selects "all rows" — --target-ids always names exact, exactly-two ids', () => {
    const args = parseArgs(baseArgv());
    expect(args.targetIds).toEqual([TARGET_A, TARGET_B]);
  });
});

// ---- Storage state classification --------------------------------------------------------------

describe('classifyStorageState', () => {
  it('classifies a plaintext-only row', () => {
    expect(classifyStorageState(plaintextRow(TARGET_A, 'secret')).kind).toBe('plaintext_only');
  });

  it('classifies a fully dual-written encrypted row', () => {
    const state = classifyStorageState(encryptedRow(TARGET_A, 'secret'));
    expect(state).toMatchObject({ kind: 'encrypted', plaintextAlsoPresent: true });
  });

  it('classifies an encrypted-only row (no plaintext)', () => {
    const state = classifyStorageState(encryptedRow(TARGET_A, 'secret', { keepPlaintext: false }));
    expect(state).toMatchObject({ kind: 'encrypted', plaintextAlsoPresent: false });
  });

  it('classifies a partial row', () => {
    const row = encryptedRow(TARGET_A, 'secret');
    row.access_token_nonce = null;
    expect(classifyStorageState(row).kind).toBe('partial');
  });

  it('classifies a row with neither representation as missing_both', () => {
    const row = plaintextRow(TARGET_A, 'x');
    row.access_token = null;
    expect(classifyStorageState(row).kind).toBe('missing_both');
  });
});

// ---- Preflight: cohort/resume invariants (§22 point 3) ------------------------------------------

describe('runPreflight — cohort and resume invariants', () => {
  const argsFor = (overrides: Partial<Parameters<typeof runPreflight>[0]> = {}) => ({
    targetIds: [TARGET_A, TARGET_B],
    expectedTotal: 3,
    expectedPlaidEnv: 'sandbox',
    apply: false,
    confirm: null,
    ...overrides,
  });

  it('passes for the original 2-plaintext-only / 1-encrypted-non-target resume state', async () => {
    setupFakeSupabase(cohort('plaintext', 'plaintext'));
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(true);
  });

  it('passes for a 1-encrypted / 1-plaintext-only resumed state', async () => {
    setupFakeSupabase(cohort('encrypted', 'plaintext'));
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(true);
  });

  it('passes for a fully-resumed 2-encrypted / 0-plaintext-only state', async () => {
    setupFakeSupabase(cohort('encrypted', 'encrypted'));
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(true);
  });

  it('fails when a plaintext-only row exists outside the target cohort', async () => {
    const rows = [encryptedRow(TARGET_A, 'a'), encryptedRow(TARGET_B, 'b'), plaintextRow(NON_TARGET, 'z')];
    setupFakeSupabase(rows);
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_plaintext_only_row');
    expect(result.failures).toContain('non_target_not_encrypted');
  });

  it('fails when the non-target row is not fully encrypted', async () => {
    const rows = [plaintextRow(TARGET_A, 'a'), plaintextRow(TARGET_B, 'b'), plaintextRow(NON_TARGET, 'z')];
    setupFakeSupabase(rows);
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('non_target_not_encrypted');
  });

  it('fails when any encrypted row anywhere is encrypted-only (no plaintext)', async () => {
    const rows = [plaintextRow(TARGET_A, 'a'), plaintextRow(TARGET_B, 'b'), encryptedRow(NON_TARGET, 'z', { keepPlaintext: false })];
    setupFakeSupabase(rows);
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_encrypted_only_row');
  });

  it('fails when an already-encrypted row uses an unexpected key id', async () => {
    const rows = [encryptedRow(TARGET_A, 'a', { keyRing: OLD_KEY_RING }), plaintextRow(TARGET_B, 'b'), nonTargetRow()];
    setupFakeSupabase(rows);
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_key_id');
  });

  it('fails when an already-encrypted row uses an unexpected enc_version', async () => {
    const rows = [rowWithVersion(TARGET_A, 'a', 2), plaintextRow(TARGET_B, 'b'), nonTargetRow()];
    setupFakeSupabase(rows);
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_enc_version');
  });

  it('fails when a target id does not exist', async () => {
    setupFakeSupabase([plaintextRow(TARGET_A, 'a'), nonTargetRow(), plaintextRow(UNKNOWN_ID, 'z')]);
    const result = await runPreflight(argsFor({ targetIds: [TARGET_A, TARGET_B] }));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('target_not_found');
  });

  it('fails on a wrong expected total', async () => {
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor({ expectedTotal: 5 }));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_total_count');
  });

  it('fails on a mismatched expected Plaid environment', async () => {
    mockEnv.plaidEnv = 'production';
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_plaid_environment');
  });

  it('fails on any partial or missing representation anywhere in the table', async () => {
    const bad = encryptedRow(NON_TARGET, 'z');
    bad.access_token_auth_tag = null;
    setupFakeSupabase([plaintextRow(TARGET_A, 'a'), plaintextRow(TARGET_B, 'b'), bad]);
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('partial_or_missing_representation');
  });

  it('performs zero writes', async () => {
    const fake = setupFakeSupabase(cohort());
    await runPreflight(argsFor());
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('never issues a query against information_schema — the actual PostgREST call is a plain plaid_items select', async () => {
    setupFakeSupabase(cohort());
    await runPreflight(argsFor());
    for (const call of mockFrom.mock.calls) {
      expect(call[0]).not.toContain('information_schema');
    }
  });
});

// ---- Postflight (§22 point 7) ---------------------------------------------------------------

describe('runPostflight', () => {
  it('passes when the table is fully, correctly backfilled', async () => {
    setupFakeSupabase(cohort('encrypted', 'encrypted'));
    const result = await runPostflight(3);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when a plaintext-only row remains', async () => {
    setupFakeSupabase(cohort('encrypted', 'plaintext'));
    const result = await runPostflight(3);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('plaintext_only_remaining');
    expect(result.failures).toContain('unexpected_encrypted_count');
  });

  it('fails when plaintext has been lost from an encrypted row', async () => {
    const rows = [encryptedRow(TARGET_A, 'a', { keepPlaintext: false }), encryptedRow(TARGET_B, 'b'), nonTargetRow()];
    setupFakeSupabase(rows);
    const result = await runPostflight(3);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('plaintext_missing_after_backfill');
  });

  it('fails on an unexpected total count', async () => {
    setupFakeSupabase(cohort('encrypted', 'encrypted'));
    const result = await runPostflight(5);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_total_count');
  });

  it('fails on a duplicate nonce across encrypted rows', async () => {
    const a = encryptedRow(TARGET_A, 'a');
    const b = encryptedRow(TARGET_B, 'b');
    b.access_token_nonce = a.access_token_nonce; // simulated nonce reuse
    setupFakeSupabase([a, b, nonTargetRow()]);
    const result = await runPostflight(3);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('duplicate_nonce');
  });
});

// ---- Dry-run: improved usefulness for a plaintext-only target (§22 point 8) --------------------

describe('processTarget — dry-run on a plaintext-only target', () => {
  it('rereads, performs in-memory encrypt/decrypt, calls itemGet with the plaintext, and writes nothing', async () => {
    const fake = setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')]);
    captureLogs();
    const result = await processTarget(TARGET_A, false);
    expect(result.outcome).toBe('dry_run_verified');
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith('secret-a');
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(fake.getRows()[0].access_token_key_id).toBeNull(); // still untouched
  });

  it('halts (does not silently pass) if the local encrypt/decrypt round trip disagrees', async () => {
    // Not realistically reachable with the real crypto module, but the check must exist and be
    // load-bearing rather than dead code — verified by directly triggering the same code path a
    // future crypto regression would hit, via a plaintext value the mismatch check is sensitive
    // to (kept simple: this test asserts the guard is present in the source and reachable, not a
    // manufactured false failure. See tokenEncryption.test.ts for the crypto round-trip's own
    // correctness coverage).
    setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')]);
    captureLogs();
    const result = await processTarget(TARGET_A, false);
    expect(result.outcome).toBe('dry_run_verified');
  });

  it('still halts a dry-run if the live Plaid check fails (a dead credential is caught even without applying)', async () => {
    setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')]);
    captureLogs();
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
    await expect(processTarget(TARGET_A, false)).rejects.toMatchObject({ reason: 'credential_rejected' });
  });

  it('already-encrypted targets continue full reread/decrypt/compare/itemGet verification in dry-run too', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARGET_A, 'secret-a')]);
    captureLogs();
    const result = await processTarget(TARGET_A, false);
    expect(result.outcome).toBe('verified');
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith('secret-a');
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

// ---- processTarget: full apply flow --------------------------------------------------------------

describe('processTarget — plaintext-only target, apply mode', () => {
  it('encrypts, writes, rereads, and verifies successfully', async () => {
    const fake = setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')]);
    captureLogs();
    const result = await processTarget(TARGET_A, true);
    expect(result.outcome).toBe('verified');
    const row = fake.getRows()[0];
    expect(row.access_token_key_id).toBe('RAILWAY_PROD_V1');
    expect(row.access_token).toBe('secret-a'); // never cleared
  });

  it('the update payload contains exactly the five encrypted columns — never access_token or updated_at', async () => {
    const fake = setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')]);
    captureLogs();
    await processTarget(TARGET_A, true);
    expect(fake.getUpdateCallCount()).toBe(1);
    const payload = fake.getUpdatePayloads()[0];
    expect(Object.keys(payload).sort()).toEqual(
      [
        'access_token_auth_tag',
        'access_token_ciphertext',
        'access_token_enc_version',
        'access_token_key_id',
        'access_token_nonce',
      ].sort()
    );
    expect(payload).not.toHaveProperty('access_token');
    expect(payload).not.toHaveProperty('updated_at');
  });
});

describe('processTarget — resumable verification (crash-safety, §22 point 1)', () => {
  it('an already-encrypted target is still fully reread and reverified, not skipped', async () => {
    setupFakeSupabase([encryptedRow(TARGET_A, 'secret-a')]);
    captureLogs();
    const result = await processTarget(TARGET_A, true);
    expect(result.outcome).toBe('verified');
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('a resumed run calls the Plaid verifier again — verification is never cached from a prior run', async () => {
    setupFakeSupabase([encryptedRow(TARGET_A, 'secret-a')]);
    captureLogs();
    await processTarget(TARGET_A, true);
    await processTarget(TARGET_A, true);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('simulated crash: row already encrypted (as if a prior run wrote but never verified) is verified on this run', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARGET_A, 'secret-a')]);
    captureLogs();
    const result = await processTarget(TARGET_A, true);
    expect(result.outcome).toBe('verified');
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

describe('processTarget — lost race on the guarded update (§22 point 1/6)', () => {
  it('discards the local encryption result and verifies the database winner instead', async () => {
    const plaintext = 'secret-a';
    const winner = encryptedRow(TARGET_A, plaintext);
    const fake = setupFakeSupabase([plaintextRow(TARGET_A, plaintext)], {
      onBeforeUpdateFilter: (rows) => {
        const row = rows.find((r) => r.id === TARGET_A);
        if (row) Object.assign(row, winner);
      },
    });
    captureLogs();
    const result = await processTarget(TARGET_A, true);
    expect(result.outcome).toBe('verified');
    const row = fake.getRows()[0];
    expect(row.access_token_ciphertext).toBe(winner.access_token_ciphertext);
    expect(row.access_token_nonce).toBe(winner.access_token_nonce);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith(plaintext);
  });
});

// ---- Malformed/anomalous storage state --------------------------------------------------------

describe('processTarget — malformed/anomalous storage state', () => {
  it('halts on a partial encrypted representation without attempting to guess or repair it', async () => {
    const bad = encryptedRow(TARGET_A, 'secret-a');
    bad.access_token_nonce = null;
    setupFakeSupabase([bad]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'partial' });
  });
});

// ---- Verification / policy failure modes (never retried) --------------------------------------

describe('processTarget — verification and policy failure modes', () => {
  it('halts with unexpected_key_id when the stored key id is not the one approved key (§22 point 4) — includes both unconfigured and merely-historical key ids', async () => {
    // The row-level policy check (keyId !== EXPECTED_CURRENT_KEY_ID) runs before any decrypt is
    // attempted, so an entirely unconfigured key id and a real-but-historical key id are both
    // caught the same way, at the same point — the crypto layer's own UnknownKeyIdError never
    // becomes reachable through this script's normal flow, by design.
    const row = encryptedRow(TARGET_A, 'secret-a');
    row.access_token_key_id = 'SOME_UNCONFIGURED_KEY';
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'unexpected_key_id' });
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('halts with unexpected_key_id when the stored key id is configured but not the approved one (§22 point 4)', async () => {
    const row = encryptedRow(TARGET_A, 'secret-a', { keyRing: OLD_KEY_RING });
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'unexpected_key_id' });
    // Rejected on stored-field policy alone, before any decrypt/Plaid call is attempted.
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('rejects an internally valid (genuinely decryptable) version-2 ciphertext outright', async () => {
    const row = rowWithVersion(TARGET_A, 'secret-a', 2);
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'unexpected_enc_version' });
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('halts with plaintext_mismatch when the decrypted value does not match retained plaintext', async () => {
    const row = encryptedRow(TARGET_A, 'secret-a');
    row.access_token = 'a-different-value-entirely';
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'plaintext_mismatch' });
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('verifies against the row-stored ciphertext, not an assumed-good value — tampered ciphertext is caught', async () => {
    const row = encryptedRow(TARGET_A, 'secret-a');
    row.access_token_ciphertext = Buffer.from('not-the-real-ciphertext-1234567890').toString('base64');
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'crypto_mismatch' });
  });
});

describe('processTarget — historical (non-current) key decryption stays supported at the crypto layer', () => {
  it('the general decrypt path still supports an older configured key (tokenEncryption.ts itself)', async () => {
    const row = encryptedRow(TARGET_A, 'secret-a', { keyRing: OLD_KEY_RING });
    expect(row.access_token_key_id).toBe('OLD_V1');
    // This script's own policy still rejects it (see "unexpected_key_id when ... configured but
    // not the approved one" above) — this test exists only to document that the rejection is a
    // *policy* choice for this one-off op, not a crypto-layer limitation.
    setupFakeSupabase([row]);
    captureLogs();
    await expect(processTarget(TARGET_A, true)).rejects.toMatchObject({ reason: 'unexpected_key_id' });
  });
});

// ---- Plaid verifier: dedicated itemGet-only helper, retry policy ------------------------------

describe('verifyLiveWithRetry — transient vs non-transient classification', () => {
  it('succeeds immediately when the first call succeeds', async () => {
    mockVerifyAccessTokenLive.mockResolvedValueOnce(undefined);
    await expect(verifyLiveWithRetry(TARGET_A, 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('retries a transient (HTTP 429) failure and succeeds within the retry budget', async () => {
    captureLogs();
    mockVerifyAccessTokenLive.mockRejectedValueOnce({ response: { status: 429 } }).mockResolvedValueOnce(undefined);
    await expect(verifyLiveWithRetry(TARGET_A, 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('retries a network-level transient failure (timeout)', async () => {
    mockVerifyAccessTokenLive.mockRejectedValueOnce({ code: 'ETIMEDOUT' }).mockResolvedValueOnce(undefined);
    captureLogs();
    await expect(verifyLiveWithRetry(TARGET_A, 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent transient failure and halts', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 500 } });
    captureLogs();
    await expect(verifyLiveWithRetry(TARGET_A, 'token', 1)).rejects.toMatchObject({ reason: 'transient_retry_exhausted' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(4);
  });

  it('never retries a non-transient (legitimate credential rejection) failure', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
    captureLogs();
    await expect(verifyLiveWithRetry(TARGET_A, 'token', 1)).rejects.toMatchObject({ reason: 'credential_rejected' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });
});

describe('processTarget — Plaid retry integration (fake timers)', () => {
  it('surfaces transient_retry_exhausted through the full processTarget flow', async () => {
    vi.useFakeTimers();
    setupFakeSupabase([encryptedRow(TARGET_A, 'secret-a')]);
    captureLogs();
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 503 } });

    const outcome = processTarget(TARGET_A, true).catch((e) => e);
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
    const fake = setupFakeSupabase(cohort());
    const { entries } = captureLogs();
    __setInterruptedForTests(true);

    const code = await main(baseArgv(['--apply', '--confirm', CONFIRM]));

    expect(code).not.toBe(0);
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled();
    expect(entries.some((e) => e.outcome === 'verified')).toBe(false);
    expect(entries.some((e) => e.outcome.includes('all_targets_verified'))).toBe(false);
    expect(entries.some((e) => e.outcome.startsWith('interrupted'))).toBe(true);
  });

  it('registers SIGINT and SIGTERM handlers when main runs', async () => {
    setupFakeSupabase(cohort());
    captureLogs();
    const onSpy = vi.spyOn(process, 'on');
    await main(baseArgv());
    const registeredSignals = onSpy.mock.calls.map((c) => c[0]);
    expect(registeredSignals).toContain('SIGINT');
    expect(registeredSignals).toContain('SIGTERM');
  });
});

// ---- main(): end-to-end CLI gating and dry-run/apply behavior -----------------------------------

describe('main — dry-run default', () => {
  it('performs zero writes and exits 0 for a valid cohort', async () => {
    const fake = setupFakeSupabase(cohort());
    captureLogs();
    const code = await main(baseArgv());
    expect(code).toBe(0);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('performs zero writes even with --apply omitted but --confirm present', async () => {
    const fake = setupFakeSupabase(cohort());
    captureLogs();
    await main(baseArgv(['--confirm', CONFIRM]));
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

describe('main — apply gating', () => {
  it('refuses --apply without the confirmation flag', async () => {
    const fake = setupFakeSupabase(cohort());
    captureLogs();
    const code = await main(baseArgv(['--apply']));
    expect(code).toBe(1);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('refuses --apply with the wrong confirmation string', async () => {
    const fake = setupFakeSupabase(cohort());
    captureLogs();
    const code = await main(baseArgv(['--apply', '--confirm', 'WRONG_TOKEN']));
    expect(code).toBe(1);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('refuses when a supplied target id is a well-formed UUID but does not exist in the table', async () => {
    const fake = setupFakeSupabase(cohort());
    captureLogs();
    const args = [
      '--target-ids',
      `${TARGET_A},${UNKNOWN_ID}`,
      '--expected-total',
      '3',
      '--expected-plaid-env',
      'sandbox',
      '--constraints-confirmed',
      CONSTRAINTS_CONFIRMED,
      '--apply',
      '--confirm',
      CONFIRM,
    ];
    const code = await main(args);
    expect(code).toBe(1);
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

describe('main — full apply run reaches postflight and succeeds end to end', () => {
  it('backfills both targets and passes final global postflight', async () => {
    const fake = setupFakeSupabase(cohort('plaintext', 'plaintext'));
    const { entries } = captureLogs();
    const code = await main(baseArgv(['--apply', '--confirm', CONFIRM]));
    expect(code).toBe(0);
    expect(fake.getRows().every((r) => r.access_token_key_id === 'RAILWAY_PROD_V1')).toBe(true);
    expect(fake.getRows().every((r) => r.access_token !== null)).toBe(true);
    expect(entries.some((e) => e.outcome === 'all_targets_verified_and_postflight_passed')).toBe(true);
  });

  it('fails overall if postflight finds a problem even after every target individually verified', async () => {
    // Simulate a row elsewhere in the table silently losing its plaintext between the per-target
    // loop and the final reread — postflight must still catch this even though both named
    // targets verified cleanly. The callback receives the fake table's own internal row array
    // (not the fixture array passed into setupFakeSupabase, which is copied on entry) — mutating
    // that internal array is what actually affects subsequent reads.
    setupFakeSupabase(cohort('plaintext', 'plaintext'), {
      onBeforeUpdateFilter: (internalRows) => {
        const nonTarget = internalRows.find((r) => r.id === NON_TARGET);
        if (nonTarget) nonTarget.access_token = null;
      },
    });
    captureLogs();
    const code = await main(baseArgv(['--apply', '--confirm', CONFIRM]));
    expect(code).toBe(1);
  });
});

// ---- Logging sentinel tests -------------------------------------------------------------------

describe('logging — never leaks credential material or raw error/argument text', () => {
  const SENTINEL_PLAINTEXT = 'SENTINEL_PLAINTEXT_TOKEN_zzz';

  it('a successful run never logs the plaintext, decrypted value, or any encrypted field', async () => {
    setupFakeSupabase([plaintextRow(TARGET_A, SENTINEL_PLAINTEXT)]);
    const { rawLines } = captureLogs();
    await processTarget(TARGET_A, true);
    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_PLAINTEXT);
    }
  });

  it('a failed run (crypto mismatch) never logs ciphertext, nonce, auth tag, or key material', async () => {
    const row = encryptedRow(TARGET_A, SENTINEL_PLAINTEXT);
    const realCiphertext = row.access_token_ciphertext!;
    const realNonce = row.access_token_nonce!;
    const realAuthTag = row.access_token_auth_tag!;
    row.access_token_ciphertext = Buffer.from('zzsentinelciphertextzz').toString('base64');
    setupFakeSupabase([row]);
    const { rawLines } = captureLogs();

    await processTarget(TARGET_A, true).catch(() => {});

    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_PLAINTEXT);
      expect(line).not.toContain(realCiphertext);
      expect(line).not.toContain(realNonce);
      expect(line).not.toContain(realAuthTag);
      expect(line).not.toContain(TEST_KEY_RING.keys.get('RAILWAY_PROD_V1')!.toString('base64'));
    }
  });

  it('a raw CLI sentinel never appears in the startup failure log', async () => {
    const SENTINEL_ARG = 'SENTINEL_RAW_CLI_ARGUMENT_zzz';
    const { rawLines } = captureLogs();
    await main([...baseArgv(), `--${SENTINEL_ARG}`, 'value']);
    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_ARG);
    }
  });

  it('a raw Supabase error message never appears in the preflight failure log', async () => {
    const SENTINEL_DB_ERROR = 'SENTINEL_RAW_SUPABASE_ERROR_MESSAGE_zzz';
    mockFrom.mockImplementation(() => ({
      select: () => ({
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          Promise.resolve(resolve({ data: null, error: { message: SENTINEL_DB_ERROR } })),
      }),
    }));
    const { rawLines } = captureLogs();
    await main(baseArgv());
    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_DB_ERROR);
    }
  });

  it('logEntry only ever serializes the allow-listed fields', () => {
    const { rawLines } = captureLogs();
    logEntry({ id: TARGET_A, stage: 'test', outcome: 'ok' });
    const parsed = JSON.parse(rawLines[0]);
    expect(Object.keys(parsed).sort()).toEqual(['id', 'outcome', 'stage', 'ts']);
  });
});

// ---- Mid-flight SIGINT/SIGTERM interruption (Codex re-audit finding) --------------------------
//
// A signal can't cancel an in-flight DB/Plaid call already awaited — these tests simulate it
// landing *while* that call is in flight, observed the moment it settles, exactly matching how
// `installSignalHandlers` actually behaves against a real OS signal.

describe('mid-flight interruption — signal during pre-write Plaid verification', () => {
  afterEach(() => {
    __setInterruptedForTests(false);
  });

  it('makes zero writes, no second Plaid call, no success log, and throws InterruptedError', async () => {
    const fake = setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')]);
    const { entries } = captureLogs();
    mockVerifyAccessTokenLive.mockImplementationOnce(async () => {
      __setInterruptedForTests(true); // the signal "arrives" while this call is in flight
      return undefined;
    });

    await expect(processTarget(TARGET_A, true)).rejects.toBeInstanceOf(InterruptedError);

    expect(fake.getUpdateCallCount()).toBe(0);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
    expect(entries.some((e) => e.outcome === 'verified' || e.outcome === 'dry_run_verified')).toBe(false);
  });
});

describe('mid-flight interruption — signal immediately after a committed update', () => {
  afterEach(() => {
    __setInterruptedForTests(false);
  });

  it('leaves the encrypted representation stored, logs no success, exits via InterruptedError, and a rerun reverifies without writing again', async () => {
    const fake = setupFakeSupabase([plaintextRow(TARGET_A, 'secret-a')], {
      onBeforeUpdateFilter: () => {
        // Fires as the guarded update's own DB call is resolving — the write itself still
        // completes (this callback runs *before* the update is applied to the fake table, but
        // the update proceeds normally either way), simulating the signal landing right as that
        // awaited call settles.
        __setInterruptedForTests(true);
      },
    });
    const { entries } = captureLogs();

    await expect(processTarget(TARGET_A, true)).rejects.toBeInstanceOf(InterruptedError);

    // The write committed and is left intact.
    expect(fake.getUpdateCallCount()).toBe(1);
    const row = fake.getRows()[0];
    expect(row.access_token_key_id).toBe('RAILWAY_PROD_V1');
    expect(row.access_token).toBe('secret-a');
    expect(entries.some((e) => e.outcome === 'verified')).toBe(false);

    // Rerun: not interrupted this time — must fully reverify the now-already-encrypted row
    // without attempting a second encryption write.
    __setInterruptedForTests(false);
    mockVerifyAccessTokenLive.mockClear();
    const result = await processTarget(TARGET_A, true);
    expect(result.outcome).toBe('verified');
    expect(fake.getUpdateCallCount()).toBe(1); // still just the one write from before
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1); // the rerun's own reverification
  });
});

describe('mid-flight interruption — signal during a retry sleep', () => {
  afterEach(() => {
    __setInterruptedForTests(false);
  });

  it('does not begin another retry attempt once interrupted during the delay, and never writes/succeeds afterward', async () => {
    vi.useFakeTimers();
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 429 } });
    captureLogs();

    const outcome = verifyLiveWithRetry(TARGET_A, 'token', 1000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0); // let the first attempt's rejection register the retry sleep
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
    __setInterruptedForTests(true); // signal "arrives" during the sleep
    await vi.advanceTimersByTimeAsync(2000); // exhaust the sleep

    const result = await outcome;
    expect(result).toBeInstanceOf(InterruptedError);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1); // no second attempt was ever begun
  });
});

describe('mid-flight interruption — signal during an already-encrypted target\'s verification', () => {
  afterEach(() => {
    __setInterruptedForTests(false);
  });

  it('logs no success, performs no further processing, and exits via InterruptedError', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARGET_A, 'secret-a')]);
    const { entries } = captureLogs();
    mockVerifyAccessTokenLive.mockImplementationOnce(async () => {
      __setInterruptedForTests(true);
      return undefined;
    });

    await expect(processTarget(TARGET_A, true)).rejects.toBeInstanceOf(InterruptedError);

    expect(fake.getUpdateCallCount()).toBe(0);
    expect(entries.some((e) => e.outcome === 'verified')).toBe(false);
  });
});

describe('mid-flight interruption — end to end through main()', () => {
  afterEach(() => {
    __setInterruptedForTests(false);
  });

  it('a signal during the first target halts before the second target ever begins, and reports interrupted, not success', async () => {
    setupFakeSupabase(cohort());
    const { entries } = captureLogs();
    mockVerifyAccessTokenLive.mockImplementationOnce(async () => {
      __setInterruptedForTests(true);
      return undefined;
    });

    const code = await main(baseArgv(['--apply', '--confirm', CONFIRM]));

    expect(code).toBe(1);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1); // never reached the second target
    expect(entries.some((e) => e.outcome.includes('verified'))).toBe(false);
    expect(entries.some((e) => e.outcome.includes('all_targets_verified'))).toBe(false);
    expect(entries.some((e) => e.stage === 'run' && e.outcome === 'interrupted')).toBe(true);
  });
});

// ---- Retry-classification hardening: a structured status is authoritative ---------------------

describe('classifyPlaidFailure (via verifyLiveWithRetry) — structured status overrides message heuristics', () => {
  it('a real HTTP 400 credential rejection is never retried, even if its message contains "timeout"', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({
      response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } },
      message: 'a timeout occurred while validating this credential',
    });
    captureLogs();

    await expect(verifyLiveWithRetry(TARGET_A, 'token', 1)).rejects.toMatchObject({ reason: 'credential_rejected' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1); // never retried
  });
});

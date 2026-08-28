import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks (established pattern, see backfillTokenEncryption.test.ts / dataService.test.ts) ---

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

const mockEnv = vi.hoisted(() => ({ plaidEnv: 'sandbox' }));
vi.mock('../config/env', () => ({ env: mockEnv }));

const mockVerifyAccessTokenLive = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', () => ({ verifyAccessTokenLive: mockVerifyAccessTokenLive }));

// Real crypto math still runs — only the environment-backed singleton is swapped for a fixed test
// key ring. Both V1 and V2 configured (mirroring the real transition window where V1 stays
// available), V2 current. A third, unrelated key exercises "some other configured-but-wrong key."
vi.mock('../services/tokenEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tokenEncryption')>();
  const testKeyRing = actual.loadKeyRing({
    PLAID_TOKEN_KEY_RAILWAY_PROD_V1: Buffer.alloc(32, 7).toString('base64'),
    PLAID_TOKEN_KEY_RAILWAY_PROD_V2: Buffer.alloc(32, 11).toString('base64'),
    PLAID_TOKEN_KEY_OTHER: Buffer.alloc(32, 13).toString('base64'),
    PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2',
  });
  // Wrapped in vi.fn (not a plain arrow function) specifically so the "degraded key-ring
  // configurations" describe block below can temporarily reconfigure its return value per test.
  return { ...actual, getKeyRing: vi.fn(() => testKeyRing) };
});

import {
  ArgError,
  classifyStorageState,
  HaltError,
  InterruptedError,
  logEntry,
  main,
  parseArgs,
  rotateTartan,
  runPreflight,
  verifyLiveWithRetry,
  __setInterruptedForTests,
} from './rotateTartanTokenKey';
import { encryptAccessToken, getKeyRing, loadKeyRing, type KeyRing } from '../services/tokenEncryption';

const CONFIRM = 'ROTATE_TARTAN_KEY_V1_TO_V2';
const CONSTRAINTS_CONFIRMED = 'PLAID_PHASE1_CONSTRAINTS_VERIFIED';

const TARTAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ID_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNKNOWN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const TEST_KEY_RING: KeyRing = loadKeyRing({
  PLAID_TOKEN_KEY_RAILWAY_PROD_V1: Buffer.alloc(32, 7).toString('base64'),
  PLAID_TOKEN_KEY_RAILWAY_PROD_V2: Buffer.alloc(32, 11).toString('base64'),
  PLAID_TOKEN_KEY_OTHER: Buffer.alloc(32, 13).toString('base64'),
  PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2',
});
const V1_KEY_RING: KeyRing = { currentKeyId: 'RAILWAY_PROD_V1', keys: TEST_KEY_RING.keys };
const OTHER_KEY_RING: KeyRing = { currentKeyId: 'OTHER', keys: TEST_KEY_RING.keys };

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
  const enc = encryptAccessToken(plaintext, opts.keyRing ?? V1_KEY_RING, id);
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

/** The standard, valid 3-row cohort: Tartan (V1 dual-write by default) plus two other,
 *  already-encrypted-on-V2 rows (representing the post-backfill state of the other two items —
 *  irrelevant to this tool beyond satisfying the fixed total-count preflight check). */
function cohort(tartanState: 'v1' | 'v2' = 'v1'): FakeRow[] {
  const tartan =
    tartanState === 'v1' ? encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING }) : encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: TEST_KEY_RING });
  return [tartan, encryptedRow(OTHER_ID_1, 'other-1', { keyRing: TEST_KEY_RING }), encryptedRow(OTHER_ID_2, 'other-2', { keyRing: TEST_KEY_RING })];
}

// ---- Fake Supabase --------------------------------------------------------------------------

function setupFakeSupabase(
  initialRows: FakeRow[],
  opts: { onBeforeUpdateFilter?: (rows: FakeRow[]) => void; forceZeroAffectedUpdate?: boolean } = {}
) {
  const rows = initialRows.map((r) => ({ ...r }));
  let updateCallCount = 0;
  const updatePayloads: Record<string, unknown>[] = [];
  const updateFilters: { eq: Record<string, unknown>; notNull: string[] }[] = [];

  mockFrom.mockImplementation((_table: string) => {
    let eqFilters: Record<string, unknown> = {};
    let notNullFilters: string[] = [];
    let mode: 'select' | 'update' = 'select';
    let updatePayload: Record<string, unknown> = {};

    const matches = () =>
      rows.filter((r) => {
        for (const [k, v] of Object.entries(eqFilters)) if ((r as Record<string, unknown>)[k] !== v) return false;
        for (const k of notNullFilters) if ((r as Record<string, unknown>)[k] === null) return false;
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
      not: (col: string, _op: string, _val: unknown) => {
        notNullFilters.push(col);
        return chain;
      },
      maybeSingle: async () => {
        const found = matches();
        return { data: found[0] ?? null, error: null };
      },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
        if (mode === 'update') {
          updateFilters.push({ eq: { ...eqFilters }, notNull: [...notNullFilters] });
          opts.onBeforeUpdateFilter?.(rows);
          if (opts.forceZeroAffectedUpdate) {
            // Reports zero rows affected without applying the payload — represents "the update
            // came back with zero rows" for whatever reason, decoupled from needing to construct
            // a scenario where the guard's own filter naturally excludes the row.
            return Promise.resolve(resolve({ data: [], error: null }));
          }
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
    getUpdateFilters: () => updateFilters,
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
    '--tartan-id',
    TARTAN_ID,
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
  __setInterruptedForTests(false);
});

// ---- CLI parsing --------------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses a valid dry-run invocation', () => {
    const args = parseArgs(baseArgv());
    expect(args).toEqual({
      tartanId: TARTAN_ID,
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

  it('rejects a missing --tartan-id', () => {
    expect(() => parseArgs(['--expected-total', '3', '--expected-plaid-env', 'sandbox', '--constraints-confirmed', CONSTRAINTS_CONFIRMED])).toThrow(
      ArgError
    );
  });

  it('rejects a malformed (non-UUID) --tartan-id without echoing it', () => {
    try {
      parseArgs(['--tartan-id', 'not-a-uuid', '--expected-total', '3', '--expected-plaid-env', 'sandbox', '--constraints-confirmed', CONSTRAINTS_CONFIRMED]);
      expect.unreachable();
    } catch (err) {
      expect((err as ArgError).code).toBe('tartan_id_malformed');
      expect((err as ArgError).message).not.toContain('not-a-uuid');
    }
  });

  it('rejects any --expected-total other than 3', () => {
    for (const bad of ['2', '4', 'abc']) {
      const args = ['--tartan-id', TARTAN_ID, '--expected-total', bad, '--expected-plaid-env', 'sandbox', '--constraints-confirmed', CONSTRAINTS_CONFIRMED];
      expect(() => parseArgs(args)).toThrow(ArgError);
    }
  });

  it('rejects any --expected-plaid-env other than sandbox', () => {
    const args = ['--tartan-id', TARTAN_ID, '--expected-total', '3', '--expected-plaid-env', 'production', '--constraints-confirmed', CONSTRAINTS_CONFIRMED];
    expect(() => parseArgs(args)).toThrow(ArgError);
  });

  it('rejects a missing or wrong constraints attestation', () => {
    expect(() => parseArgs(['--tartan-id', TARTAN_ID, '--expected-total', '3', '--expected-plaid-env', 'sandbox'])).toThrow(ArgError);
    expect(() =>
      parseArgs(['--tartan-id', TARTAN_ID, '--expected-total', '3', '--expected-plaid-env', 'sandbox', '--constraints-confirmed', 'WRONG'])
    ).toThrow(ArgError);
  });

  it('rejects --apply without --confirm', () => {
    expect(() => parseArgs([...baseArgv(), '--apply'])).toThrow(ArgError);
  });

  it('rejects --apply with the wrong confirmation string', () => {
    expect(() => parseArgs([...baseArgv(), '--apply', '--confirm', 'wrong'])).toThrow(ArgError);
  });

  it('rejects a repeated flag', () => {
    expect(() => parseArgs([...baseArgv(), '--expected-total', '3'])).toThrow(ArgError);
  });

  it('rejects an unrecognized flag without echoing it', () => {
    try {
      parseArgs([...baseArgv(), '--sentinel-unknown-flag-zzz', 'value']);
      expect.unreachable();
    } catch (err) {
      expect((err as ArgError).code).toBe('unrecognized_argument');
      expect((err as ArgError).message).not.toContain('sentinel-unknown-flag-zzz');
    }
  });
});

// ---- classifyStorageState ------------------------------------------------------------------------

describe('classifyStorageState', () => {
  it('classifies plaintext-only, encrypted, partial, and missing_both correctly', () => {
    expect(classifyStorageState(plaintextRow(TARTAN_ID, 'x')).kind).toBe('plaintext_only');
    expect(classifyStorageState(encryptedRow(TARTAN_ID, 'x')).kind).toBe('encrypted');
    const partial = encryptedRow(TARTAN_ID, 'x');
    partial.access_token_nonce = null;
    expect(classifyStorageState(partial).kind).toBe('partial');
    const missing = plaintextRow(TARTAN_ID, 'x');
    missing.access_token = null;
    expect(classifyStorageState(missing).kind).toBe('missing_both');
  });
});

// ---- Preflight: V1/V2 key-ring policy -------------------------------------------------------------

describe('runPreflight — V1/V2 key-ring policy', () => {
  const argsFor = () => ({ tartanId: TARTAN_ID, expectedTotal: 3, expectedPlaidEnv: 'sandbox', apply: false, confirm: null });

  it('passes when V1 and V2 are both configured, V2 is current, and the cohort is valid', async () => {
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails on a mismatched expected Plaid environment', async () => {
    mockEnv.plaidEnv = 'production';
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_plaid_environment');
  });

  it('fails on a wrong expected total', async () => {
    setupFakeSupabase(cohort());
    const result = await runPreflight({ ...argsFor(), expectedTotal: 5 });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unexpected_total_count');
  });

  it('fails when the Tartan id does not exist', async () => {
    setupFakeSupabase(cohort());
    const result = await runPreflight({ ...argsFor(), tartanId: UNKNOWN_ID });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('tartan_not_found');
  });

  it('performs zero writes', async () => {
    const fake = setupFakeSupabase(cohort());
    await runPreflight(argsFor());
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

// The "V1 missing"/"V2 missing"/"V2 not current"/"identical keys" cases are about the
// *configured ring itself* — this block temporarily reconfigures the mocked getKeyRing()'s
// return value (it's wrapped in vi.fn() above specifically for this), restoring the standard
// test ring afterward so it doesn't leak into any other test in this file.

describe('runPreflight — degraded key-ring configurations', () => {
  const argsFor = () => ({ tartanId: TARTAN_ID, expectedTotal: 3, expectedPlaidEnv: 'sandbox', apply: false, confirm: null });

  afterEach(() => {
    vi.mocked(getKeyRing).mockReturnValue(TEST_KEY_RING);
  });

  it('fails when V1 is missing from the ring', async () => {
    const ring: KeyRing = { currentKeyId: 'RAILWAY_PROD_V2', keys: new Map([['RAILWAY_PROD_V2', Buffer.alloc(32, 11)]]) };
    vi.mocked(getKeyRing).mockReturnValue(ring);
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('v1_key_missing');
  });

  it('fails when V2 is missing from the ring', async () => {
    const ring: KeyRing = { currentKeyId: 'RAILWAY_PROD_V1', keys: new Map([['RAILWAY_PROD_V1', Buffer.alloc(32, 7)]]) };
    vi.mocked(getKeyRing).mockReturnValue(ring);
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('v2_key_missing');
    expect(result.failures).toContain('v2_not_current');
  });

  it('fails when V2 is configured but not the current key', async () => {
    const ring: KeyRing = {
      currentKeyId: 'RAILWAY_PROD_V1',
      keys: new Map([
        ['RAILWAY_PROD_V1', Buffer.alloc(32, 7)],
        ['RAILWAY_PROD_V2', Buffer.alloc(32, 11)],
      ]),
    };
    vi.mocked(getKeyRing).mockReturnValue(ring);
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('v2_not_current');
  });

  it('fails when V1 and V2 decode to byte-identical keys', async () => {
    const sameBytes = Buffer.alloc(32, 42);
    const ring: KeyRing = {
      currentKeyId: 'RAILWAY_PROD_V2',
      keys: new Map([
        ['RAILWAY_PROD_V1', sameBytes],
        ['RAILWAY_PROD_V2', Buffer.from(sameBytes)], // equal bytes, different Buffer instance
      ]),
    };
    vi.mocked(getKeyRing).mockReturnValue(ring);
    setupFakeSupabase(cohort());
    const result = await runPreflight(argsFor());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('v1_v2_identical_keys');
  });
});

// ---- rotateTartan: the V1 → V2 flow ---------------------------------------------------------------

describe('rotateTartan — dry-run', () => {
  it('runs the complete read-only verification path (V1 consistency, live Plaid check, local V2 round trip) and writes nothing', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    captureLogs();
    const result = await rotateTartan(TARTAN_ID, false);
    expect(result.outcome).toBe('dry_run_verified');
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledWith('tartan-secret');
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(fake.getRows()[0].access_token_key_id).toBe('RAILWAY_PROD_V1'); // untouched
  });

  it('halts if V1 decrypts but disagrees with the plaintext column, and never picks one as authoritative', async () => {
    const row = encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING });
    row.access_token = 'a-different-value-entirely';
    setupFakeSupabase([row]);
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, false)).rejects.toMatchObject({ reason: 'v1_plaintext_mismatch' });
    expect(mockVerifyAccessTokenLive).not.toHaveBeenCalled(); // never reaches Plaid
  });

  it('halts when plaintext is missing', async () => {
    const row = encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING, keepPlaintext: false });
    setupFakeSupabase([row]);
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, false)).rejects.toMatchObject({ reason: 'plaintext_missing' });
  });

  it('halts when the row is not a clean V1/version-1 dual-write representation (e.g. partial)', async () => {
    const row = encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING });
    row.access_token_auth_tag = null;
    setupFakeSupabase([row]);
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, false)).rejects.toMatchObject({ reason: 'partial' });
  });

  it('halts when the row is already on some other, unapproved key (neither V1 nor V2)', async () => {
    const row = encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: OTHER_KEY_RING });
    setupFakeSupabase([row]);
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, false)).rejects.toMatchObject({ reason: 'not_v1_dual_write' });
  });

  it('permanent (non-transient) pre-write Plaid failure halts with zero writes', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, false)).rejects.toMatchObject({ reason: 'credential_rejected' });
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('the prospective V2 representation genuinely round-trips locally before anything is written', async () => {
    setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    captureLogs();
    const result = await rotateTartan(TARTAN_ID, false);
    // Real crypto ran end-to-end (not mocked) — a successful dry_run_verified result is itself
    // proof the encrypt-under-V2 → decrypt-under-V2 → compare-to-plaintext chain succeeded.
    expect(result.outcome).toBe('dry_run_verified');
  });
});

describe('rotateTartan — apply', () => {
  it('rotates V1 to V2, verifies, and reports verified', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    captureLogs();
    const result = await rotateTartan(TARTAN_ID, true);
    expect(result.outcome).toBe('verified');
    const row = fake.getRows()[0];
    expect(row.access_token_key_id).toBe('RAILWAY_PROD_V2');
    expect(row.access_token_enc_version).toBe(1);
    expect(row.access_token).toBe('tartan-secret'); // plaintext never touched
  });

  it('the guarded update filters on exactly id + old key id + old version + plaintext-not-null, and never on ciphertext/nonce/tag/plaintext values', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    captureLogs();
    await rotateTartan(TARTAN_ID, true);
    const filters = fake.getUpdateFilters();
    expect(filters).toHaveLength(1);
    expect(filters[0].eq).toEqual({ id: TARTAN_ID, access_token_key_id: 'RAILWAY_PROD_V1', access_token_enc_version: 1 });
    expect(filters[0].notNull).toEqual(['access_token']);
  });

  it('the update payload contains exactly the five encrypted columns — never access_token or updated_at', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    captureLogs();
    await rotateTartan(TARTAN_ID, true);
    const payload = fake.getUpdatePayloads()[0];
    expect(Object.keys(payload).sort()).toEqual(
      ['access_token_auth_tag', 'access_token_ciphertext', 'access_token_enc_version', 'access_token_key_id', 'access_token_nonce'].sort()
    );
    expect(payload).not.toHaveProperty('access_token');
    expect(payload).not.toHaveProperty('updated_at');
  });

  it('a post-write Plaid failure halts, but the V2 write already committed is left intact', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    // Succeed on the pre-write check, fail on the post-write one.
    mockVerifyAccessTokenLive.mockResolvedValueOnce(undefined).mockRejectedValue({ response: { status: 400 } });
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toMatchObject({ reason: 'credential_rejected' });
    const row = fake.getRows()[0];
    expect(row.access_token_key_id).toBe('RAILWAY_PROD_V2'); // write already committed, left as-is
  });
});

describe('rotateTartan — resume/crash behavior', () => {
  it('already-V2: writes nothing and still fully reverifies', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: TEST_KEY_RING })]);
    captureLogs();
    const result = await rotateTartan(TARTAN_ID, true);
    expect(result.outcome).toBe('verified');
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('a rerun on an already-V2 row calls the Plaid verifier again — never cached from a prior run', async () => {
    setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: TEST_KEY_RING })]);
    captureLogs();
    await rotateTartan(TARTAN_ID, true);
    await rotateTartan(TARTAN_ID, true);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('crash simulation: row already V2 (as if a prior run committed but never verified) is fully verified on this run', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: TEST_KEY_RING })]);
    captureLogs();
    const result = await rotateTartan(TARTAN_ID, true);
    expect(result.outcome).toBe('verified');
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('lost race: the guarded update affects zero rows because a concurrent V2 write already landed — verifies the stored winner, never the discarded local ciphertext', async () => {
    const plaintext = 'tartan-secret';
    const winner = encryptedRow(TARTAN_ID, plaintext, { keyRing: TEST_KEY_RING });
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, plaintext, { keyRing: V1_KEY_RING })], {
      onBeforeUpdateFilter: (rows) => {
        const row = rows.find((r) => r.id === TARTAN_ID);
        if (row) Object.assign(row, winner);
      },
    });
    captureLogs();
    const result = await rotateTartan(TARTAN_ID, true);
    expect(result.outcome).toBe('verified');
    const row = fake.getRows()[0];
    expect(row.access_token_ciphertext).toBe(winner.access_token_ciphertext);
    expect(row.access_token_nonce).toBe(winner.access_token_nonce);
  });

  it('lost race to a wrong-key winner halts rather than treating it as success', async () => {
    const plaintext = 'tartan-secret';
    const wrongWinner = encryptedRow(TARTAN_ID, plaintext, { keyRing: OTHER_KEY_RING });
    setupFakeSupabase([encryptedRow(TARTAN_ID, plaintext, { keyRing: V1_KEY_RING })], {
      onBeforeUpdateFilter: (rows) => {
        const row = rows.find((r) => r.id === TARTAN_ID);
        if (row) Object.assign(row, wrongWinner);
      },
    });
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toMatchObject({ reason: 'wrong_key_after_write' });
  });

  it('zero-affected update whose reread still shows V1 halts with a specific reason, rather than assuming success', async () => {
    // The guard (id + key_id='RAILWAY_PROD_V1' + version=1 + plaintext-not-null) would naturally
    // match a genuinely-still-V1 row, so this specific combination — zero rows affected, yet the
    // row is still V1 — isn't a realistic concurrent-write race; it's tested directly as a
    // defensive case: if the database ever reports zero-affected for any reason while the row
    // still isn't a valid V2 state, the code must halt, never assume the row is already rotated.
    setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })], {
      forceZeroAffectedUpdate: true,
    });
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toMatchObject({ reason: 'still_v1_after_write' });
  });

  it('lost race to a partial winner halts rather than guessing', async () => {
    const plaintext = 'tartan-secret';
    const partialWinner = encryptedRow(TARTAN_ID, plaintext, { keyRing: TEST_KEY_RING });
    partialWinner.access_token_auth_tag = null;
    setupFakeSupabase([encryptedRow(TARTAN_ID, plaintext, { keyRing: V1_KEY_RING })], {
      onBeforeUpdateFilter: (rows) => {
        const row = rows.find((r) => r.id === TARTAN_ID);
        if (row) Object.assign(row, partialWinner);
      },
    });
    captureLogs();
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toMatchObject({ reason: 'partial' });
  });
});

// ---- Retry precedence ------------------------------------------------------------------------

describe('verifyLiveWithRetry — retry precedence', () => {
  it('retries a transient (503) failure and succeeds within budget', async () => {
    mockVerifyAccessTokenLive.mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce(undefined);
    captureLogs();
    await expect(verifyLiveWithRetry(TARTAN_ID, 'token', 1)).resolves.toBeUndefined();
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on a persistent transient failure', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 500 } });
    captureLogs();
    await expect(verifyLiveWithRetry(TARTAN_ID, 'token', 1)).rejects.toMatchObject({ reason: 'transient_retry_exhausted' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(4);
  });

  it('never retries a non-transient failure, even once', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
    captureLogs();
    await expect(verifyLiveWithRetry(TARTAN_ID, 'token', 1)).rejects.toMatchObject({ reason: 'credential_rejected' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('a structured HTTP 400 is never retried even if its message contains "timeout"', async () => {
    mockVerifyAccessTokenLive.mockRejectedValue({
      response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } },
      message: 'a timeout occurred while validating this credential',
    });
    captureLogs();
    await expect(verifyLiveWithRetry(TARTAN_ID, 'token', 1)).rejects.toMatchObject({ reason: 'credential_rejected' });
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });
});

// ---- Interruption ---------------------------------------------------------------------------

describe('interruption — mid-flight SIGINT/SIGTERM', () => {
  it('signal during pre-write Plaid verification: zero writes, no second Plaid call, no success log', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })]);
    const { entries } = captureLogs();
    mockVerifyAccessTokenLive.mockImplementationOnce(async () => {
      __setInterruptedForTests(true);
      return undefined;
    });
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toBeInstanceOf(InterruptedError);
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
    expect(entries.some((e) => e.outcome === 'verified' || e.outcome === 'dry_run_verified')).toBe(false);
  });

  it('signal immediately after a committed update: row stays V2, no success log, a rerun reverifies without writing again', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: V1_KEY_RING })], {
      onBeforeUpdateFilter: () => {
        __setInterruptedForTests(true);
      },
    });
    const { entries } = captureLogs();
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toBeInstanceOf(InterruptedError);

    expect(fake.getUpdateCallCount()).toBe(1);
    expect(fake.getRows()[0].access_token_key_id).toBe('RAILWAY_PROD_V2');
    expect(entries.some((e) => e.outcome === 'verified')).toBe(false);

    __setInterruptedForTests(false);
    mockVerifyAccessTokenLive.mockClear();
    const result = await rotateTartan(TARTAN_ID, true);
    expect(result.outcome).toBe('verified');
    expect(fake.getUpdateCallCount()).toBe(1); // no second write
  });

  it('signal during a retry sleep: no further retry attempt begins', async () => {
    vi.useFakeTimers();
    mockVerifyAccessTokenLive.mockRejectedValue({ response: { status: 429 } });
    captureLogs();
    const outcome = verifyLiveWithRetry(TARTAN_ID, 'token', 1000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
    __setInterruptedForTests(true);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await outcome;
    expect(result).toBeInstanceOf(InterruptedError);
    expect(mockVerifyAccessTokenLive).toHaveBeenCalledTimes(1);
  });

  it('signal during an already-V2 target\'s verification: no success log, no writes', async () => {
    const fake = setupFakeSupabase([encryptedRow(TARTAN_ID, 'tartan-secret', { keyRing: TEST_KEY_RING })]);
    const { entries } = captureLogs();
    mockVerifyAccessTokenLive.mockImplementationOnce(async () => {
      __setInterruptedForTests(true);
      return undefined;
    });
    await expect(rotateTartan(TARTAN_ID, true)).rejects.toBeInstanceOf(InterruptedError);
    expect(fake.getUpdateCallCount()).toBe(0);
    expect(entries.some((e) => e.outcome === 'verified')).toBe(false);
  });

  it('end to end through main(): a signal halts before final success is ever logged', async () => {
    setupFakeSupabase(cohort('v1'));
    const { entries } = captureLogs();
    mockVerifyAccessTokenLive.mockImplementationOnce(async () => {
      __setInterruptedForTests(true);
      return undefined;
    });
    const code = await main(baseArgv(['--apply', '--confirm', CONFIRM]));
    expect(code).toBe(1);
    expect(entries.some((e) => e.outcome.includes('verified'))).toBe(false);
    expect(entries.some((e) => e.outcome === 'rotation_complete' || e.outcome === 'dry_run_complete')).toBe(false);
    expect(entries.some((e) => e.stage === 'run' && e.outcome === 'interrupted')).toBe(true);
  });
});

// ---- Logging sentinels ------------------------------------------------------------------------

describe('logging — never leaks plaintext, either key, ciphertext, nonce, tag, or raw Plaid objects', () => {
  const SENTINEL_PLAINTEXT = 'SENTINEL_TARTAN_PLAINTEXT_zzz';

  it('a successful apply run never logs plaintext, ciphertext, nonce, auth tag, or either key’s bytes', async () => {
    setupFakeSupabase([encryptedRow(TARTAN_ID, SENTINEL_PLAINTEXT, { keyRing: V1_KEY_RING })]);
    const { rawLines } = captureLogs();
    await rotateTartan(TARTAN_ID, true);
    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_PLAINTEXT);
      expect(line).not.toContain(TEST_KEY_RING.keys.get('RAILWAY_PROD_V1')!.toString('base64'));
      expect(line).not.toContain(TEST_KEY_RING.keys.get('RAILWAY_PROD_V2')!.toString('base64'));
    }
  });

  it('a failed run (v1/plaintext mismatch) never logs the plaintext or either key', async () => {
    const row = encryptedRow(TARTAN_ID, SENTINEL_PLAINTEXT, { keyRing: V1_KEY_RING });
    row.access_token = 'a-different-value';
    setupFakeSupabase([row]);
    const { rawLines } = captureLogs();
    await rotateTartan(TARTAN_ID, true).catch(() => {});
    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_PLAINTEXT);
      expect(line).not.toContain('a-different-value');
      expect(line).not.toContain(TEST_KEY_RING.keys.get('RAILWAY_PROD_V1')!.toString('base64'));
      expect(line).not.toContain(TEST_KEY_RING.keys.get('RAILWAY_PROD_V2')!.toString('base64'));
    }
  });

  it('a raw CLI sentinel never appears in the startup failure log', async () => {
    const SENTINEL_ARG = 'SENTINEL_RAW_CLI_ARG_zzz';
    const { rawLines } = captureLogs();
    await main([...baseArgv(), `--${SENTINEL_ARG}`, 'value']);
    for (const line of rawLines) {
      expect(line).not.toContain(SENTINEL_ARG);
    }
  });

  it('a raw Supabase error message never appears in the preflight failure log', async () => {
    const SENTINEL_DB_ERROR = 'SENTINEL_RAW_SUPABASE_ERROR_zzz';
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
    logEntry({ id: TARTAN_ID, stage: 'test', outcome: 'ok' });
    const parsed = JSON.parse(rawLines[0]);
    expect(Object.keys(parsed).sort()).toEqual(['id', 'outcome', 'stage', 'ts']);
  });
});

// ---- main(): end to end --------------------------------------------------------------------------

describe('main — end to end', () => {
  it('dry-run: exits 0, zero writes', async () => {
    const fake = setupFakeSupabase(cohort('v1'));
    captureLogs();
    const code = await main(baseArgv());
    expect(code).toBe(0);
    expect(fake.getUpdateCallCount()).toBe(0);
  });

  it('apply: rotates Tartan and exits 0', async () => {
    const fake = setupFakeSupabase(cohort('v1'));
    const { entries } = captureLogs();
    const code = await main(baseArgv(['--apply', '--confirm', CONFIRM]));
    expect(code).toBe(0);
    expect(fake.getRows().find((r) => r.id === TARTAN_ID)?.access_token_key_id).toBe('RAILWAY_PROD_V2');
    expect(entries.some((e) => e.outcome === 'rotation_complete')).toBe(true);
  });

  it('refuses apply without --apply/--confirm even with a valid cohort', async () => {
    const fake = setupFakeSupabase(cohort('v1'));
    captureLogs();
    const code = await main(baseArgv(['--confirm', CONFIRM])); // no --apply
    expect(code).toBe(0); // valid dry-run
    expect(fake.getUpdateCallCount()).toBe(0);
  });
});

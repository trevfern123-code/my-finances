import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks (established pattern, see rotateTartanTokenKey.test.ts) ------------------------------

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

const mockEnv = vi.hoisted(() => ({ plaidEnv: 'sandbox', supabaseUrl: 'https://project-ref.supabase.co' }));
vi.mock('../config/env', () => ({ env: mockEnv }));

// Plaid must never be reached from this script: the module is mocked with throwing functions so an
// accidental import-and-call fails loudly, and the test below asserts none was called.
const mockPlaid = vi.hoisted(() => ({ verifyAccessTokenLive: vi.fn(() => Promise.reject(new Error('plaid must not be called'))) }));
vi.mock('../services/plaidService', () => mockPlaid);

// Real crypto math runs; only the environment-backed key-ring singleton is swapped for a
// per-test, reconfigurable fixture ring.
const keyRingHolder = vi.hoisted(() => ({ current: null as unknown, throwOnLoad: false }));
vi.mock('../services/tokenEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tokenEncryption')>();
  return {
    ...actual,
    getKeyRing: vi.fn(() => {
      if (keyRingHolder.throwOnLoad) throw new actual.InvalidKeyConfigurationError('fixture: invalid');
      return keyRingHolder.current;
    }),
  };
});

import {
  ArgError,
  CONFIRM_TOKEN,
  CONSTRAINTS_ATTESTATION_TOKEN,
  classifyRow,
  main,
  parseArgs,
  runPreflight,
  __setInterruptedForTests,
} from './rotatePlaidTokenKeyV2ToV3';
import { decryptAccessToken, encryptAccessToken, encryptLinkToken, loadKeyRing, type KeyRing } from '../services/tokenEncryption';

// ---- Fixture keys and rings -----------------------------------------------------------------------

const V2_KEY_B64 = Buffer.alloc(32, 21).toString('base64');
const V3_KEY_B64 = Buffer.alloc(32, 33).toString('base64');
const OTHER_KEY_B64 = Buffer.alloc(32, 45).toString('base64');

function ring(env: Record<string, string>): KeyRing {
  return loadKeyRing(env);
}
/** The intended transition configuration: both keys, V3 current. */
const MIXED_RING = ring({
  PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY_B64,
  PLAID_TOKEN_KEY_RENDER_PROD_V3: V3_KEY_B64,
  PLAID_TOKEN_CURRENT_KEY_ID: 'RENDER_PROD_V3',
});
/** Today's production configuration (V2 only, V2 current) — used to build V2 fixture rows. */
const V2_RING = ring({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2' });
const V3_ONLY_RING = ring({ PLAID_TOKEN_KEY_RENDER_PROD_V3: V3_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'RENDER_PROD_V3' });
const OTHER_RING = ring({ PLAID_TOKEN_KEY_OTHER: OTHER_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'OTHER' });

const SUPABASE_HOST = 'project-ref.supabase.co';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // the encrypted-only (Hosted Link) item
const ID_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const TOKENS: Record<string, string> = {
  [ID_A]: 'access-sandbox-token-a',
  [ID_B]: 'access-sandbox-token-b',
  [ID_C]: 'access-sandbox-token-c',
  [ID_D]: 'access-sandbox-token-d',
  [ID_E]: 'access-sandbox-token-e',
};

// ---- Fixture rows ----------------------------------------------------------------------------------

interface FakeItem {
  id: string;
  user_id: string;
  status: string;
  transactions_cursor: string | null;
  access_token: string | null;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
}

function item(id: string, keyRing: KeyRing, opts: { plaintext?: boolean; status?: string; keyIdLabel?: string; encVersion?: number } = {}): FakeItem {
  const enc = encryptAccessToken(TOKENS[id], keyRing, id);
  return {
    id,
    user_id: 'user-1',
    status: opts.status ?? 'login_required',
    transactions_cursor: `cursor-${id.slice(0, 4)}`,
    access_token: opts.plaintext === false ? null : TOKENS[id],
    access_token_ciphertext: enc.ciphertextBase64,
    access_token_nonce: enc.nonceBase64,
    access_token_auth_tag: enc.authTagBase64,
    access_token_key_id: opts.keyIdLabel ?? enc.keyId,
    access_token_enc_version: opts.encVersion ?? enc.encVersion,
  };
}

/** The verified production shape: 4 rows, all V2; 3 keep a plaintext copy; 1 encrypted-only;
 *  three login_required and one credential_error. */
function productionCohort(): FakeItem[] {
  return [
    item(ID_A, V2_RING),
    item(ID_B, V2_RING),
    item(ID_C, V2_RING, { status: 'credential_error' }),
    item(ID_D, V2_RING, { plaintext: false }),
  ];
}

interface FakeLink {
  id: string;
  status: string;
  expires_at: string;
  link_token_key_id: string | null;
  link_token_enc_version: number | null;
  link_token_ciphertext: string | null;
  link_token_nonce: string | null;
  link_token_auth_tag: string | null;
}

function linkAttempt(id: string, keyRing: KeyRing | null, expiresAt: string): FakeLink {
  if (!keyRing) {
    return { id, status: 'completed', expires_at: expiresAt, link_token_key_id: null, link_token_enc_version: null, link_token_ciphertext: null, link_token_nonce: null, link_token_auth_tag: null };
  }
  const enc = encryptLinkToken('link-sandbox-token', keyRing, id);
  return {
    id,
    status: 'pending',
    expires_at: expiresAt,
    link_token_key_id: enc.keyId,
    link_token_enc_version: enc.encVersion,
    link_token_ciphertext: enc.ciphertextBase64,
    link_token_nonce: enc.nonceBase64,
    link_token_auth_tag: enc.authTagBase64,
  };
}

const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

// ---- Fake Supabase -----------------------------------------------------------------------------------
//
// Filters are applied the way PostgREST applies them (so a guard that does not match really matches
// zero rows), and every update payload/filter set is recorded for assertions.

interface FakeHooks {
  /** Runs right before an update's filter is evaluated (simulate a concurrent writer). */
  beforeUpdate?: (items: FakeItem[], callNumber: number) => void;
  /** Runs right after an update has been applied. */
  afterUpdate?: (items: FakeItem[], callNumber: number) => void;
  /** Runs before each single-row reread resolves (1-based call count). */
  beforeReread?: (items: FakeItem[], callNumber: number, links: FakeLink[]) => void;
  updateError?: boolean;
  /** Reports a different exact count than the rows returned (a truncated page). */
  itemsCountOverride?: number;
}

function setupFakeSupabase(initialItems: FakeItem[], initialLinks: FakeLink[] = [], hooks: FakeHooks = {}) {
  const items = initialItems.map((r) => ({ ...r }));
  const links = initialLinks.map((r) => ({ ...r }));
  const updates: { payload: Record<string, unknown>; filters: string[] }[] = [];
  const tablesTouched = new Set<string>();
  let updateCalls = 0;
  let rereadCalls = 0;

  mockFrom.mockImplementation((table: string) => {
    tablesTouched.add(table);
    const source = (table === 'plaid_items' ? items : links) as unknown as Record<string, unknown>[];
    const predicates: ((r: Record<string, unknown>) => boolean)[] = [];
    const filterLog: string[] = [];
    let mode: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    let countRequested = false;

    const matches = () => source.filter((r) => predicates.every((p) => p(r)));

    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (opts?.count === 'exact') countRequested = true;
        return chain;
      },
      order: () => chain,
      update: (p: Record<string, unknown>) => {
        if (table !== 'plaid_items') throw new Error(`unexpected update of ${table}`);
        mode = 'update';
        payload = p;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        predicates.push((r) => r[col] === val);
        filterLog.push(`eq:${col}`);
        return chain;
      },
      not: (col: string, op: string, val: unknown) => {
        if (op !== 'is' || val !== null) throw new Error('unsupported not()');
        predicates.push((r) => r[col] !== null);
        filterLog.push(`not_null:${col}`);
        return chain;
      },
      is: (col: string, val: unknown) => {
        if (val !== null) throw new Error('unsupported is()');
        predicates.push((r) => r[col] === null);
        filterLog.push(`is_null:${col}`);
        return chain;
      },
      maybeSingle: async () => {
        rereadCalls++;
        hooks.beforeReread?.(items, rereadCalls, links);
        const found = matches();
        return { data: found[0] ? { ...found[0] } : null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => {
        if (mode === 'update') {
          updateCalls++;
          updates.push({ payload: { ...payload }, filters: [...filterLog] });
          if (hooks.updateError) return Promise.resolve(resolve({ data: null, error: { message: 'boom' } }));
          hooks.beforeUpdate?.(items, updateCalls);
          const found = matches();
          found.forEach((r) => Object.assign(r, payload));
          hooks.afterUpdate?.(items, updateCalls);
          return Promise.resolve(resolve({ data: found.map((r) => ({ id: r.id })), error: null }));
        }
        const found = matches().map((r) => ({ ...r }));
        const count = countRequested
          ? table === 'plaid_items' && hooks.itemsCountOverride !== undefined
            ? hooks.itemsCountOverride
            : found.length
          : null;
        return Promise.resolve(resolve({ data: found, error: null, count }));
      },
    };
    return chain;
  });

  return {
    items,
    links,
    updates,
    tablesTouched,
    snapshot: () => items.map((r) => ({ ...r })),
  };
}

function captureLogs() {
  const entries: { id?: string; stage: string; outcome: string; counts?: Record<string, number> }[] = [];
  const rawLines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    rawLines.push(String(line));
    entries.push(JSON.parse(String(line)));
  });
  return { entries, rawLines, outcomes: () => entries.map((e) => e.outcome) };
}

function rotateArgv(opts: { total?: number; remaining?: number; plaintext?: number; extra?: string[] } = {}): string[] {
  return [
    '--mode',
    'rotate',
    '--expected-total',
    String(opts.total ?? 4),
    '--expected-remaining-v2',
    String(opts.remaining ?? 4),
    '--expected-plaintext-copies',
    String(opts.plaintext ?? 3),
    '--expected-plaid-env',
    'sandbox',
    '--expected-supabase-host',
    SUPABASE_HOST,
    '--constraints-confirmed',
    CONSTRAINTS_ATTESTATION_TOKEN,
    ...(opts.extra ?? []),
  ];
}
const APPLY = ['--apply', '--confirm', CONFIRM_TOKEN];

function verifyArgv(opts: { total?: number; plaintext?: number } = {}): string[] {
  return [
    '--mode',
    'verify-retirement',
    '--expected-total',
    String(opts.total ?? 4),
    '--expected-plaintext-copies',
    String(opts.plaintext ?? 3),
    '--expected-plaid-env',
    'sandbox',
    '--expected-supabase-host',
    SUPABASE_HOST,
    '--constraints-confirmed',
    CONSTRAINTS_ATTESTATION_TOKEN,
  ];
}

function decryptStored(row: FakeItem, keyRing: KeyRing): string {
  return decryptAccessToken(
    {
      ciphertextBase64: row.access_token_ciphertext as string,
      nonceBase64: row.access_token_nonce as string,
      authTagBase64: row.access_token_auth_tag as string,
      keyId: row.access_token_key_id as string,
      encVersion: row.access_token_enc_version as number,
    },
    keyRing,
    row.id
  );
}

beforeEach(() => {
  mockEnv.plaidEnv = 'sandbox';
  mockEnv.supabaseUrl = 'https://project-ref.supabase.co';
  keyRingHolder.current = MIXED_RING;
  keyRingHolder.throwOnLoad = false;
  mockFrom.mockReset();
  mockPlaid.verifyAccessTokenLive.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  __setInterruptedForTests(false);
});

// ---- CLI parsing -----------------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses a rotate dry run (the default: no --apply means read-only)', () => {
    expect(parseArgs(rotateArgv())).toEqual({
      mode: 'rotate',
      expectedTotal: 4,
      expectedRemainingV2: 4,
      expectedPlaintextCopies: 3,
      expectedPlaidEnv: 'sandbox',
      expectedSupabaseHost: SUPABASE_HOST,
      apply: false,
    });
  });

  it('parses an apply run only with the exact confirmation token', () => {
    expect(parseArgs(rotateArgv({ extra: APPLY })).apply).toBe(true);
    expect(() => parseArgs(rotateArgv({ extra: ['--apply'] }))).toThrow(ArgError);
    expect(() => parseArgs(rotateArgv({ extra: ['--apply', '--confirm', 'rotate_plaid_key_v2_to_v3'] }))).toThrow(ArgError);
  });

  it('parses verify-retirement and refuses any write flag or V2 count with it', () => {
    expect(parseArgs(verifyArgv()).mode).toBe('verify-retirement');
    expect(parseArgs(verifyArgv()).expectedRemainingV2).toBeNull();
    const codeOf = (argv: string[]) => {
      try {
        parseArgs(argv);
        return null;
      } catch (err) {
        return (err as ArgError).code;
      }
    };
    expect(codeOf([...verifyArgv(), ...APPLY])).toBe('apply_not_allowed_in_mode');
    expect(codeOf([...verifyArgv(), '--expected-remaining-v2', '0'])).toBe('expected_remaining_v2_not_allowed');
  });

  it.each([
    [['--mode', 'rotate'], 'expected_total_required'],
    [[], 'mode_required'],
    [['--mode', 'ROTATE'], 'mode_invalid'],
  ])('rejects an incomplete invocation %j', (argv, code) => {
    expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code }));
  });

  it.each(['04', '-1', '1e1', ' 4', '4.0', '', '0', '1001'])('rejects a non-canonical or out-of-range --expected-total %j', (value) => {
    const argv = rotateArgv();
    argv[argv.indexOf('--expected-total') + 1] = value;
    expect(() => parseArgs(argv)).toThrow(ArgError);
  });

  it('rejects counts that cannot both be true', () => {
    expect(() => parseArgs(rotateArgv({ total: 4, remaining: 5 }))).toThrow(expect.objectContaining({ code: 'expected_remaining_v2_invalid' }));
    expect(() => parseArgs(rotateArgv({ total: 4, plaintext: 5 }))).toThrow(expect.objectContaining({ code: 'expected_plaintext_copies_invalid' }));
  });

  it('rejects a stray --confirm on a dry run', () => {
    expect(() => parseArgs(rotateArgv({ extra: ['--confirm', CONFIRM_TOKEN] }))).toThrow(expect.objectContaining({ code: 'confirm_without_apply' }));
  });

  it.each(['https://project-ref.supabase.co', 'Project-Ref.supabase.co', 'project-ref.supabase.co/rest', 'user@host'])(
    'rejects a Supabase host that is not a bare lowercase hostname: %j',
    (host) => {
      const argv = rotateArgv();
      argv[argv.indexOf('--expected-supabase-host') + 1] = host;
      expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: 'expected_supabase_host_invalid' }));
    }
  );

  it('rejects unknown, repeated and value-less flags, and a wrong constraints attestation', () => {
    expect(() => parseArgs([...rotateArgv(), '--force'])).toThrow(expect.objectContaining({ code: 'unrecognized_argument' }));
    expect(() => parseArgs([...rotateArgv(), '--expected-total', '4'])).toThrow(expect.objectContaining({ code: 'repeated_flag' }));
    expect(() => parseArgs(['--mode', '--apply'])).toThrow(expect.objectContaining({ code: 'missing_flag_value' }));
    const argv = rotateArgv();
    argv[argv.indexOf('--constraints-confirmed') + 1] = 'yes';
    expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: 'constraints_confirmed_invalid' }));
  });

  it('logs only the error code for a bad command line, then exits nonzero without touching the database', async () => {
    const logs = captureLogs();
    expect(await main(['--mode', 'rotate', '--expected-total', 'secret-looking-value'])).toBe(1);
    expect(logs.outcomes()).toEqual(['failed:expected_total_invalid']);
    expect(logs.rawLines.join('\n')).not.toContain('secret-looking-value');
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// ---- Classification -----------------------------------------------------------------------------------

describe('classifyRow', () => {
  it('distinguishes every stored state rather than collapsing them into "not V2"', () => {
    expect(classifyRow(item(ID_A, V2_RING))).toBe('v2');
    expect(classifyRow(item(ID_A, V3_ONLY_RING))).toBe('v3');
    expect(classifyRow(item(ID_A, OTHER_RING))).toBe('unexpected_key');
    expect(classifyRow(item(ID_A, V2_RING, { encVersion: 2 }))).toBe('unexpected_version');
    expect(classifyRow({ ...item(ID_A, V2_RING), access_token_nonce: null })).toBe('partial');
    expect(
      classifyRow({ ...item(ID_A, V2_RING), access_token_ciphertext: null, access_token_nonce: null, access_token_auth_tag: null, access_token_key_id: null, access_token_enc_version: null })
    ).toBe('plaintext_only');
    expect(
      classifyRow({
        ...item(ID_A, V2_RING, { plaintext: false }),
        access_token_ciphertext: null,
        access_token_nonce: null,
        access_token_auth_tag: null,
        access_token_key_id: null,
        access_token_enc_version: null,
      })
    ).toBe('missing_both');
  });
});

// ---- Preflight ------------------------------------------------------------------------------------------

describe('runPreflight (read-only)', () => {
  it('passes for the verified production shape (4 V2 rows, 3 plaintext copies, 1 encrypted-only)', async () => {
    const fake = setupFakeSupabase(productionCohort());
    const result = await runPreflight(parseArgs(rotateArgv()));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.inventory?.counts).toMatchObject({ total: 4, v2: 4, v3: 0, plaintextCopies: 3, distinctNonces: 4 });
    expect(fake.updates).toHaveLength(0);
  });

  it.each([
    [{ total: 5 }, 'unexpected_total_count'],
    [{ remaining: 3 }, 'unexpected_remaining_v2_count'],
    [{ plaintext: 2 }, 'unexpected_plaintext_copy_count'],
  ])('fails closed on a record-count mismatch %j', async (counts, failure) => {
    setupFakeSupabase(productionCohort());
    const result = await runPreflight(parseArgs(rotateArgv(counts)));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([failure]);
  });

  it('never reads the database when SUPABASE_URL is not the expected host', async () => {
    setupFakeSupabase(productionCohort());
    mockEnv.supabaseUrl = 'https://some-other-project.supabase.co';
    const result = await runPreflight(parseArgs(rotateArgv()));
    expect(result.failures).toContain('unexpected_supabase_host');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('fails on a non-sandbox Plaid environment', async () => {
    setupFakeSupabase(productionCohort());
    mockEnv.plaidEnv = 'production';
    expect((await runPreflight(parseArgs(rotateArgv()))).failures).toEqual(['unexpected_plaid_environment']);
  });

  it.each([
    ['V3 key absent', ring({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2' }), ['v3_key_missing', 'v3_not_current']],
    ['V2 key absent', V3_ONLY_RING, ['v2_key_missing']],
    [
      'V3 configured but V2 still current',
      ring({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY_B64, PLAID_TOKEN_KEY_RENDER_PROD_V3: V3_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2' }),
      ['v3_not_current'],
    ],
    [
      'V3 configured with the V2 key bytes',
      ring({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: V2_KEY_B64, PLAID_TOKEN_KEY_RENDER_PROD_V3: V2_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'RENDER_PROD_V3' }),
      ['v2_v3_identical_keys'],
    ],
  ])('rotate refuses a key ring with %s', async (_name, keyRing, failures) => {
    setupFakeSupabase(productionCohort());
    keyRingHolder.current = keyRing;
    expect((await runPreflight(parseArgs(rotateArgv()))).failures).toEqual(failures);
  });

  it('rotate refuses an unloadable key ring', async () => {
    setupFakeSupabase(productionCohort());
    keyRingHolder.throwOnLoad = true;
    expect((await runPreflight(parseArgs(rotateArgv()))).failures).toEqual(['key_ring_unavailable']);
  });

  it.each([
    ['a plaintext-only row', (rows: FakeItem[]) => Object.assign(rows[0], { access_token_ciphertext: null, access_token_nonce: null, access_token_auth_tag: null, access_token_key_id: null, access_token_enc_version: null }), 'plaintext_only_rows_present'],
    ['a partial row', (rows: FakeItem[]) => Object.assign(rows[0], { access_token_auth_tag: null }), 'partial_rows_present'],
    ['a row on an unexpected key', (rows: FakeItem[]) => Object.assign(rows[0], item(ID_A, OTHER_RING)), 'unexpected_key_rows_present'],
    ['a row at an unexpected version', (rows: FakeItem[]) => Object.assign(rows[0], { access_token_enc_version: 2 }), 'unexpected_version_rows_present'],
    ['a reused nonce', (rows: FakeItem[]) => Object.assign(rows[1], { access_token_nonce: rows[0].access_token_nonce }), 'nonce_reuse_detected'],
  ])('refuses the whole run when the table contains %s', async (_name, mutate, failure) => {
    const rows = productionCohort();
    mutate(rows);
    setupFakeSupabase(rows);
    const plaintext = rows.filter((r) => r.access_token !== null).length;
    const v2 = rows.filter((r) => classifyRow(r) === 'v2').length;
    const result = await runPreflight(parseArgs(rotateArgv({ plaintext, remaining: v2 })));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(failure);
  });

  it('treats a truncated page (count larger than rows returned) as a database error', async () => {
    setupFakeSupabase(productionCohort(), [], { itemsCountOverride: 5 });
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(1);
    expect(logs.outcomes()).toContain('halted:db_error:inventory_truncated');
  });

  it('allows V2 Hosted Link tokens during rotation but refuses link tokens on an unknown key', async () => {
    setupFakeSupabase(productionCohort(), [linkAttempt('11111111-1111-4111-8111-111111111111', V2_RING, FUTURE), linkAttempt('22222222-2222-4222-8222-222222222222', null, PAST)]);
    const ok = await runPreflight(parseArgs(rotateArgv()));
    expect(ok.ok).toBe(true);
    expect(ok.linkTokens).toEqual({ withToken: 1, v2: 1, v2Unexpired: 1, v3: 0, unexpectedKey: 0, unexpectedVersion: 0 });

    setupFakeSupabase(productionCohort(), [linkAttempt('11111111-1111-4111-8111-111111111111', OTHER_RING, FUTURE)]);
    expect((await runPreflight(parseArgs(rotateArgv()))).failures).toEqual(['link_tokens_unexpected_key']);
  });
});

// ---- Rotation: dry run ---------------------------------------------------------------------------------

describe('rotate — dry run (default)', () => {
  it('verifies all four rows end to end and writes nothing', async () => {
    const fake = setupFakeSupabase(productionCohort());
    const before = fake.snapshot();
    const logs = captureLogs();

    expect(await main(rotateArgv())).toBe(0);
    expect(fake.updates).toHaveLength(0);
    expect(fake.snapshot()).toEqual(before);
    expect(logs.entries.filter((e) => e.outcome === 'dry_run_verified').map((e) => e.id)).toEqual([ID_A, ID_B, ID_C, ID_D]);
    expect(logs.entries.at(-1)).toMatchObject({ stage: 'done', outcome: 'dry_run_complete', counts: { dry_run_verified: 4 } });
  });

  it('halts on a V2/plaintext disagreement without writing, leaving later rows untouched', async () => {
    const rows = productionCohort();
    rows[1].access_token = 'a-different-token';
    const fake = setupFakeSupabase(rows);
    const logs = captureLogs();

    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:v2_plaintext_mismatch');
    expect(fake.updates).toHaveLength(1); // row A only — row B halted before its write
    expect(fake.items[1]).toEqual(rows[1]);
    expect(fake.items[2]).toEqual(rows[2]);
    expect(fake.items[3]).toEqual(rows[3]);
  });

  it('halts on a GCM failure (tampered V2 ciphertext) and never falls back to the plaintext copy', async () => {
    const rows = productionCohort();
    const tampered = Buffer.from(rows[0].access_token_ciphertext as string, 'base64');
    tampered[0] ^= 0xff;
    rows[0].access_token_ciphertext = tampered.toString('base64');
    const fake = setupFakeSupabase(rows);
    const logs = captureLogs();

    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:crypto_mismatch');
    expect(fake.updates).toHaveLength(0);
  });
});

// ---- Final whole-table recheck (every mode recounts before reporting success) -----------------------

describe('rotate — final recheck', () => {
  const NEW_LINK_ID = '33333333-3333-4333-8333-333333333333';

  it('logs a passing final check (with counts) before dry_run_complete', async () => {
    setupFakeSupabase(productionCohort());
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(0);
    const tail = logs.entries.slice(-2);
    expect(tail[0]).toMatchObject({ stage: 'final_check', outcome: 'passed', counts: { total: 4, v2: 4, v3: 0, plaintext_copies: 3 } });
    expect(tail[1]).toMatchObject({ stage: 'done', outcome: 'dry_run_complete' });
  });

  it('fails a dry run when a V2 item is inserted while it runs', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 4) items.push(item(ID_E, V2_RING, { plaintext: false, status: 'active' }));
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(1);
    expect(logs.outcomes()).toEqual(expect.arrayContaining(['failed:row_set_changed', 'failed:total_changed', 'failed:row_shape_changed']));
    expect(logs.outcomes()).not.toContain('dry_run_complete');
    expect(fake.updates).toHaveLength(0);
  });

  it('fails a dry run when an item is replaced (same total, different row set)', async () => {
    setupFakeSupabase(productionCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 4) items.splice(0, 1, item(ID_E, V2_RING));
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(1);
    expect(logs.outcomes()).toContain('failed:row_set_changed');
    expect(logs.outcomes()).not.toContain('failed:total_changed');
  });

  it.each([
    ['a dry run', [] as string[]],
    ['an apply run', APPLY],
  ])('fails %s when a writer creates a V2 Hosted Link token while it runs (a backend still on V2)', async (_name, extra) => {
    setupFakeSupabase(productionCohort(), [], {
      beforeReread: (_items, n, links) => {
        if (n === 2) links.push(linkAttempt(NEW_LINK_ID, V2_RING, FUTURE));
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra }))).toBe(1);
    expect(logs.outcomes()).toContain('failed:new_v2_link_tokens_created');
  });

  it('accepts a V3 Hosted Link token created while a dry run runs (the expected post-switch state)', async () => {
    setupFakeSupabase(productionCohort(), [], {
      beforeReread: (_items, n, links) => {
        if (n === 2) links.push(linkAttempt(NEW_LINK_ID, MIXED_RING, FUTURE));
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(0);
    expect(logs.entries.find((e) => e.stage === 'final_check')?.counts).toMatchObject({ link_tokens_v2: 0, link_tokens_v3: 1 });
  });

  // Changes that leave every count, the row-id set and the V2/V3 split intact: only the per-row
  // fingerprint of the verified state catches these.
  it.each([
    ['a V2 ciphertext replaced by another valid V2 encryption', (items: FakeItem[]) => Object.assign(items[0], { ...item(ID_A, V2_RING), status: items[0].status, transactions_cursor: items[0].transactions_cursor })],
    ['a plaintext copy changed to another value', (items: FakeItem[]) => Object.assign(items[1], { access_token: 'a-different-token' })],
    ['a nonce swapped for a fresh one', (items: FakeItem[]) => Object.assign(items[2], { access_token_nonce: Buffer.alloc(12, 9).toString('base64') })],
  ])('fails a dry run when, after a row was verified, %s', async (_name, mutate) => {
    setupFakeSupabase(productionCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 4) mutate(items); // row D is being read; rows A-C were verified already
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(1);
    expect(logs.outcomes()).toEqual(['started:rotate:read_only', 'read', 'passed', 'dry_run_verified', 'dry_run_verified', 'dry_run_verified', 'dry_run_verified', 'failed:row_changed_after_verification', 'failed']);
  });

  it('fails an apply run when a rotated row is changed after its post-write verification', async () => {
    setupFakeSupabase(productionCohort(), [], {
      afterUpdate: (items, n) => {
        if (n === 4) Object.assign(items[0], { ...item(ID_A, MIXED_RING), status: items[0].status, transactions_cursor: items[0].transactions_cursor });
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('failed:row_changed_after_verification');
    expect(logs.outcomes()).not.toContain('rotation_complete');
  });

  it('fails a dry run when a plaintext copy is cleared while it runs', async () => {
    setupFakeSupabase(productionCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 4) items[0].access_token = null;
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv())).toBe(1);
    expect(logs.outcomes()).toContain('failed:plaintext_copy_count_changed');
  });
});

// ---- Rotation: apply ------------------------------------------------------------------------------------

describe('rotate — apply', () => {
  it('rotates all four rows to V3, touching only the five encrypted columns', async () => {
    const fake = setupFakeSupabase(productionCohort());
    const before = fake.snapshot();
    const logs = captureLogs();

    expect(await main(rotateArgv({ extra: APPLY }))).toBe(0);
    expect(logs.entries.at(-1)).toMatchObject({ stage: 'done', outcome: 'rotation_complete', counts: { rotated: 4 } });

    expect(fake.updates).toHaveLength(4);
    for (const u of fake.updates) {
      expect(Object.keys(u.payload).sort()).toEqual([
        'access_token_auth_tag',
        'access_token_ciphertext',
        'access_token_enc_version',
        'access_token_key_id',
        'access_token_nonce',
      ]);
      expect(u.payload.access_token_key_id).toBe('RENDER_PROD_V3');
      expect(u.payload.access_token_enc_version).toBe(1);
    }
    // Guard: exact id, still V2 at version 1, plaintext presence as read (is-null for the
    // encrypted-only row) — never a value filter on ciphertext/nonce/tag/plaintext.
    expect(fake.updates[0].filters).toEqual(['eq:id', 'eq:access_token_key_id', 'eq:access_token_enc_version', 'not_null:access_token']);
    expect(fake.updates[3].filters).toEqual(['eq:id', 'eq:access_token_key_id', 'eq:access_token_enc_version', 'is_null:access_token']);

    fake.items.forEach((row, i) => {
      // Every non-encryption column is byte-for-byte unchanged, including the plaintext copy and
      // the login_required / credential_error statuses.
      expect(row.access_token).toBe(before[i].access_token);
      expect(row.status).toBe(before[i].status);
      expect(row.user_id).toBe(before[i].user_id);
      expect(row.transactions_cursor).toBe(before[i].transactions_cursor);
      expect(row.access_token_nonce).not.toBe(before[i].access_token_nonce);
      // The stored value decrypts with a ring that does not contain V2 at all.
      expect(decryptStored(row, V3_ONLY_RING)).toBe(TOKENS[row.id]);
    });
    expect(fake.items[3].access_token).toBeNull(); // the encrypted-only row gained no plaintext
    expect(fake.tablesTouched).toEqual(new Set(['plaid_items', 'plaid_link_attempts']));
    expect(mockPlaid.verifyAccessTokenLive).not.toHaveBeenCalled();
  });

  it('is idempotent: a second apply run writes nothing and reverifies every row', async () => {
    const fake = setupFakeSupabase(productionCohort());
    captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(0);
    const afterFirst = fake.snapshot();
    fake.updates.length = 0;

    const logs = captureLogs();
    expect(await main(rotateArgv({ remaining: 0, extra: APPLY }))).toBe(0);
    expect(fake.updates).toHaveLength(0);
    expect(fake.snapshot()).toEqual(afterFirst);
    expect(logs.entries.filter((e) => e.outcome === 'already_v3_verified')).toHaveLength(4);
  });

  it('resumes after an interruption right after the first write', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      afterUpdate: (_items, n) => {
        if (n === 1) __setInterruptedForTests(true);
      },
    });
    let logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.entries.at(-1)).toMatchObject({ id: ID_A, stage: 'run', outcome: 'interrupted' });
    // Stops immediately after the awaited write: no write outcome, no reread, nothing that could
    // read as success for a row whose stored state was never verified.
    expect(logs.entries.filter((e) => e.stage === 'write').map((e) => e.outcome)).toEqual(['started']);
    expect(fake.items.map(classifyRow)).toEqual(['v3', 'v2', 'v2', 'v2']);

    __setInterruptedForTests(false);
    // The operator re-attests the counts as they are now (3 left on V2) — a stale "4" is refused.
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    logs = captureLogs();
    expect(await main(rotateArgv({ remaining: 3, extra: APPLY }))).toBe(0);
    expect(logs.entries.filter((e) => e.outcome === 'already_v3_verified').map((e) => e.id)).toEqual([ID_A]);
    expect(logs.entries.filter((e) => e.outcome === 'rotated').map((e) => e.id)).toEqual([ID_B, ID_C, ID_D]);
    expect(fake.items.map(classifyRow)).toEqual(['v3', 'v3', 'v3', 'v3']);
  });

  it('accepts a concurrent run of this script having rotated the row first, after verifying what it stored', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      beforeUpdate: (items, n) => {
        if (n === 2) Object.assign(items[1], { ...item(ID_B, MIXED_RING), status: items[1].status, transactions_cursor: items[1].transactions_cursor });
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(0);
    expect(logs.entries.find((e) => e.id === ID_B && e.stage === 'done')?.outcome).toBe('concurrent_rotation_verified');
    expect(fake.items.map(classifyRow)).toEqual(['v3', 'v3', 'v3', 'v3']);
  });

  it('halts when the plaintext copy vanished between the read and the write (the guard matches nothing)', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      beforeUpdate: (items, n) => {
        if (n === 1) items[0].access_token = null;
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:update_not_applied');
    expect(fake.items.map(classifyRow)).toEqual(['v2', 'v2', 'v2', 'v2']);
  });

  it('halts when the plaintext copy CHANGED (still present) between the read and the write', async () => {
    setupFakeSupabase(productionCohort(), [], {
      beforeUpdate: (items, n) => {
        if (n === 1) items[0].access_token = 'a-different-token';
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:plaintext_copy_changed');
  });

  it('halts when the stored value does not decrypt with V3 after the write (never trusts the local copy)', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      afterUpdate: (items, n) => {
        if (n === 1) {
          const tag = Buffer.from(items[0].access_token_auth_tag as string, 'base64');
          tag[0] ^= 0x01;
          items[0].access_token_auth_tag = tag.toString('base64');
        }
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:crypto_mismatch');
    expect(fake.updates).toHaveLength(1);
  });

  it('halts when a row labelled V3 only decrypts under V2 bytes', async () => {
    const rows = productionCohort();
    Object.assign(rows[0], item(ID_A, V2_RING, { keyIdLabel: 'RENDER_PROD_V3' }));
    setupFakeSupabase(rows);
    const logs = captureLogs();
    expect(await main(rotateArgv({ remaining: 3, extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:crypto_mismatch');
  });

  it('halts when a row is deleted between the inventory and its rotation', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 1) items.splice(0, 1);
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:row_missing');
    expect(fake.updates).toHaveLength(0);
  });

  it('fails the final check when a new V2 row is inserted mid-run (e.g. the active backend still writes V2)', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], {
      afterUpdate: (items, n) => {
        if (n === 4) items.push(item(ID_E, V2_RING, { plaintext: false, status: 'active' }));
      },
    });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toEqual(expect.arrayContaining(['failed:total_changed', 'failed:v2_rows_remaining']));
    expect(fake.items.map(classifyRow)).toEqual(['v3', 'v3', 'v3', 'v3', 'v2']);
  });

  it('reports a failed write as a database error and leaves the row on V2', async () => {
    const fake = setupFakeSupabase(productionCohort(), [], { updateError: true });
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(1);
    expect(logs.outcomes()).toContain('halted:db_error:write');
    expect(fake.items.map(classifyRow)).toEqual(['v2', 'v2', 'v2', 'v2']);
  });

  it('never logs a token, ciphertext, nonce, auth tag, key or the Supabase host', async () => {
    const fake = setupFakeSupabase(productionCohort(), [linkAttempt('11111111-1111-4111-8111-111111111111', V2_RING, FUTURE)]);
    const before = fake.snapshot();
    const logs = captureLogs();
    expect(await main(rotateArgv({ extra: APPLY }))).toBe(0);
    const output = logs.rawLines.join('\n');
    const secrets = [
      ...Object.values(TOKENS),
      'link-sandbox-token',
      V2_KEY_B64,
      V3_KEY_B64,
      SUPABASE_HOST,
      ...[...before, ...fake.items].flatMap((r) => [r.access_token_ciphertext, r.access_token_nonce, r.access_token_auth_tag]),
      ...fake.links.flatMap((l) => [l.link_token_ciphertext, l.link_token_nonce, l.link_token_auth_tag]),
    ].filter((s): s is string => typeof s === 'string');
    for (const s of secrets) expect(output).not.toContain(s);
    for (const e of logs.entries) expect(Object.keys(e).every((k) => ['ts', 'id', 'stage', 'outcome', 'counts'].includes(k))).toBe(true);
  });
});

// ---- verify-retirement --------------------------------------------------------------------------------

describe('verify-retirement (read-only V2 retirement gate)', () => {
  function rotatedCohort(): FakeItem[] {
    return productionCohort().map((r) => ({ ...r, ...item(r.id, MIXED_RING, { plaintext: r.access_token !== null }), status: r.status }));
  }

  it('passes with V2 entirely absent from the key ring, and writes nothing', async () => {
    keyRingHolder.current = V3_ONLY_RING;
    const fake = setupFakeSupabase(rotatedCohort(), [linkAttempt('22222222-2222-4222-8222-222222222222', null, PAST)]);
    const before = fake.snapshot();
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(0);
    expect(logs.entries.at(-1)).toMatchObject({ outcome: 'v2_retirement_gate_passed' });
    expect(logs.entries.filter((e) => e.outcome === 'v3_only_verified')).toHaveLength(4);
    expect(fake.updates).toHaveLength(0);
    expect(fake.snapshot()).toEqual(before);
  });

  it('fails while any plaid_items row is still on V2', async () => {
    const rows = rotatedCohort();
    rows[3] = item(ID_D, V2_RING, { plaintext: false });
    setupFakeSupabase(rows);
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    expect(logs.outcomes()).toContain('failed:v2_rows_remaining');
  });

  it('fails while any Hosted Link token still references V2 — expired ones included', async () => {
    setupFakeSupabase(rotatedCohort(), [linkAttempt('11111111-1111-4111-8111-111111111111', V2_RING, PAST)]);
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    // Refused at preflight — before any per-row work — not only by the final recheck.
    expect(logs.entries).toContainEqual(expect.objectContaining({ stage: 'preflight', outcome: 'failed:v2_link_tokens_remaining' }));
    expect(logs.outcomes()).not.toContain('v3_only_verified');
  });

  it('fails when a V3 row disagrees with its plaintext copy', async () => {
    const rows = rotatedCohort();
    rows[0].access_token = 'a-different-token';
    setupFakeSupabase(rows);
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    expect(logs.outcomes()).toContain('halted:v3_plaintext_mismatch');
  });

  it('fails when a plaintext copy changes between the inventory and the per-row reread', async () => {
    setupFakeSupabase(rotatedCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 2) items[1].access_token = 'a-different-token';
      },
    });
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    expect(logs.outcomes()).toContain('halted:plaintext_copy_changed');
  });

  it('fails when a row is re-encrypted (still valid V3) after it was verified', async () => {
    setupFakeSupabase(rotatedCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 4) Object.assign(items[0], { ...item(ID_A, MIXED_RING), status: items[0].status, transactions_cursor: items[0].transactions_cursor });
      },
    });
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    expect(logs.outcomes()).toContain('failed:row_changed_after_verification');
    expect(logs.outcomes()).not.toContain('v2_retirement_gate_passed');
  });

  it('fails when a row labelled V3 actually needs the V2 key', async () => {
    const rows = rotatedCohort();
    rows[2] = { ...item(ID_C, V2_RING, { keyIdLabel: 'RENDER_PROD_V3' }), status: 'credential_error' };
    setupFakeSupabase(rows);
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    expect(logs.outcomes()).toContain('halted:crypto_mismatch');
  });

  it('fails when a V2 row appears during the per-row pass', async () => {
    const fake = setupFakeSupabase(rotatedCohort(), [], {
      beforeReread: (items, n) => {
        if (n === 4) items.push(item(ID_E, V2_RING, { plaintext: false, status: 'active' }));
      },
    });
    const logs = captureLogs();
    expect(await main(verifyArgv())).toBe(1);
    expect(logs.outcomes()).toEqual(expect.arrayContaining(['failed:row_set_changed', 'failed:total_changed', 'failed:v2_rows_remaining']));
    expect(fake.updates).toHaveLength(0);
  });
});

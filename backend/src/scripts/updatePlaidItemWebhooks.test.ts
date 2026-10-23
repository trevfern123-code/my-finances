import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

const mockEnv = vi.hoisted(() => ({
  plaidEnv: 'sandbox',
  supabaseUrl: 'https://project-ref.supabase.co',
  backendPublicUrl: 'https://render-backend.example.com' as string | null,
}));
vi.mock('../config/env', () => ({ env: mockEnv }));

// A fake Plaid: one webhook per access token; every call is recorded.
const plaid = vi.hoisted(() => ({
  webhooks: new Map<string, string | null>(),
  calls: [] as { method: string; accessToken: string; webhook?: string }[],
  failUpdateFor: null as string | null,
  failGetFor: null as string | null,
  ignoreUpdateFor: null as string | null,
}));
vi.mock('../config/plaid', () => ({
  plaidClient: {
    itemGet: vi.fn(async ({ access_token }: { access_token: string }) => {
      plaid.calls.push({ method: 'itemGet', accessToken: access_token });
      if (plaid.failGetFor === access_token) throw Object.assign(new Error('x'), { response: { status: 400, data: { error_code: 'INVALID_ACCESS_TOKEN' } } });
      return { data: { item: { item_id: `ext-${access_token}`, webhook: plaid.webhooks.get(access_token) ?? null } } };
    }),
    itemWebhookUpdate: vi.fn(async ({ access_token, webhook }: { access_token: string; webhook: string }) => {
      plaid.calls.push({ method: 'itemWebhookUpdate', accessToken: access_token, webhook });
      if (plaid.failUpdateFor === access_token) throw Object.assign(new Error('x'), { response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
      if (plaid.ignoreUpdateFor !== access_token) plaid.webhooks.set(access_token, webhook);
      return { data: { item: {} } };
    }),
  },
}));

const keyRingHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../services/tokenEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tokenEncryption')>();
  return { ...actual, getKeyRing: vi.fn(() => keyRingHolder.current) };
});

import { CONFIRM_TOKEN, canonicalWebhookUrl, main, parseArgs, __setInterruptedForTests } from './updatePlaidItemWebhooks';
import { encryptAccessToken, loadKeyRing } from '../services/tokenEncryption';

const RING = loadKeyRing({ PLAID_TOKEN_KEY_RAILWAY_PROD_V2: Buffer.alloc(32, 21).toString('base64'), PLAID_TOKEN_CURRENT_KEY_ID: 'RAILWAY_PROD_V2' });
const RENDER_HOOK = 'https://render-backend.example.com/api/webhooks/plaid';
const RAILWAY_HOOK = 'https://railway-backend.example.com/api/webhooks/plaid';
const IDS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
];
const tokenOf = (id: string) => `access-sandbox-${id.slice(0, 4)}`;

function cohort() {
  return IDS.map((id, i) => {
    const enc = encryptAccessToken(tokenOf(id), RING, id);
    return {
      id,
      status: i === 2 ? 'credential_error' : 'login_required',
      access_token: i === 3 ? null : tokenOf(id),
      access_token_ciphertext: enc.ciphertextBase64,
      access_token_nonce: enc.nonceBase64,
      access_token_auth_tag: enc.authTagBase64,
      access_token_key_id: enc.keyId,
      access_token_enc_version: enc.encVersion,
    };
  });
}

function setupDb(rows: ReturnType<typeof cohort>, opts: { onSecondRead?: (rows: ReturnType<typeof cohort>) => void } = {}) {
  let reads = 0;
  const writes: string[] = [];
  mockFrom.mockImplementation(() => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      update: () => (writes.push('update'), chain),
      insert: () => (writes.push('insert'), chain),
      delete: () => (writes.push('delete'), chain),
      then: (resolve: (v: unknown) => unknown) => {
        reads++;
        if (reads === 2) opts.onSecondRead?.(rows);
        return Promise.resolve(resolve({ data: rows.map((r) => ({ ...r })), error: null, count: rows.length }));
      },
    };
    return chain;
  });
  return { writes };
}

function argv(target: string, role: string, extra: string[] = []) {
  return ['--target-webhook-url', target, '--target-role', role, '--expected-total', '4', '--expected-plaid-env', 'sandbox', '--expected-supabase-host', 'project-ref.supabase.co', ...extra];
}
const APPLY = ['--apply', '--confirm', CONFIRM_TOKEN];

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)));
  return { lines, outcomes: () => lines.map((l) => JSON.parse(l).outcome as string) };
}

beforeEach(() => {
  mockFrom.mockReset();
  keyRingHolder.current = RING;
  mockEnv.backendPublicUrl = 'https://render-backend.example.com';
  mockEnv.plaidEnv = 'sandbox';
  plaid.webhooks = new Map(IDS.map((id) => [tokenOf(id), RAILWAY_HOOK]));
  plaid.calls = [];
  plaid.failUpdateFor = null;
  plaid.failGetFor = null;
  plaid.ignoreUpdateFor = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  __setInterruptedForTests(false);
});

describe('parseArgs / target URL', () => {
  it.each([
    'http://render-backend.example.com/api/webhooks/plaid',
    'https://render-backend.example.com/api/webhooks/plaid/',
    'https://render-backend.example.com/api/webhooks/plaid?x=1',
    'https://user:pw@render-backend.example.com/api/webhooks/plaid',
    'https://Render-Backend.example.com/api/webhooks/plaid',
    'https://render-backend.example.com/other',
    'https://render-backend.example.com:443/api/webhooks/plaid',
  ])('refuses a non-canonical target %j', (url) => {
    expect(canonicalWebhookUrl(url)).toBeNull();
  });

  it('requires an explicit role and the exact confirm token for apply', () => {
    expect(() => parseArgs(argv(RENDER_HOOK, 'render'))).toThrow(expect.objectContaining({ code: 'target_role_invalid' }));
    expect(() => parseArgs(argv(RENDER_HOOK, 'this-backend', ['--apply']))).toThrow(expect.objectContaining({ code: 'apply_requires_confirm' }));
    expect(() => parseArgs(argv(RENDER_HOOK, 'this-backend', ['--confirm', CONFIRM_TOKEN]))).toThrow(expect.objectContaining({ code: 'confirm_without_apply' }));
    expect(parseArgs(argv(RENDER_HOOK, 'this-backend', APPLY)).apply).toBe(true);
  });
});

describe('preflight', () => {
  it('refuses this-backend when BACKEND_PUBLIC_URL is unset or different (the Render parity gap)', async () => {
    setupDb(cohort());
    mockEnv.backendPublicUrl = null;
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend'))).toBe(1);
    expect(logs.outcomes()).toContain('failed:target_is_not_this_backend');
    expect(plaid.calls).toHaveLength(0);
  });

  it('refuses other-backend when the target is in fact this backend', async () => {
    setupDb(cohort());
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'other-backend'))).toBe(1);
    expect(logs.outcomes()).toContain('failed:target_is_this_backend');
  });

  it('never reads the database or calls Plaid for the wrong Supabase host', async () => {
    setupDb(cohort());
    mockEnv.supabaseUrl = 'https://other.supabase.co';
    captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend'))).toBe(1);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(plaid.calls).toHaveLength(0);
    mockEnv.supabaseUrl = 'https://project-ref.supabase.co';
  });

  it('refuses a count mismatch and an Item that is being removed', async () => {
    const rows = cohort();
    rows[0].status = 'removing';
    setupDb(rows.slice(0, 3));
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend'))).toBe(1);
    expect(logs.outcomes()).toEqual(expect.arrayContaining(['failed:unexpected_total_count', 'failed:item_being_removed']));
    expect(plaid.calls).toHaveLength(0);
  });
});

describe('dry run (default)', () => {
  it('only reads: one /item/get per Item, no webhook update, no database write', async () => {
    const db = setupDb(cohort());
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend'))).toBe(0);
    expect(plaid.calls.map((c) => c.method)).toEqual(['itemGet', 'itemGet', 'itemGet', 'itemGet']);
    // Every token resolved correctly, including the encrypted-only Item.
    expect(plaid.calls.map((c) => c.accessToken)).toEqual(IDS.map(tokenOf));
    expect(db.writes).toHaveLength(0);
    expect(JSON.parse(logs.lines.at(-1) as string)).toMatchObject({ outcome: 'dry_run_complete', counts: { would_update: 4, already_target: 0, updated: 0 } });
  });
});

describe('apply', () => {
  it('moves every Item to the target and verifies each with a fresh /item/get', async () => {
    const db = setupDb(cohort());
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(0);
    expect([...plaid.webhooks.values()]).toEqual([RENDER_HOOK, RENDER_HOOK, RENDER_HOOK, RENDER_HOOK]);
    expect(plaid.calls.map((c) => c.method)).toEqual(Array(4).fill(['itemGet', 'itemWebhookUpdate', 'itemGet']).flat());
    expect(db.writes).toHaveLength(0);
    expect(JSON.parse(logs.lines.at(-1) as string)).toMatchObject({ outcome: 'webhooks_on_target', counts: { updated: 4 } });
  });

  it('is idempotent: a rerun updates nothing', async () => {
    setupDb(cohort());
    captureLogs();
    await main(argv(RENDER_HOOK, 'this-backend', APPLY));
    plaid.calls = [];
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(0);
    expect(plaid.calls.map((c) => c.method)).toEqual(['itemGet', 'itemGet', 'itemGet', 'itemGet']);
  });

  it('rolls back with the previous URL and --target-role other-backend', async () => {
    setupDb(cohort());
    captureLogs();
    await main(argv(RENDER_HOOK, 'this-backend', APPLY));
    expect(await main(argv(RAILWAY_HOOK, 'other-backend', APPLY))).toBe(0);
    expect([...plaid.webhooks.values()]).toEqual([RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK]);
  });

  it('halts on the first Plaid refusal, logging only the Plaid error code; earlier Items stay moved, later ones untouched', async () => {
    setupDb(cohort());
    plaid.failUpdateFor = tokenOf(IDS[1]);
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:plaid_error:ITEM_LOGIN_REQUIRED');
    expect([...plaid.webhooks.values()]).toEqual([RENDER_HOOK, RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK]);
  });

  it('halts when the re-read webhook is not the target', async () => {
    setupDb(cohort());
    plaid.ignoreUpdateFor = tokenOf(IDS[0]);
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:webhook_not_applied');
  });

  it('halts on an undecryptable token and never falls back to the plaintext copy', async () => {
    const rows = cohort();
    rows[0].access_token_auth_tag = Buffer.alloc(16, 1).toString('base64');
    setupDb(rows);
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:decrypt_failed');
    expect(plaid.calls).toHaveLength(0);
  });

  it('fails the final check when an Item is linked during the pass', async () => {
    setupDb(cohort(), {
      onSecondRead: (rows) => {
        rows.push({ ...cohort()[0], id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
      },
    });
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('failed:item_set_changed');
  });

  it('never logs a token, ciphertext, external item id, webhook URL or host', async () => {
    const rows = cohort();
    setupDb(rows);
    const logs = captureLogs();
    expect(await main(argv(RENDER_HOOK, 'this-backend', APPLY))).toBe(0);
    const out = logs.lines.join('\n');
    for (const s of [
      ...IDS.map(tokenOf),
      ...IDS.map((id) => `ext-${tokenOf(id)}`),
      ...rows.flatMap((r) => [r.access_token_ciphertext, r.access_token_nonce, r.access_token_auth_tag]),
      'render-backend.example.com',
      'railway-backend.example.com',
      'project-ref.supabase.co',
    ]) {
      expect(out).not.toContain(s as string);
    }
  });
});

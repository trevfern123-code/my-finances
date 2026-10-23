import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom } }));

const mockEnv = vi.hoisted(() => ({
  plaidEnv: 'sandbox',
  supabaseUrl: 'https://project-ref.supabase.co',
  backendPublicUrl: 'https://render-backend.example.com' as string | null,
}));
vi.mock('../config/env', () => ({ env: mockEnv }));

// A fake Plaid keyed by access token: each token belongs to one Item (external item_id) with one
// webhook. Every call is recorded; hooks simulate Plaid-side changes made by someone else.
interface FakeItem {
  itemId: string;
  webhook: string | null;
}
const plaid = vi.hoisted(() => ({
  items: new Map<string, FakeItem>(),
  calls: [] as { method: string; accessToken: string; webhook?: string | null }[],
  failUpdateFor: null as string | null,
  ignoreUpdateFor: null as string | null,
  onUpdate: null as ((accessToken: string, n: number) => void) | null,
  updates: 0,
}));
vi.mock('../config/plaid', () => ({
  plaidClient: {
    itemGet: vi.fn(async ({ access_token }: { access_token: string }) => {
      plaid.calls.push({ method: 'itemGet', accessToken: access_token });
      const it = plaid.items.get(access_token);
      if (!it) throw Object.assign(new Error('x'), { response: { status: 400, data: { error_code: 'INVALID_ACCESS_TOKEN' } } });
      return { data: { item: { item_id: it.itemId, webhook: it.webhook } } };
    }),
    itemWebhookUpdate: vi.fn(async ({ access_token, webhook }: { access_token: string; webhook: string | null }) => {
      plaid.calls.push({ method: 'itemWebhookUpdate', accessToken: access_token, webhook });
      plaid.updates++;
      if (plaid.failUpdateFor === access_token) throw Object.assign(new Error('x'), { response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
      const it = plaid.items.get(access_token);
      if (it && plaid.ignoreUpdateFor !== access_token) it.webhook = webhook;
      plaid.onUpdate?.(access_token, plaid.updates);
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
const TYPO_HOOK = 'https://raiiway-backend.example.com/api/webhooks/plaid';
const THIRD_PARTY_HOOK = 'https://elsewhere.example.net/api/webhooks/plaid';
const IDS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
];
const tokenOf = (id: string) => `access-sandbox-${id.slice(0, 4)}`;
const extIdOf = (id: string) => `ext-item-${id.slice(0, 4)}`;

function cohort() {
  return IDS.map((id, i) => {
    const enc = encryptAccessToken(tokenOf(id), RING, id);
    return {
      id,
      plaid_item_id: extIdOf(id),
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

function forward(extra: string[] = [], opts: { total?: number; none?: number } = {}) {
  return [
    '--target-role', 'this-backend',
    '--target-webhook-url', RENDER_HOOK,
    '--approved-previous-webhook-url', RAILWAY_HOOK,
    '--expected-total', String(opts.total ?? 4),
    '--expected-no-webhook', String(opts.none ?? 0),
    '--expected-plaid-env', 'sandbox',
    '--expected-supabase-host', 'project-ref.supabase.co',
    ...extra,
  ];
}
function rollback(extra: string[] = [], opts: { target?: string; none?: number } = {}) {
  return [
    '--target-role', 'other-backend',
    '--target-webhook-url', opts.target ?? RAILWAY_HOOK,
    '--approved-previous-webhook-url', RAILWAY_HOOK,
    '--expected-total', '4',
    '--expected-no-webhook', String(opts.none ?? 0),
    '--expected-plaid-env', 'sandbox',
    '--expected-supabase-host', 'project-ref.supabase.co',
    ...extra,
  ];
}
const APPLY = ['--apply', '--confirm', CONFIRM_TOKEN];

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)));
  return { lines, outcomes: () => lines.map((l) => JSON.parse(l).outcome as string), last: () => JSON.parse(lines.at(-1) as string) };
}
const webhooks = () => IDS.map((id) => plaid.items.get(tokenOf(id))?.webhook);
const updateCalls = () => plaid.calls.filter((c) => c.method === 'itemWebhookUpdate');

beforeEach(() => {
  mockFrom.mockReset();
  keyRingHolder.current = RING;
  mockEnv.backendPublicUrl = 'https://render-backend.example.com';
  mockEnv.plaidEnv = 'sandbox';
  mockEnv.supabaseUrl = 'https://project-ref.supabase.co';
  plaid.items = new Map(IDS.map((id) => [tokenOf(id), { itemId: extIdOf(id), webhook: RAILWAY_HOOK }]));
  plaid.calls = [];
  plaid.failUpdateFor = null;
  plaid.ignoreUpdateFor = null;
  plaid.onUpdate = null;
  plaid.updates = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  __setInterruptedForTests(false);
});

// ---- Arguments ------------------------------------------------------------------------------------------

describe('parseArgs / URLs', () => {
  it.each([
    'http://render-backend.example.com/api/webhooks/plaid',
    'https://render-backend.example.com/api/webhooks/plaid/',
    'https://render-backend.example.com/api/webhooks/plaid?x=1',
    'https://user:pw@render-backend.example.com/api/webhooks/plaid',
    'https://Render-Backend.example.com/api/webhooks/plaid',
    'https://render-backend.example.com/other',
    'https://render-backend.example.com:443/api/webhooks/plaid',
  ])('refuses a non-canonical URL %j', (url) => {
    expect(canonicalWebhookUrl(url)).toBeNull();
  });

  it('requires the approved previous URL, an explicit role, an exact no-webhook count and the confirm token', () => {
    const without = (flag: string) => {
      const a = forward();
      a.splice(a.indexOf(flag), 2);
      return a;
    };
    expect(() => parseArgs(without('--approved-previous-webhook-url'))).toThrow(expect.objectContaining({ code: 'approved_previous_webhook_url_required' }));
    expect(() => parseArgs(without('--expected-no-webhook'))).toThrow(expect.objectContaining({ code: 'expected_no_webhook_required' }));
    expect(() => parseArgs(forward().map((v) => (v === 'this-backend' ? 'render' : v)))).toThrow(expect.objectContaining({ code: 'target_role_invalid' }));
    expect(() => parseArgs(forward(['--apply']))).toThrow(expect.objectContaining({ code: 'apply_requires_confirm' }));
    expect(() => parseArgs(forward(['--confirm', CONFIRM_TOKEN]))).toThrow(expect.objectContaining({ code: 'confirm_without_apply' }));
    expect(() => parseArgs(forward(['--restore-no-webhook-ids', IDS[0]]))).toThrow(expect.objectContaining({ code: 'restore_only_on_rollback' }));
    expect(() => parseArgs(rollback(['--restore-no-webhook-ids', `${IDS[0]},${IDS[0]}`]))).toThrow(expect.objectContaining({ code: 'restore_no_webhook_ids_invalid' }));
    expect(parseArgs(forward(APPLY)).apply).toBe(true);
  });
});

// ---- Preflight ----------------------------------------------------------------------------------------------

describe('preflight', () => {
  it.each([
    ['unset', null],
    ['with a trailing slash (would register //api/...)', 'https://render-backend.example.com/'],
  ])('refuses BOTH directions when BACKEND_PUBLIC_URL is %s', async (_name, value) => {
    for (const a of [forward(), rollback()]) {
      setupDb(cohort());
      mockEnv.backendPublicUrl = value;
      const logs = captureLogs();
      expect(await main(a)).toBe(1);
      expect(logs.outcomes()).toContain('failed:own_webhook_url_unconfigured');
    }
    expect(plaid.calls).toHaveLength(0);
  });

  it('refuses a rollback target that is not exactly the approved previous URL (a host typo)', async () => {
    setupDb(cohort());
    const logs = captureLogs();
    expect(await main(rollback([], { target: TYPO_HOOK }))).toBe(1);
    expect(logs.outcomes()).toContain('failed:target_is_not_approved_previous');
    expect(plaid.calls).toHaveLength(0);
  });

  it('refuses a forward target other than this backend, and an approved previous URL equal to this backend', async () => {
    setupDb(cohort());
    let logs = captureLogs();
    const a = forward();
    a[a.indexOf(RENDER_HOOK)] = THIRD_PARTY_HOOK;
    expect(await main(a)).toBe(1);
    expect(logs.outcomes()).toContain('failed:target_is_not_this_backend');

    setupDb(cohort());
    logs = captureLogs();
    const b = forward();
    b[b.indexOf(RAILWAY_HOOK)] = RENDER_HOOK;
    expect(await main(b)).toBe(1);
    expect(logs.outcomes()).toContain('failed:previous_equals_own');
    expect(plaid.calls).toHaveLength(0);
  });

  it('never reads the database or calls Plaid for the wrong Supabase host', async () => {
    setupDb(cohort());
    mockEnv.supabaseUrl = 'https://other.supabase.co';
    captureLogs();
    expect(await main(forward())).toBe(1);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(plaid.calls).toHaveLength(0);
  });

  it('refuses a count mismatch and an Item that is being removed', async () => {
    const rows = cohort();
    rows[0].status = 'removing';
    setupDb(rows.slice(0, 3));
    const logs = captureLogs();
    expect(await main(forward())).toBe(1);
    expect(logs.outcomes()).toEqual(expect.arrayContaining(['failed:unexpected_total_count', 'failed:item_being_removed']));
    expect(plaid.calls).toHaveLength(0);
  });
});

// ---- Phase 1: classification before any change ------------------------------------------------------------------

describe('classification (read-only, every Item before any update)', () => {
  it('halts with NO update when a decrypted credential belongs to a different Item than the row says', async () => {
    // Row D's token now answers for another Item (a stale or misassociated credential).
    plaid.items.get(tokenOf(IDS[3]))!.itemId = 'ext-item-someone-else';
    setupDb(cohort());
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:item_id_mismatch');
    expect(updateCalls()).toHaveLength(0);
    expect(webhooks()).toEqual([RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK]);
    expect(logs.lines.join('\n')).not.toContain('ext-item');
  });

  it('halts with NO update on an unexpected third-party webhook source, in either direction', async () => {
    plaid.items.get(tokenOf(IDS[2]))!.webhook = THIRD_PARTY_HOOK;
    for (const a of [forward(APPLY), rollback(APPLY)]) {
      setupDb(cohort());
      const logs = captureLogs();
      expect(await main(a)).toBe(1);
      expect(logs.outcomes()).toContain('halted:unexpected_webhook_source');
    }
    expect(updateCalls()).toHaveLength(0);
  });

  it('refuses Items with no webhook unless their number is attested exactly', async () => {
    plaid.items.get(tokenOf(IDS[1]))!.webhook = null;
    setupDb(cohort());
    let logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:unexpected_no_webhook_count');
    expect(updateCalls()).toHaveLength(0);

    setupDb(cohort());
    logs = captureLogs();
    expect(await main(forward([], { none: 1 }))).toBe(0);
    // The dry run names the no-webhook Item by internal row id, so the operator can record it for rollback.
    expect(logs.lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ id: IDS[1], stage: 'classify', outcome: 'source:none' }));
  });
});

// ---- Dry run ------------------------------------------------------------------------------------------------------

describe('dry run (default)', () => {
  it('only reads: one /item/get per Item, no webhook update, no database write', async () => {
    const db = setupDb(cohort());
    const logs = captureLogs();
    expect(await main(forward())).toBe(0);
    expect(plaid.calls.map((c) => c.method)).toEqual(['itemGet', 'itemGet', 'itemGet', 'itemGet']);
    expect(plaid.calls.map((c) => c.accessToken)).toEqual(IDS.map(tokenOf));
    expect(db.writes).toHaveLength(0);
    expect(logs.last()).toMatchObject({ outcome: 'dry_run_complete', counts: { total: 4, on_source: 4, on_target: 0, none: 0, to_update: 4 } });
  });
});

// ---- Apply ----------------------------------------------------------------------------------------------------------

describe('apply', () => {
  it('moves every Item, verifies each, then re-reads every Item at Plaid before reporting success', async () => {
    const db = setupDb(cohort());
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(0);
    expect(webhooks()).toEqual([RENDER_HOOK, RENDER_HOOK, RENDER_HOOK, RENDER_HOOK]);
    expect(plaid.calls.map((c) => c.method)).toEqual([
      ...Array(4).fill('itemGet'), // classify
      ...Array(4).fill(['itemWebhookUpdate', 'itemGet']).flat(), // update + verify
      ...Array(4).fill('itemGet'), // postflight
    ]);
    expect(db.writes).toHaveLength(0);
    expect(logs.outcomes()).toContain('passed');
    expect(logs.last()).toMatchObject({ outcome: 'webhooks_on_target' });
  });

  it('fails the postflight when an earlier Item changes again while a later Item is updated', async () => {
    plaid.onUpdate = (_token, n) => {
      if (n === 3) plaid.items.get(tokenOf(IDS[0]))!.webhook = RAILWAY_HOOK; // A was already moved and verified
    };
    setupDb(cohort());
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ id: IDS[0], outcome: 'failed:webhook_changed_after_update' }));
    expect(logs.outcomes()).not.toContain('webhooks_on_target');
  });

  it('fails the postflight when an Item\'s token starts answering for another Item after the updates', async () => {
    plaid.onUpdate = (_token, n) => {
      if (n === 4) plaid.items.get(tokenOf(IDS[1]))!.itemId = 'ext-item-someone-else';
    };
    setupDb(cohort());
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:item_id_mismatch');
    expect(logs.outcomes()).not.toContain('webhooks_on_target');
  });

  it('is idempotent: a rerun classifies everything on target and updates nothing', async () => {
    setupDb(cohort());
    captureLogs();
    await main(forward(APPLY));
    plaid.calls = [];
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(0);
    expect(updateCalls()).toHaveLength(0);
    expect(logs.last()).toMatchObject({ outcome: 'webhooks_on_target', counts: { on_target: 4, to_update: 0 } });
  });

  it('rolls back to the approved previous URL, restoring an originally unset webhook only when listed', async () => {
    plaid.items.get(tokenOf(IDS[1]))!.webhook = null; // B had no webhook before the move
    setupDb(cohort());
    captureLogs();
    expect(await main(forward(APPLY, { none: 1 }))).toBe(0);
    expect(webhooks()).toEqual([RENDER_HOOK, RENDER_HOOK, RENDER_HOOK, RENDER_HOOK]);

    setupDb(cohort());
    captureLogs();
    expect(await main(rollback([...APPLY, '--restore-no-webhook-ids', IDS[1]]))).toBe(0);
    expect(webhooks()).toEqual([RAILWAY_HOOK, null, RAILWAY_HOOK, RAILWAY_HOOK]);
    expect(updateCalls().at(-3)).toMatchObject({ webhook: null });

    // Re-running the same rollback is a no-op (B is now "none" and still listed).
    setupDb(cohort());
    plaid.calls = [];
    captureLogs();
    expect(await main(rollback([...APPLY, '--restore-no-webhook-ids', IDS[1]], { none: 1 }))).toBe(0);
    expect(updateCalls()).toHaveLength(0);
  });

  it('a rollback without the restore list moves an originally unset Item to the previous URL, as documented', async () => {
    plaid.items.get(tokenOf(IDS[1]))!.webhook = null;
    setupDb(cohort());
    captureLogs();
    await main(forward(APPLY, { none: 1 }));
    setupDb(cohort());
    captureLogs();
    expect(await main(rollback(APPLY))).toBe(0);
    expect(webhooks()).toEqual([RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK]);
  });

  it('refuses a restore id that is on the previous URL (contradicts the operator record) or unknown', async () => {
    setupDb(cohort());
    let logs = captureLogs();
    expect(await main(rollback([...APPLY, '--restore-no-webhook-ids', IDS[0]]))).toBe(1);
    expect(logs.outcomes()).toContain('halted:restore_id_unexpected_state');
    setupDb(cohort());
    logs = captureLogs();
    expect(await main(rollback([...APPLY, '--restore-no-webhook-ids', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']))).toBe(1);
    expect(logs.outcomes()).toContain('failed:restore_id_not_found');
    expect(updateCalls()).toHaveLength(0);
  });

  it('halts on the first Plaid refusal, logging only the Plaid error code; earlier Items stay moved, later ones untouched', async () => {
    setupDb(cohort());
    plaid.failUpdateFor = tokenOf(IDS[1]);
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:plaid_error:ITEM_LOGIN_REQUIRED');
    expect(webhooks()).toEqual([RENDER_HOOK, RAILWAY_HOOK, RAILWAY_HOOK, RAILWAY_HOOK]);
  });

  it('halts when the re-read webhook is not the target', async () => {
    setupDb(cohort());
    plaid.ignoreUpdateFor = tokenOf(IDS[0]);
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('halted:webhook_not_applied');
  });

  it('stops at the next checkpoint when interrupted mid-run, without reporting success', async () => {
    plaid.onUpdate = (_token, n) => {
      if (n === 2) __setInterruptedForTests(true);
    };
    setupDb(cohort());
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ id: IDS[1], outcome: 'halted:interrupted' }));
    expect(updateCalls()).toHaveLength(2);
    expect(logs.outcomes()).not.toContain('webhooks_on_target');
  });

  it('halts on an undecryptable token and never falls back to the plaintext copy', async () => {
    const rows = cohort();
    rows[0].access_token_auth_tag = Buffer.alloc(16, 1).toString('base64');
    setupDb(rows);
    const logs = captureLogs();
    expect(await main(forward(APPLY))).toBe(1);
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
    expect(await main(forward(APPLY))).toBe(1);
    expect(logs.outcomes()).toContain('failed:item_set_changed');
  });

  it('never logs a token, ciphertext, external item id, webhook URL or host', async () => {
    plaid.items.get(tokenOf(IDS[1]))!.webhook = null;
    const rows = cohort();
    setupDb(rows);
    const logs = captureLogs();
    expect(await main(forward(APPLY, { none: 1 }))).toBe(0);
    const out = logs.lines.join('\n');
    for (const s of [
      ...IDS.map(tokenOf),
      ...IDS.map(extIdOf),
      ...rows.flatMap((r) => [r.access_token_ciphertext, r.access_token_nonce, r.access_token_auth_tag]),
      'render-backend.example.com',
      'railway-backend.example.com',
      'project-ref.supabase.co',
    ]) {
      expect(out).not.toContain(s as string);
    }
  });
});

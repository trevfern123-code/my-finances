import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemRemovalRecord } from './dataService';
import { UnknownKeyIdError } from './tokenEncryption';

// A stateful stand-in for the database contract (the SQL itself is proven against PostgreSQL 17 by
// supabase/tests/access_control a03/a04/c07-c09): one removal record per item, the same transitions,
// the same refusals. What this file tests is the orchestration around it.
const db = vi.hoisted(() => ({
  item: null as null | { id: string; status: string; access_token: string | Error },
  removal: null as null | Record<string, unknown>,
  digest: 'digest-now',
  cleanupError: null as null | Error,
  calls: [] as string[],
}));

const mockTransitionItemStatus = vi.hoisted(() => vi.fn());
vi.mock('./dataService', () => ({
  getItemRemoval: vi.fn(async () => (db.removal ? { ...db.removal } : null)),
  getPlaidItemForUser: vi.fn(async () => {
    if (!db.item) return null;
    if (db.item.access_token instanceof Error) throw db.item.access_token;
    return { id: db.item.id, status: db.item.status, access_token: db.item.access_token };
  }),
  transitionItemStatus: mockTransitionItemStatus,
  beginItemRemoval: vi.fn(async (_u: string, itemId: string, digest: string | null) => {
    db.calls.push('begin');
    if (db.removal) return { outcome: 'existing', removal: { ...db.removal } };
    if (!db.item) return { outcome: 'not_found' };
    if (db.item.status === 'credential_error') return { outcome: 'connection_needs_attention' };
    if (digest !== db.digest) return { outcome: 'preview_stale' };
    db.removal = {
      item_id: itemId, institution_name: 'Test Bank', status: 'requested', attempts: 0, last_outcome: null, last_error_code: null,
      plaid_outcome: null, loan_adjustments: null, deleted_counts: null, requested_at: '2026-09-26T00:00:00Z', cleaned_at: null,
      reconciled_at: null, user_id: 'user-1', plaid_item_id: 'plaid-item-1', preview_digest: digest, status_before: db.item.status,
    };
    db.item.status = 'removing';
    return { outcome: 'started', removal: { ...db.removal } };
  }),
  recordItemRemovalAttempt: vi.fn(async (_u: string, _i: string, outcome: string, code: string | null) => {
    db.calls.push(`attempt:${outcome}`);
    const r = db.removal!;
    if (r.status !== 'requested') return { ...r };
    r.attempts = (r.attempts as number) + 1;
    if (outcome === 'removed' || outcome === 'already_removed') {
      Object.assign(r, { status: 'plaid_removed', plaid_outcome: outcome, last_outcome: null, last_error_code: code });
    } else {
      Object.assign(r, { last_outcome: outcome, last_error_code: code });
    }
    return { ...r };
  }),
  removeItemLocally: vi.fn(async () => {
    db.calls.push('cleanup');
    if (db.cleanupError) throw db.cleanupError;
    if (db.removal!.status !== 'plaid_removed' && db.removal!.status !== 'cleaned') throw new Error('Plaid removal is not confirmed');
    if (db.removal!.status === 'plaid_removed') {
      Object.assign(db.removal!, {
        status: 'cleaned', cleaned_at: '2026-09-26T00:01:00Z',
        loan_adjustments: [{ loan_id: 'loan-1', loan_name: 'Loan', linked_transactions: 1, restored: 50, balance_before: 0, balance_after: 50 }],
        deleted_counts: { accounts: 1, transactions: 3 },
      });
      db.item = null;
    }
    return { replayed: false, loan_adjustments: db.removal!.loan_adjustments, deleted_counts: db.removal!.deleted_counts };
  }),
  markItemRemovalReconciled: vi.fn(async () => {
    db.calls.push('reconciled');
    db.removal!.reconciled_at = '2026-09-26T00:02:00Z';
  }),
}));

const mockRemoveItem = vi.hoisted(() => vi.fn());
vi.mock('./plaidService', () => ({ removeItem: mockRemoveItem }));

const mockRepair = vi.hoisted(() => vi.fn());
const mockReconcile = vi.hoisted(() => vi.fn());
vi.mock('./roleReconciliation', () => ({ repairExistingRelationalRoles: mockRepair, reconcileRelationalRoles: mockReconcile }));

const mockSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./netWorth', () => ({ recordSnapshotForUser: mockSnapshot }));

import { ItemRemovalIncompleteError, runItemRemoval, toRemovalView } from './itemRemoval';

const plaidError = (status: number, code?: string) => ({ response: { status, data: code ? { error_code: code } : {} } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.item = { id: 'item-1', status: 'active', access_token: 'access-sandbox-placeholder' };
  db.removal = null;
  db.digest = 'digest-now';
  db.cleanupError = null;
  db.calls = [];
  mockRemoveItem.mockResolvedValue(undefined);
  mockRepair.mockResolvedValue({ resolved: [], unresolved: [] });
  mockReconcile.mockResolvedValue({ resolved: [], unresolved: [] });
  mockSnapshot.mockResolvedValue(undefined);
});

describe('runItemRemoval — the happy path', () => {
  it('Plaid first, then local cleanup, then the follow-ups: finished', async () => {
    const result = await runItemRemoval('user-1', 'item-1', 'digest-now');
    expect(result).toMatchObject({ kind: 'progressed', removal: { status: 'cleaned', finished: true, plaid_outcome: 'removed' } });
    expect(db.calls).toEqual(['begin', 'attempt:removed', 'cleanup', 'reconciled']);
    expect(mockRemoveItem).toHaveBeenCalledExactlyOnceWith('access-sandbox-placeholder');
    expect(mockRemoveItem.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked((await import('./dataService')).removeItemLocally).mock.invocationCallOrder[0]
    );
    expect(mockRepair).toHaveBeenCalledWith('user-1');
    expect(mockSnapshot).toHaveBeenCalledWith('user-1');
  });

  it('ITEM_NOT_FOUND counts as removed at Plaid, and the removal completes', async () => {
    mockRemoveItem.mockRejectedValueOnce(plaidError(400, 'ITEM_NOT_FOUND'));
    const result = await runItemRemoval('user-1', 'item-1', 'digest-now');
    expect(result).toMatchObject({ kind: 'progressed', removal: { finished: true, plaid_outcome: 'already_removed' } });
    expect(db.calls).toEqual(['begin', 'attempt:already_removed', 'cleanup', 'reconciled']);
  });

  it('forward-reconciles exactly the rows the repair sweep reset (deduplicated)', async () => {
    mockRepair.mockResolvedValueOnce({ resolved: [{ id: 't1', fields: {} }, { id: 't2', fields: {} }, { id: 't1', fields: {} }], unresolved: [] });
    await runItemRemoval('user-1', 'item-1', 'digest-now');
    expect(mockReconcile).toHaveBeenCalledExactlyOnceWith('user-1', ['t1', 't2']);
    expect(mockReconcile.mock.invocationCallOrder[0]).toBeGreaterThan(mockRepair.mock.invocationCallOrder[0]);
    expect(mockSnapshot.mock.invocationCallOrder[0]).toBeGreaterThan(mockReconcile.mock.invocationCallOrder[0]);
  });

  it('skips the forward pass when the sweep reset nothing', async () => {
    await runItemRemoval('user-1', 'item-1', 'digest-now');
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});

describe('runItemRemoval — refusals (nothing happens at Plaid or locally)', () => {
  it('an unknown item (or another user\'s) is not found', async () => {
    db.item = null;
    expect(await runItemRemoval('user-1', 'item-1', 'digest-now')).toEqual({ kind: 'not_found' });
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it('a stale preview digest is refused', async () => {
    expect(await runItemRemoval('user-1', 'item-1', 'digest-old')).toEqual({ kind: 'preview_stale' });
    expect(db.removal).toBeNull();
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it('an unreadable credential refuses up front (409 connection_needs_attention) and flags the item', async () => {
    db.item!.access_token = new UnknownKeyIdError('item-1');
    expect(await runItemRemoval('user-1', 'item-1', 'digest-now')).toEqual({ kind: 'connection_needs_attention' });
    expect(mockTransitionItemStatus).toHaveBeenCalledWith('item-1', 'credential_error');
    expect(db.calls).not.toContain('begin');
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it('an item already flagged credential_error is refused by the database', async () => {
    db.item!.status = 'credential_error';
    expect(await runItemRemoval('user-1', 'item-1', 'digest-now')).toEqual({ kind: 'connection_needs_attention' });
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });
});

describe('runItemRemoval — unknown Plaid outcomes never delete local data', () => {
  it.each([
    ['a timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
    ['a Plaid 5xx', plaidError(500, 'INTERNAL_SERVER_ERROR')],
    ['rate limiting', plaidError(429, 'RATE_LIMIT_EXCEEDED')],
  ])('%s: stays requested (retryable), no cleanup', async (_label, err) => {
    mockRemoveItem.mockRejectedValueOnce(err);
    const result = await runItemRemoval('user-1', 'item-1', 'digest-now');
    expect(result).toMatchObject({ kind: 'progressed', removal: { status: 'requested', finished: false, last_outcome: 'retryable', attempts: 1 } });
    expect(db.calls).not.toContain('cleanup');
    expect(db.item).not.toBeNull();
  });

  it('a definitive refusal (INVALID_ACCESS_TOKEN) needs attention: stays requested, no cleanup, never treated as removed', async () => {
    mockRemoveItem.mockRejectedValueOnce(plaidError(400, 'INVALID_ACCESS_TOKEN'));
    const result = await runItemRemoval('user-1', 'item-1', 'digest-now');
    expect(result).toMatchObject({ removal: { status: 'requested', last_outcome: 'needs_attention', last_error_code: 'INVALID_ACCESS_TOKEN' } });
    expect(db.calls).not.toContain('cleanup');
  });

  it('a retry after a timeout calls Plaid again and then completes', async () => {
    mockRemoveItem.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await runItemRemoval('user-1', 'item-1', 'digest-now');
    // The first call had in fact succeeded at Plaid: the retry is told the Item no longer exists.
    mockRemoveItem.mockRejectedValueOnce(plaidError(400, 'ITEM_NOT_FOUND'));
    const retry = await runItemRemoval('user-1', 'item-1', null); // digest ignored on resume
    expect(retry).toMatchObject({ removal: { finished: true, plaid_outcome: 'already_removed', attempts: 2 } });
    expect(mockRemoveItem).toHaveBeenCalledTimes(2);
  });

  it('never logs the raw Plaid error (it can carry the access token)', async () => {
    const err = Object.assign(new Error('boom'), { config: { data: '{"access_token":"access-sandbox-placeholder"}' } });
    mockRemoveItem.mockRejectedValueOnce(err);
    await runItemRemoval('user-1', 'item-1', 'digest-now');
    for (const call of vi.mocked(console.error).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('access-sandbox-placeholder');
    }
  });

  it('a credential that became unreadable after the removal began: stays requested, needs attention, Plaid not called', async () => {
    db.removal = {
      item_id: 'item-1', institution_name: 'Test Bank', status: 'requested', attempts: 0, last_outcome: null, last_error_code: null,
      plaid_outcome: null, loan_adjustments: null, deleted_counts: null, requested_at: 'x', cleaned_at: null, reconciled_at: null,
    };
    db.item = { id: 'item-1', status: 'removing', access_token: new UnknownKeyIdError('item-1') };
    const result = await runItemRemoval('user-1', 'item-1', null);
    expect(result).toMatchObject({ removal: { status: 'requested', last_outcome: 'needs_attention', last_error_code: 'CREDENTIAL_UNREADABLE' } });
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(db.calls).not.toContain('cleanup');
  });
});

describe('runItemRemoval — resuming', () => {
  it('from plaid_removed: local cleanup only, Plaid is never called again', async () => {
    db.removal = {
      item_id: 'item-1', institution_name: 'Test Bank', status: 'plaid_removed', attempts: 1, last_outcome: null, last_error_code: null,
      plaid_outcome: 'removed', loan_adjustments: null, deleted_counts: null, requested_at: 'x', cleaned_at: null, reconciled_at: null,
    };
    db.item!.status = 'removing';
    const result = await runItemRemoval('user-1', 'item-1', null);
    expect(result).toMatchObject({ removal: { finished: true } });
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(db.calls).toEqual(['cleanup', 'reconciled']);
  });

  it('from cleaned-but-unreconciled: only the follow-ups rerun', async () => {
    db.removal = {
      item_id: 'item-1', institution_name: 'Test Bank', status: 'cleaned', attempts: 1, last_outcome: null, last_error_code: null,
      plaid_outcome: 'removed', loan_adjustments: [], deleted_counts: {}, requested_at: 'x', cleaned_at: 'y', reconciled_at: null,
    };
    db.item = null;
    const result = await runItemRemoval('user-1', 'item-1', null);
    expect(result).toMatchObject({ removal: { finished: true } });
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(db.calls).toEqual(['reconciled']);
    expect(mockRepair).toHaveBeenCalled();
    expect(mockSnapshot).toHaveBeenCalled();
  });

  it('a finished removal is returned as-is (no work repeated)', async () => {
    await runItemRemoval('user-1', 'item-1', 'digest-now');
    vi.clearAllMocks();
    db.calls = [];
    const again = await runItemRemoval('user-1', 'item-1', null);
    expect(again).toMatchObject({ removal: { finished: true } });
    expect(db.calls).toEqual([]);
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(mockRepair).not.toHaveBeenCalled();
  });

  it('a cleanup failure leaves the operation at plaid_removed and reports it incomplete (retryable)', async () => {
    db.cleanupError = new Error('manual-loan reconciliation required: remove_plaid_item_local: ...');
    const err = await runItemRemoval('user-1', 'item-1', 'digest-now').catch((e) => e);
    expect(err).toBeInstanceOf(ItemRemovalIncompleteError);
    expect((err as ItemRemovalIncompleteError).removal).toMatchObject({ status: 'plaid_removed', finished: false });
    expect(db.item).not.toBeNull(); // nothing deleted
    db.cleanupError = null;
    expect(await runItemRemoval('user-1', 'item-1', null)).toMatchObject({ removal: { finished: true } });
    expect(mockRemoveItem).toHaveBeenCalledTimes(1);
  });

  it('a follow-up failure leaves the operation cleaned but unfinished, and a retry finishes it', async () => {
    mockSnapshot.mockRejectedValueOnce(new Error('snapshot failed'));
    const err = await runItemRemoval('user-1', 'item-1', 'digest-now').catch((e) => e);
    expect((err as ItemRemovalIncompleteError).removal).toMatchObject({ status: 'cleaned', finished: false });
    expect(db.calls).not.toContain('reconciled');
    const retry = await runItemRemoval('user-1', 'item-1', null);
    expect(retry).toMatchObject({ removal: { status: 'cleaned', finished: true } });
    expect(db.calls.filter((c) => c === 'cleanup')).toHaveLength(1); // the cleanup ran once
  });
});

describe('toRemovalView', () => {
  it('never exposes user ids, the Plaid item id or the preview digest', () => {
    const view = toRemovalView({
      id: 'op-1', user_id: 'user-1', item_id: 'item-1', plaid_item_id: 'plaid-item-1', institution_name: 'Bank', status_before: 'active',
      status: 'requested', preview_digest: 'secretish', attempts: 0, last_attempt_at: null, last_outcome: null, last_error_code: null,
      plaid_outcome: null, loan_adjustments: null, deleted_counts: null, requested_at: 'x', plaid_removed_at: null, cleaned_at: null,
      reconciled_at: null,
    } as ItemRemovalRecord);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('plaid-item-1');
    expect(serialized).not.toContain('secretish');
  });
});

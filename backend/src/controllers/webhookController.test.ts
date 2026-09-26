import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { handlePlaidWebhook } from './webhookController';
import { PlaidCredentialError, UnknownKeyIdError } from '../services/tokenEncryption';

const mockVerifyPlaidWebhook = vi.hoisted(() => vi.fn());
vi.mock('../services/webhookVerification', () => ({ verifyPlaidWebhook: mockVerifyPlaidWebhook }));

const mockGetPlaidItemByPlaidItemId = vi.hoisted(() => vi.fn());
const mockTransitionItemStatus = vi.hoisted(() => vi.fn());
const mockGetPlaidItemStatusByPlaidItemId = vi.hoisted(() => vi.fn());
const mockRecordItemPendingExpiration = vi.hoisted(() => vi.fn());
const mockMarkPlaidLinkAttemptReady = vi.hoisted(() => vi.fn());
const mockClaimPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockFinishPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockInsertPlaidItem = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getPlaidItemByPlaidItemId: mockGetPlaidItemByPlaidItemId,
  transitionItemStatus: mockTransitionItemStatus,
  getPlaidItemStatusByPlaidItemId: mockGetPlaidItemStatusByPlaidItemId,
  recordItemPendingExpiration: mockRecordItemPendingExpiration,
  markPlaidLinkAttemptReady: mockMarkPlaidLinkAttemptReady,
  claimPlaidLinkAttempt: mockClaimPlaidLinkAttempt,
  finishPlaidLinkAttempt: mockFinishPlaidLinkAttempt,
  insertPlaidItem: mockInsertPlaidItem,
}));

const mockSyncItemTransactions = vi.hoisted(() => vi.fn());
vi.mock('../services/syncService', () => ({ syncItemTransactions: mockSyncItemTransactions }));

function fakeReq(payload: Record<string, unknown>): Request {
  return {
    headers: { 'plaid-verification': 'signed-jwt' },
    rawBody: Buffer.from(JSON.stringify(payload)),
    body: payload,
  } as unknown as Request;
}

function fakeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

// The controller acknowledges the webhook synchronously, then continues processing in a
// fire-and-forget promise (see handlePlaidWebhook's own comment) — flush microtasks so that
// background work has actually run before each test's assertions.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Matches the shape errorSanitizer.ts's summarizeErrorSafely produces for a plain Error with no
 *  Plaid/Axios fields — every log-call assertion below checks against this, never a raw Error
 *  instance or a bare string, since that's exactly the distinction these tests exist to lock in. */
function safeSummaryFor(err: Error) {
  return {
    name: err.name,
    message: err.message,
    plaidErrorCode: undefined,
    plaidErrorType: undefined,
    httpStatus: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockVerifyPlaidWebhook.mockResolvedValue({});
  // Linked Institution Management: every non-LINK webhook first reads the item's status (no token).
  mockGetPlaidItemStatusByPlaidItemId.mockResolvedValue({ id: 'row-1', user_id: 'user-1', status: 'active' });
});

describe('handlePlaidWebhook — credential-error handling on the async path (§7 Phase 4, §9)', () => {
  it('logs a sanitized summary (never the raw error) when the item cannot be resolved at all (no internal row id known)', async () => {
    const err = new UnknownKeyIdError(); // no itemRowId — the row itself never resolved
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(res.status).toHaveBeenCalledWith(200); // still acknowledged before the failure surfaced
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Plaid credential error resolving webhook item plaid-item-1'),
      safeSummaryFor(err)
    );
    // No internal row id was available on this error, so there is genuinely nothing to mark —
    // confirms this stays an honest "logged, not silently treated as success" case rather than
    // guessing at a row id.
    expect(mockTransitionItemStatus).not.toHaveBeenCalled();
  });

  it('marks the correct item credential_error when the thrown error carries its itemRowId (Blocker 3)', async () => {
    const err = new UnknownKeyIdError('internal-row-42');
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('internal-row-42', 'credential_error');
  });

  it('one item\'s credential failure does not affect another item\'s status', async () => {
    const err = new UnknownKeyIdError('row-affected');
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-affected', 'credential_error');
    expect(mockTransitionItemStatus).not.toHaveBeenCalledWith('row-unrelated', expect.anything());
  });

  it('rethrows (surfacing to the outer .catch, sanitized) a non-credential error resolving the item', async () => {
    const err = new Error('network blip');
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledWith(
      'Failed to process Plaid webhook:',
      'SYNC_UPDATES_AVAILABLE',
      safeSummaryFor(err)
    );
    expect(mockTransitionItemStatus).not.toHaveBeenCalled();
  });

  it('processes a normal webhook exactly as before when nothing fails', async () => {
    mockGetPlaidItemByPlaidItemId.mockResolvedValue({
      id: 'row-1',
      user_id: 'user-1',
      access_token: 'a-token',
      transactions_cursor: 'cursor-1',
    });
    mockSyncItemTransactions.mockResolvedValue({ added: 0, modified: 0, removed: 0 });
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(mockSyncItemTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'row-1', access_token: 'a-token' })
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('legitimate Plaid reauthentication (ITEM_LOGIN_REQUIRED) still sets login_required, distinct from credential_error', async () => {
    mockGetPlaidItemByPlaidItemId.mockResolvedValue({
      id: 'row-1',
      user_id: 'user-1',
      access_token: 'a-token',
      transactions_cursor: 'cursor-1',
    });
    const req = fakeReq({
      webhook_type: 'ITEM',
      webhook_code: 'ERROR',
      item_id: 'plaid-item-1',
      error: { error_code: 'ITEM_LOGIN_REQUIRED' },
    });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'login_required');
    expect(mockTransitionItemStatus).not.toHaveBeenCalledWith('row-1', 'credential_error');
  });

  it('does not swallow a PlaidCredentialError instance differently than any of its subclasses (instanceof, not name-matching)', async () => {
    class SomeFutureSubclass extends PlaidCredentialError {
      constructor(itemRowId?: string) {
        super('future subclass', itemRowId);
      }
    }
    const err = new SomeFutureSubclass('row-99');
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Plaid credential error resolving webhook item plaid-item-1'),
      safeSummaryFor(err)
    );
    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-99', 'credential_error');
  });
});

describe('handlePlaidWebhook — LINK SESSION_FINISHED (Wave 1 Hosted Link): readiness only', () => {
  const LINK_TOKEN = 'link-sandbox-placeholder-token';
  const sessionFinished = (overrides: Record<string, unknown> = {}) => ({
    webhook_type: 'LINK',
    webhook_code: 'SESSION_FINISHED',
    status: 'SUCCESS',
    link_session_id: 'session-1',
    link_token: LINK_TOKEN,
    public_tokens: ['public-token-from-webhook'],
    environment: 'sandbox',
    ...overrides,
  });

  function expectNoLinkSideEffects() {
    expect(mockClaimPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(mockFinishPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(mockInsertPlaidItem).not.toHaveBeenCalled();
    expect(mockGetPlaidItemByPlaidItemId).not.toHaveBeenCalled();
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
  }

  it('records readiness for the link token and nothing else — its public tokens are never used', async () => {
    mockMarkPlaidLinkAttemptReady.mockResolvedValue(true);
    const res = fakeRes();
    await handlePlaidWebhook(fakeReq(sessionFinished()), res);
    await flushMicrotasks();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockMarkPlaidLinkAttemptReady).toHaveBeenCalledExactlyOnceWith(LINK_TOKEN, 'SUCCESS');
    expectNoLinkSideEffects();
    expect(JSON.stringify(mockMarkPlaidLinkAttemptReady.mock.calls)).not.toContain('public-token-from-webhook');
  });

  it('duplicate delivery: each is acknowledged, the second records nothing new, and still nothing is exchanged', async () => {
    mockMarkPlaidLinkAttemptReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      await handlePlaidWebhook(fakeReq(sessionFinished()), res);
      expect(res.status).toHaveBeenCalledWith(200);
    }
    await flushMicrotasks();
    expect(mockMarkPlaidLinkAttemptReady).toHaveBeenCalledTimes(2);
    expectNoLinkSideEffects();
  });

  it('an unverified SESSION_FINISHED is rejected before anything is recorded', async () => {
    mockVerifyPlaidWebhook.mockResolvedValue(null);
    const res = fakeRes();
    await handlePlaidWebhook(fakeReq(sessionFinished()), res);
    await flushMicrotasks();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockMarkPlaidLinkAttemptReady).not.toHaveBeenCalled();
  });

  it('a LINK webhook without a link token, or with another code, is ignored', async () => {
    await handlePlaidWebhook(fakeReq(sessionFinished({ link_token: undefined })), fakeRes());
    await handlePlaidWebhook(fakeReq(sessionFinished({ webhook_code: 'EVENTS' })), fakeRes());
    await flushMicrotasks();
    expect(mockMarkPlaidLinkAttemptReady).not.toHaveBeenCalled();
    expectNoLinkSideEffects();
  });

  it('a failure recording readiness is logged without the link token', async () => {
    mockMarkPlaidLinkAttemptReady.mockRejectedValue(new Error('Failed to record Plaid Link readiness: connection reset'));
    await handlePlaidWebhook(fakeReq(sessionFinished()), fakeRes());
    await flushMicrotasks();
    expect(console.error).toHaveBeenCalled();
    expect(JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(LINK_TOKEN);
  });
});

describe('handlePlaidWebhook — connection lifecycle (Linked Institution Management)', () => {
  const syncUpdates = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' };
  const itemWebhook = (code: string, extra: Record<string, unknown> = {}) => ({ webhook_type: 'ITEM', webhook_code: code, item_id: 'plaid-item-1', ...extra });

  async function deliver(payload: Record<string, unknown>) {
    const res = fakeRes();
    await handlePlaidWebhook(fakeReq(payload), res);
    await flushMicrotasks();
    expect(res.status).toHaveBeenCalledWith(200);
  }

  it('USER_PERMISSION_REVOKED marks the item permission_revoked — and deletes nothing', async () => {
    await deliver(itemWebhook('USER_PERMISSION_REVOKED'));
    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'permission_revoked');
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
    expect(mockGetPlaidItemByPlaidItemId).not.toHaveBeenCalled(); // no token needed
  });

  it('PENDING_EXPIRATION records the expiry time and flags the item', async () => {
    await deliver(itemWebhook('PENDING_EXPIRATION', { consent_expiration_time: '2026-10-02T12:00:00Z' }));
    expect(mockRecordItemPendingExpiration).toHaveBeenCalledExactlyOnceWith('row-1', '2026-10-02T12:00:00.000Z');
  });

  it('PENDING_EXPIRATION without a usable time still flags the item', async () => {
    await deliver(itemWebhook('PENDING_EXPIRATION', { consent_expiration_time: 'not-a-date' }));
    expect(mockRecordItemPendingExpiration).not.toHaveBeenCalled();
    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'pending_expiration');
  });

  it('PENDING_DISCONNECT flags the item for reconnection', async () => {
    await deliver(itemWebhook('PENDING_DISCONNECT', { reason: 'INSTITUTION_MIGRATION' }));
    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'pending_expiration');
  });

  it('LOGIN_REPAIRED clears login_required', async () => {
    await deliver(itemWebhook('LOGIN_REPAIRED'));
    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'login_repaired');
  });

  it('unhandled ITEM codes (e.g. NEW_ACCOUNTS_AVAILABLE) change nothing', async () => {
    await deliver(itemWebhook('NEW_ACCOUNTS_AVAILABLE'));
    expect(mockTransitionItemStatus).not.toHaveBeenCalled();
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
  });

  it('a status webhook works even when the item\'s credential cannot be decrypted (the token is never read)', async () => {
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(new UnknownKeyIdError('row-1'));
    await deliver(itemWebhook('USER_PERMISSION_REVOKED'));
    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'permission_revoked');
  });

  it.each([
    ['a sync', syncUpdates],
    ['ITEM_LOGIN_REQUIRED', itemWebhook('ERROR', { error: { error_code: 'ITEM_LOGIN_REQUIRED' } })],
    ['USER_PERMISSION_REVOKED', itemWebhook('USER_PERMISSION_REVOKED')],
    ['PENDING_EXPIRATION', itemWebhook('PENDING_EXPIRATION', { consent_expiration_time: '2026-10-02T12:00:00Z' })],
  ])('a removing item ignores %s entirely', async (_label, payload) => {
    mockGetPlaidItemStatusByPlaidItemId.mockResolvedValue({ id: 'row-1', user_id: 'user-1', status: 'removing' });
    await deliver(payload);
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
    expect(mockTransitionItemStatus).not.toHaveBeenCalled();
    expect(mockRecordItemPendingExpiration).not.toHaveBeenCalled();
    expect(mockGetPlaidItemByPlaidItemId).not.toHaveBeenCalled();
  });

  it('a permission_revoked item does not sync (its data is kept, untouched)', async () => {
    mockGetPlaidItemStatusByPlaidItemId.mockResolvedValue({ id: 'row-1', user_id: 'user-1', status: 'permission_revoked' });
    await deliver(syncUpdates);
    expect(mockGetPlaidItemByPlaidItemId).not.toHaveBeenCalled();
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
  });

  it('an unknown (or already removed) item is ignored', async () => {
    mockGetPlaidItemStatusByPlaidItemId.mockResolvedValue(null);
    await deliver(syncUpdates);
    await deliver(itemWebhook('USER_PERMISSION_REVOKED'));
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
    expect(mockTransitionItemStatus).not.toHaveBeenCalled();
  });
});

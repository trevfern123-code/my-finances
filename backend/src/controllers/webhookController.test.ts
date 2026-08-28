import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { handlePlaidWebhook } from './webhookController';
import { PlaidCredentialError, UnknownKeyIdError } from '../services/tokenEncryption';

const mockVerifyPlaidWebhook = vi.hoisted(() => vi.fn());
vi.mock('../services/webhookVerification', () => ({ verifyPlaidWebhook: mockVerifyPlaidWebhook }));

const mockGetPlaidItemByPlaidItemId = vi.hoisted(() => vi.fn());
const mockSetItemStatus = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getPlaidItemByPlaidItemId: mockGetPlaidItemByPlaidItemId,
  setItemStatus: mockSetItemStatus,
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
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('marks the correct item credential_error when the thrown error carries its itemRowId (Blocker 3)', async () => {
    const err = new UnknownKeyIdError('internal-row-42');
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(mockSetItemStatus).toHaveBeenCalledExactlyOnceWith('internal-row-42', 'credential_error');
  });

  it('one item\'s credential failure does not affect another item\'s status', async () => {
    const err = new UnknownKeyIdError('row-affected');
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(err);
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(mockSetItemStatus).toHaveBeenCalledExactlyOnceWith('row-affected', 'credential_error');
    expect(mockSetItemStatus).not.toHaveBeenCalledWith('row-unrelated', expect.anything());
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
    expect(mockSetItemStatus).not.toHaveBeenCalled();
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

    expect(mockSetItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'login_required');
    expect(mockSetItemStatus).not.toHaveBeenCalledWith('row-1', 'credential_error');
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
    expect(mockSetItemStatus).toHaveBeenCalledExactlyOnceWith('row-99', 'credential_error');
  });
});

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockVerifyPlaidWebhook.mockResolvedValue({});
});

describe('handlePlaidWebhook — credential-error handling on the async path (§7 Phase 4, §9)', () => {
  it('logs a credential error resolving the item and does not throw an unhandled rejection', async () => {
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(new UnknownKeyIdError());
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(res.status).toHaveBeenCalledWith(200); // still acknowledged before the failure surfaced
    expect(mockSyncItemTransactions).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Plaid credential error resolving webhook item plaid-item-1'),
      'UnknownKeyIdError'
    );
    // No internal row id was ever available for this failure mode — confirms this case is
    // deliberately just logged, not silently treated as a normal processing error either.
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });

  it('rethrows (surfacing to the outer .catch as an unexpected error) a non-credential error resolving the item', async () => {
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(new Error('network blip'));
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledWith(
      'Failed to process Plaid webhook:',
      'SYNC_UPDATES_AVAILABLE',
      expect.any(Error)
    );
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

  it('does not swallow a PlaidCredentialError instance differently than any of its subclasses (instanceof, not name-matching)', async () => {
    class SomeFutureSubclass extends PlaidCredentialError {
      constructor() {
        super('future subclass');
      }
    }
    mockGetPlaidItemByPlaidItemId.mockRejectedValue(new SomeFutureSubclass());
    const req = fakeReq({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'plaid-item-1' });
    const res = fakeRes();

    await handlePlaidWebhook(req, res);
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Plaid credential error resolving webhook item plaid-item-1'),
      'SomeFutureSubclass'
    );
  });
});

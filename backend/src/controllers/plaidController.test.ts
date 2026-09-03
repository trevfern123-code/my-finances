import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { completeReauth, exchangePublicToken } from './plaidController';
import { UnknownKeyIdError } from '../services/tokenEncryption';

const mockGetPlaidItemForUser = vi.hoisted(() => vi.fn());
const mockSetItemStatus = vi.hoisted(() => vi.fn());
const mockGetLinkedItemsForUser = vi.hoisted(() => vi.fn());
const mockInsertPlaidItem = vi.hoisted(() => vi.fn());
const mockUpsertAccountsForItem = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getPlaidItemForUser: mockGetPlaidItemForUser,
  setItemStatus: mockSetItemStatus,
  getLinkedItemsForUser: mockGetLinkedItemsForUser,
  insertPlaidItem: mockInsertPlaidItem,
  upsertAccountsForItem: mockUpsertAccountsForItem,
}));

const mockGetAccounts = vi.hoisted(() => vi.fn());
const mockExchangePublicToken = vi.hoisted(() => vi.fn());
const mockGetItemInstitution = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', () => ({
  getAccounts: mockGetAccounts,
  exchangePublicToken: mockExchangePublicToken,
  getItemInstitution: mockGetItemInstitution,
  isReauthRequiredError: (err: unknown) =>
    (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED',
}));

// Only needed by exchangePublicToken, below — completeReauth never touches any of these.
const mockSyncItemTransactions = vi.hoisted(() => vi.fn());
vi.mock('../services/syncService', () => ({ syncItemTransactions: mockSyncItemTransactions }));

const mockRecordSnapshotForUser = vi.hoisted(() => vi.fn());
vi.mock('../services/netWorth', () => ({ recordSnapshotForUser: mockRecordSnapshotForUser }));

const mockRefreshLoansForItem = vi.hoisted(() => vi.fn());
vi.mock('../services/loans', () => ({
  refreshLoansForItem: mockRefreshLoansForItem,
  computePayoffProgressPct: vi.fn(),
}));

function fakeReq(itemId: string): Request {
  return { user: { id: 'user-1' }, params: { itemId } } as unknown as Request;
}

function fakeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

const next = vi.fn() as unknown as NextFunction;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('completeReauth — controller-level credential_error vs login_required (§9/§10)', () => {
  it('sets credential_error (not login_required) when resolving the item fails with a PlaidCredentialError', async () => {
    mockGetPlaidItemForUser.mockRejectedValue(new UnknownKeyIdError('row-1'));
    const req = fakeReq('row-1');
    const res = fakeRes();

    await completeReauth(req, res, next);

    expect(mockSetItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'credential_error');
    expect(mockSetItemStatus).not.toHaveBeenCalledWith('row-1', 'login_required');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockGetAccounts).not.toHaveBeenCalled(); // never reached Plaid at all
    expect(next).not.toHaveBeenCalled();
  });

  it('sets login_required (not credential_error) when Plaid itself still rejects the token', async () => {
    mockGetPlaidItemForUser.mockResolvedValue({ id: 'row-1', access_token: 'a-real-token', status: 'login_required' });
    mockGetAccounts.mockRejectedValue({ response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
    const req = fakeReq('row-1');
    const res = fakeRes();

    await completeReauth(req, res, next);

    expect(mockSetItemStatus).not.toHaveBeenCalled(); // stays login_required — nothing to flip yet
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('sets active on genuine success, distinct from both credential_error and login_required', async () => {
    mockGetPlaidItemForUser.mockResolvedValue({ id: 'row-1', access_token: 'a-real-token', status: 'login_required' });
    mockGetAccounts.mockResolvedValue([]);
    mockGetLinkedItemsForUser.mockResolvedValue([]);
    const req = fakeReq('row-1');
    const res = fakeRes();

    await completeReauth(req, res, next);

    expect(mockSetItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'active');
  });

  it('never logs the raw error object for a credential failure — only a safe summary', async () => {
    mockGetPlaidItemForUser.mockRejectedValue(new UnknownKeyIdError('row-1'));
    const req = fakeReq('row-1');
    const res = fakeRes();

    await completeReauth(req, res, next);

    expect(console.error).toHaveBeenCalledTimes(1);
    const loggedArgs = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    for (const arg of loggedArgs) {
      expect(typeof arg).toBe('string');
    }
  });
});

describe('exchangePublicToken — uses the in-memory token, never the inserted row (§27, Phase 2b revision)', () => {
  const IN_MEMORY_TOKEN = 'in-memory-access-token-abc123';

  function fakeExchangeReq(): Request {
    return { user: { id: 'user-1' }, body: { public_token: 'public-token-xyz' } } as unknown as Request;
  }

  beforeEach(() => {
    mockExchangePublicToken.mockResolvedValue({ accessToken: IN_MEMORY_TOKEN, itemId: 'plaid-item-1' });
    mockGetItemInstitution.mockResolvedValue({ institutionId: 'ins_1', institutionName: 'Sandbox Bank' });
    // The Phase 2b shape: the persisted row never carries plaintext back to the caller.
    mockInsertPlaidItem.mockResolvedValue({
      id: 'row-1',
      access_token: null,
      institution_id: 'ins_1',
      institution_name: 'Sandbox Bank',
    });
    mockGetAccounts.mockResolvedValue([{ account_id: 'plaid-acc-1' }]);
    mockUpsertAccountsForItem.mockResolvedValue([{ id: 'account-row-1', plaid_account_id: 'plaid-acc-1' }]);
    mockSyncItemTransactions.mockResolvedValue({ added: [], modified: [], removed: [], cursor: 'cursor-1' });
    mockRecordSnapshotForUser.mockResolvedValue(undefined);
    mockRefreshLoansForItem.mockResolvedValue(undefined);
  });

  it('uses the in-memory access token for the initial account fetch, transaction sync, and loan refresh, even though the inserted row has access_token: null', async () => {
    const req = fakeExchangeReq();
    const res = fakeRes();

    await exchangePublicToken(req, res, next);

    expect(mockGetAccounts).toHaveBeenCalledWith(IN_MEMORY_TOKEN);
    expect(mockSyncItemTransactions).toHaveBeenCalledWith(expect.objectContaining({ access_token: IN_MEMORY_TOKEN }));
    expect(mockRefreshLoansForItem).toHaveBeenCalledWith('row-1', IN_MEMORY_TOKEN, expect.any(Map));
    // insertPlaidItem itself is what the plaintext actually flows through — proven not to persist
    // it at the dataService.ts unit level (dataService.test.ts); this proves the controller hands
    // it the correct in-memory value, not something re-read off the (null-plaintext) inserted row.
    expect(mockInsertPlaidItem).toHaveBeenCalledWith(expect.objectContaining({ accessToken: IN_MEMORY_TOKEN }));
    expect(next).not.toHaveBeenCalled();
  });

  it('never returns the plaintext token in the response', async () => {
    const req = fakeExchangeReq();
    const res = fakeRes();

    await exchangePublicToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(jsonArg)).not.toContain(IN_MEMORY_TOKEN);
  });
});

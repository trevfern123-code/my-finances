import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { completeReauth } from './plaidController';
import { UnknownKeyIdError } from '../services/tokenEncryption';

const mockGetPlaidItemForUser = vi.hoisted(() => vi.fn());
const mockSetItemStatus = vi.hoisted(() => vi.fn());
const mockGetLinkedItemsForUser = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getPlaidItemForUser: mockGetPlaidItemForUser,
  setItemStatus: mockSetItemStatus,
  getLinkedItemsForUser: mockGetLinkedItemsForUser,
}));

const mockGetAccounts = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', () => ({
  getAccounts: mockGetAccounts,
  isReauthRequiredError: (err: unknown) =>
    (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED',
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

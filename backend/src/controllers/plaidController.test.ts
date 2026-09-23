import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { completeReauth, createLinkToken, exchangePublicToken } from './plaidController';
import { UnknownKeyIdError } from '../services/tokenEncryption';

const mockGetPlaidItemForUser = vi.hoisted(() => vi.fn());
const mockSetItemStatus = vi.hoisted(() => vi.fn());
const mockGetLinkedItemsForUser = vi.hoisted(() => vi.fn());
const mockInsertPlaidItem = vi.hoisted(() => vi.fn());
const mockUpsertAccountsForItem = vi.hoisted(() => vi.fn());
const mockCreatePlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockConsumePlaidLinkAttempt = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  createPlaidLinkAttempt: mockCreatePlaidLinkAttempt,
  consumePlaidLinkAttempt: mockConsumePlaidLinkAttempt,
  getPlaidItemForUser: mockGetPlaidItemForUser,
  setItemStatus: mockSetItemStatus,
  getLinkedItemsForUser: mockGetLinkedItemsForUser,
  insertPlaidItem: mockInsertPlaidItem,
  upsertAccountsForItem: mockUpsertAccountsForItem,
}));

const mockGetAccounts = vi.hoisted(() => vi.fn());
const mockExchangePublicToken = vi.hoisted(() => vi.fn());
const mockGetItemInstitution = vi.hoisted(() => vi.fn());
const mockPlaidCreateLinkToken = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', () => ({
  createLinkToken: mockPlaidCreateLinkToken,
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

const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';

describe('exchangePublicToken — uses the in-memory token, never the inserted row (§27, Phase 2b revision)', () => {
  const IN_MEMORY_TOKEN = 'in-memory-access-token-abc123';

  function fakeExchangeReq(): Request {
    return {
      user: { id: 'user-1', sessionId: 'sid-1' },
      body: { public_token: 'public-token-xyz', link_attempt_id: ATTEMPT_ID },
    } as unknown as Request;
  }

  beforeEach(() => {
    mockConsumePlaidLinkAttempt.mockResolvedValue('consumed');
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

// Wave 1: a public token is only exchanged under a one-time Plaid Link attempt bound to the
// verified user AND login session that started the flow. The attempt store below is an in-memory
// stand-in for create_/consume_plaid_link_attempt's contract (the SQL itself is proven against
// PostgreSQL 17 by supabase/tests/access_control/).
describe('Plaid Link attempts — exchange is bound to the initiating user and login session (Wave 1)', () => {
  const attempts = new Map<string, { userId: string; sessionId: string; expired: boolean }>();
  let nextAttempt = 0;

  function authedReq(user: { id: string; sessionId: string | null }, body: Record<string, unknown> = {}): Request {
    return { user, body } as unknown as Request;
  }
  function jsonBody(res: Response) {
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
  }
  async function startLink(user: { id: string; sessionId: string }): Promise<string> {
    const res = fakeRes();
    await createLinkToken(authedReq(user), res, next);
    return jsonBody(res).link_attempt_id;
  }
  async function exchange(user: { id: string; sessionId: string | null }, body: Record<string, unknown>) {
    const res = fakeRes();
    await exchangePublicToken(authedReq(user, body), res, next);
    return res;
  }

  const userA = { id: 'user-a', sessionId: 'sid-a' };
  const userB = { id: 'user-b', sessionId: 'sid-b' };

  beforeEach(() => {
    attempts.clear();
    mockCreatePlaidLinkAttempt.mockImplementation(async (userId: string, sessionId: string) => {
      const id = `00000000-0000-4000-8000-${String(++nextAttempt).padStart(12, '0')}`;
      attempts.set(id, { userId, sessionId, expired: false });
      return id;
    });
    mockConsumePlaidLinkAttempt.mockImplementation(async (id: string, userId: string, sessionId: string) => {
      const attempt = attempts.get(id);
      if (!attempt || attempt.userId !== userId || attempt.sessionId !== sessionId) return 'invalid';
      attempts.delete(id);
      return attempt.expired ? 'expired' : 'consumed';
    });
    mockPlaidCreateLinkToken.mockResolvedValue('link-sandbox-token');
    mockExchangePublicToken.mockResolvedValue({ accessToken: 'in-memory-access-token', itemId: 'plaid-item-1' });
    mockGetItemInstitution.mockResolvedValue({ institutionId: 'ins_1', institutionName: 'Sandbox Bank' });
    mockInsertPlaidItem.mockResolvedValue({ id: 'row-1', access_token: null, institution_id: 'ins_1', institution_name: 'Sandbox Bank' });
    mockGetAccounts.mockResolvedValue([]);
    mockUpsertAccountsForItem.mockResolvedValue([]);
    mockSyncItemTransactions.mockResolvedValue({ added: 0 });
    mockRecordSnapshotForUser.mockResolvedValue(undefined);
    mockRefreshLoansForItem.mockResolvedValue(undefined);
  });

  function expectNothingExchanged() {
    expect(mockExchangePublicToken).not.toHaveBeenCalled();
    expect(mockInsertPlaidItem).not.toHaveBeenCalled();
  }

  it('link-token: records the attempt for the VERIFIED user and session, ignoring any body ids', async () => {
    const res = fakeRes();
    await createLinkToken(authedReq(userA, { user_id: 'user-b', session_id: 'sid-b' }), res, next);

    expect(mockCreatePlaidLinkAttempt).toHaveBeenCalledWith('user-a', 'sid-a');
    expect(mockPlaidCreateLinkToken).toHaveBeenCalledWith('user-a');
    const body = jsonBody(res);
    expect(body).toEqual({ link_token: 'link-sandbox-token', link_attempt_id: expect.any(String) });
    expect(attempts.get(body.link_attempt_id)).toEqual({ userId: 'user-a', sessionId: 'sid-a', expired: false });
  });

  it('link-token: refuses (401) a token that carries no login session — no attempt, no Plaid call', async () => {
    const res = fakeRes();
    await createLinkToken(authedReq({ id: 'user-a', sessionId: null }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(jsonBody(res)).toMatchObject({ code: 'session_required' });
    expect(mockCreatePlaidLinkAttempt).not.toHaveBeenCalled();
    expect(mockPlaidCreateLinkToken).not.toHaveBeenCalled();
  });

  it('link-token: if the attempt cannot be recorded, no link token is issued', async () => {
    const failure = new Error('Failed to start Plaid Link attempt: connection reset');
    mockCreatePlaidLinkAttempt.mockRejectedValueOnce(failure);
    await createLinkToken(authedReq(userA), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(failure);
    expect(mockPlaidCreateLinkToken).not.toHaveBeenCalled();
  });

  it('the initiating user and session exchange once (201), consuming the attempt BEFORE calling Plaid', async () => {
    const attemptId = await startLink(userA);
    const order: string[] = [];
    mockConsumePlaidLinkAttempt.mockImplementationOnce(async (id: string, userId: string, sessionId: string) => {
      order.push('consume');
      expect([id, userId, sessionId]).toEqual([attemptId, 'user-a', 'sid-a']);
      attempts.delete(id);
      return 'consumed';
    });
    mockExchangePublicToken.mockImplementationOnce(async () => {
      order.push('plaid-exchange');
      return { accessToken: 'in-memory-access-token', itemId: 'plaid-item-1' };
    });

    const res = await exchange(userA, { public_token: 'public-1', link_attempt_id: attemptId });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(order).toEqual(['consume', 'plaid-exchange']);
    expect(mockInsertPlaidItem).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
    expect(next).not.toHaveBeenCalled();
  });

  it("a DIFFERENT user completing Plaid Link with A's attempt is refused (409); nothing is exchanged and A can still finish", async () => {
    const attemptId = await startLink(userA);

    const resB = await exchange(userB, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(resB.status).toHaveBeenCalledWith(409);
    expect(jsonBody(resB)).toMatchObject({ code: 'link_attempt_invalid' });
    expectNothingExchanged();

    const resA = await exchange(userA, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(resA.status).toHaveBeenCalledWith(201);
    expect(mockInsertPlaidItem).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
  });

  it('the same user after signing out and back in (a new login session) cannot spend the old attempt', async () => {
    const attemptId = await startLink(userA);
    const res = await exchange({ id: 'user-a', sessionId: 'sid-a-relogin' }, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(res.status).toHaveBeenCalledWith(409);
    expectNothingExchanged();
  });

  it('a client-supplied user_id/session_id in the body is ignored: the owner is always the verified bearer token', async () => {
    const attemptId = await startLink(userA);
    const res = await exchange(userB, {
      public_token: 'public-1',
      link_attempt_id: attemptId,
      user_id: 'user-a',
      session_id: 'sid-a',
    });
    expect(mockConsumePlaidLinkAttempt).toHaveBeenCalledWith(attemptId, 'user-b', 'sid-b');
    expect(res.status).toHaveBeenCalledWith(409);
    expectNothingExchanged();
  });

  it('a replayed attempt is refused (409) and exchanges nothing the second time', async () => {
    const attemptId = await startLink(userA);
    const first = await exchange(userA, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(first.status).toHaveBeenCalledWith(201);
    vi.clearAllMocks();

    const res = await exchange(userA, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_invalid' });
    expectNothingExchanged();
  });

  it('an expired attempt is refused (410) and exchanges nothing', async () => {
    const attemptId = await startLink(userA);
    attempts.get(attemptId)!.expired = true;

    const res = await exchange(userA, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(res.status).toHaveBeenCalledWith(410);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_expired' });
    expectNothingExchanged();
  });

  it.each([
    ['missing', undefined],
    ['not a uuid', 'not-a-uuid'],
    ['not a string', 42],
  ])('an attempt id that is %s is a 400 that never reaches the attempt store or Plaid', async (_label, linkAttemptId) => {
    const res = await exchange(userA, { public_token: 'public-1', link_attempt_id: linkAttemptId });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_required' });
    expect(mockConsumePlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
  });

  it('a token with no login session is refused (401) before the attempt store is consulted', async () => {
    const attemptId = await startLink(userA);
    const res = await exchange({ id: 'user-a', sessionId: null }, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockConsumePlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
  });

  it('a failure verifying the attempt is an error (next(err)), never an exchange', async () => {
    const attemptId = await startLink(userA);
    const failure = new Error('Failed to verify Plaid Link attempt: connection reset');
    mockConsumePlaidLinkAttempt.mockRejectedValueOnce(failure);
    await exchange(userA, { public_token: 'public-1', link_attempt_id: attemptId });
    expect(next).toHaveBeenCalledWith(failure);
    expectNothingExchanged();
  });
});

// Wave 1 review P1 — UNRESOLVED, deliberately left pending rather than asserting a false guarantee.
// A Link attempt proves the caller recently started SOME Link flow, not that the submitted public
// token came from it, and embedded Link offers no default server-side correlation (README "Wave 1
// follow-ups"). Whichever fix is chosen (Hosted Link, or /link/token/get with Plaid's Link-events
// enablement) must turn this into a passing test.
describe('Wave 1 P1: a public token is only exchanged for the Link flow that produced it', () => {
  it.todo(
    "user A completes Link and keeps the public token; user B signs in, creates a fresh valid attempt and submits A's public token with it: rejected before exchange, and no Plaid item is created"
  );
});

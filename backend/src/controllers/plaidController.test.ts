import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { completeLinkAttempt, completeReauth, createLinkToken, exchangePublicToken } from './plaidController';
import { UnknownKeyIdError } from '../services/tokenEncryption';

const mockGetPlaidItemForUser = vi.hoisted(() => vi.fn());
const mockSetItemStatus = vi.hoisted(() => vi.fn());
const mockGetLinkedItemsForUser = vi.hoisted(() => vi.fn());
const mockInsertPlaidItem = vi.hoisted(() => vi.fn());
const mockUpsertAccountsForItem = vi.hoisted(() => vi.fn());
const mockCreatePlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockReadPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockClaimPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockFinishPlaidLinkAttempt = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  createPlaidLinkAttempt: mockCreatePlaidLinkAttempt,
  readPlaidLinkAttempt: mockReadPlaidLinkAttempt,
  claimPlaidLinkAttempt: mockClaimPlaidLinkAttempt,
  finishPlaidLinkAttempt: mockFinishPlaidLinkAttempt,
  getPlaidItemForUser: mockGetPlaidItemForUser,
  setItemStatus: mockSetItemStatus,
  getLinkedItemsForUser: mockGetLinkedItemsForUser,
  insertPlaidItem: mockInsertPlaidItem,
  upsertAccountsForItem: mockUpsertAccountsForItem,
}));

const mockGetAccounts = vi.hoisted(() => vi.fn());
const mockExchangePublicToken = vi.hoisted(() => vi.fn());
const mockGetItemInstitution = vi.hoisted(() => vi.fn());
const mockPlaidCreateHostedLinkToken = vi.hoisted(() => vi.fn());
const mockGetLinkTokenSessions = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', () => ({
  createHostedLinkToken: mockPlaidCreateHostedLinkToken,
  getLinkTokenSessions: mockGetLinkTokenSessions,
  getAccounts: mockGetAccounts,
  exchangePublicToken: mockExchangePublicToken,
  getItemInstitution: mockGetItemInstitution,
  isReauthRequiredError: (err: unknown) =>
    (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED',
}));

// Only needed by completeLinkAttempt, below — completeReauth never touches any of these.
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

// ---- Wave 1: backend-owned Plaid Hosted Link ------------------------------------------------------
// `attempts` is an in-memory stand-in for the plaid_link_attempts functions' contract (the SQL itself
// is proven against PostgreSQL 17 by supabase/tests/access_control/), and `plaidSessions` for what
// Plaid's /link/token/get reports per link token. Neither ever reaches a client.
type FakeAttempt = {
  userId: string;
  sessionId: string;
  linkToken: string;
  status: 'pending' | 'completing' | 'completed' | 'failed';
  expired: boolean;
  itemRowId: string | null;
};
const attempts = new Map<string, FakeAttempt>();
const plaidSessions = new Map<string, unknown[]>();
let linkTokenCounter = 0;

const userA = { id: 'user-a', sessionId: 'sid-a' };
const userB = { id: 'user-b', sessionId: 'sid-b' };

function authedReq(user: { id: string; sessionId: string | null }, extra: { params?: Record<string, string>; body?: unknown } = {}): Request {
  return { user, params: extra.params ?? {}, body: extra.body ?? {} } as unknown as Request;
}
function jsonBody(res: Response) {
  return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
}
async function startLink(user: { id: string; sessionId: string }) {
  const res = fakeRes();
  await createLinkToken(authedReq(user), res, next);
  const body = jsonBody(res);
  return { attemptId: body.link_attempt_id as string, body, linkToken: attempts.get(body.link_attempt_id)!.linkToken };
}
async function complete(user: { id: string; sessionId: string | null }, attemptId: string, body: unknown = {}) {
  const res = fakeRes();
  await completeLinkAttempt(authedReq(user, { params: { attemptId }, body }), res, next);
  return res;
}
/** Plaid's view once the user finished Hosted Link for `linkToken` and Plaid created an Item. */
function plaidFinished(linkToken: string, publicToken: string) {
  plaidSessions.set(linkToken, [
    {
      link_session_id: `session-for-${linkToken}`,
      started_at: '2026-09-22T12:00:00Z',
      finished_at: '2026-09-22T12:05:00Z',
      results: { item_add_results: [{ public_token: publicToken, accounts: [], institution: null }] },
    },
  ]);
}

beforeEach(() => {
  attempts.clear();
  plaidSessions.clear();
  mockPlaidCreateHostedLinkToken.mockImplementation(async (userId: string) => {
    linkTokenCounter += 1;
    return { linkToken: `link-sandbox-${userId}-${linkTokenCounter}`, hostedLinkUrl: `https://hosted.plaid.test/link/${linkTokenCounter}` };
  });
  mockGetLinkTokenSessions.mockImplementation(async (linkToken: string) => plaidSessions.get(linkToken) ?? []);
  mockCreatePlaidLinkAttempt.mockImplementation(
    async (p: { attemptId: string; userId: string; sessionId: string; linkToken: string }) => {
      attempts.set(p.attemptId, { userId: p.userId, sessionId: p.sessionId, linkToken: p.linkToken, status: 'pending', expired: false, itemRowId: null });
      return { expiresAt: '2026-09-22T12:30:00+00:00' };
    }
  );
  const own = (id: string, userId: string, sessionId: string) => {
    const a = attempts.get(id);
    return a && a.userId === userId && a.sessionId === sessionId ? a : undefined;
  };
  mockReadPlaidLinkAttempt.mockImplementation(async (id: string, userId: string, sessionId: string) => {
    const a = own(id, userId, sessionId);
    if (!a) return null;
    return a.status === 'pending' ? { status: a.status, expired: a.expired, linkToken: a.linkToken } : { status: a.status, expired: a.expired };
  });
  mockClaimPlaidLinkAttempt.mockImplementation(async (id: string, userId: string, sessionId: string) => {
    const a = own(id, userId, sessionId);
    if (!a) return 'invalid';
    if (a.status === 'pending' && !a.expired) {
      a.status = 'completing';
      return 'claimed';
    }
    return a.status === 'pending' ? 'expired' : a.status;
  });
  mockFinishPlaidLinkAttempt.mockImplementation(
    async (id: string, userId: string, sessionId: string, outcome: 'completed' | 'failed', itemRowId: string | null) => {
      const a = own(id, userId, sessionId);
      if (!a) return false;
      if (outcome === 'completed' && a.status === 'completing') Object.assign(a, { status: 'completed', itemRowId });
      else if (outcome === 'failed' && (a.status === 'pending' || a.status === 'completing')) a.status = 'failed';
      else return false;
      return true;
    }
  );
  mockExchangePublicToken.mockImplementation(async (publicToken: string) => ({
    accessToken: `in-memory-access-for-${publicToken}`,
    itemId: `plaid-item-${publicToken === "public-a" ? "a" : "other"}`,
  }));
  mockGetItemInstitution.mockResolvedValue({ institutionId: 'ins_1', institutionName: 'Sandbox Bank' });
  mockInsertPlaidItem.mockImplementation(async (p: { userId: string; itemId: string }) => ({
    id: `row-for-${p.itemId}`,
    access_token: null,
    institution_id: 'ins_1',
    institution_name: 'Sandbox Bank',
  }));
  mockGetAccounts.mockResolvedValue([{ account_id: 'plaid-acc-1' }]);
  mockUpsertAccountsForItem.mockResolvedValue([{ id: 'account-row-1', plaid_account_id: 'plaid-acc-1' }]);
  mockSyncItemTransactions.mockResolvedValue({ added: 3 });
  mockRecordSnapshotForUser.mockResolvedValue(undefined);
  mockRefreshLoansForItem.mockResolvedValue(undefined);
});

function expectNothingExchanged() {
  expect(mockExchangePublicToken).not.toHaveBeenCalled();
  expect(mockInsertPlaidItem).not.toHaveBeenCalled();
}

describe('POST /link-token — Hosted Link attempt creation', () => {
  it('stores the link token server-side for the VERIFIED user and session and returns ONLY the Hosted Link URL, attempt id and expiry', async () => {
    const res = fakeRes();
    await createLinkToken(authedReq(userA, { body: { user_id: 'user-b', session_id: 'sid-b' } }), res, next);

    expect(mockPlaidCreateHostedLinkToken).toHaveBeenCalledWith('user-a');
    const body = jsonBody(res);
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'hosted_link_url', 'link_attempt_id']);
    expect(body.hosted_link_url).toMatch(/^https:\/\/hosted\.plaid\.test\//);
    expect(body.link_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = attempts.get(body.link_attempt_id)!;
    expect(stored).toMatchObject({ userId: 'user-a', sessionId: 'sid-a', status: 'pending' });
    // The link token itself never leaves the server.
    expect(JSON.stringify(body)).not.toContain(stored.linkToken);
    expect(mockCreatePlaidLinkAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: body.link_attempt_id, userId: 'user-a', sessionId: 'sid-a', linkToken: stored.linkToken })
    );
  });

  it('refuses (401) a token that carries no login session — no Plaid call, no attempt', async () => {
    const res = fakeRes();
    await createLinkToken(authedReq({ id: 'user-a', sessionId: null }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(jsonBody(res)).toMatchObject({ code: 'session_required' });
    expect(mockPlaidCreateHostedLinkToken).not.toHaveBeenCalled();
    expect(mockCreatePlaidLinkAttempt).not.toHaveBeenCalled();
  });

  it('if the attempt cannot be stored, no Hosted Link URL is returned', async () => {
    const failure = new Error('Failed to start Plaid Link attempt: connection reset');
    mockCreatePlaidLinkAttempt.mockRejectedValueOnce(failure);
    const res = fakeRes();
    await createLinkToken(authedReq(userA), res, next);
    expect(next).toHaveBeenCalledWith(failure);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('POST /link-attempts/:attemptId/complete — the only way an item is created', () => {
  it('success: exchanges the public token Plaid reports for the attempt\'s OWN stored link token, stores the item for the verified user, and completes the attempt once', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');

    const res = await complete(userA, attemptId);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockGetLinkTokenSessions).toHaveBeenCalledWith(linkToken);
    expect(mockExchangePublicToken).toHaveBeenCalledExactlyOnceWith('public-a');
    expect(mockInsertPlaidItem).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'user-a', accessToken: 'in-memory-access-for-public-a' }));
    // The in-memory access token is what later steps use (never re-read off the stored row).
    expect(mockGetAccounts).toHaveBeenCalledWith('in-memory-access-for-public-a');
    expect(mockSyncItemTransactions).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'in-memory-access-for-public-a', user_id: 'user-a' }));
    expect(mockRefreshLoansForItem).toHaveBeenCalledWith('row-for-plaid-item-a', 'in-memory-access-for-public-a', expect.any(Map));
    expect(attempts.get(attemptId)).toMatchObject({ status: 'completed', itemRowId: 'row-for-plaid-item-a' });
    const body = jsonBody(res);
    expect(body).toMatchObject({ status: 'completed', item: { id: 'row-for-plaid-item-a' }, transactions_synced: 3 });
    const serialized = JSON.stringify(body);
    for (const secret of ['public-a', 'in-memory-access-for-public-a', linkToken]) expect(serialized).not.toContain(secret);
    expect(next).not.toHaveBeenCalled();
  });

  it('pending: Hosted Link not finished yet -> 202 pending; nothing claimed or exchanged; completes on a later call', async () => {
    const { attemptId, linkToken } = await startLink(userA);

    const noSession = await complete(userA, attemptId);
    expect(noSession.status).toHaveBeenCalledWith(202);
    expect(jsonBody(noSession)).toEqual({ status: 'pending' });

    plaidSessions.set(linkToken, [{ link_session_id: 's1', started_at: '2026-09-22T12:00:00Z', finished_at: null }]);
    const inProgress = await complete(userA, attemptId);
    expect(jsonBody(inProgress)).toEqual({ status: 'pending' });

    // "Finished" with no result yet (and no exit) is still pending, never a failure.
    plaidSessions.set(linkToken, [{ link_session_id: 's1', finished_at: '2026-09-22T12:05:00Z', results: { item_add_results: [] } }]);
    expect(jsonBody(await complete(userA, attemptId))).toEqual({ status: 'pending' });

    expect(mockClaimPlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
    expect(attempts.get(attemptId)!.status).toBe('pending');

    plaidFinished(linkToken, 'public-a');
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);
  });

  it('exit: the user left Hosted Link without linking -> 409 link_attempt_exited, the attempt fails, and it can never be exchanged later', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidSessions.set(linkToken, [{ link_session_id: 's1', finished_at: '2026-09-22T12:05:00Z', exit: { error: null, metadata: { status: 'institution_not_found' } } }]);

    const res = await complete(userA, attemptId);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_exited' });
    expect(attempts.get(attemptId)!.status).toBe('failed');

    plaidFinished(linkToken, 'public-a'); // even if Plaid later reported a token for it
    const again = await complete(userA, attemptId);
    expect(jsonBody(again)).toMatchObject({ code: 'link_attempt_failed' });
    expectNothingExchanged();
  });

  it('expiry: -> 410 link_attempt_expired, without asking Plaid or exchanging', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');
    attempts.get(attemptId)!.expired = true;

    const res = await complete(userA, attemptId);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_expired' });
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalled();
    expectNothingExchanged();
  });

  it('replay: completing an already-completed attempt -> 409 link_attempt_already_completed; exchanged and stored exactly once', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);

    for (let i = 0; i < 3; i++) {
      const res = await complete(userA, attemptId);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_already_completed' });
    }
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(mockInsertPlaidItem).toHaveBeenCalledTimes(1);
  });

  it('concurrent completion: two simultaneous calls -> exactly one exchange and one insert; the other is told it is completing', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');
    let releaseExchange!: () => void;
    mockExchangePublicToken.mockImplementationOnce(
      (publicToken: string) =>
        new Promise((resolve) => {
          releaseExchange = () => resolve({ accessToken: `in-memory-access-for-${publicToken}`, itemId: 'plaid-item-a' });
        })
    );

    const first = complete(userA, attemptId);
    const second = complete(userA, attemptId);
    await vi.waitFor(() => expect(mockExchangePublicToken).toHaveBeenCalledTimes(1));
    const secondRes = await second;
    releaseExchange();
    const firstRes = await first;

    expect(firstRes.status).toHaveBeenCalledWith(201);
    expect(secondRes.status).toHaveBeenCalledWith(202);
    expect(jsonBody(secondRes)).toEqual({ status: 'completing' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(mockInsertPlaidItem).toHaveBeenCalledTimes(1);
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_already_completed' });
  });

  it("foreign user: B completing A's attempt -> 409 link_attempt_invalid, reveals and touches nothing; A can still finish", async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');

    const res = await complete(userB, attemptId);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_invalid' });
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalled();
    expect(mockClaimPlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
    expect(attempts.get(attemptId)!.status).toBe('pending');

    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);
    expect(mockInsertPlaidItem).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
  });

  it('foreign session: the same user after signing out and back in cannot complete the old attempt', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');
    const res = await complete({ id: 'user-a', sessionId: 'sid-a-relogin' }, attemptId);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_invalid' });
    expectNothingExchanged();
  });

  it('a malformed attempt id is refused before the attempt store; a token with no login session is refused (401)', async () => {
    const malformed = await complete(userA, 'not-a-uuid');
    expect(jsonBody(malformed)).toMatchObject({ code: 'link_attempt_invalid' });
    const { attemptId } = await startLink(userA);
    const noSession = await complete({ id: 'user-a', sessionId: null }, attemptId);
    expect(noSession.status).toHaveBeenCalledWith(401);
    expect(mockReadPlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
  });

  it('ambiguous: Plaid reports two public tokens for the one link token -> 409, the attempt fails, nothing is guessed or exchanged', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidSessions.set(linkToken, [
      { link_session_id: 's1', finished_at: 'x', results: { item_add_results: [{ public_token: 'public-1' }] } },
      { link_session_id: 's2', finished_at: 'y', results: { item_add_results: [{ public_token: 'public-2' }] } },
    ]);
    const res = await complete(userA, attemptId);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_ambiguous' });
    expect(attempts.get(attemptId)!.status).toBe('failed');
    expectNothingExchanged();
  });

  it('an exchange failure after claiming fails the attempt: the error propagates and the public token is never exchanged again', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');
    const failure = new Error('INVALID_PUBLIC_TOKEN');
    mockExchangePublicToken.mockRejectedValueOnce(failure);

    await complete(userA, attemptId);
    expect(next).toHaveBeenCalledWith(failure);
    expect(attempts.get(attemptId)!.status).toBe('failed');
    expect(mockInsertPlaidItem).not.toHaveBeenCalled();

    const retry = await complete(userA, attemptId);
    expect(jsonBody(retry)).toMatchObject({ code: 'link_attempt_failed' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
  });

  it('a failure AFTER the item is stored still completes the attempt (the item exists), so it can never be exchanged twice', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken, 'public-a');
    const failure = new Error('sync failed');
    mockSyncItemTransactions.mockRejectedValueOnce(failure);

    await complete(userA, attemptId);
    expect(next).toHaveBeenCalledWith(failure);
    expect(attempts.get(attemptId)).toMatchObject({ status: 'completed', itemRowId: 'row-for-plaid-item-a' });
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_already_completed' });
    expect(mockInsertPlaidItem).toHaveBeenCalledTimes(1);
  });

  it('ignores anything in the request body — including a public token', async () => {
    const { attemptId } = await startLink(userA);
    const res = await complete(userA, attemptId, { public_token: 'public-from-client', user_id: 'user-b' });
    expect(jsonBody(res)).toEqual({ status: 'pending' });
    expectNothingExchanged();
  });
});

describe('Wave 1 P1: a public token is only exchanged for the Link flow that produced it', () => {
  it("user A completes Link and keeps the public token; user B signs in, creates a fresh valid attempt and submits A's public token with it: rejected before exchange, and no Plaid item is created", async () => {
    // User A completes Hosted Link; Plaid reports A's public token for A's link token, and A keeps it.
    const a = await startLink(userA);
    plaidFinished(a.linkToken, 'public-token-of-a');
    const capturedPublicTokenOfA = 'public-token-of-a';

    // User B signs in and creates a fresh, valid attempt of their own.
    const b = await startLink(userB);
    expect(attempts.get(b.attemptId)).toMatchObject({ userId: 'user-b', status: 'pending' });

    // B submits A's public token with B's attempt — on the retired route (the only one that ever
    // took a public token)...
    const retired = fakeRes();
    exchangePublicToken(authedReq(userB, { body: { public_token: capturedPublicTokenOfA, link_attempt_id: b.attemptId } }), retired);
    expect(retired.status).toHaveBeenCalledWith(410);
    expect(jsonBody(retired)).toMatchObject({ code: 'exchange_retired' });

    // ...and on the completion route, for B's own attempt: the body is ignored, and Plaid is asked
    // only about B's own link token, whose flow B has not finished.
    const own = await complete(userB, b.attemptId, { public_token: capturedPublicTokenOfA });
    expect(jsonBody(own)).toEqual({ status: 'pending' });
    expect(mockGetLinkTokenSessions).toHaveBeenCalledWith(b.linkToken);
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalledWith(a.linkToken);

    // ...and by completing A's attempt: not B's.
    const foreign = await complete(userB, a.attemptId, { public_token: capturedPublicTokenOfA });
    expect(jsonBody(foreign)).toMatchObject({ code: 'link_attempt_invalid' });

    // Rejected before any exchange; no Plaid item was created or stored — for B or anyone.
    expect(mockExchangePublicToken).not.toHaveBeenCalled();
    expect(mockInsertPlaidItem).not.toHaveBeenCalled();
    expect(attempts.get(b.attemptId)!.status).toBe('pending');
    expect(attempts.get(a.attemptId)!.status).toBe('pending');
  });
});

describe('POST /exchange-public-token — retired', () => {
  it.each([
    ['a cached pre-Wave-1 client (public token only)', { public_token: 'public-x' }],
    ['a cached Wave-1-embedded client (public token + attempt id)', { public_token: 'public-x', link_attempt_id: '11111111-2222-4333-8444-555555555555' }],
    ['an empty body', {}],
  ])('%s gets 410 exchange_retired and nothing is read, claimed or exchanged', (_label, body) => {
    const res = fakeRes();
    exchangePublicToken(authedReq(userA, { body }), res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(jsonBody(res)).toMatchObject({ code: 'exchange_retired' });
    expect(mockReadPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(mockClaimPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalled();
    expectNothingExchanged();
  });
});

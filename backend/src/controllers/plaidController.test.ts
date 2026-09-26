import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  completeLinkAttempt,
  completeReauth,
  createLinkToken,
  exchangePublicToken,
  createReauthLinkToken,
  getItemRemoval,
  LINK_OUTCOME_UNKNOWN_MESSAGE,
  listLinkedItems,
  previewItemRemoval,
  refreshAccounts,
  removeInstitution,
  syncTransactions,
} from './plaidController';
import { ItemRemovalIncompleteError } from '../services/itemRemoval';
import { UnknownKeyIdError, PlaidCredentialError } from '../services/tokenEncryption';

const mockGetPlaidItemForUser = vi.hoisted(() => vi.fn());
const mockTransitionItemStatus = vi.hoisted(() => vi.fn());
const mockGetPlaidItemStatusForUser = vi.hoisted(() => vi.fn());
const mockListUnfinishedItemRemovals = vi.hoisted(() => vi.fn());
const mockGetItemRemoval = vi.hoisted(() => vi.fn());
const mockPreviewItemRemoval = vi.hoisted(() => vi.fn());
const mockGetLinkedItemsForUser = vi.hoisted(() => vi.fn());
const mockInsertPlaidItem = vi.hoisted(() => vi.fn());
const mockUpsertAccountsForItem = vi.hoisted(() => vi.fn());
const mockCreatePlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockReadPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockClaimPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockBeginPlaidLinkExchange = vi.hoisted(() => vi.fn());
const mockStorePlaidLinkItem = vi.hoisted(() => vi.fn());
const mockFailPlaidLinkAttempt = vi.hoisted(() => vi.fn());
const mockUpdatePlaidItemInstitution = vi.hoisted(() => vi.fn());
const mockGetPlaidItemsForUser = vi.hoisted(() => vi.fn());
const mockGetPlaidItemIdsMissingInstitution = vi.hoisted(() => vi.fn());
const dataServiceErrors = vi.hoisted(() => ({
  TooManyPlaidLinkAttemptsError: class TooManyPlaidLinkAttemptsError extends Error {
    constructor() {
      super('Too many bank links are still being finished. Wait a moment and try again.');
    }
  },
  PlaidLinkStoreOutcomeUnknownError: class PlaidLinkStoreOutcomeUnknownError extends Error {},
}));
vi.mock('../services/dataService', () => ({
  createPlaidLinkAttempt: mockCreatePlaidLinkAttempt,
  readPlaidLinkAttempt: mockReadPlaidLinkAttempt,
  claimPlaidLinkAttempt: mockClaimPlaidLinkAttempt,
  beginPlaidLinkExchange: mockBeginPlaidLinkExchange,
  storePlaidLinkItem: mockStorePlaidLinkItem,
  failPlaidLinkAttempt: mockFailPlaidLinkAttempt,
  updatePlaidItemInstitution: mockUpdatePlaidItemInstitution,
  getPlaidItemsForUser: mockGetPlaidItemsForUser,
  getPlaidItemIdsMissingInstitution: mockGetPlaidItemIdsMissingInstitution,
  ...dataServiceErrors,
  getPlaidItemForUser: mockGetPlaidItemForUser,
  transitionItemStatus: mockTransitionItemStatus,
  getPlaidItemStatusForUser: mockGetPlaidItemStatusForUser,
  listUnfinishedItemRemovals: mockListUnfinishedItemRemovals,
  getItemRemoval: mockGetItemRemoval,
  previewItemRemoval: mockPreviewItemRemoval,
  getLinkedItemsForUser: mockGetLinkedItemsForUser,
  insertPlaidItem: mockInsertPlaidItem,
  upsertAccountsForItem: mockUpsertAccountsForItem,
}));

const mockGetAccounts = vi.hoisted(() => vi.fn());
const mockExchangePublicToken = vi.hoisted(() => vi.fn());
const mockGetItemInstitution = vi.hoisted(() => vi.fn());
const mockPlaidCreateHostedLinkToken = vi.hoisted(() => vi.fn());
const mockGetLinkTokenSessions = vi.hoisted(() => vi.fn());
const mockRemoveItem = vi.hoisted(() => vi.fn());
const mockCreateReauthLinkToken = vi.hoisted(() => vi.fn());
const mockUpdateItemWebhook = vi.hoisted(() => vi.fn());
vi.mock('../services/plaidService', async () => {
  const errors = await vi.importActual<typeof import('../services/plaidErrors')>('../services/plaidErrors');
  return {
    createHostedLinkToken: mockPlaidCreateHostedLinkToken,
    getLinkTokenSessions: mockGetLinkTokenSessions,
    getAccounts: mockGetAccounts,
    exchangePublicToken: mockExchangePublicToken,
    removeItem: mockRemoveItem,
    createReauthLinkToken: mockCreateReauthLinkToken,
    updateItemWebhook: mockUpdateItemWebhook,
    getItemInstitution: mockGetItemInstitution,
    isReauthRequiredError: errors.isReauthRequiredError,
    isDefinitivePlaidRejection: errors.isDefinitivePlaidRejection,
  };
});

// Only needed by completeLinkAttempt, below — completeReauth never touches any of these.
const mockSyncItemTransactions = vi.hoisted(() => vi.fn());
vi.mock('../services/syncService', () => ({ syncItemTransactions: mockSyncItemTransactions }));

const mockRecordSnapshotForUser = vi.hoisted(() => vi.fn());
vi.mock('../services/netWorth', () => ({ recordSnapshotForUser: mockRecordSnapshotForUser }));

const mockRunItemRemoval = vi.hoisted(() => vi.fn());
vi.mock('../services/itemRemoval', async () => {
  const actual = await vi.importActual<typeof import('../services/itemRemoval')>('../services/itemRemoval');
  return { ...actual, runItemRemoval: mockRunItemRemoval };
});

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
  mockListUnfinishedItemRemovals.mockResolvedValue([]);
});

describe('completeReauth — controller-level credential_error vs login_required (§9/§10)', () => {
  it('sets credential_error (not login_required) when resolving the item fails with a PlaidCredentialError', async () => {
    mockGetPlaidItemForUser.mockRejectedValue(new UnknownKeyIdError('row-1'));
    const req = fakeReq('row-1');
    const res = fakeRes();

    await completeReauth(req, res, next);

    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'credential_error');
    expect(mockTransitionItemStatus).not.toHaveBeenCalledWith('row-1', 'login_required');
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

    expect(mockTransitionItemStatus).not.toHaveBeenCalled(); // stays login_required — nothing to flip yet
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('sets active on genuine success, distinct from both credential_error and login_required', async () => {
    mockGetPlaidItemForUser.mockResolvedValue({ id: 'row-1', access_token: 'a-real-token', status: 'login_required' });
    mockGetAccounts.mockResolvedValue([]);
    mockGetLinkedItemsForUser.mockResolvedValue([]);
    const req = fakeReq('row-1');
    const res = fakeRes();

    await completeReauth(req, res, next);

    expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('row-1', 'reauth_completed');
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
// is proven against PostgreSQL 17 by supabase/tests/access_control/, including every transition and
// race below), with its own clock so a claim or exchange can go stale. `plaidSessions` stands in for
// what Plaid's /link/token/get reports per link token; `storedItems` for plaid_items rows written by
// store_plaid_link_item. A process "terminated" at some step is simulated by a call that never
// settles: nothing after it — including catch blocks — ever runs for that request.
type Status = 'pending' | 'claimed' | 'exchanging' | 'completed' | 'failed' | 'exchange_unknown';
type FakeAttempt = {
  userId: string;
  sessionId: string;
  linkToken: string;
  status: Status;
  expired: boolean;
  claimToken: string | null;
  claimedAt: number | null;
  exchangeStartedAt: number | null;
  itemRowId: string | null;
  reason: string | null;
};
const STALE_MS = 2 * 60 * 1000;
const attempts = new Map<string, FakeAttempt>();
const plaidSessions = new Map<string, unknown[]>();
const storedItems: { itemRowId: string; userId: string; plaidItemId: string; accessToken: string }[] = [];
let clock = 0;
let counter = 0;
const never = () => new Promise<never>(() => {});

const userA = { id: 'user-a', sessionId: 'sid-a' };
const userB = { id: 'user-b', sessionId: 'sid-b' };
const ACCESS_TOKEN = 'access-sandbox-secret-for-a';
const PUBLIC_TOKEN = 'public-sandbox-secret-for-a';

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
/** Starts a completion that will never finish (the process "dies" at whichever step never settles). */
function completeAndDie(user: { id: string; sessionId: string }, attemptId: string) {
  void completeLinkAttempt(authedReq(user, { params: { attemptId } }), fakeRes(), next);
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
/** Plaid's view once the user finished Hosted Link for `linkToken` and Plaid created an Item. */
function plaidFinished(linkToken: string, publicToken = PUBLIC_TOKEN) {
  plaidSessions.set(linkToken, [
    {
      link_session_id: `session-for-${linkToken}`,
      started_at: '2026-09-22T12:00:00Z',
      finished_at: '2026-09-22T12:05:00Z',
      results: { item_add_results: [{ public_token: publicToken, accounts: [], institution: null }] },
    },
  ]);
}
/** A Plaid API error as Axios raises it: Plaid answered with an error code, and the outgoing request
 *  (which carried the public token) is attached — exactly what must never be logged. */
function plaidApiError(status: number, errorCode?: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    config: { data: JSON.stringify({ public_token: PUBLIC_TOKEN }) },
    response: { status, data: errorCode ? { error_code: errorCode, error_type: 'INVALID_INPUT' } : {} },
  });
}
function expectNoSecretsLogged() {
  const logged = JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls);
  for (const secret of [ACCESS_TOKEN, PUBLIC_TOKEN, 'link-sandbox-']) expect(logged).not.toContain(secret);
}
function callOrder(...mocks: ReturnType<typeof vi.fn>[]) {
  return mocks.map((m) => m.mock.invocationCallOrder[0] ?? Infinity);
}

beforeEach(() => {
  attempts.clear();
  plaidSessions.clear();
  storedItems.length = 0;
  clock = 0;
  mockPlaidCreateHostedLinkToken.mockImplementation(async (userId: string) => {
    counter += 1;
    return { linkToken: `link-sandbox-${userId}-${counter}`, hostedLinkUrl: `https://hosted.plaid.test/link/${counter}` };
  });
  mockGetLinkTokenSessions.mockImplementation(async (linkToken: string) => plaidSessions.get(linkToken) ?? []);
  mockCreatePlaidLinkAttempt.mockImplementation(async (p: { attemptId: string; userId: string; sessionId: string; linkToken: string }) => {
    attempts.set(p.attemptId, {
      userId: p.userId,
      sessionId: p.sessionId,
      linkToken: p.linkToken,
      status: 'pending',
      expired: false,
      claimToken: null,
      claimedAt: null,
      exchangeStartedAt: null,
      itemRowId: null,
      reason: null,
    });
    return { expiresAt: '2026-09-22T12:30:00+00:00' };
  });
  const own = (id: string, userId: string, sessionId: string) => {
    const a = attempts.get(id);
    return a && a.userId === userId && a.sessionId === sessionId ? a : undefined;
  };
  const isStale = (a: FakeAttempt) =>
    (a.status === 'claimed' && clock - a.claimedAt! >= STALE_MS) || (a.status === 'exchanging' && clock - a.exchangeStartedAt! >= STALE_MS);
  mockReadPlaidLinkAttempt.mockImplementation(async (id: string, userId: string, sessionId: string) => {
    const a = own(id, userId, sessionId);
    if (!a) return null;
    const base = { status: a.status, expired: a.expired, stale: isStale(a) };
    return a.status === 'pending' || a.status === 'claimed' ? { ...base, linkToken: a.linkToken } : base;
  });
  mockClaimPlaidLinkAttempt.mockImplementation(async (id: string, userId: string, sessionId: string) => {
    const a = own(id, userId, sessionId);
    if (!a) return { outcome: 'invalid' };
    if (!a.expired && (a.status === 'pending' || (a.status === 'claimed' && isStale(a)))) {
      counter += 1;
      Object.assign(a, { status: 'claimed', claimToken: `claim-${counter}`, claimedAt: clock });
      return { outcome: 'claimed', claimToken: a.claimToken };
    }
    if (a.status === 'exchanging' && isStale(a)) Object.assign(a, { status: 'exchange_unknown', reason: 'stale_exchange' });
    if ((a.status === 'pending' || a.status === 'claimed') && a.expired) return { outcome: 'expired' };
    if (a.status === 'claimed' || a.status === 'exchanging') return { outcome: 'in_progress' };
    return { outcome: a.status };
  });
  mockBeginPlaidLinkExchange.mockImplementation(async (id: string, userId: string, sessionId: string, token: string) => {
    const a = own(id, userId, sessionId);
    if (!a || a.status !== 'claimed' || a.claimToken !== token) return false;
    Object.assign(a, { status: 'exchanging', exchangeStartedAt: clock });
    return true;
  });
  mockStorePlaidLinkItem.mockImplementation(
    async (p: { attemptId: string; userId: string; sessionId: string; claimToken: string; plaidItemId: string; accessToken: string }) => {
      const a = own(p.attemptId, p.userId, p.sessionId);
      if (!a || a.status !== 'exchanging' || a.claimToken !== p.claimToken) return { outcome: 'refused' };
      counter += 1;
      const itemRowId = `row-${counter}`;
      Object.assign(a, { status: 'completed', itemRowId });
      storedItems.push({ itemRowId, userId: p.userId, plaidItemId: p.plaidItemId, accessToken: p.accessToken });
      return { outcome: 'stored', itemRowId };
    }
  );
  mockFailPlaidLinkAttempt.mockImplementation(async (id: string, userId: string, sessionId: string, token: string | null, reason: string) => {
    const a = own(id, userId, sessionId);
    const rules: Record<string, [Status, Status[]]> = {
      exited: ['failed', ['pending']],
      ambiguous: ['failed', ['pending']],
      exchange_rejected: ['failed', ['exchanging']],
      exchange_outcome_unknown: ['exchange_unknown', ['exchanging']],
      store_failed_item_removed: ['failed', ['exchanging', 'exchange_unknown']],
      store_failed_remove_unknown: ['exchange_unknown', ['exchanging', 'exchange_unknown']],
    };
    const [to, from] = rules[reason];
    if (!a || !from.includes(a.status) || (a.status !== 'pending' && a.claimToken !== token)) return false;
    Object.assign(a, { status: to, reason });
    return true;
  });
  mockExchangePublicToken.mockResolvedValue({ accessToken: ACCESS_TOKEN, itemId: 'plaid-item-a' });
  mockRemoveItem.mockResolvedValue(undefined);
  mockGetItemInstitution.mockResolvedValue({ institutionId: 'ins_1', institutionName: 'Sandbox Bank' });
  mockUpdatePlaidItemInstitution.mockResolvedValue(undefined);
  mockGetAccounts.mockResolvedValue([{ account_id: 'plaid-acc-1' }]);
  mockUpsertAccountsForItem.mockResolvedValue([{ id: 'account-row-1', plaid_account_id: 'plaid-acc-1' }]);
  mockSyncItemTransactions.mockResolvedValue({ added: 3 });
  mockRecordSnapshotForUser.mockResolvedValue(undefined);
  mockRefreshLoansForItem.mockResolvedValue(undefined);
});

function expectNothingExchanged() {
  expect(mockExchangePublicToken).not.toHaveBeenCalled();
  expect(mockStorePlaidLinkItem).not.toHaveBeenCalled();
  expect(storedItems).toHaveLength(0);
}

describe('POST /link-token — Hosted Link attempt creation', () => {
  it('stores the link token server-side for the VERIFIED user and session and returns ONLY the Hosted Link URL, attempt id and expiry', async () => {
    const res = fakeRes();
    await createLinkToken(authedReq(userA, { body: { user_id: 'user-b', session_id: 'sid-b' } }), res, next);

    expect(mockPlaidCreateHostedLinkToken).toHaveBeenCalledWith('user-a');
    const body = jsonBody(res);
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'hosted_link_url', 'link_attempt_id']);
    const stored = attempts.get(body.link_attempt_id)!;
    expect(stored).toMatchObject({ userId: 'user-a', sessionId: 'sid-a', status: 'pending' });
    expect(JSON.stringify(body)).not.toContain(stored.linkToken);
  });

  it('refuses (401) a token that carries no login session — no Plaid call, no attempt', async () => {
    const res = fakeRes();
    await createLinkToken(authedReq({ id: 'user-a', sessionId: null }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockPlaidCreateHostedLinkToken).not.toHaveBeenCalled();
    expect(mockCreatePlaidLinkAttempt).not.toHaveBeenCalled();
  });

  it('five attempts already being completed: 429, no Hosted Link URL', async () => {
    mockCreatePlaidLinkAttempt.mockRejectedValueOnce(new dataServiceErrors.TooManyPlaidLinkAttemptsError());
    const res = fakeRes();
    await createLinkToken(authedReq(userA), res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempts_in_progress' });
    expect(next).not.toHaveBeenCalled();
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

describe('completion — success, and the order of durable steps', () => {
  it('claims, records the exchange start, exchanges once, stores the item IMMEDIATELY (before any other Plaid call), then runs the follow-ups', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);

    const res = await complete(userA, attemptId);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockGetLinkTokenSessions).toHaveBeenCalledWith(linkToken);
    expect(mockExchangePublicToken).toHaveBeenCalledExactlyOnceWith(PUBLIC_TOKEN);
    expect(mockStorePlaidLinkItem).toHaveBeenCalledExactlyOnceWith({
      attemptId,
      userId: 'user-a',
      sessionId: 'sid-a',
      claimToken: expect.any(String),
      plaidItemId: 'plaid-item-a',
      accessToken: ACCESS_TOKEN,
    });
    const order = callOrder(
      mockClaimPlaidLinkAttempt,
      mockBeginPlaidLinkExchange,
      mockExchangePublicToken,
      mockStorePlaidLinkItem,
      mockGetItemInstitution,
      mockGetAccounts,
      mockSyncItemTransactions,
      mockRecordSnapshotForUser,
      mockRefreshLoansForItem
    );
    expect([...order].sort((x, y) => x - y)).toEqual(order);

    expect(storedItems).toEqual([{ itemRowId: expect.any(String), userId: 'user-a', plaidItemId: 'plaid-item-a', accessToken: ACCESS_TOKEN }]);
    const itemRowId = storedItems[0].itemRowId;
    expect(attempts.get(attemptId)).toMatchObject({ status: 'completed', itemRowId });
    expect(mockUpdatePlaidItemInstitution).toHaveBeenCalledWith(itemRowId, 'ins_1', 'Sandbox Bank');
    expect(mockUpsertAccountsForItem).toHaveBeenCalledWith(itemRowId, [{ account_id: 'plaid-acc-1' }]);
    expect(mockSyncItemTransactions).toHaveBeenCalledWith({ id: itemRowId, user_id: 'user-a', access_token: ACCESS_TOKEN, transactions_cursor: null });
    expect(mockRefreshLoansForItem).toHaveBeenCalledWith(itemRowId, ACCESS_TOKEN, expect.any(Map));
    const body = jsonBody(res);
    expect(body).toMatchObject({
      status: 'completed',
      item: { id: itemRowId, institution_id: 'ins_1', institution_name: 'Sandbox Bank' },
      transactions_synced: 3,
      follow_up_incomplete: [],
    });
    const serialized = JSON.stringify(body);
    for (const secret of [PUBLIC_TOKEN, ACCESS_TOKEN, linkToken]) expect(serialized).not.toContain(secret);
    expect(next).not.toHaveBeenCalled();
  });

  it('replay: an already-completed attempt -> 409 link_attempt_already_completed; exchanged and stored exactly once', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);
    for (let i = 0; i < 3; i++) {
      expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_already_completed' });
    }
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(storedItems).toHaveLength(1);
  });

  it('concurrent completion: two simultaneous calls -> exactly one exchange and one stored item; the other is told it is completing', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    let releaseExchange!: () => void;
    mockExchangePublicToken.mockImplementationOnce(
      () => new Promise((resolve) => (releaseExchange = () => resolve({ accessToken: ACCESS_TOKEN, itemId: 'plaid-item-a' })))
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
    expect(storedItems).toHaveLength(1);
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_already_completed' });
  });
});

describe('completion — failures and simulated termination at every step', () => {
  it('terminated immediately BEFORE the exchange (claimed, exchange never begun): after two minutes the claim is safely taken over and completes — one exchange in total', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockBeginPlaidLinkExchange.mockImplementationOnce(never); // the process dies right after claiming
    completeAndDie(userA, attemptId);
    await flush();
    expect(attempts.get(attemptId)!.status).toBe('claimed');

    // Within two minutes the live-looking claim is left alone.
    clock += 60 * 1000;
    const early = await complete(userA, attemptId);
    expect(early.status).toHaveBeenCalledWith(202);
    expect(jsonBody(early)).toEqual({ status: 'completing' });

    clock += 2 * 60 * 1000;
    const recovered = await complete(userA, attemptId);
    expect(recovered.status).toHaveBeenCalledWith(201);
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(storedItems).toHaveLength(1);
  });

  it('terminated DURING the exchange (outcome never learned): after two minutes it is exchange_unknown — never exchanged again', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockExchangePublicToken.mockImplementationOnce(never);
    completeAndDie(userA, attemptId);
    await flush();
    expect(attempts.get(attemptId)!.status).toBe('exchanging');

    clock += 60 * 1000;
    expect(jsonBody(await complete(userA, attemptId))).toEqual({ status: 'completing' });

    clock += 2 * 60 * 1000;
    const res = await complete(userA, attemptId);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'exchange_unknown', reason: 'stale_exchange' });
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(mockStorePlaidLinkItem).not.toHaveBeenCalled();
  });

  it('exchange rejected by Plaid (4xx with an error code): failed, never retried, nothing stored or removed, no token logged', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockExchangePublicToken.mockRejectedValueOnce(plaidApiError(400, 'INVALID_PUBLIC_TOKEN'));

    const res = await complete(userA, attemptId);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_failed' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'failed', reason: 'exchange_rejected' });
    expect(mockStorePlaidLinkItem).not.toHaveBeenCalled();
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_failed' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expectNoSecretsLogged();
  });

  it.each([
    ['a network error / timeout (no response)', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
    ['a Plaid 5xx', plaidApiError(500, 'INTERNAL_SERVER_ERROR')],
  ])('exchange failure with %s: exchange_unknown (Plaid may have exchanged), never retried', async (_label, err) => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockExchangePublicToken.mockRejectedValueOnce(err);

    const res = await complete(userA, attemptId);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'exchange_unknown', reason: 'exchange_outcome_unknown' });
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(mockStorePlaidLinkItem).not.toHaveBeenCalled();
    expectNoSecretsLogged();
  });

  it('terminated immediately AFTER the exchange (token received, never stored): exchange_unknown once stale; no second exchange', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockImplementationOnce(never); // dies with the access token only in memory
    completeAndDie(userA, attemptId);
    await flush();
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);

    clock += 3 * 60 * 1000;
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(storedItems).toHaveLength(0);
  });

  it('item persistence rejected by the database (rolled back): the Item is removed at Plaid, then failed — no follow-ups, no token logged or returned', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockResolvedValueOnce({ outcome: 'rejected' });

    const res = await complete(userA, attemptId);
    expect(mockRemoveItem).toHaveBeenCalledExactlyOnceWith(ACCESS_TOKEN);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_failed' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'failed', reason: 'store_failed_item_removed' });
    expect(mockGetItemInstitution).not.toHaveBeenCalled();
    expect(mockGetAccounts).not.toHaveBeenCalled();
    expect(JSON.stringify(jsonBody(res))).not.toContain(ACCESS_TOKEN);
    expectNoSecretsLogged();
  });

  it('item persistence refused because the attempt was meanwhile recorded exchange_unknown: removed at Plaid, recorded failed', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockImplementationOnce(async (p: { attemptId: string }) => {
      Object.assign(attempts.get(p.attemptId)!, { status: 'exchange_unknown', reason: 'stale_exchange' });
      return { outcome: 'refused' };
    });
    const res = await complete(userA, attemptId);
    expect(mockRemoveItem).toHaveBeenCalledExactlyOnceWith(ACCESS_TOKEN);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_failed' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'failed', reason: 'store_failed_item_removed' });
  });

  it('item persistence failed and the compensating removal failed too: exchange_unknown — never reported as removed', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockResolvedValueOnce({ outcome: 'rejected' });
    mockRemoveItem.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { config: { data: JSON.stringify({ access_token: ACCESS_TOKEN }) } }));

    const res = await complete(userA, attemptId);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'exchange_unknown', reason: 'store_failed_remove_unknown' });
    expectNoSecretsLogged();
  });

  it('encrypting the access token failed (nothing sent): definitively not stored, so it is removed at Plaid', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockRejectedValueOnce(new PlaidCredentialError('Plaid credential encryption key configuration is invalid.'));
    const res = await complete(userA, attemptId);
    expect(mockRemoveItem).toHaveBeenCalledExactlyOnceWith(ACCESS_TOKEN);
    expect(jsonBody(res)).toMatchObject({ code: 'link_attempt_failed' });
  });

  it('whether the item was stored is UNKNOWN (no answer from the database): nothing is removed; the attempt resolves later', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockRejectedValueOnce(new dataServiceErrors.PlaidLinkStoreOutcomeUnknownError('unknown'));

    const res = await complete(userA, attemptId);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(jsonBody(res)).toEqual({ status: 'completing' });
    expect(mockRemoveItem).not.toHaveBeenCalled(); // it may well be stored — removing it could destroy a linked item
    expect(mockFailPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(mockGetAccounts).not.toHaveBeenCalled();

    clock += 3 * 60 * 1000; // (here it was not stored) — once stale it is exchange_unknown, never re-exchanged
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_outcome_unknown' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
  });

  it('terminated AFTER the item was stored (store and completion are one transaction): the item is linked; a later call reports completed and never re-exchanges', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockGetItemInstitution.mockImplementationOnce(never); // dies in the first follow-up
    completeAndDie(userA, attemptId);
    await flush();

    expect(storedItems).toHaveLength(1);
    expect(attempts.get(attemptId)).toMatchObject({ status: 'completed', itemRowId: storedItems[0].itemRowId });
    clock += 3 * 60 * 1000;
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_already_completed' });
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it.each([
    ['institution lookup', () => mockGetItemInstitution.mockRejectedValueOnce(plaidApiError(500, 'INTERNAL_SERVER_ERROR')), ['institution']],
    ['account retrieval', () => mockGetAccounts.mockRejectedValueOnce(plaidApiError(500, 'INTERNAL_SERVER_ERROR')), ['accounts', 'transactions', 'liabilities']],
    ['account insertion', () => mockUpsertAccountsForItem.mockRejectedValueOnce(new Error('Failed to insert accounts: timeout')), ['accounts', 'transactions', 'liabilities']],
    ['transaction synchronization', () => mockSyncItemTransactions.mockRejectedValueOnce(plaidApiError(400, 'PRODUCT_NOT_READY')), ['transactions']],
    ['net-worth snapshot', () => mockRecordSnapshotForUser.mockRejectedValueOnce(new Error('Failed to record snapshot')), ['net_worth_snapshot']],
    ['liability refresh', () => mockRefreshLoansForItem.mockRejectedValueOnce(plaidApiError(400, 'PRODUCTS_NOT_SUPPORTED')), ['liabilities']],
  ])('%s failure after the item is stored: still 201 linked, the item and attempt are untouched, and the failure is reported as follow-up', async (_label, arrange, incomplete) => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    arrange();

    const res = await complete(userA, attemptId);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(jsonBody(res)).toMatchObject({ status: 'completed', follow_up_incomplete: incomplete });
    expect(storedItems).toHaveLength(1);
    expect(attempts.get(attemptId)!.status).toBe('completed');
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(mockFailPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expectNoSecretsLogged();
  });

  it('a failure before claiming (reading Plaid\'s sessions) changes nothing and can simply be retried', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    const failure = plaidApiError(500, 'INTERNAL_SERVER_ERROR');
    mockGetLinkTokenSessions.mockRejectedValueOnce(failure);
    await complete(userA, attemptId);
    expect(next).toHaveBeenCalledWith(failure);
    expect(attempts.get(attemptId)!.status).toBe('pending');
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);
  });
});

describe('completion — binding, pending, exit, expiry', () => {
  it('pending: Hosted Link not finished yet -> 202 pending; nothing claimed or exchanged; completes on a later call', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    expect(jsonBody(await complete(userA, attemptId))).toEqual({ status: 'pending' });
    plaidSessions.set(linkToken, [{ link_session_id: 's1', finished_at: '2026-09-22T12:05:00Z', results: { item_add_results: [] } }]);
    expect(jsonBody(await complete(userA, attemptId))).toEqual({ status: 'pending' });
    expect(mockClaimPlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
    plaidFinished(linkToken);
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);
  });

  it('exit -> 409 link_attempt_exited; the attempt fails and can never be exchanged later', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidSessions.set(linkToken, [{ link_session_id: 's1', finished_at: 'x', exit: { error: null, metadata: null } }]);
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_exited' });
    expect(attempts.get(attemptId)).toMatchObject({ status: 'failed', reason: 'exited' });
    plaidFinished(linkToken);
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_failed' });
    expectNothingExchanged();
  });

  it('ambiguous (two public tokens) -> 409, failed, nothing guessed or exchanged', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidSessions.set(linkToken, [
      { link_session_id: 's1', results: { item_add_results: [{ public_token: 'public-1' }] } },
      { link_session_id: 's2', results: { item_add_results: [{ public_token: 'public-2' }] } },
    ]);
    expect(jsonBody(await complete(userA, attemptId))).toMatchObject({ code: 'link_attempt_ambiguous' });
    expect(attempts.get(attemptId)!.status).toBe('failed');
    expectNothingExchanged();
  });

  it('expiry -> 410, without asking Plaid or exchanging', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    attempts.get(attemptId)!.expired = true;
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(410);
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalled();
    expectNothingExchanged();
  });

  it("foreign user: B completing A's attempt -> 409 invalid, touches nothing; A can still finish", async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    expect(jsonBody(await complete(userB, attemptId))).toMatchObject({ code: 'link_attempt_invalid' });
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalled();
    expect(mockClaimPlaidLinkAttempt).not.toHaveBeenCalled();
    expect(attempts.get(attemptId)!.status).toBe('pending');
    expect((await complete(userA, attemptId)).status).toHaveBeenCalledWith(201);
    expect(storedItems[0].userId).toBe('user-a');
  });

  it("foreign user or session cannot trigger recovery of someone else's stale attempt", async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockExchangePublicToken.mockImplementationOnce(never);
    completeAndDie(userA, attemptId);
    await flush();
    clock += 3 * 60 * 1000;
    expect(jsonBody(await complete(userB, attemptId))).toMatchObject({ code: 'link_attempt_invalid' });
    expect(jsonBody(await complete({ id: 'user-a', sessionId: 'sid-a-relogin' }, attemptId))).toMatchObject({ code: 'link_attempt_invalid' });
    expect(attempts.get(attemptId)!.status).toBe('exchanging');
  });

  it('a malformed attempt id is refused before the attempt store; a token with no login session is refused (401)', async () => {
    expect(jsonBody(await complete(userA, 'not-a-uuid'))).toMatchObject({ code: 'link_attempt_invalid' });
    const { attemptId } = await startLink(userA);
    expect((await complete({ id: 'user-a', sessionId: null }, attemptId)).status).toHaveBeenCalledWith(401);
    expect(mockReadPlaidLinkAttempt).not.toHaveBeenCalled();
    expectNothingExchanged();
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
    const a = await startLink(userA);
    plaidFinished(a.linkToken, 'public-token-of-a');
    const capturedPublicTokenOfA = 'public-token-of-a';

    const b = await startLink(userB);
    expect(attempts.get(b.attemptId)).toMatchObject({ userId: 'user-b', status: 'pending' });

    const retired = fakeRes();
    exchangePublicToken(authedReq(userB, { body: { public_token: capturedPublicTokenOfA, link_attempt_id: b.attemptId } }), retired);
    expect(retired.status).toHaveBeenCalledWith(410);
    expect(jsonBody(retired)).toMatchObject({ code: 'exchange_retired' });

    const own = await complete(userB, b.attemptId, { public_token: capturedPublicTokenOfA });
    expect(jsonBody(own)).toEqual({ status: 'pending' });
    expect(mockGetLinkTokenSessions).toHaveBeenCalledWith(b.linkToken);
    expect(mockGetLinkTokenSessions).not.toHaveBeenCalledWith(a.linkToken);

    const foreign = await complete(userB, a.attemptId, { public_token: capturedPublicTokenOfA });
    expect(jsonBody(foreign)).toMatchObject({ code: 'link_attempt_invalid' });

    expect(mockExchangePublicToken).not.toHaveBeenCalled();
    expect(storedItems).toHaveLength(0);
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

describe('refreshAccounts — retries the institution follow-up for items still missing it (Wave 1)', () => {
  const item = (id: string) => ({ id, user_id: 'user-a', access_token: `access-for-${id}`, transactions_cursor: null });

  beforeEach(() => {
    mockGetPlaidItemsForUser.mockResolvedValue([item('row-missing'), item('row-known')]);
    mockGetPlaidItemIdsMissingInstitution.mockResolvedValue(new Set(['row-missing']));
    mockUpdateItemWebhook.mockResolvedValue(undefined);
    mockGetLinkedItemsForUser.mockResolvedValue([]);
    mockTransitionItemStatus.mockResolvedValue(undefined);
  });

  it('looks up and stores the institution only for the item that has none', async () => {
    const res = fakeRes();
    await refreshAccounts(authedReq(userA), res, next);
    expect(mockGetItemInstitution).toHaveBeenCalledExactlyOnceWith('access-for-row-missing');
    expect(mockUpdatePlaidItemInstitution).toHaveBeenCalledExactlyOnceWith('row-missing', 'ins_1', 'Sandbox Bank');
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('an enrichment failure is logged (sanitized) and does not fail the refresh', async () => {
    mockGetItemInstitution.mockRejectedValueOnce(plaidApiError(500, 'INTERNAL_SERVER_ERROR'));
    const res = fakeRes();
    await refreshAccounts(authedReq(userA), res, next);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(mockUpsertAccountsForItem).toHaveBeenCalledTimes(2);
    expectNoSecretsLogged();
  });

  it('if the missing-institution check itself fails, the refresh still runs (without enrichment)', async () => {
    mockGetPlaidItemIdsMissingInstitution.mockRejectedValueOnce(new Error('down'));
    const res = fakeRes();
    await refreshAccounts(authedReq(userA), res, next);
    expect(res.json).toHaveBeenCalled();
    expect(mockGetItemInstitution).not.toHaveBeenCalled();
  });
});

describe('exchange_unknown guidance: the Item may exist at Plaid, so never say it was not added or invite relinking', () => {
  function expectCalmUnknownGuidance(res: Response) {
    expect(res.status).toHaveBeenCalledWith(409);
    const body = jsonBody(res);
    expect(body).toEqual({ code: 'link_attempt_outcome_unknown', error: LINK_OUTCOME_UNKNOWN_MESSAGE });
    const message: string = body.error;
    // States that the outcome could not be confirmed, and asks for support before any retry.
    expect(message).toMatch(/couldn't confirm/i);
    expect(message).toMatch(/don't try linking this bank again yet/i);
    expect(message).toMatch(/contact support/i);
    // Never claims the connection is definitely absent...
    expect(message).not.toMatch(/was not added|wasn't added|not linked|was not connected|nothing was (added|linked)|no (bank|connection) was/i);
    // ...and never advises linking again now.
    expect(message).not.toMatch(/start linking|link (it|the account|this bank|your bank) again(?! yet)|try again|please retry|start again/i);
    // No Plaid token of any kind in the response.
    const serialized = JSON.stringify(body);
    for (const secret of [PUBLIC_TOKEN, ACCESS_TOKEN, 'link-sandbox-']) expect(serialized).not.toContain(secret);
  }

  async function expectTerminal(attemptId: string) {
    const exchangesBefore = mockExchangePublicToken.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      clock += 5 * 60 * 1000;
      expectCalmUnknownGuidance(await complete(userA, attemptId));
    }
    expect(attempts.get(attemptId)!.status).toBe('exchange_unknown');
    expect(mockExchangePublicToken.mock.calls.length).toBe(exchangesBefore);
    expect(mockExchangePublicToken).toHaveBeenCalledTimes(1);
    expect(mockStorePlaidLinkItem.mock.calls.length).toBeLessThanOrEqual(1);
    expectNoSecretsLogged();
  }

  it.each([
    ['a network error / timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED', config: { data: JSON.stringify({ public_token: PUBLIC_TOKEN }) } })],
    ['a Plaid 5xx', plaidApiError(500, 'INTERNAL_SERVER_ERROR')],
  ])('exchange outcome unknown after %s', async (_label, err) => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockExchangePublicToken.mockRejectedValueOnce(err);
    expectCalmUnknownGuidance(await complete(userA, attemptId));
    await expectTerminal(attemptId);
  });

  it('a stale exchange whose process died mid-exchange', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockExchangePublicToken.mockImplementationOnce(never);
    completeAndDie(userA, attemptId);
    await flush();
    clock += 3 * 60 * 1000;
    expectCalmUnknownGuidance(await complete(userA, attemptId));
    await expectTerminal(attemptId);
  });

  it('the item could not be stored and its removal at Plaid could not be confirmed', async () => {
    const { attemptId, linkToken } = await startLink(userA);
    plaidFinished(linkToken);
    mockStorePlaidLinkItem.mockResolvedValueOnce({ outcome: 'rejected' });
    mockRemoveItem.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { config: { data: JSON.stringify({ access_token: ACCESS_TOKEN }) } }));
    expectCalmUnknownGuidance(await complete(userA, attemptId));
    expect(mockRemoveItem).toHaveBeenCalledTimes(1);
    await expectTerminal(attemptId);
    expect(mockRemoveItem).toHaveBeenCalledTimes(1); // no repeated compensation either
  });
});

// ---- Linked Institution Management V1 ------------------------------------------------------------
describe('Linked Institution Management — connections, removal and reconnect guards', () => {
  const removalRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'op-1', user_id: 'user-a', item_id: 'item-1', plaid_item_id: 'plaid-item-secret-id', institution_name: 'Test Bank',
    status_before: 'active', status: 'requested', preview_digest: 'the-digest', attempts: 1, last_attempt_at: null,
    last_outcome: 'retryable', last_error_code: null, plaid_outcome: null, loan_adjustments: null, deleted_counts: null,
    requested_at: '2026-09-26T00:00:00Z', plaid_removed_at: null, cleaned_at: null, reconciled_at: null,
    ...overrides,
  });
  const itemReq = (itemId: string, body?: unknown) => authedReq(userA, { params: { itemId }, body });

  describe('GET /items', () => {
    it("attaches each item's removal and lists unfinished removals — including one whose item is already gone", async () => {
      mockGetLinkedItemsForUser.mockResolvedValue([
        { id: 'item-1', status: 'removing', accounts: [] },
        { id: 'item-2', status: 'active', accounts: [] },
      ]);
      mockListUnfinishedItemRemovals.mockResolvedValue([
        removalRecord(),
        removalRecord({ item_id: 'item-gone', status: 'cleaned', cleaned_at: 'x', loan_adjustments: [], deleted_counts: {} }),
      ]);
      const res = fakeRes();
      await listLinkedItems(authedReq(userA), res, next);
      const body = jsonBody(res);
      expect(body.items[0].removal).toMatchObject({ item_id: 'item-1', status: 'requested', finished: false });
      expect(body.items[1].removal).toBeNull();
      expect(body.unfinished_removals.map((r: { item_id: string }) => r.item_id)).toEqual(['item-1', 'item-gone']);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('the-digest');
      expect(serialized).not.toContain('plaid-item-secret-id');
    });
  });

  describe('GET /items/:itemId/removal-preview', () => {
    const preview = (overrides: Record<string, unknown> = {}) => ({
      item_id: 'item-1', institution_name: 'Test Bank', status: 'active', accounts: [], counts: {}, loan_restorations: [],
      unrestorable_links: 0, digest: 'the-digest', ...overrides,
    });

    it('returns the preview with its digest', async () => {
      mockGetItemRemoval.mockResolvedValue(null);
      mockPreviewItemRemoval.mockResolvedValue(preview());
      const res = fakeRes();
      await previewItemRemoval(itemReq('item-1'), res, next);
      expect(jsonBody(res)).toMatchObject({ preview: { digest: 'the-digest' }, blocked_reason: null });
    });

    it.each([
      ['credential_error', { status: 'credential_error' }, 'connection_needs_attention'],
      ['an unrestorable loan link', { unrestorable_links: 1, blocker: 'manual_loan_reconciliation_required' }, 'manual_loan_reconciliation_required'],
      ["a payment linked to another user's loan", { ownership_mismatch_links: 1, blocker: 'manual_loan_ownership_mismatch' }, 'manual_loan_ownership_mismatch'],
    ])('shows why removal is blocked (%s) before the user confirms', async (_label, overrides, reason) => {
      mockGetItemRemoval.mockResolvedValue(null);
      mockPreviewItemRemoval.mockResolvedValue(preview(overrides));
      const res = fakeRes();
      await previewItemRemoval(itemReq('item-1'), res, next);
      expect(jsonBody(res)).toMatchObject({ blocked_reason: reason, blocked_message: expect.any(String) });
    });

    it("404s for an unknown (or another user's) item", async () => {
      mockGetItemRemoval.mockResolvedValue(null);
      mockPreviewItemRemoval.mockResolvedValue(null);
      const res = fakeRes();
      await previewItemRemoval(itemReq('item-x'), res, next);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('409 removal_in_progress with the operation when a removal already exists', async () => {
      mockGetItemRemoval.mockResolvedValue(removalRecord());
      const res = fakeRes();
      await previewItemRemoval(itemReq('item-1'), res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonBody(res)).toMatchObject({ code: 'removal_in_progress', removal: { status: 'requested' } });
      expect(mockPreviewItemRemoval).not.toHaveBeenCalled();
    });
  });

  describe('POST /items/:itemId/removal', () => {
    it('passes the confirmed digest; 200 when finished', async () => {
      mockRunItemRemoval.mockResolvedValue({ kind: 'progressed', removal: { status: 'cleaned', finished: true } });
      const res = fakeRes();
      await removeInstitution(itemReq('item-1', { preview_digest: 'the-digest' }), res, next);
      expect(mockRunItemRemoval).toHaveBeenCalledWith('user-a', 'item-1', 'the-digest');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('202 when it stopped at a retryable point', async () => {
      mockRunItemRemoval.mockResolvedValue({ kind: 'progressed', removal: { status: 'requested', finished: false, last_outcome: 'retryable' } });
      const res = fakeRes();
      await removeInstitution(itemReq('item-1', {}), res, next);
      expect(mockRunItemRemoval).toHaveBeenCalledWith('user-a', 'item-1', null);
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('ignores a malformed digest (the request is then simply stale)', async () => {
      mockRunItemRemoval.mockResolvedValue({ kind: 'preview_stale' });
      const res = fakeRes();
      await removeInstitution(itemReq('item-1', { preview_digest: 42 }), res, next);
      expect(mockRunItemRemoval).toHaveBeenCalledWith('user-a', 'item-1', null);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it.each([
      ['not_found', 404],
      ['preview_stale', 409],
      ['connection_needs_attention', 409],
      ['manual_loan_reconciliation_required', 409],
      ['manual_loan_ownership_mismatch', 409],
    ])('%s -> %i with that code', async (kind, status) => {
      mockRunItemRemoval.mockResolvedValue({ kind });
      const res = fakeRes();
      await removeInstitution(itemReq('item-1', { preview_digest: 'd' }), res, next);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonBody(res)).toMatchObject({ code: kind, error: expect.any(String) });
    });

    it('the ownership refusal says nothing was removed and names no other user or loan', async () => {
      mockRunItemRemoval.mockResolvedValue({ kind: 'manual_loan_ownership_mismatch' });
      const res = fakeRes();
      await removeInstitution(itemReq('item-1', { preview_digest: 'd' }), res, next);
      const body = jsonBody(res);
      expect(body.error).toMatch(/Nothing was removed/);
      expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    });

    it('a failure after the operation began is 202 removal_incomplete with the persisted state (sanitized log)', async () => {
      const cause = Object.assign(new Error('db down'), { config: { data: 'access-sandbox-secret-for-a' } });
      mockRunItemRemoval.mockRejectedValue(new ItemRemovalIncompleteError({ status: 'plaid_removed', finished: false } as never, cause));
      const res = fakeRes();
      await removeInstitution(itemReq('item-1', {}), res, next);
      expect(res.status).toHaveBeenCalledWith(202);
      expect(jsonBody(res)).toMatchObject({ code: 'removal_incomplete', removal: { status: 'plaid_removed' } });
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('access-sandbox-secret-for-a');
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('GET /items/:itemId/removal', () => {
    it('returns the operation, even after the item is gone', async () => {
      mockGetItemRemoval.mockResolvedValue(
        removalRecord({ status: 'cleaned', cleaned_at: 'x', loan_adjustments: [], deleted_counts: {}, reconciled_at: 'y' })
      );
      const res = fakeRes();
      await getItemRemoval(itemReq('item-1'), res, next);
      expect(jsonBody(res)).toMatchObject({ removal: { status: 'cleaned', finished: true } });
    });

    it('404s when there is none', async () => {
      mockGetItemRemoval.mockResolvedValue(null);
      const res = fakeRes();
      await getItemRemoval(itemReq('item-1'), res, next);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('reconnect guards', () => {
    it('a removing item cannot start Update Mode', async () => {
      mockGetPlaidItemForUser.mockResolvedValue({ id: 'item-1', access_token: ACCESS_TOKEN, status: 'removing' });
      const res = fakeRes();
      await createReauthLinkToken(itemReq('item-1'), res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonBody(res)).toMatchObject({ code: 'connection_being_removed' });
      expect(mockCreateReauthLinkToken).not.toHaveBeenCalled();
    });

    it('a permission_revoked item CAN start Update Mode', async () => {
      mockGetPlaidItemForUser.mockResolvedValue({ id: 'item-1', access_token: ACCESS_TOKEN, status: 'permission_revoked' });
      mockCreateReauthLinkToken.mockResolvedValue('link-update-token');
      const res = fakeRes();
      await createReauthLinkToken(itemReq('item-1'), res, next);
      expect(jsonBody(res)).toEqual({ link_token: 'link-update-token' });
    });

    it('a permission_revoked item Plaid refuses Update Mode for gets reconnect_unavailable (remove, then link again)', async () => {
      mockGetPlaidItemForUser.mockResolvedValue({ id: 'item-1', access_token: ACCESS_TOKEN, status: 'permission_revoked' });
      mockCreateReauthLinkToken.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_NOT_FOUND' } } });
      const res = fakeRes();
      await createReauthLinkToken(itemReq('item-1'), res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonBody(res)).toMatchObject({ code: 'reconnect_unavailable', error: expect.stringContaining('link the bank again') });
    });

    it('completing Update Mode for a revoked item that is still refused: reconnect_unavailable, status untouched', async () => {
      mockGetPlaidItemForUser.mockResolvedValue({ id: 'item-1', access_token: ACCESS_TOKEN, status: 'permission_revoked' });
      mockGetAccounts.mockRejectedValue({ response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } });
      const res = fakeRes();
      await completeReauth(itemReq('item-1'), res, next);
      expect(jsonBody(res)).toMatchObject({ code: 'reconnect_unavailable' });
      expect(mockTransitionItemStatus).not.toHaveBeenCalled();
    });

    it('completing Update Mode for a revoked item that works again: permission_revoked -> active', async () => {
      mockGetPlaidItemForUser.mockResolvedValue({ id: 'item-1', access_token: ACCESS_TOKEN, status: 'permission_revoked' });
      mockGetAccounts.mockResolvedValue([]);
      mockGetLinkedItemsForUser.mockResolvedValue([]);
      const res = fakeRes();
      await completeReauth(itemReq('item-1'), res, next);
      expect(mockTransitionItemStatus).toHaveBeenCalledExactlyOnceWith('item-1', 'reauth_completed');
    });

    it('completing Update Mode for a removing item is refused', async () => {
      mockGetPlaidItemForUser.mockResolvedValue({ id: 'item-1', access_token: ACCESS_TOKEN, status: 'removing' });
      const res = fakeRes();
      await completeReauth(itemReq('item-1'), res, next);
      expect(jsonBody(res)).toMatchObject({ code: 'connection_being_removed' });
      expect(mockGetAccounts).not.toHaveBeenCalled();
      expect(mockTransitionItemStatus).not.toHaveBeenCalled();
    });
  });

  describe('an item removed (or revoked) while a sync/refresh loop is running is skipped, not a failure', () => {
    const item = (id: string) => ({ id, user_id: 'user-a', access_token: `access-for-${id}`, transactions_cursor: null });

    it('refresh: the vanished item is skipped; the others still refresh', async () => {
      mockGetPlaidItemsForUser.mockResolvedValue([item('gone'), item('kept')]);
      mockGetPlaidItemIdsMissingInstitution.mockResolvedValue(new Set());
      mockGetAccounts.mockResolvedValue([]);
      mockUpsertAccountsForItem.mockImplementation(async (id: string) => {
        if (id === 'gone') throw new Error('insert or update on table "accounts" violates foreign key constraint');
        return [];
      });
      mockGetPlaidItemStatusForUser.mockImplementation(async (id: string) => (id === 'gone' ? null : { id, status: 'active' }));
      mockUpdateItemWebhook.mockResolvedValue(undefined);
      mockGetLinkedItemsForUser.mockResolvedValue([]);
      const res = fakeRes();
      await refreshAccounts(authedReq(userA), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockUpsertAccountsForItem).toHaveBeenCalledWith('kept', []);
      expect(res.json).toHaveBeenCalled();
    });

    it('sync: an item that started removing mid-loop is skipped', async () => {
      mockGetPlaidItemsForUser.mockResolvedValue([item('removing-now')]);
      mockSyncItemTransactions.mockRejectedValue(
        new Error('apply_synced_transaction_batch: one or more rows reference an account not owned by this user')
      );
      mockGetPlaidItemStatusForUser.mockResolvedValue({ id: 'removing-now', status: 'removing' });
      const res = fakeRes();
      await syncTransactions(authedReq(userA), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(jsonBody(res)).toEqual({ added: 0, modified: 0, removed: 0 });
    });

    it('sync: a genuine failure on a still-syncable item still fails the request', async () => {
      mockGetPlaidItemsForUser.mockResolvedValue([item('ok')]);
      mockSyncItemTransactions.mockRejectedValue(new Error('boom'));
      mockGetPlaidItemStatusForUser.mockResolvedValue({ id: 'ok', status: 'active' });
      const res = fakeRes();
      await syncTransactions(authedReq(userA), res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockDeleteManualLoan = vi.hoisted(() => vi.fn());
const mockMarkReconciled = vi.hoisted(() => vi.fn());
const mockCreateManualLoan = vi.hoisted(() => vi.fn());
const mockGetManualLoan = vi.hoisted(() => vi.fn());
const mockListPaymentsForLoan = vi.hoisted(() => vi.fn());
const mockGetLinkedPaymentsForLoan = vi.hoisted(() => vi.fn());

// Declared via vi.hoisted so they exist by the time the hoisted vi.mock factory below runs.
const { ManualLoanNotFoundError, ManualLoanCreationError, ManualLoanCreationKeyResolvedError } = vi.hoisted(() => {
  class ManualLoanCreationError extends Error {}
  return {
    ManualLoanNotFoundError: class ManualLoanNotFoundError extends Error {},
    ManualLoanCreationError,
    ManualLoanCreationKeyResolvedError: class ManualLoanCreationKeyResolvedError extends ManualLoanCreationError {},
  };
});

const mockUpdateLinkedPaymentPrincipal = vi.hoisted(() => vi.fn());
const mockUnlinkPaymentFromLoan = vi.hoisted(() => vi.fn());
const mockFindTransactionCarryover = vi.hoisted(() => vi.fn());
const mockGetTransactionItemForUser = vi.hoisted(() => vi.fn());
const { TransactionNotFoundError } = vi.hoisted(() => ({ TransactionNotFoundError: class TransactionNotFoundError extends Error {} }));
vi.mock('../services/dataService', () => ({
  deleteManualLoan: mockDeleteManualLoan,
  markManualLoanDeletionReconciled: mockMarkReconciled,
  createManualLoan: mockCreateManualLoan,
  getManualLoan: mockGetManualLoan,
  listPaymentsForLoan: mockListPaymentsForLoan,
  getLinkedPaymentsForLoan: mockGetLinkedPaymentsForLoan,
  updateLinkedPaymentPrincipal: mockUpdateLinkedPaymentPrincipal,
  unlinkPaymentFromLoan: mockUnlinkPaymentFromLoan,
  findTransactionCarryover: mockFindTransactionCarryover,
  getTransactionItemForUser: mockGetTransactionItemForUser,
  TransactionNotFoundError,
  ManualLoanNotFoundError,
  ManualLoanCreationError,
  ManualLoanCreationKeyResolvedError,
}));

const mockReconcileRelationalRoles = vi.hoisted(() => vi.fn());
const mockRepairExistingRelationalRoles = vi.hoisted(() => vi.fn());
vi.mock('../services/roleReconciliation', () => ({
  reconcileRelationalRoles: mockReconcileRelationalRoles,
  repairExistingRelationalRoles: mockRepairExistingRelationalRoles,
  reconcileAfterRelationalStateChange: vi.fn(),
}));

vi.mock('../services/loans', () => ({
  backfillMatchesForLoan: vi.fn(),
  computePayoffProgressPct: vi.fn(),
}));

import { createManualLoanIdempotent, deleteManualLoan, unlinkPayment, updateLinkedPayment } from './manualLoanController';

function fakeReq(): Request {
  return { user: { id: 'user-1' }, params: { id: 'loan-1' }, body: {} } as unknown as Request;
}

function fakeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReconcileRelationalRoles.mockResolvedValue({ resolved: [], unresolved: [] });
  mockRepairExistingRelationalRoles.mockResolvedValue({ resolved: [], unresolved: [] });
  mockMarkReconciled.mockResolvedValue(undefined);
});

describe('deleteManualLoan controller — post-deletion reconciliation (Round 10 remediation, blocker 5)', () => {
  it('runs FORWARD reconciliation for every affected transaction, then the repair sweep, then marks the deletion reconciled', async () => {
    mockDeleteManualLoan.mockResolvedValue({
      affectedTransactionIds: ['txn-1', 'txn-2'],
      replayed: false,
      alreadyReconciled: false,
    });
    const res = fakeRes();

    await deleteManualLoan(fakeReq(), res, vi.fn() as unknown as NextFunction);

    // Forward reconciliation is the half that was missing entirely before this round: reclassifying
    // a row off a deleted loan is exactly what can make it newly eligible as a transfer counterpart
    // or refund original, which the backward-looking repair sweep alone never considers.
    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-1', ['txn-1', 'txn-2']);
    expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
    expect(mockReconcileRelationalRoles.mock.invocationCallOrder[0]).toBeLessThan(
      mockRepairExistingRelationalRoles.mock.invocationCallOrder[0]
    );
    expect(mockMarkReconciled).toHaveBeenCalledWith('loan-1', 'user-1');
    expect(mockMarkReconciled.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRepairExistingRelationalRoles.mock.invocationCallOrder[0]
    );
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('still runs the repair sweep when the loan had no linked transactions, and skips forward reconciliation', async () => {
    mockDeleteManualLoan.mockResolvedValue({
      affectedTransactionIds: [],
      replayed: false,
      alreadyReconciled: false,
    });
    const res = fakeRes();

    await deleteManualLoan(fakeReq(), res, vi.fn() as unknown as NextFunction);

    expect(mockReconcileRelationalRoles).not.toHaveBeenCalled();
    expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
    expect(mockMarkReconciled).toHaveBeenCalled();
  });

  it('leaves the deletion UNMARKED when reconciliation fails, so a retry re-runs it', async () => {
    mockDeleteManualLoan.mockResolvedValue({
      affectedTransactionIds: ['txn-1'],
      replayed: false,
      alreadyReconciled: false,
    });
    mockRepairExistingRelationalRoles.mockRejectedValue(new Error('repair exploded'));
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();

    await deleteManualLoan(fakeReq(), res, next);

    expect(mockMarkReconciled).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'repair exploded' }));
    expect(res.status).not.toHaveBeenCalledWith(204);
  });

  it('a RETRY after a post-commit reconciliation failure replays the recorded ids and reconciles them — it does not 404', async () => {
    // The loan row is already gone; the tombstone is what makes this retryable at all.
    mockDeleteManualLoan.mockResolvedValue({
      affectedTransactionIds: ['txn-1', 'txn-2'],
      replayed: true,
      alreadyReconciled: false,
    });
    const res = fakeRes();

    await deleteManualLoan(fakeReq(), res, vi.fn() as unknown as NextFunction);

    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-1', ['txn-1', 'txn-2']);
    expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
    expect(mockMarkReconciled).toHaveBeenCalledWith('loan-1', 'user-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('skips redundant work when replaying a deletion whose reconciliation already completed', async () => {
    mockDeleteManualLoan.mockResolvedValue({
      affectedTransactionIds: ['txn-1'],
      replayed: true,
      alreadyReconciled: true,
    });
    const res = fakeRes();

    await deleteManualLoan(fakeReq(), res, vi.fn() as unknown as NextFunction);

    expect(mockReconcileRelationalRoles).not.toHaveBeenCalled();
    expect(mockRepairExistingRelationalRoles).not.toHaveBeenCalled();
    expect(mockMarkReconciled).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('answers 404 for a loan that never existed (no tombstone either), without reconciling anything', async () => {
    mockDeleteManualLoan.mockRejectedValue(new ManualLoanNotFoundError('Manual loan not found'));
    const res = fakeRes();

    await deleteManualLoan(fakeReq(), res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockReconcileRelationalRoles).not.toHaveBeenCalled();
    expect(mockRepairExistingRelationalRoles).not.toHaveBeenCalled();
  });
});

describe('createManualLoan controller — resolved idempotency keys (Round 12 remediation)', () => {
  function createReq(): Request {
    return {
      user: { id: 'user-1' },
      params: {},
      body: { name: 'Car', current_balance: 100 },
      header: (name: string) => (name === 'Idempotency-Key' ? 'key-1' : undefined),
    } as unknown as Request;
  }

  it('answers 409 with a machine-readable code when the key already created a since-deleted loan', async () => {
    mockCreateManualLoan.mockRejectedValue(
      new ManualLoanCreationKeyResolvedError('This loan was already created by an earlier attempt and has since been deleted.')
    );
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;

    await createManualLoanIdempotent(createReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'This loan was already created by an earlier attempt and has since been deleted.',
      code: 'idempotency_key_loan_deleted',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('still passes every OTHER creation failure to the error handler, with no resolution code', async () => {
    mockCreateManualLoan.mockRejectedValue(new ManualLoanCreationError('Failed to create manual loan: boom'));
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;

    await createManualLoanIdempotent(createReq(), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Failed to create manual loan: boom' }));
    expect(res.status).not.toHaveBeenCalledWith(409);
  });
});

// Pending → posted continuity (design §8): a linked-payment edit that loses the race to the posting
// of its pending row is answered with what happened, through the user-scoped carry-over lookup.
describe('linked-payment edits racing a posting (pending → posted continuity)', () => {
  const paymentReq = (body: unknown = {}) =>
    ({ user: { id: 'user-1' }, params: { id: 'loan-1', transactionId: 'txn-pending' }, body } as unknown as Request);
  const next = vi.fn() as unknown as NextFunction;
  const body = (res: Response) => (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

  beforeEach(() => {
    mockGetManualLoan.mockResolvedValue({ id: 'loan-1', user_id: 'user-1', current_balance: 900 });
    mockFindTransactionCarryover.mockResolvedValue(null);
  });

  it('principal edit: the pending payment has posted → 409 transaction_superseded with the posted row (this user only)', async () => {
    mockUpdateLinkedPaymentPrincipal.mockRejectedValue(new TransactionNotFoundError('Payment not found'));
    mockFindTransactionCarryover.mockResolvedValue({ status: 'superseded', postedTransactionId: 'txn-posted' });
    mockGetTransactionItemForUser.mockResolvedValue({ id: 'txn-posted', amount: 400, pending_transaction_id: 'plaid-p' });
    const res = fakeRes();
    await updateLinkedPayment(paymentReq({ principal_portion: 300 }), res, next);
    expect(mockFindTransactionCarryover).toHaveBeenCalledWith('user-1', 'txn-pending');
    expect(mockGetTransactionItemForUser).toHaveBeenCalledWith('user-1', 'txn-posted');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toEqual({
      error: expect.stringContaining('has posted'),
      code: 'transaction_superseded',
      superseded_by: expect.objectContaining({ id: 'txn-posted' }),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('principal edit: the pending payment was withdrawn → 409 transaction_pending_removed', async () => {
    mockUpdateLinkedPaymentPrincipal.mockRejectedValue(new TransactionNotFoundError('Payment not found'));
    mockFindTransactionCarryover.mockResolvedValue({ status: 'pending_removed' });
    const res = fakeRes();
    await updateLinkedPayment(paymentReq({ principal_portion: 300 }), res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toEqual({ error: expect.stringContaining('withdrew'), code: 'transaction_pending_removed' });
  });

  it('unlink: superseded → 409 with the posted row; the loan is not re-read and no repair runs', async () => {
    mockUnlinkPaymentFromLoan.mockRejectedValue(new TransactionNotFoundError('Payment not found'));
    mockFindTransactionCarryover.mockResolvedValue({ status: 'superseded', postedTransactionId: 'txn-posted' });
    mockGetTransactionItemForUser.mockResolvedValue({ id: 'txn-posted' });
    const res = fakeRes();
    await unlinkPayment(paymentReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toMatchObject({ code: 'transaction_superseded' });
    expect(mockGetManualLoan).toHaveBeenCalledTimes(1);
  });

  it('unlink: withdrawn → 409 transaction_pending_removed; an unknown or foreign row → 404', async () => {
    mockUnlinkPaymentFromLoan.mockRejectedValue(new TransactionNotFoundError('Payment not found'));
    mockFindTransactionCarryover.mockResolvedValueOnce({ status: 'pending_removed' });
    const res1 = fakeRes();
    await unlinkPayment(paymentReq(), res1, next);
    expect(res1.status).toHaveBeenCalledWith(409);
    expect(body(res1)).toMatchObject({ code: 'transaction_pending_removed' });

    mockFindTransactionCarryover.mockResolvedValueOnce(null);
    const res2 = fakeRes();
    await unlinkPayment(paymentReq(), res2, next);
    expect(res2.status).toHaveBeenCalledWith(404);
  });

  it('any other failure still goes to the error handler', async () => {
    mockUpdateLinkedPaymentPrincipal.mockRejectedValue(new Error('Payment is not linked to this loan'));
    const res = fakeRes();
    await updateLinkedPayment(paymentReq({ principal_portion: 1 }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Payment is not linked to this loan' }));
    expect(res.status).not.toHaveBeenCalled();
  });
});

// Codex final review of 3534697: a foreign transaction id and a random id must produce the same 404
// from the payment controllers — the service reports both as TransactionNotFoundError, and the
// user-scoped carry-over lookup finds nothing for either.
describe('linked-payment controllers: foreign and random ids are the same 404', () => {
  const next = vi.fn() as unknown as NextFunction;
  const reqFor = (transactionId: string, body: unknown = {}) =>
    ({ user: { id: 'user-1' }, params: { id: 'loan-1', transactionId }, body } as unknown as Request);

  beforeEach(() => {
    mockGetManualLoan.mockResolvedValue({ id: 'loan-1', user_id: 'user-1', current_balance: 900 });
    mockFindTransactionCarryover.mockResolvedValue(null);
    mockUpdateLinkedPaymentPrincipal.mockRejectedValue(new TransactionNotFoundError('Payment not found'));
    mockUnlinkPaymentFromLoan.mockRejectedValue(new TransactionNotFoundError('Payment not found'));
  });

  it.each([
    ['a random id', 'no-such-transaction'],
    ["another user's transaction", 'txn-owned-by-user-2'],
  ])('principal edit with %s → 404, identical body', async (_label, transactionId) => {
    const res = fakeRes();
    await updateLinkedPayment(reqFor(transactionId, { principal_portion: 10 }), res, next);
    expect(mockFindTransactionCarryover).toHaveBeenCalledWith('user-1', transactionId);
    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ error: 'Transaction not found' });
    expect(mockGetTransactionItemForUser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['a random id', 'no-such-transaction'],
    ["another user's transaction", 'txn-owned-by-user-2'],
  ])('unlink with %s → 404, identical body, no reconciliation', async (_label, transactionId) => {
    const res = fakeRes();
    await unlinkPayment(reqFor(transactionId), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ error: 'Transaction not found' });
    expect(mockGetManualLoan).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockDeleteManualLoan = vi.hoisted(() => vi.fn());
const mockMarkReconciled = vi.hoisted(() => vi.fn());
const mockCreateManualLoan = vi.hoisted(() => vi.fn());
const mockGetManualLoan = vi.hoisted(() => vi.fn());
const mockListPaymentsForLoan = vi.hoisted(() => vi.fn());
const mockGetLinkedPaymentsForLoan = vi.hoisted(() => vi.fn());

// Declared via vi.hoisted so they exist by the time the hoisted vi.mock factory below runs.
const { ManualLoanNotFoundError, ManualLoanCreationError } = vi.hoisted(() => ({
  ManualLoanNotFoundError: class ManualLoanNotFoundError extends Error {},
  ManualLoanCreationError: class ManualLoanCreationError extends Error {},
}));

vi.mock('../services/dataService', () => ({
  deleteManualLoan: mockDeleteManualLoan,
  markManualLoanDeletionReconciled: mockMarkReconciled,
  createManualLoan: mockCreateManualLoan,
  getManualLoan: mockGetManualLoan,
  listPaymentsForLoan: mockListPaymentsForLoan,
  getLinkedPaymentsForLoan: mockGetLinkedPaymentsForLoan,
  ManualLoanNotFoundError,
  ManualLoanCreationError,
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

import { deleteManualLoan } from './manualLoanController';

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

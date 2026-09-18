import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';
import { backfillMatchesForLoan, computePayoffProgressPct } from '../services/loans';
import {
  reconcileAfterRelationalStateChange,
  reconcileRelationalRoles,
  repairExistingRelationalRoles,
} from '../services/roleReconciliation';
import type { ManualLoanRow } from '../types';

type LifetimeTotals = { principalPaid: number; interestPaid: number };

// Computed fresh on every response (list, create, update, and every payment mutation) rather
// than stored — cheap, and avoids the "field only present on the list endpoint" gap that bit
// the budget-category spent/recent_avg_spent fields earlier: every manual-loan response has
// payoff_progress_pct and lifetime totals.
function withLoanExtras(loan: ManualLoanRow, totals: LifetimeTotals | undefined) {
  return {
    ...loan,
    payoff_progress_pct: computePayoffProgressPct(loan.origination_principal_amount, loan.current_balance),
    lifetime_principal_paid: totals?.principalPaid ?? 0,
    lifetime_interest_paid: totals?.interestPaid ?? 0,
  };
}

/** Re-fetches one loan's lifetime totals — used after any payment mutation so the response
 *  reflects the change without the caller having to patch the totals in by hand. */
async function enrichLoan(loan: ManualLoanRow) {
  const totals = await dataService.getLifetimeTotalsByLoanId([loan.id]);
  return withLoanExtras(loan, totals.get(loan.id));
}

export async function listManualLoans(req: Request, res: Response, next: NextFunction) {
  try {
    const loans = await dataService.listManualLoans(req.user!.id);
    const totals = await dataService.getLifetimeTotalsByLoanId(loans.map((l) => l.id));
    res.json({ loans: loans.map((loan) => withLoanExtras(loan, totals.get(loan.id))) });
  } catch (err) {
    next(err);
  }
}

interface ManualLoanBody {
  name?: string;
  loan_type?: string;
  current_balance?: number;
  origination_principal_amount?: number | null;
  interest_rate_percentage?: number | null;
  origination_date?: string | null;
  term_months?: number | null;
  minimum_payment_amount?: number | null;
  next_payment_due_date?: string | null;
  notes?: string | null;
  match_text?: string | null;
}

/**
 * Prefix for the keys the LEGACY create route generates on the server. The idempotent route
 * refuses any client-supplied key carrying it, so a legacy request's key can never collide with,
 * replay, or be replayed by a key from the new client's pending-attempt protocol.
 */
export const LEGACY_SERVER_KEY_PREFIX = 'legacy-server:';

/** Creates the loan through the idempotent RPC under `idempotencyKey`, then backfills matches. */
async function createLoanUnderKey(req: Request, res: Response, next: NextFunction, idempotencyKey: string) {
  try {
    const userId = req.user!.id;
    const body = req.body as ManualLoanBody;

    if (!body.name || typeof body.current_balance !== 'number') {
      res.status(400).json({ error: 'name and current_balance are required' });
      return;
    }

    const loan = await dataService.createManualLoan(
      userId,
      {
        name: body.name,
        loanType: body.loan_type ?? 'personal',
        currentBalance: body.current_balance,
        originationPrincipalAmount: body.origination_principal_amount ?? null,
        interestRatePercentage: body.interest_rate_percentage ?? null,
        originationDate: body.origination_date ?? null,
        termMonths: body.term_months ?? null,
        minimumPaymentAmount: body.minimum_payment_amount ?? null,
        nextPaymentDueDate: body.next_payment_due_date ?? null,
        notes: body.notes ?? null,
        matchText: body.match_text ?? null,
      },
      idempotencyKey
    );

    // Round 5 remediation: NOT best-effort/swallowed — a failure here must be reported as a
    // failed request. On the idempotent route the client resends the identical request, key
    // included, and replays the already-created loan above rather than duplicating it.
    await backfillMatchesForLoan(userId, loan);
    const refreshed = (await dataService.getManualLoan(loan.id, userId)) ?? loan;

    res.status(201).json({ loan: await enrichLoan(refreshed) });
  } catch (err) {
    if (err instanceof dataService.ManualLoanCreationKeyResolvedError) {
      // Round 12: a definitive outcome for this key (it created a loan that was later deleted), so
      // the client can stop retrying it — see ManualLoanCreationKeyResolvedError.
      res.status(409).json({ error: err.message, code: 'idempotency_key_loan_deleted' });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/manual-loans/idempotent — the ONLY create route the current frontend calls.
 *
 * Requires a client-supplied Idempotency-Key and never falls back to non-idempotent behaviour: a
 * missing, blank, or reserved key is a 400, not a silent downgrade — the frontend's whole
 * duplicate-prevention protocol (Rounds 8–15) depends on its key reaching the database.
 */
export async function createManualLoanIdempotent(req: Request, res: Response, next: NextFunction) {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    res.status(400).json({ error: 'Idempotency-Key header is required' });
    return;
  }
  if (idempotencyKey.startsWith(LEGACY_SERVER_KEY_PREFIX)) {
    res.status(400).json({ error: 'Idempotency-Key uses a reserved prefix' });
    return;
  }
  await createLoanUnderKey(req, res, next, idempotencyKey);
}

/**
 * POST /api/manual-loans — LEGACY route, kept only for frontend bundles that predate the idempotent
 * route (Round 16 remediation). The PWA precaches the app shell, so those bundles can keep running
 * for a long time after a deploy; they send no Idempotency-Key and must keep working.
 *
 * Explicitly NOT retry-idempotent — the same as it always was for those clients: every request
 * gets a fresh server-generated key, so a resubmission creates another loan, exactly as before
 * Phase A. It goes through the same database RPC (ownership, numeric validation, atomicity) so it
 * is no weaker than before, but it deliberately does not pretend two requests are one. Any
 * Idempotency-Key header sent here is ignored: this route never enters the new client's
 * pending-key protocol, and its keys live under LEGACY_SERVER_KEY_PREFIX, which the idempotent
 * route rejects.
 *
 * Remove once no client can still be running a pre-Round-16 bundle (see the rollout plan).
 */
export async function createManualLoanLegacy(req: Request, res: Response, next: NextFunction) {
  await createLoanUnderKey(req, res, next, `${LEGACY_SERVER_KEY_PREFIX}${randomUUID()}`);
}

export async function updateManualLoan(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const body = req.body as ManualLoanBody;

    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.loan_type !== undefined) fields.loan_type = body.loan_type;
    if (body.current_balance !== undefined) fields.current_balance = body.current_balance;
    if (body.origination_principal_amount !== undefined) {
      fields.origination_principal_amount = body.origination_principal_amount;
    }
    if (body.interest_rate_percentage !== undefined) {
      fields.interest_rate_percentage = body.interest_rate_percentage;
    }
    if (body.origination_date !== undefined) fields.origination_date = body.origination_date;
    if (body.term_months !== undefined) fields.term_months = body.term_months;
    if (body.minimum_payment_amount !== undefined) fields.minimum_payment_amount = body.minimum_payment_amount;
    if (body.next_payment_due_date !== undefined) fields.next_payment_due_date = body.next_payment_due_date;
    if (body.notes !== undefined) fields.notes = body.notes;
    if (body.match_text !== undefined) fields.match_text = body.match_text;

    let loan = await dataService.updateManualLoan(id, userId, fields);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    if (body.match_text !== undefined) {
      // Best-effort (wrapped internally) — picks up already-synced payments that predate this
      // match_text value, so response can just await it rather than racing a background call.
      await backfillMatchesForLoan(userId, loan);
      loan = (await dataService.getManualLoan(id, userId)) ?? loan;
    }

    res.json({ loan: await enrichLoan(loan) });
  } catch (err) {
    next(err);
  }
}

export async function deleteManualLoan(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { affectedTransactionIds, alreadyReconciled } = await dataService.deleteManualLoan(id, userId);

    // Round 10 remediation: this used to run ONLY the repair sweep, which looks backwards — it
    // fixes rows that depended on the deleted loan's transactions in their OLD state. It never ran
    // FORWARD reconciliation for the reclassified rows themselves, even though reclassifying a row
    // off a loan is exactly what can make it newly eligible as a transfer counterpart or refund
    // original (`transfer_like_unconfirmed` / a refund-eligible `sign_default`). Both directions
    // are needed, in this order, and this is the same pairing reconcileAfterRelationalStateChange
    // performs for a single-row relational change.
    //
    // This block also runs on a REPLAY (a retry of a deletion that already committed but whose
    // reconciliation then failed) — deliberately, because that is the only way such a failure ever
    // gets retried. Both halves are idempotent, so re-running them for an already-reconciled
    // deletion is safe; it is skipped in that case only to avoid pointless work.
    if (!alreadyReconciled) {
      if (affectedTransactionIds.length > 0) {
        await reconcileRelationalRoles(userId, affectedTransactionIds);
      }
      await repairExistingRelationalRoles(userId);
      // Only now is the deletion genuinely complete. If either call above throws, the tombstone
      // stays unmarked and a retried DELETE replays the same affected ids and tries again.
      await dataService.markManualLoanDeletionReconciled(id, userId);
    }

    res.status(204).send();
  } catch (err) {
    if (err instanceof dataService.ManualLoanNotFoundError) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }
    next(err);
  }
}

/** Merges auto-linked bank transactions and manually-logged payments into one chronological
 *  ledger — a linked transaction's interest is implicit (amount minus principal), a manual
 *  payment's is explicit, but both render the same way once shaped into this common form. */
export async function listPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const loan = await dataService.getManualLoan(req.params.id, req.user!.id);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    const [linked, manual] = await Promise.all([
      dataService.getLinkedPaymentsForLoan(loan.id),
      dataService.listManualLoanPayments(loan.id),
    ]);

    const linkedPayments = linked.map((t) => {
      const principalPortion = t.principal_portion ?? 0;
      return {
        id: t.id,
        source: 'linked' as const,
        date: t.date,
        name: t.name,
        merchant_name: t.merchant_name,
        principal_portion: principalPortion,
        interest_portion: t.amount - principalPortion,
        notes: null,
      };
    });

    const manualPayments = manual.map((p) => ({
      id: p.id,
      source: 'manual' as const,
      date: p.date,
      name: 'Manual payment',
      merchant_name: null,
      principal_portion: p.principal_portion,
      interest_portion: p.interest_portion,
      notes: p.notes,
    }));

    const payments = [...linkedPayments, ...manualPayments].sort((a, b) => b.date.localeCompare(a.date));
    res.json({ payments });
  } catch (err) {
    next(err);
  }
}

export async function updateLinkedPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const loan = await dataService.getManualLoan(req.params.id, userId);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    const { principal_portion: principalPortion } = req.body as { principal_portion?: number };
    if (typeof principalPortion !== 'number') {
      res.status(400).json({ error: 'principal_portion is required' });
      return;
    }

    await dataService.updateLinkedPaymentPrincipal(userId, req.params.transactionId, loan.id, principalPortion);
    const updatedLoan = (await dataService.getManualLoan(loan.id, userId))!;
    res.json({ loan: await enrichLoan(updatedLoan) });
  } catch (err) {
    next(err);
  }
}

export async function unlinkPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const loan = await dataService.getManualLoan(req.params.id, userId);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    await dataService.unlinkPaymentFromLoan(userId, req.params.transactionId, loan.id);
    // The unlinked transaction is no longer a manual_loan_link row — it may now be, or may have
    // previously invalidated, a transfer/refund relationship (Round 3 remediation §2/§3).
    // Bounded, reuses the same fixed windows as ordinary reconciliation — never a global scan.
    await reconcileAfterRelationalStateChange(userId, req.params.transactionId);
    const updatedLoan = (await dataService.getManualLoan(loan.id, userId))!;
    res.json({ loan: await enrichLoan(updatedLoan) });
  } catch (err) {
    next(err);
  }
}

interface ManualPaymentBody {
  date?: string;
  principal_portion?: number;
  interest_portion?: number;
  notes?: string | null;
}

export async function createManualPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const loan = await dataService.getManualLoan(req.params.id, userId);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    const body = req.body as ManualPaymentBody;
    if (!body.date || typeof body.principal_portion !== 'number' || typeof body.interest_portion !== 'number') {
      res.status(400).json({ error: 'date, principal_portion, and interest_portion are required' });
      return;
    }

    await dataService.createManualLoanPayment(userId, loan.id, {
      date: body.date,
      principalPortion: body.principal_portion,
      interestPortion: body.interest_portion,
      notes: body.notes ?? null,
    });

    const updatedLoan = (await dataService.getManualLoan(loan.id, userId))!;
    res.status(201).json({ loan: await enrichLoan(updatedLoan) });
  } catch (err) {
    next(err);
  }
}

export async function updateManualPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const loan = await dataService.getManualLoan(req.params.id, userId);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    const body = req.body as ManualPaymentBody;
    const fields: Record<string, unknown> = {};
    if (body.date !== undefined) fields.date = body.date;
    if (body.principal_portion !== undefined) fields.principal_portion = body.principal_portion;
    if (body.interest_portion !== undefined) fields.interest_portion = body.interest_portion;
    if (body.notes !== undefined) fields.notes = body.notes;

    const payment = await dataService.updateManualLoanPayment(userId, req.params.paymentId, loan.id, fields);
    if (!payment) {
      res.status(404).json({ error: 'Manual payment not found' });
      return;
    }

    const updatedLoan = (await dataService.getManualLoan(loan.id, userId))!;
    res.json({ loan: await enrichLoan(updatedLoan) });
  } catch (err) {
    next(err);
  }
}

export async function deleteManualPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const loan = await dataService.getManualLoan(req.params.id, userId);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    await dataService.deleteManualLoanPayment(userId, req.params.paymentId, loan.id);
    const updatedLoan = (await dataService.getManualLoan(loan.id, userId))!;
    res.json({ loan: await enrichLoan(updatedLoan) });
  } catch (err) {
    next(err);
  }
}

import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';
import { computePayoffProgressPct } from '../services/loans';
import type { ManualLoanRow } from '../types';

// Computed fresh on every response (list, create, update) rather than stored — cheap, and
// avoids the "field only present on the list endpoint" gap that bit the budget-category
// spent/recent_avg_spent fields earlier: every manual-loan response has payoff_progress_pct.
function withPayoffProgress(loan: ManualLoanRow) {
  return {
    ...loan,
    payoff_progress_pct: computePayoffProgressPct(loan.origination_principal_amount, loan.current_balance),
  };
}

export async function listManualLoans(req: Request, res: Response, next: NextFunction) {
  try {
    const loans = await dataService.listManualLoans(req.user!.id);
    res.json({ loans: loans.map(withPayoffProgress) });
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
}

export async function createManualLoan(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as ManualLoanBody;

    if (!body.name || typeof body.current_balance !== 'number') {
      res.status(400).json({ error: 'name and current_balance are required' });
      return;
    }

    const loan = await dataService.createManualLoan(req.user!.id, {
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
    });

    res.status(201).json({ loan: withPayoffProgress(loan) });
  } catch (err) {
    next(err);
  }
}

export async function updateManualLoan(req: Request, res: Response, next: NextFunction) {
  try {
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

    const loan = await dataService.updateManualLoan(id, req.user!.id, fields);
    if (!loan) {
      res.status(404).json({ error: 'Manual loan not found' });
      return;
    }

    res.json({ loan: withPayoffProgress(loan) });
  } catch (err) {
    next(err);
  }
}

export async function deleteManualLoan(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    await dataService.deleteManualLoan(id, req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

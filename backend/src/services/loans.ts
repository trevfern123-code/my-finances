import type { CreditCardLiability, MortgageLiability, StudentLoan } from 'plaid';
import * as plaidService from './plaidService';
import * as dataService from './dataService';

export type LoanType = 'student' | 'mortgage' | 'credit';

export interface NormalizedLoan {
  plaid_account_id: string;
  loan_type: LoanType;
  name: string | null;
  interest_rate_percentage: number | null;
  origination_principal_amount: number | null;
  origination_date: string | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
}

function pickAprPercentage(aprs: { apr_percentage: number; apr_type: string }[]): number | null {
  const purchase = aprs.find((a) => a.apr_type === 'purchase_apr');
  return (purchase ?? aprs[0])?.apr_percentage ?? null;
}

/**
 * Flattens Plaid's three liability categories (credit/mortgage/student) — each with its own
 * field names and shape — into one common row shape our schema and UI can treat uniformly.
 * Note what Plaid's Liabilities product does NOT cover: generic personal loans (e.g. a SoFi
 * personal loan) aren't a first-class liability category, only credit cards, mortgages, and
 * student loans are. A personal loan account still shows up via the regular accounts sync with
 * a balance, just without the interest-rate/payment-schedule detail modeled here.
 */
export function normalizeLiabilities(liabilities: {
  student: StudentLoan[] | null;
  mortgage: MortgageLiability[] | null;
  credit: CreditCardLiability[] | null;
}): NormalizedLoan[] {
  const student: NormalizedLoan[] = (liabilities.student ?? [])
    .filter((l): l is StudentLoan & { account_id: string } => l.account_id !== null)
    .map((l) => ({
      plaid_account_id: l.account_id,
      loan_type: 'student',
      name: l.loan_name,
      interest_rate_percentage: l.interest_rate_percentage,
      origination_principal_amount: l.origination_principal_amount,
      origination_date: l.origination_date,
      minimum_payment_amount: l.minimum_payment_amount,
      next_payment_due_date: l.next_payment_due_date,
      last_payment_amount: l.last_payment_amount,
      last_payment_date: l.last_payment_date,
      is_overdue: l.is_overdue,
    }));

  const mortgage: NormalizedLoan[] = (liabilities.mortgage ?? []).map((l) => ({
    plaid_account_id: l.account_id,
    loan_type: 'mortgage',
    name: l.loan_type_description,
    interest_rate_percentage: l.interest_rate?.percentage ?? null,
    origination_principal_amount: l.origination_principal_amount,
    origination_date: l.origination_date,
    minimum_payment_amount: l.next_monthly_payment,
    next_payment_due_date: l.next_payment_due_date,
    last_payment_amount: l.last_payment_amount,
    last_payment_date: l.last_payment_date,
    is_overdue: null,
  }));

  const credit: NormalizedLoan[] = (liabilities.credit ?? [])
    .filter((l): l is CreditCardLiability & { account_id: string } => l.account_id !== null)
    .map((l) => ({
      plaid_account_id: l.account_id,
      loan_type: 'credit',
      name: null,
      interest_rate_percentage: pickAprPercentage(l.aprs ?? []),
      origination_principal_amount: null,
      origination_date: null,
      minimum_payment_amount: l.minimum_payment_amount,
      next_payment_due_date: l.next_payment_due_date,
      last_payment_amount: l.last_payment_amount,
      last_payment_date: l.last_payment_date,
      is_overdue: l.is_overdue,
    }));

  return [...student, ...mortgage, ...credit];
}

/**
 * Percentage of the original loan paid off so far. Only meaningful when we know the original
 * principal (student loans and mortgages; credit cards are revolving debt with no "original
 * amount" concept, so this is null for those) and a current balance from the linked account.
 */
export function computePayoffProgressPct(
  originalAmount: number | null,
  currentBalance: number | null
): number | null {
  if (originalAmount === null || originalAmount <= 0 || currentBalance === null) return null;
  const paidOff = originalAmount - currentBalance;
  return Math.max(0, Math.min(100, (paidOff / originalAmount) * 100));
}

/**
 * Best-effort by design (wrapped internally, not just by callers) — requires the `liabilities`
 * product to be enabled and called from two places (initial link, balance refresh), so a
 * failure here (product not enabled yet, item has no liability accounts, etc.) logging and
 * moving on rather than failing the link/refresh that triggered it is the right default in
 * both places, not something worth re-implementing at each call site.
 */
export async function refreshLoansForItem(
  itemRowId: string,
  accessToken: string,
  accountIdByPlaidId: Map<string, string>
): Promise<void> {
  try {
    const liabilities = await plaidService.getLiabilities(accessToken);
    const normalized = normalizeLiabilities(liabilities);
    await dataService.upsertLoans(itemRowId, normalized, accountIdByPlaidId);
  } catch (err) {
    console.error(`Failed to refresh loans for item ${itemRowId}:`, err);
  }
}

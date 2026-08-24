import type { CreditCardLiability, MortgageLiability, StudentLoan } from 'plaid';
import * as plaidService from './plaidService';
import * as dataService from './dataService';
import type { InsertedTransaction } from '../types';

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

export interface LoanMatcher {
  id: string;
  match_text: string;
}

/**
 * Picks which manual loan (if any) a transaction's payment should auto-link to, by a
 * case-insensitive substring match of the loan's match_text against the transaction's name or
 * merchant name. Only outflow transactions can be loan payments — Plaid's convention is a
 * positive amount for money leaving the account. First matching loan wins if more than one
 * loan's match_text happens to match the same transaction.
 */
export function matchTransactionToLoan(
  transaction: { name: string; merchant_name: string | null; amount: number },
  loans: LoanMatcher[]
): string | null {
  if (transaction.amount <= 0) return null;
  const haystack = `${transaction.name} ${transaction.merchant_name ?? ''}`.toLowerCase();
  const match = loans.find((l) => l.match_text.trim() !== '' && haystack.includes(l.match_text.toLowerCase()));
  return match?.id ?? null;
}

/**
 * Best-effort by design (wrapped internally, not just by callers) — runs after every
 * transaction sync so newly-synced payments auto-link to the user's manual loans, but a failure
 * here shouldn't fail the sync it's piggybacking on.
 */
export async function linkNewTransactionsToManualLoans(
  userId: string,
  insertedTransactions: InsertedTransaction[]
): Promise<void> {
  if (insertedTransactions.length === 0) return;

  try {
    const loans = await dataService.listManualLoans(userId);
    const matchers = loans
      .filter((l): l is typeof l & { match_text: string } => !!l.match_text)
      .map((l) => ({ id: l.id, match_text: l.match_text }));
    if (matchers.length === 0) return;

    for (const txn of insertedTransactions) {
      const loanId = matchTransactionToLoan(txn, matchers);
      if (loanId) {
        await dataService.linkTransactionToLoan(txn.id, loanId, txn.amount);
      }
    }
  } catch (err) {
    console.error(`Failed to auto-link transactions to manual loans for user ${userId}:`, err);
  }
}

/**
 * Scans a user's not-yet-linked outflow transactions for matches against one loan's match_text
 * — run after creating/updating a manual loan so setting or changing match_text picks up
 * payments that were already synced before the match rule existed, not just future ones.
 */
export async function backfillMatchesForLoan(
  userId: string,
  loan: { id: string; match_text: string | null }
): Promise<void> {
  if (!loan.match_text) return;

  try {
    const candidates = await dataService.getUnlinkedOutflowTransactionsForUser(userId);
    const matcher = { id: loan.id, match_text: loan.match_text };
    for (const txn of candidates) {
      if (matchTransactionToLoan(txn, [matcher])) {
        await dataService.linkTransactionToLoan(txn.id, loan.id, txn.amount);
      }
    }
  } catch (err) {
    console.error(`Failed to backfill matches for manual loan ${loan.id}:`, err);
  }
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

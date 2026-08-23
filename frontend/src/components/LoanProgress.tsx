import type { Loan } from '../lib/api';

const LOAN_TYPE_LABELS: Record<Loan['loan_type'], string> = {
  student: 'Student Loan',
  mortgage: 'Mortgage',
  credit: 'Credit Card',
};

function formatCurrency(amount: number | null, currency: string | null) {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(amount);
}

function formatDate(date: string | null) {
  if (!date) return '—';
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function LoanProgress({
  loans,
  totalDebt,
  totalMinimumPayment,
}: {
  loans: Loan[];
  totalDebt: number;
  totalMinimumPayment: number;
}) {
  if (loans.length === 0) {
    return (
      <div className="card">
        <h2>Loan progress</h2>
        <p className="hint">
          No loans detected yet. This covers credit cards, mortgages, and student loans via
          Plaid's Liabilities product — note that general personal loans (e.g. from an online
          lender) aren't a Plaid liability category and won't show detailed payment/interest
          info here even once linked, only a balance in Accounts.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="section-header">
          <h2>Loan progress</h2>
          <div className="loan-summary-badges">
            <span className="monthly-total-badge over">{formatCurrency(totalDebt, null)} total debt</span>
            <span className="monthly-total-badge">
              {formatCurrency(totalMinimumPayment, null)}/mo min. payments
            </span>
          </div>
        </div>
      </div>

      <div className="loan-cards">
        {loans.map((loan) => (
          <div key={loan.id} className="card loan-card">
            <div className="loan-card-header">
              <div>
                <h3>{loan.name ?? loan.account_name ?? LOAN_TYPE_LABELS[loan.loan_type]}</h3>
                <span className="hint">{LOAN_TYPE_LABELS[loan.loan_type]}</span>
              </div>
              {loan.is_overdue && <span className="pending-badge overdue">overdue</span>}
            </div>

            <div className="loan-stats">
              <div>
                <span className="stat-label">Balance</span>
                <span className="loan-stat-value">
                  {formatCurrency(loan.current_balance, loan.iso_currency_code)}
                </span>
              </div>
              {loan.interest_rate_percentage !== null && (
                <div>
                  <span className="stat-label">Rate</span>
                  <span className="loan-stat-value">{loan.interest_rate_percentage.toFixed(2)}%</span>
                </div>
              )}
              {loan.minimum_payment_amount !== null && (
                <div>
                  <span className="stat-label">Min. payment</span>
                  <span className="loan-stat-value">
                    {formatCurrency(loan.minimum_payment_amount, loan.iso_currency_code)}
                  </span>
                </div>
              )}
              {loan.next_payment_due_date && (
                <div>
                  <span className="stat-label">Next due</span>
                  <span className="loan-stat-value">{formatDate(loan.next_payment_due_date)}</span>
                </div>
              )}
            </div>

            {loan.payoff_progress_pct !== null && (
              <div className="loan-payoff">
                <div className="progress-track">
                  <div className="progress-fill progress-good" style={{ width: `${loan.payoff_progress_pct}%` }} />
                </div>
                <span className="hint">
                  {loan.payoff_progress_pct.toFixed(0)}% paid off
                  {loan.origination_principal_amount !== null &&
                    ` (of ${formatCurrency(loan.origination_principal_amount, loan.iso_currency_code)} original)`}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

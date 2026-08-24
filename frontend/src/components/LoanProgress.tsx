import { useState } from 'react';
import type { LinkedLoanPayment, Loan, ManualLoan, ManualLoanInput } from '../lib/api';

const LOAN_TYPE_LABELS: Record<string, string> = {
  student: 'Student Loan',
  mortgage: 'Mortgage',
  credit: 'Credit Card',
  personal: 'Personal Loan',
  auto: 'Auto Loan',
  other: 'Other Loan',
};

const MANUAL_LOAN_TYPE_OPTIONS: { value: ManualLoanInput['loan_type']; label: string }[] = [
  { value: 'personal', label: 'Personal Loan' },
  { value: 'student', label: 'Student Loan' },
  { value: 'mortgage', label: 'Mortgage' },
  { value: 'auto', label: 'Auto Loan' },
  { value: 'other', label: 'Other' },
];

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

// A shape both Plaid-sourced and manually-entered loans can be rendered from with one card.
interface DisplayLoan {
  id: string;
  title: string;
  typeLabel: string;
  currentBalance: number | null;
  currencyCode: string | null;
  interestRatePercentage: number | null;
  minimumPaymentAmount: number | null;
  nextPaymentDueDate: string | null;
  isOverdue: boolean | null;
  payoffProgressPct: number | null;
  originationPrincipalAmount: number | null;
  termMonths: number | null;
  notes: string | null;
  matchText: string | null;
  editable: boolean;
}

function LinkedPaymentRow({
  payment,
  onUpdate,
  onUnlink,
}: {
  payment: LinkedLoanPayment;
  onUpdate: (principalPortion: number) => void;
  onUnlink: () => void;
}) {
  const [principal, setPrincipal] = useState(String(payment.principal_portion ?? payment.amount));
  const dirty = Number(principal) !== (payment.principal_portion ?? payment.amount);

  return (
    <div className="linked-payment-row">
      <div className="linked-payment-info">
        <span>{payment.name}</span>
        <span className="hint">
          {formatDate(payment.date)} · {formatCurrency(payment.amount, null)} paid
        </span>
      </div>
      <label className="linked-payment-principal">
        Principal
        <input
          type="number"
          step="0.01"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
        />
      </label>
      <div className="linked-payment-actions">
        <button
          type="button"
          className="link-button"
          disabled={!dirty || principal.trim() === ''}
          onClick={() => onUpdate(Number(principal))}
        >
          Save
        </button>
        <button type="button" className="link-button" onClick={onUnlink}>
          Unlink
        </button>
      </div>
    </div>
  );
}

function LinkedPayments({
  loanId,
  payments,
  loading,
  onUpdate,
  onUnlink,
}: {
  loanId: string;
  payments: LinkedLoanPayment[] | undefined;
  loading: boolean;
  onUpdate: (transactionId: string, principalPortion: number) => void;
  onUnlink: (transactionId: string) => void;
}) {
  if (loading) return <p className="hint">Loading linked payments...</p>;
  if (!payments || payments.length === 0) {
    return <p className="hint">No bank transactions linked to this loan yet.</p>;
  }

  return (
    <div className="linked-payments">
      {payments.map((payment) => (
        <LinkedPaymentRow
          key={payment.id}
          payment={payment}
          onUpdate={(principalPortion) => onUpdate(payment.id, principalPortion)}
          onUnlink={() => onUnlink(payment.id)}
        />
      ))}
    </div>
  );
}

function LoanCard({
  loan,
  onEdit,
  onDelete,
  expanded,
  onToggleExpanded,
  payments,
  paymentsLoading,
  onUpdatePayment,
  onUnlinkPayment,
}: {
  loan: DisplayLoan;
  onEdit?: () => void;
  onDelete?: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  payments: LinkedLoanPayment[] | undefined;
  paymentsLoading: boolean;
  onUpdatePayment: (transactionId: string, principalPortion: number) => void;
  onUnlinkPayment: (transactionId: string) => void;
}) {
  return (
    <div className="card loan-card">
      <div className="loan-card-header">
        <div>
          <h3>{loan.title}</h3>
          <span className="hint">{loan.typeLabel}</span>
        </div>
        {loan.isOverdue && <span className="pending-badge overdue">overdue</span>}
      </div>

      <div className="loan-stats">
        <div>
          <span className="stat-label">Balance</span>
          <span className="loan-stat-value">{formatCurrency(loan.currentBalance, loan.currencyCode)}</span>
        </div>
        {loan.interestRatePercentage !== null && (
          <div>
            <span className="stat-label">Rate</span>
            <span className="loan-stat-value">{loan.interestRatePercentage.toFixed(2)}%</span>
          </div>
        )}
        {loan.minimumPaymentAmount !== null && (
          <div>
            <span className="stat-label">Min. payment</span>
            <span className="loan-stat-value">
              {formatCurrency(loan.minimumPaymentAmount, loan.currencyCode)}
            </span>
          </div>
        )}
        {loan.nextPaymentDueDate && (
          <div>
            <span className="stat-label">Next due</span>
            <span className="loan-stat-value">{formatDate(loan.nextPaymentDueDate)}</span>
          </div>
        )}
        {loan.termMonths !== null && (
          <div>
            <span className="stat-label">Term</span>
            <span className="loan-stat-value">{loan.termMonths} months</span>
          </div>
        )}
      </div>

      {loan.payoffProgressPct !== null && (
        <div className="loan-payoff">
          <div className="progress-track">
            <div className="progress-fill progress-good" style={{ width: `${loan.payoffProgressPct}%` }} />
          </div>
          <span className="hint">
            {loan.payoffProgressPct.toFixed(0)}% paid off
            {loan.originationPrincipalAmount !== null &&
              ` (of ${formatCurrency(loan.originationPrincipalAmount, loan.currencyCode)} original)`}
          </span>
        </div>
      )}

      {loan.notes && <p className="hint loan-notes">{loan.notes}</p>}

      {loan.editable && (
        <>
          <div className="loan-card-actions">
            <button className="link-button" onClick={onEdit}>
              Edit
            </button>
            <button className="link-button" onClick={onDelete}>
              Delete
            </button>
            <button className="link-button" onClick={onToggleExpanded}>
              {expanded ? 'Hide linked payments' : 'Linked payments'}
            </button>
          </div>
          {expanded && (
            <LinkedPayments
              loanId={loan.id}
              payments={payments}
              loading={paymentsLoading}
              onUpdate={onUpdatePayment}
              onUnlink={onUnlinkPayment}
            />
          )}
        </>
      )}
    </div>
  );
}

function plaidToDisplay(loan: Loan): DisplayLoan {
  return {
    id: loan.id,
    title: loan.name ?? loan.account_name ?? LOAN_TYPE_LABELS[loan.loan_type],
    typeLabel: LOAN_TYPE_LABELS[loan.loan_type] ?? loan.loan_type,
    currentBalance: loan.current_balance,
    currencyCode: loan.iso_currency_code,
    interestRatePercentage: loan.interest_rate_percentage,
    minimumPaymentAmount: loan.minimum_payment_amount,
    nextPaymentDueDate: loan.next_payment_due_date,
    isOverdue: loan.is_overdue,
    payoffProgressPct: loan.payoff_progress_pct,
    originationPrincipalAmount: loan.origination_principal_amount,
    termMonths: null,
    notes: null,
    matchText: null,
    editable: false,
  };
}

function manualToDisplay(loan: ManualLoan): DisplayLoan {
  return {
    id: loan.id,
    title: loan.name,
    typeLabel: LOAN_TYPE_LABELS[loan.loan_type] ?? loan.loan_type,
    currentBalance: loan.current_balance,
    currencyCode: 'USD',
    interestRatePercentage: loan.interest_rate_percentage,
    minimumPaymentAmount: loan.minimum_payment_amount,
    nextPaymentDueDate: loan.next_payment_due_date,
    isOverdue: null,
    payoffProgressPct: loan.payoff_progress_pct,
    originationPrincipalAmount: loan.origination_principal_amount,
    termMonths: loan.term_months,
    notes: loan.notes,
    matchText: loan.match_text,
    editable: true,
  };
}

const EMPTY_FORM: ManualLoanInput = {
  name: '',
  loan_type: 'personal',
  current_balance: 0,
  origination_principal_amount: null,
  interest_rate_percentage: null,
  origination_date: null,
  term_months: null,
  minimum_payment_amount: null,
  next_payment_due_date: null,
  notes: null,
  match_text: null,
};

function toNullableNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function ManualLoanForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: ManualLoanInput;
  onCancel: () => void;
  onSubmit: (input: ManualLoanInput) => void;
}) {
  const [form, setForm] = useState(initial);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || form.current_balance === null) return;
    onSubmit(form);
  }

  return (
    <form className="card manual-loan-form" onSubmit={handleSubmit}>
      <h3>{initial.name ? 'Edit loan' : 'Add a personal loan'}</h3>
      <div className="manual-loan-form-grid">
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. SoFi Personal Loan"
            required
          />
        </label>
        <label>
          Type
          <select
            value={form.loan_type}
            onChange={(e) => setForm({ ...form, loan_type: e.target.value })}
          >
            {MANUAL_LOAN_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Current balance
          <input
            type="number"
            step="0.01"
            value={form.current_balance}
            onChange={(e) => setForm({ ...form, current_balance: Number(e.target.value) })}
            required
          />
        </label>
        <label>
          Interest rate (%)
          <input
            type="number"
            step="0.01"
            value={form.interest_rate_percentage ?? ''}
            onChange={(e) =>
              setForm({ ...form, interest_rate_percentage: toNullableNumber(e.target.value) })
            }
          />
        </label>
        <label>
          Original loan amount
          <input
            type="number"
            step="0.01"
            value={form.origination_principal_amount ?? ''}
            onChange={(e) =>
              setForm({ ...form, origination_principal_amount: toNullableNumber(e.target.value) })
            }
          />
        </label>
        <label>
          Term (months)
          <input
            type="number"
            value={form.term_months ?? ''}
            onChange={(e) => setForm({ ...form, term_months: toNullableNumber(e.target.value) })}
          />
        </label>
        <label>
          Minimum payment
          <input
            type="number"
            step="0.01"
            value={form.minimum_payment_amount ?? ''}
            onChange={(e) =>
              setForm({ ...form, minimum_payment_amount: toNullableNumber(e.target.value) })
            }
          />
        </label>
        <label>
          Next payment due
          <input
            type="date"
            value={form.next_payment_due_date ?? ''}
            onChange={(e) => setForm({ ...form, next_payment_due_date: e.target.value || null })}
          />
        </label>
        <label>
          Loan start date
          <input
            type="date"
            value={form.origination_date ?? ''}
            onChange={(e) => setForm({ ...form, origination_date: e.target.value || null })}
          />
        </label>
        <label className="manual-loan-form-notes">
          Notes
          <input
            value={form.notes ?? ''}
            onChange={(e) => setForm({ ...form, notes: e.target.value || null })}
            placeholder="Optional"
          />
        </label>
        <label className="manual-loan-form-notes">
          Auto-link bank transactions containing
          <input
            value={form.match_text ?? ''}
            onChange={(e) => setForm({ ...form, match_text: e.target.value || null })}
            placeholder="e.g. SoFi"
          />
          <span className="hint">
            Matching outflow transactions from your linked accounts will auto-link here and
            reduce the balance by the transaction amount — edit the linked payment afterward if a
            payment includes interest.
          </span>
        </label>
      </div>
      <div className="manual-loan-form-actions">
        <button type="submit">Save loan</button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function LoanProgress({
  loans,
  manualLoans,
  totalDebt,
  totalMinimumPayment,
  onCreateManualLoan,
  onUpdateManualLoan,
  onDeleteManualLoan,
  onFetchLinkedPayments,
  onUpdateLinkedPayment,
  onUnlinkPayment,
}: {
  loans: Loan[];
  manualLoans: ManualLoan[];
  totalDebt: number;
  totalMinimumPayment: number;
  onCreateManualLoan: (input: ManualLoanInput) => void;
  onUpdateManualLoan: (id: string, input: ManualLoanInput) => Promise<void>;
  onDeleteManualLoan: (id: string) => void;
  onFetchLinkedPayments: (loanId: string) => Promise<LinkedLoanPayment[]>;
  onUpdateLinkedPayment: (loanId: string, transactionId: string, principalPortion: number) => Promise<void>;
  onUnlinkPayment: (loanId: string, transactionId: string) => Promise<void>;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingLoanId, setEditingLoanId] = useState<string | null>(null);
  const [expandedLoanId, setExpandedLoanId] = useState<string | null>(null);
  const [paymentsByLoanId, setPaymentsByLoanId] = useState<Record<string, LinkedLoanPayment[]>>({});
  const [paymentsLoadingId, setPaymentsLoadingId] = useState<string | null>(null);

  const combinedTotalDebt = totalDebt + manualLoans.reduce((sum, l) => sum + l.current_balance, 0);
  const combinedTotalMinPayment =
    totalMinimumPayment + manualLoans.reduce((sum, l) => sum + (l.minimum_payment_amount ?? 0), 0);

  const displayLoans: DisplayLoan[] = [
    ...loans.map(plaidToDisplay),
    ...manualLoans.map(manualToDisplay),
  ];

  const editingLoan = manualLoans.find((l) => l.id === editingLoanId) ?? null;

  function handleCreate(input: ManualLoanInput) {
    onCreateManualLoan(input);
    setShowAddForm(false);
  }

  async function handleUpdate(input: ManualLoanInput) {
    const loanId = editingLoanId;
    setEditingLoanId(null);
    if (!loanId) return;

    await onUpdateManualLoan(loanId, input);
    // A match_text change can auto-link/unlink payments server-side (backfill runs as part of
    // the PATCH itself), so any cached linked-payments list for this loan is now stale — drop
    // it and reload if it's currently on screen.
    setPaymentsByLoanId((prev) => {
      const { [loanId]: _dropped, ...rest } = prev;
      return rest;
    });
    if (expandedLoanId === loanId) loadPayments(loanId);
  }

  async function loadPayments(loanId: string) {
    setPaymentsLoadingId(loanId);
    try {
      const payments = await onFetchLinkedPayments(loanId);
      setPaymentsByLoanId((prev) => ({ ...prev, [loanId]: payments }));
    } catch {
      // ignore — the section just stays empty/stale, no dedicated error UI for this yet
    } finally {
      setPaymentsLoadingId(null);
    }
  }

  function handleToggleExpanded(loanId: string) {
    if (expandedLoanId === loanId) {
      setExpandedLoanId(null);
      return;
    }
    setExpandedLoanId(loanId);
    if (!paymentsByLoanId[loanId]) loadPayments(loanId);
  }

  async function handleUpdatePayment(loanId: string, transactionId: string, principalPortion: number) {
    try {
      await onUpdateLinkedPayment(loanId, transactionId, principalPortion);
      await loadPayments(loanId);
    } catch {
      // error already surfaced via the app-level action error banner
    }
  }

  async function handleUnlinkPayment(loanId: string, transactionId: string) {
    try {
      await onUnlinkPayment(loanId, transactionId);
      await loadPayments(loanId);
    } catch {
      // error already surfaced via the app-level action error banner
    }
  }

  return (
    <div>
      <div className="card">
        <div className="section-header">
          <h2>Loan progress</h2>
          <div className="loan-summary-badges">
            <span className="monthly-total-badge over">
              {formatCurrency(combinedTotalDebt, null)} total debt
            </span>
            <span className="monthly-total-badge">
              {formatCurrency(combinedTotalMinPayment, null)}/mo min. payments
            </span>
            <button onClick={() => setShowAddForm(true)}>Add a loan</button>
          </div>
        </div>
        {displayLoans.length === 0 && !showAddForm && (
          <p className="hint">
            No loans yet. Credit cards, mortgages, and student loans sync automatically via
            Plaid's Liabilities product once linked. General personal loans (e.g. from an online
            lender) aren't a Plaid liability category — add those by hand with "Add a loan".
          </p>
        )}
      </div>

      {showAddForm && (
        <ManualLoanForm initial={EMPTY_FORM} onCancel={() => setShowAddForm(false)} onSubmit={handleCreate} />
      )}

      {editingLoan && (
        <ManualLoanForm
          initial={{
            name: editingLoan.name,
            loan_type: editingLoan.loan_type,
            current_balance: editingLoan.current_balance,
            origination_principal_amount: editingLoan.origination_principal_amount,
            interest_rate_percentage: editingLoan.interest_rate_percentage,
            origination_date: editingLoan.origination_date,
            term_months: editingLoan.term_months,
            minimum_payment_amount: editingLoan.minimum_payment_amount,
            next_payment_due_date: editingLoan.next_payment_due_date,
            notes: editingLoan.notes,
            match_text: editingLoan.match_text,
          }}
          onCancel={() => setEditingLoanId(null)}
          onSubmit={handleUpdate}
        />
      )}

      {displayLoans.length > 0 && (
        <div className="loan-cards">
          {displayLoans.map((loan) => (
            <LoanCard
              key={loan.id}
              loan={loan}
              onEdit={() => setEditingLoanId(loan.id)}
              onDelete={() => onDeleteManualLoan(loan.id)}
              expanded={expandedLoanId === loan.id}
              onToggleExpanded={() => handleToggleExpanded(loan.id)}
              payments={paymentsByLoanId[loan.id]}
              paymentsLoading={paymentsLoadingId === loan.id}
              onUpdatePayment={(transactionId, principalPortion) =>
                handleUpdatePayment(loan.id, transactionId, principalPortion)
              }
              onUnlinkPayment={(transactionId) => handleUnlinkPayment(loan.id, transactionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

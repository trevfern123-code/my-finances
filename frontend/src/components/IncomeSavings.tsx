import { useState } from 'react';
import { useUpdateGuard } from '../hooks/useAppUpdate';
import type { AssetAccountSummary, AssetGroup, RecurringStream } from '../lib/api';
import { accountDisplayName } from '../lib/accountDisplay';
import { formatCurrency } from '../lib/currency';
import { savingsRateTier } from '../lib/financialPreferences';
import type { SummaryView } from '../lib/semanticModel';
import {
  formatAmountRange,
  formatRate,
  formatRateRange,
  formatSigned,
  nonPositiveIncomeNote,
  unresolvedCardPaymentsNote,
} from '../lib/semanticPresentation';
import { SemanticNotice } from './SemanticNotice';

const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Biweekly',
  SEMI_MONTHLY: 'Twice a month',
  MONTHLY: 'Monthly',
  ANNUALLY: 'Annually',
  UNKNOWN: 'Irregular',
};

/**
 * Savings rate of the current calendar month (design §5 C4). The rate, the cash flow and the amounts
 * named in the copy are the server's: (cash flow + known loan principal) / income. Nothing is
 * recomputed here, and when a card payment is not matched yet the rate is the server's range.
 */
function SavingsRateCard({
  semantics,
  targetPercent,
  onRetry,
}: {
  semantics: SummaryView;
  /** User's savings-rate goal (Settings → Financial preferences), a percentage like 15, not a
   *  fraction. Changes the target/comparison shown here — never the rate itself. */
  targetPercent: number;
  onRetry?: () => void;
}) {
  if (semantics.kind !== 'ok') {
    return (
      <div className="card">
        <div className="section-header">
          <h2>Savings rate</h2>
          <span className="monthly-total-badge">— this month</span>
        </div>
        <SemanticNotice state={semantics} onRetry={onRetry} />
      </div>
    );
  }

  const figures = semantics.currentMonth;
  const rate = figures.savings_rate;
  // While the rate is a range, the bar and its colour follow the lower bound; the text gives both.
  const shownRate = rate ?? figures.savings_rate_range.low;
  const tier = savingsRateTier(shownRate, targetPercent);
  const pct = Math.max(0, Math.min(shownRate, 1)) * 100;

  return (
    <div className="card">
      <div className="section-header">
        <h2>Savings rate</h2>
        <span className={tier === 'good' ? 'monthly-total-badge income' : `monthly-total-badge ${tier}`}>
          {rate !== null ? formatRate(rate) : formatRateRange(figures.savings_rate_range)} this month
        </span>
      </div>
      {/* Zero and negative income are figures, not an absence: say the figure and why the rate is 0%. */}
      {figures.income_semantic <= 0 && <p className="hint">{nonPositiveIncomeNote(figures.income_semantic)}</p>}
      <div className="progress-track">
        <div className={`progress-fill progress-${tier}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="hint budget-pace-hint">
        {figures.cash_flow !== null ? (
          <>
            {formatSigned(figures.cash_flow)} cash flow of {formatSigned(figures.income_semantic)} income this month
            {tier === 'over' && ' — more went out than came in'}
          </>
        ) : (
          <>
            {formatAmountRange(figures.cash_flow_range)} cash flow of {formatSigned(figures.income_semantic)} income this month ·{' '}
            {unresolvedCardPaymentsNote(figures.card_payments_unresolved.count)}
          </>
        )}
      </p>
      <p className="hint">
        Cash kept after debt service
        {figures.known_principal !== 0 && `, plus ${formatSigned(figures.known_principal)} of loan principal paid down`}.
      </p>
      {figures.debt_payments_unknown_principal !== 0 && (
        <p className="hint">
          {formatSigned(figures.debt_payments_unknown_principal)} of loan payments with an unknown principal share counted as outflow.
        </p>
      )}
      {figures.transfers_external < 0 && (
        <p className="hint">{formatCurrency(-figures.transfers_external, null)} transferred to accounts not tracked (not counted as saving).</p>
      )}
      <p className="hint">Goal: {targetPercent}% of income saved</p>
    </div>
  );
}

function IncomeBreakdown({ recurringStreams }: { recurringStreams: RecurringStream[] }) {
  const inflows = recurringStreams.filter((s) => s.direction === 'inflow');
  const maxMonthly = Math.max(...inflows.map((s) => s.monthly_amount), 1);

  return (
    <div className="card">
      <h2>Income sources</h2>
      {inflows.length === 0 ? (
        <p className="hint">
          No recurring income detected yet — this is picked up automatically as transaction
          history builds up (usually needs a few months of history per source).
        </p>
      ) : (
        <div className="recurring-list">
          {inflows.map((s) => (
            <div key={s.id} className="sub-row">
              <div className="sub-info">
                <span className="sub-name">{s.merchant_name ?? s.description}</span>
                <span className="sub-frequency">{FREQUENCY_LABELS[s.frequency] ?? s.frequency}</span>
              </div>
              <div className="sub-bar-track">
                <div
                  className="sub-bar-fill income"
                  style={{ width: `${(s.monthly_amount / maxMonthly) * 100}%` }}
                />
              </div>
              <span className="sub-amount">{formatCurrency(s.monthly_amount, 'USD')}/mo</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SavingsGoalRow({
  account,
  onUpdateSavingsGoal,
}: {
  account: AssetAccountSummary;
  onUpdateSavingsGoal: (accountId: string, savingsGoal: number | null) => void;
}) {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  // A value typed but not yet committed (on blur) holds off an automatic app-update reload.
  useUpdateGuard('unsaved_edit', editing !== undefined);
  const balance = account.current_balance ?? 0;
  const goal = account.savings_goal;
  const hasGoal = goal !== null && goal > 0;
  const pct = hasGoal ? Math.min((balance / goal) * 100, 100) : 0;
  const reached = hasGoal && balance >= goal;

  return (
    <li className="account-list-item">
      <div className="account-row">
        <span>
          {account.icon && <span className="account-icon">{account.icon}</span>}
          {accountDisplayName(account)}
          {account.institution_name && <span className="account-type"> — {account.institution_name}</span>}
          {account.exclude_from_net_worth && (
            <span className="account-flag-indicator"> · Excluded from net worth</span>
          )}
        </span>
        <span className="balance">{formatCurrency(account.current_balance, account.iso_currency_code)}</span>
      </div>
      <div className="savings-goal">
        <div className="savings-goal-header">
          <span className="hint">Goal</span>
          <input
            type="number"
            step="0.01"
            className="budget-amount-input"
            value={editing ?? goal ?? ''}
            placeholder="Not set"
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => {
              if (editing === undefined) return;
              const value = editing.trim() === '' ? null : Number(editing);
              if (value === null || !Number.isNaN(value)) onUpdateSavingsGoal(account.id, value);
              setEditing(undefined);
            }}
          />
        </div>
        {hasGoal && (
          <>
            <div className="progress-track">
              <div
                className={reached ? 'progress-fill progress-good' : 'progress-fill progress-warn'}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="hint">
              {pct.toFixed(0)}% of {formatCurrency(goal, account.iso_currency_code)}
              {reached && ' — goal reached'}
            </span>
          </>
        )}
      </div>
    </li>
  );
}

export function IncomeSavings({
  groups,
  totalAssets,
  recurringStreams,
  semantics,
  savingsRateTarget,
  onUpdateSavingsGoal,
  onRetry,
}: {
  groups: AssetGroup[];
  totalAssets: number;
  recurringStreams: RecurringStream[];
  /** The summary's role-aware figures; the Savings rate card shows the current calendar month. */
  semantics: SummaryView;
  /** Percentage (e.g. 15), from Settings → Financial preferences. Distinct from a per-account
   *  dollar savings_goal below — this is a single overall rate target, not a balance target. */
  savingsRateTarget: number;
  onUpdateSavingsGoal: (accountId: string, savingsGoal: number | null) => void;
  onRetry?: () => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="card">
        <h2>Income &amp; savings</h2>
        <p className="hint">
          No asset accounts linked yet. Investment/401k accounts also require Plaid's
          Investments product to be enabled and a fresh link (or re-link) for the item — see the
          README for details.
        </p>
      </div>
    );
  }

  return (
    <div className="tab-panel">
      <div className="card">
        <div className="section-header">
          <h2>Income &amp; savings</h2>
          <span className="monthly-total-badge">{formatCurrency(totalAssets, 'USD')} total assets</span>
        </div>
      </div>

      <SavingsRateCard semantics={semantics} targetPercent={savingsRateTarget} onRetry={onRetry} />
      <IncomeBreakdown recurringStreams={recurringStreams} />

      <div className="asset-groups">
        {groups.map((group) => (
          <div key={group.category} className="card">
            <div className="section-header">
              <h3>{group.label}</h3>
              <span className="hint">{formatCurrency(group.total, 'USD')}</span>
            </div>
            {group.category === 'savings' ? (
              <ul className="quick-view-list">
                {group.accounts
                  .filter((account) => !account.hidden)
                  .map((account) => (
                    <SavingsGoalRow key={account.id} account={account} onUpdateSavingsGoal={onUpdateSavingsGoal} />
                  ))}
              </ul>
            ) : (
              <ul className="asset-account-list">
                {group.accounts.filter((account) => !account.hidden).map((account) => (
                  <li key={account.id} className="account-row">
                    <span>
                      {account.icon && <span className="account-icon">{account.icon}</span>}
                      {accountDisplayName(account)}
                      {account.institution_name && (
                        <span className="account-type"> — {account.institution_name}</span>
                      )}
                      {account.exclude_from_net_worth && (
                        <span className="account-flag-indicator"> · Excluded from net worth</span>
                      )}
                    </span>
                    <span className="balance">
                      {formatCurrency(account.current_balance, account.iso_currency_code)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

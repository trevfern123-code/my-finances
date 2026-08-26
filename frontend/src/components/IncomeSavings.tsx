import { useState } from 'react';
import type { AssetAccountSummary, AssetGroup, RecurringStream } from '../lib/api';
import { accountDisplayName } from '../lib/accountDisplay';
import { formatCurrency } from '../lib/currency';
import { savingsRateTier } from '../lib/financialPreferences';

const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Biweekly',
  SEMI_MONTHLY: 'Twice a month',
  MONTHLY: 'Monthly',
  ANNUALLY: 'Annually',
  UNKNOWN: 'Irregular',
};

function SavingsRateCard({
  income,
  spent,
  targetPercent,
}: {
  income: number;
  spent: number;
  /** User's savings-rate goal (Settings → Financial preferences), a percentage like 15, not a
   *  fraction. Changes the target/comparison shown here — never the calculated rate itself. */
  targetPercent: number;
}) {
  const rate = income > 0 ? (income - spent) / income : null;
  const tier = rate !== null ? savingsRateTier(rate, targetPercent) : 'good';
  const pct = rate !== null ? Math.max(0, Math.min(rate, 1)) * 100 : 0;

  return (
    <div className="card">
      <div className="section-header">
        <h2>Savings rate</h2>
        <span className={tier === 'good' ? 'monthly-total-badge income' : `monthly-total-badge ${tier}`}>
          {rate !== null ? `${(rate * 100).toFixed(0)}%` : '—'} this month
        </span>
      </div>
      {rate === null ? (
        <p className="hint">No income recorded yet this month.</p>
      ) : (
        <>
          <div className="progress-track">
            <div className={`progress-fill progress-${tier}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="hint budget-pace-hint">
            {formatCurrency(income - spent, null)} saved of {formatCurrency(income, null)} income this month
            {tier === 'over' && ' — spending exceeded income'}
          </p>
          <p className="hint">Goal: {targetPercent}% of income saved</p>
        </>
      )}
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
  currentMonthIncome,
  currentMonthSpent,
  savingsRateTarget,
  onUpdateSavingsGoal,
}: {
  groups: AssetGroup[];
  totalAssets: number;
  recurringStreams: RecurringStream[];
  currentMonthIncome: number;
  currentMonthSpent: number;
  /** Percentage (e.g. 15), from Settings → Financial preferences. Distinct from a per-account
   *  dollar savings_goal below — this is a single overall rate target, not a balance target. */
  savingsRateTarget: number;
  onUpdateSavingsGoal: (accountId: string, savingsGoal: number | null) => void;
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

      <SavingsRateCard income={currentMonthIncome} spent={currentMonthSpent} targetPercent={savingsRateTarget} />
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

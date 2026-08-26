import { useState } from 'react';
import {
  RECENT_AVG_MONTHS_MAX,
  RECENT_AVG_MONTHS_MIN,
  SAVINGS_RATE_TARGET_MAX,
  SAVINGS_RATE_TARGET_MIN,
  UPCOMING_BILLS_DAYS_MAX,
  UPCOMING_BILLS_DAYS_MIN,
} from '../lib/financialPreferences';

function PreferenceRow({
  label,
  description,
  value,
  unit,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  description: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: string;
  onCommit: (value: number) => void;
}) {
  // Local text state so the user can freely clear/retype the field mid-edit without every
  // keystroke round-tripping through the clamp + persist path — only committed on blur, same
  // pattern as the savings-goal input in IncomeSavings.
  const [editing, setEditing] = useState<string | undefined>(undefined);

  return (
    <div className="appearance-section financial-prefs-row">
      <div className="financial-prefs-row-header">
        <span className="hint">{label}</span>
        <div className="financial-prefs-input-group">
          <input
            type="number"
            step={step ?? '1'}
            min={min}
            max={max}
            className="budget-amount-input"
            value={editing ?? value}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => {
              if (editing === undefined) return;
              const parsed = Number(editing);
              if (editing.trim() !== '' && !Number.isNaN(parsed)) onCommit(parsed);
              setEditing(undefined);
            }}
          />
          <span className="financial-prefs-unit">{unit}</span>
        </div>
      </div>
      <p className="financial-prefs-desc">{description}</p>
    </div>
  );
}

export function FinancialPreferencesSettings({
  minimumCashBuffer,
  upcomingBillsDays,
  recentAvgMonths,
  savingsRateTarget,
  onSetMinimumCashBuffer,
  onSetUpcomingBillsDays,
  onSetRecentAvgMonths,
  onSetSavingsRateTarget,
}: {
  minimumCashBuffer: number;
  upcomingBillsDays: number;
  recentAvgMonths: number;
  savingsRateTarget: number;
  onSetMinimumCashBuffer: (value: number) => void;
  onSetUpcomingBillsDays: (value: number) => void;
  onSetRecentAvgMonths: (value: number) => void;
  onSetSavingsRateTarget: (value: number) => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <h2>Financial Preferences</h2>
      </div>
      <p className="financial-prefs-intro">These settings affect how Safe to Spend, Upcoming Bills, budget averages, and your savings-rate goal are calculated.</p>

      <PreferenceRow
        label="Minimum cash buffer"
        description="Held back from Safe to Spend as a cushion — doesn't change any account balance or budget."
        value={minimumCashBuffer}
        unit="$"
        min={0}
        max={1_000_000}
        step="0.01"
        onCommit={onSetMinimumCashBuffer}
      />
      <PreferenceRow
        label="Upcoming-bills look-ahead"
        description="How many days ahead to look for due bills, on the Upcoming Bills card and in Safe to Spend."
        value={upcomingBillsDays}
        unit="days"
        min={UPCOMING_BILLS_DAYS_MIN}
        max={UPCOMING_BILLS_DAYS_MAX}
        onCommit={onSetUpcomingBillsDays}
      />
      <PreferenceRow
        label="Recent-average window"
        description={'Number of past months averaged for each budget category’s "recent avg" comparison.'}
        value={recentAvgMonths}
        unit="months"
        min={RECENT_AVG_MONTHS_MIN}
        max={RECENT_AVG_MONTHS_MAX}
        onCommit={onSetRecentAvgMonths}
      />
      <PreferenceRow
        label="Savings-rate target"
        description="Your goal percentage of income saved — compared against your calculated savings rate. Separate from individual savings-account goals."
        value={savingsRateTarget}
        unit="%"
        min={SAVINGS_RATE_TARGET_MIN}
        max={SAVINGS_RATE_TARGET_MAX}
        step="0.1"
        onCommit={onSetSavingsRateTarget}
      />
    </div>
  );
}

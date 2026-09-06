import type { SaveStatus } from '../hooks/useSaveStatus';
import { SaveStatusIndicator } from './SaveStatusIndicator';
import { ToggleRow } from './SettingsToggleRow';

/** Split out of FinancialPreferencesSettings into its own Settings section — same underlying
 *  `user_preferences` columns and the same `useFinancialPreferences` hook/persist call as
 *  Financial Preferences (this is a navigational split only, not a new preference or a new
 *  endpoint), but given its own place in the Settings sidebar since Safe to Spend was explicitly
 *  called out as a differentiating feature in its own right when it was originally built, not
 *  "just another settings toggle." */
export function SafeToSpendSettings({
  includeUpcomingBills,
  includeRemainingBudget,
  onSetIncludeUpcomingBills,
  onSetIncludeRemainingBudget,
  saveStatus,
  onRetry,
}: {
  includeUpcomingBills: boolean;
  includeRemainingBudget: boolean;
  onSetIncludeUpcomingBills: (value: boolean) => void;
  onSetIncludeRemainingBudget: (value: boolean) => void;
  saveStatus: SaveStatus;
  onRetry: () => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <h2>Safe to Spend</h2>
        <SaveStatusIndicator status={saveStatus} onRetry={onRetry} />
      </div>
      <p className="financial-prefs-intro">
        Choose what counts toward your Safe to Spend figure on the Overview tab.
      </p>

      <ToggleRow
        label="Include upcoming bills"
        description="When off, upcoming bills and credit card minimum payments are excluded from Safe to Spend (shown as $0, not hidden)."
        checked={includeUpcomingBills}
        onToggle={onSetIncludeUpcomingBills}
      />
      <ToggleRow
        label="Include remaining budget"
        description="When off, unspent budget headroom is excluded from Safe to Spend (shown as $0, not hidden)."
        checked={includeRemainingBudget}
        onToggle={onSetIncludeRemainingBudget}
      />
    </div>
  );
}

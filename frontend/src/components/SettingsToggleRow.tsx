/** A single labeled checkbox + description, styled to match the numeric PreferenceRow layout used
 *  throughout the Settings sections — shared by FinancialPreferencesSettings and
 *  SafeToSpendSettings (split out of what was originally one component). */
export function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <div className="appearance-section financial-prefs-row">
      <label className="financial-prefs-toggle-header">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        <span className="hint">{label}</span>
      </label>
      <p className="financial-prefs-desc">{description}</p>
    </div>
  );
}

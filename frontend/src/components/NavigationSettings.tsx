import type { SaveStatus } from '../hooks/useNavLayout';
import type { NavTabEntry } from '../lib/navLayout';
import { FIXED_FIRST_TAB, FIXED_LAST_TAB, getTabLabel, type CustomizableTabId } from '../lib/tabRegistry';
import { SaveStatusIndicator } from './SaveStatusIndicator';

/** Reuses DashboardCustomizer's exact row markup/classes (.dashboard-customizer-row/-label,
 *  .budget-category-reorder, .reorder-btn) — this list is functionally a sibling of that one, just
 *  for tabs instead of dashboard cards, so no new CSS is needed. Overview and Settings render as
 *  plain fixed rows (no reorder controls, no Hide button) rather than disabled controls that could
 *  never do anything — see tabRegistry.ts for why they're structurally absent from `layout`
 *  entirely rather than merely disabled here. */
export function NavigationSettings({
  layout,
  onToggleVisibility,
  onMove,
  onReset,
  saveStatus,
  onRetry,
}: {
  layout: NavTabEntry[];
  onToggleVisibility: (id: CustomizableTabId) => void;
  onMove: (id: CustomizableTabId, direction: 'up' | 'down') => void;
  onReset: () => void;
  saveStatus: SaveStatus;
  onRetry: () => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <h2>Navigation</h2>
        <SaveStatusIndicator status={saveStatus} onRetry={onRetry} />
      </div>
      <p className="financial-prefs-intro">
        Choose which sections appear in My Finances and what order they appear in. Hiding a tab
        does not remove any financial data.
      </p>

      <div className="dashboard-customizer-list">
        <div className="dashboard-customizer-row">
          <span className="dashboard-customizer-label">{FIXED_FIRST_TAB.label}</span>
          <span className="hint">Always shown</span>
        </div>

        {layout.map((tab, index) => (
          <div
            key={tab.id}
            className={tab.visible ? 'dashboard-customizer-row' : 'dashboard-customizer-row hidden'}
          >
            <div className="budget-category-reorder">
              <button
                type="button"
                className="reorder-btn"
                disabled={index === 0}
                onClick={() => onMove(tab.id, 'up')}
                aria-label={`Move ${getTabLabel(tab.id)} up`}
              >
                ▲
              </button>
              <button
                type="button"
                className="reorder-btn"
                disabled={index === layout.length - 1}
                onClick={() => onMove(tab.id, 'down')}
                aria-label={`Move ${getTabLabel(tab.id)} down`}
              >
                ▼
              </button>
            </div>
            <span className="dashboard-customizer-label">{getTabLabel(tab.id)}</span>
            <button type="button" className="link-button" onClick={() => onToggleVisibility(tab.id)}>
              {tab.visible ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}

        <div className="dashboard-customizer-row">
          <span className="dashboard-customizer-label">{FIXED_LAST_TAB.label}</span>
          <span className="hint">Always shown</span>
        </div>
      </div>

      <button type="button" className="link-button" onClick={onReset}>
        Reset to default
      </button>
    </div>
  );
}

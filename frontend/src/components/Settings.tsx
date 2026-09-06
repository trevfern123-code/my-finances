import { useState } from 'react';
import type { BudgetCategory, CategoryMapping } from '../lib/api';
import type { useAppearance } from '../hooks/useAppearance';
import type { useFinancialPreferences } from '../hooks/useFinancialPreferences';
import { AppearanceSettings } from './AppearanceSettings';
import { FinancialPreferencesSettings } from './FinancialPreferencesSettings';
import { SafeToSpendSettings } from './SafeToSpendSettings';
import { CategoryMappings } from './CategoryMappings';

// Every section Settings could ever show, including ones not built yet — a stable, append-only
// id registry (§ "Navigation preference architecture" reasoning applies here too, ahead of
// Phase 2 actually needing it for nav_layout). `available: false` is how a section gets a
// permanent home in this list before its content exists, without ever being rendered or
// selectable until it does — Phase 2 (Navigation) and Phase 3 (Dashboard, Connections) will each
// flip one entry to `available: true` and add its content, not restructure this list.
type SettingsSectionId = 'appearance' | 'financial' | 'safe_to_spend' | 'categories' | 'dashboard' | 'navigation' | 'connections';

interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  available: boolean;
}

const ALL_SECTIONS: SettingsSectionMeta[] = [
  { id: 'appearance', label: 'Appearance', available: true },
  { id: 'dashboard', label: 'Dashboard', available: false },
  { id: 'navigation', label: 'Navigation', available: false },
  { id: 'financial', label: 'Financial Preferences', available: true },
  { id: 'safe_to_spend', label: 'Safe to Spend', available: true },
  { id: 'categories', label: 'Categories', available: true },
  { id: 'connections', label: 'Connections', available: false },
];

const AVAILABLE_SECTIONS = ALL_SECTIONS.filter((s) => s.available);

export function Settings({
  appearance,
  financialPreferences,
  categoryMappings,
}: {
  appearance: ReturnType<typeof useAppearance>;
  financialPreferences: ReturnType<typeof useFinancialPreferences>;
  categoryMappings: {
    plaidCategories: string[];
    mappings: CategoryMapping[];
    budgetCategories: BudgetCategory[];
    onSave: (plaidCategory: string, budgetCategoryId: string, backfill: boolean) => Promise<number>;
    onDelete: (mappingId: string) => void;
  };
}) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance');
  // Mobile-only drill-down state: which pane the (narrow-viewport) view currently shows. Has no
  // effect at desktop widths, where CSS keeps both panes visible side by side regardless of this
  // value — see the `.settings-shell` rules in App.css.
  const [mobileView, setMobileView] = useState<'list' | 'section'>('list');

  function selectSection(id: SettingsSectionId) {
    setActiveSection(id);
    setMobileView('section');
  }

  return (
    <div className={`settings-shell settings-mobile-${mobileView}`}>
      <nav className="settings-sidebar" aria-label="Settings sections">
        {AVAILABLE_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={section.id === activeSection ? 'settings-sidebar-item active' : 'settings-sidebar-item'}
            aria-current={section.id === activeSection}
            onClick={() => selectSection(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        <button type="button" className="link-button settings-back-link" onClick={() => setMobileView('list')}>
          ← Settings
        </button>

        {activeSection === 'appearance' && (
          <AppearanceSettings
            theme={appearance.theme}
            accent={appearance.accent}
            onSetTheme={appearance.setTheme}
            onSetAccent={appearance.setAccent}
            saveStatus={appearance.saveStatus}
            onRetry={appearance.retry}
          />
        )}

        {activeSection === 'financial' && (
          <FinancialPreferencesSettings
            minimumCashBuffer={financialPreferences.minimumCashBuffer}
            upcomingBillsDays={financialPreferences.upcomingBillsDays}
            recentAvgMonths={financialPreferences.recentAvgMonths}
            savingsRateTarget={financialPreferences.savingsRateTarget}
            onSetMinimumCashBuffer={financialPreferences.setMinimumCashBuffer}
            onSetUpcomingBillsDays={financialPreferences.setUpcomingBillsDays}
            onSetRecentAvgMonths={financialPreferences.setRecentAvgMonths}
            onSetSavingsRateTarget={financialPreferences.setSavingsRateTarget}
            saveStatus={financialPreferences.saveStatus}
            onRetry={financialPreferences.retry}
          />
        )}

        {activeSection === 'safe_to_spend' && (
          <SafeToSpendSettings
            includeUpcomingBills={financialPreferences.includeUpcomingBills}
            includeRemainingBudget={financialPreferences.includeRemainingBudget}
            onSetIncludeUpcomingBills={financialPreferences.setIncludeUpcomingBills}
            onSetIncludeRemainingBudget={financialPreferences.setIncludeRemainingBudget}
            saveStatus={financialPreferences.saveStatus}
            onRetry={financialPreferences.retry}
          />
        )}

        {activeSection === 'categories' && (
          <CategoryMappings
            plaidCategories={categoryMappings.plaidCategories}
            mappings={categoryMappings.mappings}
            budgetCategories={categoryMappings.budgetCategories}
            onSave={categoryMappings.onSave}
            onDelete={categoryMappings.onDelete}
          />
        )}
      </div>
    </div>
  );
}

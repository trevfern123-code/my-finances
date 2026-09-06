import { useState } from 'react';
import type { BudgetCategory, CategoryMapping } from '../lib/api';
import type { useAppearance } from '../hooks/useAppearance';
import type { useFinancialPreferences } from '../hooks/useFinancialPreferences';
import type { useNavLayout } from '../hooks/useNavLayout';
import {
  getAvailableSections,
  goBackToList,
  INITIAL_SETTINGS_VIEW_STATE,
  selectSection,
  type SettingsSectionId,
} from '../lib/settingsSections';
import { AppearanceSettings } from './AppearanceSettings';
import { FinancialPreferencesSettings } from './FinancialPreferencesSettings';
import { SafeToSpendSettings } from './SafeToSpendSettings';
import { NavigationSettings } from './NavigationSettings';
import { CategoryMappings } from './CategoryMappings';

const AVAILABLE_SECTIONS = getAvailableSections();

export function Settings({
  appearance,
  financialPreferences,
  navLayout,
  categoryMappings,
}: {
  appearance: ReturnType<typeof useAppearance>;
  financialPreferences: ReturnType<typeof useFinancialPreferences>;
  navLayout: ReturnType<typeof useNavLayout>;
  categoryMappings: {
    plaidCategories: string[];
    mappings: CategoryMapping[];
    budgetCategories: BudgetCategory[];
    onSave: (plaidCategory: string, budgetCategoryId: string, backfill: boolean) => Promise<number>;
    onDelete: (mappingId: string) => void;
  };
}) {
  // The mobile drill-down state lives alongside activeSection (lib/settingsSections.ts owns the
  // transition logic — see selectSection/goBackToList and their tests) — has no effect at desktop
  // widths, where CSS keeps both panes visible side by side regardless of this value.
  const [viewState, setViewState] = useState(INITIAL_SETTINGS_VIEW_STATE);
  const { activeSection, mobileView } = viewState;

  return (
    <div className={`settings-shell settings-mobile-${mobileView}`}>
      <nav className="settings-sidebar" aria-label="Settings sections">
        {AVAILABLE_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={section.id === activeSection ? 'settings-sidebar-item active' : 'settings-sidebar-item'}
            aria-current={section.id === activeSection}
            onClick={() => setViewState((prev) => selectSection(prev, section.id as SettingsSectionId))}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        <button
          type="button"
          className="link-button settings-back-link"
          onClick={() => setViewState((prev) => goBackToList(prev))}
        >
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

        {activeSection === 'navigation' && (
          <NavigationSettings
            layout={navLayout.layout}
            onToggleVisibility={navLayout.toggleVisibility}
            onMove={navLayout.move}
            onReset={navLayout.resetToDefault}
            saveStatus={navLayout.status}
            onRetry={navLayout.retry}
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

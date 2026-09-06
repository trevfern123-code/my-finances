// Every section Settings could ever show, including ones not built yet — a stable, append-only
// id registry. `available: false` is how a section gets a permanent home in this list before its
// content exists, without ever being rendered or selectable until it does — Phase 2 (Navigation)
// has shipped; Phase 3 (Dashboard, Connections) will flip its remaining entries to
// `available: true` and add their content, not restructure this list.
export type SettingsSectionId =
  | 'appearance'
  | 'financial'
  | 'safe_to_spend'
  | 'categories'
  | 'dashboard'
  | 'navigation'
  | 'connections';

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  available: boolean;
}

export const ALL_SECTIONS: SettingsSectionMeta[] = [
  { id: 'appearance', label: 'Appearance', available: true },
  { id: 'dashboard', label: 'Dashboard', available: false },
  { id: 'navigation', label: 'Navigation', available: true },
  { id: 'financial', label: 'Financial Preferences', available: true },
  { id: 'safe_to_spend', label: 'Safe to Spend', available: true },
  { id: 'categories', label: 'Categories', available: true },
  { id: 'connections', label: 'Connections', available: false },
];

export function getAvailableSections(): SettingsSectionMeta[] {
  return ALL_SECTIONS.filter((s) => s.available);
}

export function isSectionAvailable(id: SettingsSectionId): boolean {
  return ALL_SECTIONS.some((s) => s.id === id && s.available);
}

// Appearance is the safe default: it's always available, has no dependency on any other data
// having loaded, and is the least consequential section to land on first.
export const DEFAULT_SECTION_ID: SettingsSectionId = 'appearance';

export type SettingsMobileView = 'list' | 'section';

export interface SettingsViewState {
  activeSection: SettingsSectionId;
  mobileView: SettingsMobileView;
}

export const INITIAL_SETTINGS_VIEW_STATE: SettingsViewState = {
  activeSection: DEFAULT_SECTION_ID,
  mobileView: 'list',
};

/** Picking a section always shows its content — at desktop widths this is the only thing that
 *  changes; at the mobile drill-down breakpoint, CSS additionally uses `mobileView` to hide the
 *  sidebar and show the content pane instead (see .settings-mobile-* in App.css). */
export function selectSection(state: SettingsViewState, id: SettingsSectionId): SettingsViewState {
  return { activeSection: id, mobileView: 'section' };
}

/** Returns to the section list — only meaningful at the mobile breakpoint; harmless (and
 *  invisible) at desktop widths, where the sidebar is always shown regardless of mobileView. */
export function goBackToList(state: SettingsViewState): SettingsViewState {
  return { ...state, mobileView: 'list' };
}

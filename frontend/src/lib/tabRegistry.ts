// The single source of truth for every main-navigation tab's id and label — App.tsx's TabNav,
// lib/webTabNav.ts, lib/navLayout.ts, and NavigationSettings.tsx all read from this one list
// instead of each hardcoding their own copy of ids/labels that could silently drift apart.
//
// `role` is a structural fact about the tab, not a statement about any one platform's UI: it only
// answers "is this tab a permanent, guaranteed destination (never hidden, never stored in
// nav_layout) or something the user can show/hide/reorder." It deliberately says nothing about
// *where* a structural tab appears — see lib/webTabNav.ts for the current web/PWA's own decision
// to put Overview first and Settings last in its primary tab bar. A future native client (e.g. a
// permanent profile icon opening an Account Hub containing Settings & Customization) would reach
// 'settings' through a completely different presentation without this file, or the 'structural'
// role itself, needing to change at all.
export type TabId = 'overview' | 'monthly' | 'budget' | 'recurring' | 'loans' | 'income' | 'accounts' | 'settings';

// Reserved ids for tabs that don't exist yet — documented here so a future tab never collides with
// or reuses one of today's ids, but deliberately NOT added to TAB_REGISTRY below: an entry in this
// registry is expected to have real content to render, so a not-yet-built tab is added the day it
// ships (as a 'customizable' entry), not pre-registered like Settings' unbuilt sections are.
// Reserved: 'bills_utilities', 'reports_insights'

export type TabRole = 'structural' | 'customizable';

export interface TabMeta {
  id: TabId;
  label: string;
  role: TabRole;
}

export const TAB_REGISTRY: TabMeta[] = [
  { id: 'overview', label: 'Overview', role: 'structural' },
  { id: 'monthly', label: 'Monthly Breakdown', role: 'customizable' },
  { id: 'budget', label: 'Budget', role: 'customizable' },
  { id: 'recurring', label: 'Subscriptions & Recurring', role: 'customizable' },
  { id: 'loans', label: 'Loans', role: 'customizable' },
  { id: 'income', label: 'Income & Savings', role: 'customizable' },
  { id: 'accounts', label: 'Accounts', role: 'customizable' },
  { id: 'settings', label: 'Settings', role: 'structural' },
];

export type CustomizableTabId = Exclude<TabId, 'overview' | 'settings'>;

export const CUSTOMIZABLE_TAB_IDS = TAB_REGISTRY.filter(
  (t): t is TabMeta & { id: CustomizableTabId } => t.role === 'customizable'
).map((t) => t.id);

export const FIXED_FIRST_TAB: TabMeta = TAB_REGISTRY.find((t) => t.id === 'overview')!;
export const FIXED_LAST_TAB: TabMeta = TAB_REGISTRY.find((t) => t.id === 'settings')!;

export function getTabLabel(id: TabId): string {
  return TAB_REGISTRY.find((t) => t.id === id)!.label;
}

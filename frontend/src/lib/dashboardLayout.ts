import type { DashboardCardEntry } from './api';

export type CardId =
  | 'stats'
  | 'safe_to_spend'
  | 'cash_flow_pace'
  | 'accounts_quick_view'
  | 'upcoming_bills'
  | 'recent_activity'
  | 'monthly_spending_chart'
  | 'net_worth_chart';

export interface DashboardCard {
  id: CardId;
  visible: boolean;
}

export const CARD_LABELS: Record<CardId, string> = {
  stats: 'Net worth & spending stats',
  safe_to_spend: 'Safe to spend',
  cash_flow_pace: 'Cash flow & budget pace',
  accounts_quick_view: 'Accounts at a glance',
  upcoming_bills: 'Upcoming bills',
  recent_activity: 'Recent activity',
  monthly_spending_chart: 'Monthly spending chart',
  net_worth_chart: 'Net worth over time',
};

// Canonical order — today's Overview order. Also what a user with no saved layout sees, and
// where a not-yet-seen card (added after a user last saved their layout) gets appended.
const CANONICAL_ORDER: CardId[] = [
  'stats',
  'safe_to_spend',
  'cash_flow_pace',
  'accounts_quick_view',
  'upcoming_bills',
  'recent_activity',
  'monthly_spending_chart',
  'net_worth_chart',
];

export const DEFAULT_DASHBOARD_LAYOUT: DashboardCard[] = CANONICAL_ORDER.map((id) => ({ id, visible: true }));

/** Merges a saved layout against the full known-card set: a card the user has never seen (added
 *  after they last saved) is appended at the end, visible by default, rather than silently
 *  disappearing forever; a saved id that's no longer a real card (a removed feature) is dropped.
 *  No saved layout at all (new user, or one who's never customized) resolves to the same default
 *  layout as today's fixed Overview order — customizing changes nothing until you touch it. */
export function mergeDashboardLayout(saved: DashboardCardEntry[] | null | undefined): DashboardCard[] {
  if (!saved || saved.length === 0) return DEFAULT_DASHBOARD_LAYOUT;

  const isCardId = (id: string): id is CardId => (CANONICAL_ORDER as string[]).includes(id);
  const seen = new Set<CardId>();

  const merged: DashboardCard[] = [];
  for (const entry of saved) {
    if (!isCardId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push({ id: entry.id, visible: entry.visible });
  }
  for (const id of CANONICAL_ORDER) {
    if (!seen.has(id)) merged.push({ id, visible: true });
  }
  return merged;
}

export function toggleCardVisibility(layout: DashboardCard[], cardId: CardId): DashboardCard[] {
  return layout.map((c) => (c.id === cardId ? { ...c, visible: !c.visible } : c));
}

export function moveCard(layout: DashboardCard[], cardId: CardId, direction: 'up' | 'down'): DashboardCard[] {
  const index = layout.findIndex((c) => c.id === cardId);
  if (index === -1) return layout;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= layout.length) return layout;
  const reordered = [...layout];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return reordered;
}

export type PresetId = 'standard' | 'budget_focus' | 'net_worth_focus' | 'minimal';

export const PRESET_LABELS: Record<PresetId, string> = {
  standard: 'Standard',
  budget_focus: 'Budget Focus',
  net_worth_focus: 'Net Worth Focus',
  minimal: 'Minimal',
};

/** Builds a preset from its visible cards (in the order they should appear) — every other known
 *  card is appended after, hidden, in canonical order, so re-enabling one later lands it
 *  somewhere sensible rather than at a random position. */
function buildPreset(visibleInOrder: CardId[]): DashboardCard[] {
  const visibleSet = new Set(visibleInOrder);
  const hidden = CANONICAL_ORDER.filter((id) => !visibleSet.has(id));
  return [...visibleInOrder, ...hidden].map((id) => ({ id, visible: visibleSet.has(id) }));
}

/** Presets are editable starting templates, not fixed modes — applying one just sets the current
 *  layout to this snapshot; nothing here is persisted as "which preset is active," and the user
 *  can freely show/hide/reorder afterward same as any other layout. */
export const PRESETS: Record<PresetId, DashboardCard[]> = {
  standard: DEFAULT_DASHBOARD_LAYOUT,
  budget_focus: buildPreset(['cash_flow_pace', 'safe_to_spend', 'recent_activity', 'upcoming_bills']),
  net_worth_focus: buildPreset(['stats', 'net_worth_chart', 'accounts_quick_view', 'monthly_spending_chart']),
  minimal: buildPreset(['stats', 'safe_to_spend']),
};

// Cards rendered side by side as long as both are visible and directly adjacent in the current
// order — purely a rendering detail (preserves today's two fixed two-column rows), not part of
// the persisted layout itself.
const PAIRED_CARDS: [CardId, CardId][] = [
  ['accounts_quick_view', 'upcoming_bills'],
  ['recent_activity', 'monthly_spending_chart'],
];

/** Groups an ordered list of visible card ids into rendered rows: a pair renders together only
 *  when both its members are visible and adjacent in the current order; everything else renders
 *  full width, including a pair split apart by hiding one member or reordering. */
export function groupCardsIntoRows(visibleIds: CardId[]): CardId[][] {
  const rows: CardId[][] = [];
  let i = 0;
  while (i < visibleIds.length) {
    const current = visibleIds[i];
    const next = visibleIds[i + 1];
    const isPair =
      next !== undefined &&
      PAIRED_CARDS.some(([a, b]) => (current === a && next === b) || (current === b && next === a));
    if (isPair) {
      rows.push([current, next]);
      i += 2;
    } else {
      rows.push([current]);
      i += 1;
    }
  }
  return rows;
}

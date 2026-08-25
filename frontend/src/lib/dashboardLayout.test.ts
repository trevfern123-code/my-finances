import { describe, expect, it } from 'vitest';
import type { DashboardCardEntry } from './api';
import {
  DEFAULT_DASHBOARD_LAYOUT,
  PRESETS,
  groupCardsIntoRows,
  mergeDashboardLayout,
  moveCard,
  toggleCardVisibility,
  type CardId,
} from './dashboardLayout';

describe('mergeDashboardLayout', () => {
  it('returns the default layout when there is no saved layout at all', () => {
    expect(mergeDashboardLayout(null)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(mergeDashboardLayout(undefined)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(mergeDashboardLayout([])).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it('preserves a saved order and visibility for known cards', () => {
    const saved: DashboardCardEntry[] = [
      { id: 'net_worth_chart', visible: true },
      { id: 'stats', visible: false },
    ];
    const merged = mergeDashboardLayout(saved);
    expect(merged[0]).toEqual({ id: 'net_worth_chart', visible: true });
    expect(merged[1]).toEqual({ id: 'stats', visible: false });
  });

  it('appends a card missing from the saved layout at the end, visible by default', () => {
    // Simulates a saved layout from before "net_worth_chart" existed.
    const saved: DashboardCardEntry[] = DEFAULT_DASHBOARD_LAYOUT.filter((c) => c.id !== 'net_worth_chart');
    const merged = mergeDashboardLayout(saved);
    expect(merged).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.length);
    expect(merged[merged.length - 1]).toEqual({ id: 'net_worth_chart', visible: true });
  });

  it('drops a saved id that is no longer a known card', () => {
    const saved: DashboardCardEntry[] = [
      { id: 'stats', visible: true },
      { id: 'some_removed_card', visible: true },
    ];
    const merged = mergeDashboardLayout(saved);
    expect(merged.some((c) => (c.id as string) === 'some_removed_card')).toBe(false);
  });

  it('drops a duplicate entry for the same card id, keeping the first', () => {
    const saved: DashboardCardEntry[] = [
      { id: 'stats', visible: false },
      { id: 'stats', visible: true },
    ];
    const merged = mergeDashboardLayout(saved);
    expect(merged.filter((c) => c.id === 'stats')).toEqual([{ id: 'stats', visible: false }]);
  });

  it('includes every known card exactly once, regardless of what was saved', () => {
    const merged = mergeDashboardLayout([{ id: 'stats', visible: true }]);
    const ids = merged.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.length);
  });
});

describe('toggleCardVisibility', () => {
  it('flips only the targeted card', () => {
    const result = toggleCardVisibility(DEFAULT_DASHBOARD_LAYOUT, 'safe_to_spend');
    expect(result.find((c) => c.id === 'safe_to_spend')?.visible).toBe(false);
    expect(result.find((c) => c.id === 'stats')?.visible).toBe(true);
  });
});

describe('moveCard', () => {
  it('swaps a card with the one above it', () => {
    const result = moveCard(DEFAULT_DASHBOARD_LAYOUT, 'safe_to_spend', 'up');
    expect(result.map((c) => c.id).slice(0, 2)).toEqual(['safe_to_spend', 'stats']);
  });

  it('swaps a card with the one below it', () => {
    const result = moveCard(DEFAULT_DASHBOARD_LAYOUT, 'stats', 'down');
    expect(result.map((c) => c.id).slice(0, 2)).toEqual(['safe_to_spend', 'stats']);
  });

  it('does nothing when moving the first card up', () => {
    const result = moveCard(DEFAULT_DASHBOARD_LAYOUT, 'stats', 'up');
    expect(result).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it('does nothing when moving the last card down', () => {
    const lastId = DEFAULT_DASHBOARD_LAYOUT[DEFAULT_DASHBOARD_LAYOUT.length - 1].id;
    const result = moveCard(DEFAULT_DASHBOARD_LAYOUT, lastId, 'down');
    expect(result).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it('returns the layout unchanged for an unknown card id', () => {
    const result = moveCard(DEFAULT_DASHBOARD_LAYOUT, 'not_a_real_card' as CardId, 'up');
    expect(result).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });
});

describe('PRESETS', () => {
  it('every preset includes every known card exactly once', () => {
    for (const layout of Object.values(PRESETS)) {
      const ids = layout.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.length);
    }
  });

  it('standard preset matches the default layout', () => {
    expect(PRESETS.standard).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it('minimal preset shows only stats and safe_to_spend', () => {
    const visible = PRESETS.minimal.filter((c) => c.visible).map((c) => c.id);
    expect(visible).toEqual(['stats', 'safe_to_spend']);
  });

  it('budget_focus preset hides the net worth chart', () => {
    expect(PRESETS.budget_focus.find((c) => c.id === 'net_worth_chart')?.visible).toBe(false);
  });
});

describe('groupCardsIntoRows', () => {
  it('groups the two known adjacent pairs into two-card rows', () => {
    const rows = groupCardsIntoRows(['accounts_quick_view', 'upcoming_bills', 'recent_activity', 'monthly_spending_chart']);
    expect(rows).toEqual([
      ['accounts_quick_view', 'upcoming_bills'],
      ['recent_activity', 'monthly_spending_chart'],
    ]);
  });

  it('renders a lone member of a pair full width when its partner is hidden', () => {
    const rows = groupCardsIntoRows(['accounts_quick_view', 'recent_activity']);
    expect(rows).toEqual([['accounts_quick_view'], ['recent_activity']]);
  });

  it('does not pair two cards that are not adjacent, even if both are visible', () => {
    const rows = groupCardsIntoRows(['accounts_quick_view', 'stats', 'upcoming_bills']);
    expect(rows).toEqual([['accounts_quick_view'], ['stats'], ['upcoming_bills']]);
  });

  it('pairs regardless of which member comes first', () => {
    const rows = groupCardsIntoRows(['upcoming_bills', 'accounts_quick_view']);
    expect(rows).toEqual([['upcoming_bills', 'accounts_quick_view']]);
  });

  it('reproduces the full default layout as today\'s exact two grid rows plus singles', () => {
    const rows = groupCardsIntoRows(DEFAULT_DASHBOARD_LAYOUT.map((c) => c.id));
    expect(rows).toEqual([
      ['stats'],
      ['safe_to_spend'],
      ['cash_flow_pace'],
      ['accounts_quick_view', 'upcoming_bills'],
      ['recent_activity', 'monthly_spending_chart'],
      ['net_worth_chart'],
    ]);
  });
});

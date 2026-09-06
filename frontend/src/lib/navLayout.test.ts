import { describe, expect, it } from 'vitest';
import { DEFAULT_NAV_LAYOUT, getVisibleOrderedTabIds, mergeNavLayout, moveTab, toggleTabVisibility } from './navLayout';
import { CUSTOMIZABLE_TAB_IDS } from './tabRegistry';

describe('DEFAULT_NAV_LAYOUT', () => {
  it('contains exactly the customizable tabs, all visible, in canonical order', () => {
    expect(DEFAULT_NAV_LAYOUT).toEqual(CUSTOMIZABLE_TAB_IDS.map((id) => ({ id, visible: true })));
  });
});

describe('mergeNavLayout — defaults and malformed input', () => {
  it('resolves undefined/null/empty to the default layout', () => {
    expect(mergeNavLayout(undefined)).toEqual(DEFAULT_NAV_LAYOUT);
    expect(mergeNavLayout(null)).toEqual(DEFAULT_NAV_LAYOUT);
    expect(mergeNavLayout([])).toEqual(DEFAULT_NAV_LAYOUT);
  });

  it('resolves a non-array value to the default layout rather than throwing', () => {
    // Malformed JSON shape — e.g. a hand-edited row, or a future format change gone wrong.
    expect(mergeNavLayout({ not: 'an array' } as never)).toEqual(DEFAULT_NAV_LAYOUT);
    expect(mergeNavLayout('garbage' as never)).toEqual(DEFAULT_NAV_LAYOUT);
  });

  it('drops unknown tab ids', () => {
    const result = mergeNavLayout([{ id: 'not_a_real_tab', visible: true }, { id: 'loans', visible: false }]);
    expect(result.find((t) => t.id === ('not_a_real_tab' as never))).toBeUndefined();
    expect(result.find((t) => t.id === 'loans')).toEqual({ id: 'loans', visible: false });
  });

  it('keeps the first occurrence of a duplicate id and drops the rest', () => {
    const result = mergeNavLayout([
      { id: 'loans', visible: false },
      { id: 'loans', visible: true },
    ]);
    expect(result.filter((t) => t.id === 'loans')).toEqual([{ id: 'loans', visible: false }]);
  });

  it('appends every tab missing from saved data, visible, in canonical order, after what was saved', () => {
    const result = mergeNavLayout([{ id: 'accounts', visible: false }]);
    // the one saved entry is preserved (including its visibility) and kept first
    expect(result[0]).toEqual({ id: 'accounts', visible: false });
    // every other customizable tab — never seen in the saved data — is appended, visible, in
    // canonical order
    expect(result.slice(1)).toEqual([
      { id: 'monthly', visible: true },
      { id: 'budget', visible: true },
      { id: 'recurring', visible: true },
      { id: 'loans', visible: true },
      { id: 'income', visible: true },
    ]);
  });

  it('strips structural ids defensively, even though the app itself never writes them', () => {
    const result = mergeNavLayout([
      { id: 'overview', visible: false } as never,
      { id: 'settings', visible: false } as never,
      { id: 'loans', visible: true },
    ]);
    expect(result.find((t) => t.id === ('overview' as never))).toBeUndefined();
    expect(result.find((t) => t.id === ('settings' as never))).toBeUndefined();
  });

  it('fails open: a non-boolean or missing visible is treated as visible, never as hidden', () => {
    const result = mergeNavLayout([
      { id: 'loans', visible: 'yes' as never },
      { id: 'budget' } as never,
    ]);
    expect(result.find((t) => t.id === 'loans')).toEqual({ id: 'loans', visible: true });
    expect(result.find((t) => t.id === 'budget')).toEqual({ id: 'budget', visible: true });
  });

  it('only an explicit false hides a tab', () => {
    const result = mergeNavLayout([{ id: 'loans', visible: false }]);
    expect(result.find((t) => t.id === 'loans')).toEqual({ id: 'loans', visible: false });
  });
});

describe('toggleTabVisibility', () => {
  it('flips only the targeted tab', () => {
    const result = toggleTabVisibility(DEFAULT_NAV_LAYOUT, 'loans');
    expect(result.find((t) => t.id === 'loans')!.visible).toBe(false);
    expect(result.find((t) => t.id === 'budget')!.visible).toBe(true);
  });
});

describe('moveTab', () => {
  it('swaps with the previous entry when moving up', () => {
    const result = moveTab(DEFAULT_NAV_LAYOUT, 'budget', 'up');
    expect(result.map((t) => t.id)).toEqual(['budget', 'monthly', 'recurring', 'loans', 'income', 'accounts']);
  });

  it('swaps with the next entry when moving down', () => {
    const result = moveTab(DEFAULT_NAV_LAYOUT, 'monthly', 'down');
    expect(result.map((t) => t.id)).toEqual(['budget', 'monthly', 'recurring', 'loans', 'income', 'accounts']);
  });

  it('is a no-op at the top boundary', () => {
    expect(moveTab(DEFAULT_NAV_LAYOUT, 'monthly', 'up')).toEqual(DEFAULT_NAV_LAYOUT);
  });

  it('is a no-op at the bottom boundary', () => {
    expect(moveTab(DEFAULT_NAV_LAYOUT, 'accounts', 'down')).toEqual(DEFAULT_NAV_LAYOUT);
  });

  it('is a no-op for an id not present in the layout', () => {
    const partial = [{ id: 'loans' as const, visible: true }];
    expect(moveTab(partial, 'budget', 'up')).toEqual(partial);
  });
});

describe('getVisibleOrderedTabIds', () => {
  it('filters to visible tabs only, preserving order', () => {
    const layout = toggleTabVisibility(DEFAULT_NAV_LAYOUT, 'recurring');
    expect(getVisibleOrderedTabIds(layout)).toEqual(['monthly', 'budget', 'loans', 'income', 'accounts']);
  });

  it('reflects reordering', () => {
    const layout = moveTab(DEFAULT_NAV_LAYOUT, 'accounts', 'up');
    expect(getVisibleOrderedTabIds(layout)).toEqual(['monthly', 'budget', 'recurring', 'loans', 'accounts', 'income']);
  });
});

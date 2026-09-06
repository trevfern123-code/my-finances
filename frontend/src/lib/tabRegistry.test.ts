import { describe, expect, it } from 'vitest';
import { CUSTOMIZABLE_TAB_IDS, FIXED_FIRST_TAB, FIXED_LAST_TAB, getTabLabel, TAB_REGISTRY } from './tabRegistry';

describe('TAB_REGISTRY', () => {
  it('has no duplicate ids', () => {
    const ids = TAB_REGISTRY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has a non-empty label and a valid role', () => {
    for (const tab of TAB_REGISTRY) {
      expect(tab.label.length).toBeGreaterThan(0);
      expect(['structural', 'customizable']).toContain(tab.role);
    }
  });
});

describe('CUSTOMIZABLE_TAB_IDS', () => {
  it('excludes overview and settings', () => {
    expect(CUSTOMIZABLE_TAB_IDS).not.toContain('overview');
    expect(CUSTOMIZABLE_TAB_IDS).not.toContain('settings');
  });

  it('contains exactly today\'s six customizable tabs, in canonical order', () => {
    expect(CUSTOMIZABLE_TAB_IDS).toEqual(['monthly', 'budget', 'recurring', 'loans', 'income', 'accounts']);
  });
});

describe('FIXED_FIRST_TAB / FIXED_LAST_TAB', () => {
  it('Overview is the fixed-first structural tab', () => {
    expect(FIXED_FIRST_TAB.id).toBe('overview');
    expect(FIXED_FIRST_TAB.role).toBe('structural');
  });

  it('Settings is the fixed-last structural tab', () => {
    expect(FIXED_LAST_TAB.id).toBe('settings');
    expect(FIXED_LAST_TAB.role).toBe('structural');
  });
});

describe('getTabLabel', () => {
  it('resolves every registered id, including the structural ones', () => {
    for (const tab of TAB_REGISTRY) {
      expect(getTabLabel(tab.id)).toBe(tab.label);
    }
  });
});

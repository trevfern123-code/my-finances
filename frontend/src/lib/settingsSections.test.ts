import { describe, expect, it } from 'vitest';
import {
  ALL_SECTIONS,
  DEFAULT_SECTION_ID,
  getAvailableSections,
  goBackToList,
  INITIAL_SETTINGS_VIEW_STATE,
  isSectionAvailable,
  selectSection,
} from './settingsSections';

describe('getAvailableSections', () => {
  it('only returns sections marked available — Phase 2/3 placeholders are excluded', () => {
    const available = getAvailableSections();
    const ids = available.map((s) => s.id);
    expect(ids).toEqual(['appearance', 'financial', 'safe_to_spend', 'categories']);
  });

  it('excludes every registered-but-unbuilt section by name, explicitly', () => {
    const ids = getAvailableSections().map((s) => s.id);
    expect(ids).not.toContain('dashboard');
    expect(ids).not.toContain('navigation');
    expect(ids).not.toContain('connections');
  });

  it('every section in the full registry is accounted for as either available or not', () => {
    // Guards against a future section being added to ALL_SECTIONS without an explicit `available`
    // decision ever being made for it.
    for (const section of ALL_SECTIONS) {
      expect(typeof section.available).toBe('boolean');
    }
  });
});

describe('isSectionAvailable', () => {
  it('is true for each currently-available section', () => {
    expect(isSectionAvailable('appearance')).toBe(true);
    expect(isSectionAvailable('financial')).toBe(true);
    expect(isSectionAvailable('safe_to_spend')).toBe(true);
    expect(isSectionAvailable('categories')).toBe(true);
  });

  it('is false for each Phase 2/3 placeholder', () => {
    expect(isSectionAvailable('dashboard')).toBe(false);
    expect(isSectionAvailable('navigation')).toBe(false);
    expect(isSectionAvailable('connections')).toBe(false);
  });
});

describe('default section', () => {
  it('Appearance is the default/safe section', () => {
    expect(DEFAULT_SECTION_ID).toBe('appearance');
    expect(INITIAL_SETTINGS_VIEW_STATE.activeSection).toBe('appearance');
  });

  it('the default section is itself always available', () => {
    expect(isSectionAvailable(DEFAULT_SECTION_ID)).toBe(true);
  });

  it('the initial view state starts on the section list, not drilled into a section', () => {
    expect(INITIAL_SETTINGS_VIEW_STATE.mobileView).toBe('list');
  });
});

describe('selectSection / goBackToList — mobile drill-down state transitions', () => {
  it('selecting a section switches the active section and drills into it', () => {
    const next = selectSection(INITIAL_SETTINGS_VIEW_STATE, 'categories');
    expect(next).toEqual({ activeSection: 'categories', mobileView: 'section' });
  });

  it('selecting the section already active still results in the "section" mobile view', () => {
    // Re-selecting the current section (e.g. tapping it again on mobile) must still land in the
    // drilled-in view, not silently no-op and leave a user stuck on the list.
    const state = { activeSection: 'appearance' as const, mobileView: 'list' as const };
    const next = selectSection(state, 'appearance');
    expect(next.mobileView).toBe('section');
  });

  it('going back to the list preserves which section is active', () => {
    const drilledIn = selectSection(INITIAL_SETTINGS_VIEW_STATE, 'financial');
    const backOut = goBackToList(drilledIn);
    expect(backOut).toEqual({ activeSection: 'financial', mobileView: 'list' });
  });

  it('a select-then-back-then-select-different sequence ends in the right state', () => {
    let state = INITIAL_SETTINGS_VIEW_STATE;
    state = selectSection(state, 'safe_to_spend');
    state = goBackToList(state);
    state = selectSection(state, 'categories');
    expect(state).toEqual({ activeSection: 'categories', mobileView: 'section' });
  });
});

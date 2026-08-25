import { describe, expect, it } from 'vitest';
import {
  ACCENT_LABELS,
  ACCENT_SWATCHES,
  THEME_LABELS,
  isAccentId,
  isThemeId,
  normalizeAccent,
  normalizeTheme,
} from './theme';

// applyAppearanceToDocument is deliberately untested here — it's the one function in this module
// that touches document.documentElement, and this test environment has no DOM (see
// vitest.config.ts). Verified via browser instead, same convention as the rest of this module's
// platform-agnostic-vs-DOM split.

describe('isThemeId / isAccentId', () => {
  it('accepts every known theme id', () => {
    expect(isThemeId('system')).toBe(true);
    expect(isThemeId('light')).toBe(true);
    expect(isThemeId('dark')).toBe(true);
  });

  it('rejects an unknown theme id', () => {
    expect(isThemeId('midnight')).toBe(false);
    expect(isThemeId('')).toBe(false);
  });

  it('accepts every known accent id', () => {
    for (const id of Object.keys(ACCENT_LABELS)) {
      expect(isAccentId(id)).toBe(true);
    }
  });

  it('rejects an unknown accent id', () => {
    expect(isAccentId('magenta')).toBe(false);
  });
});

describe('normalizeTheme', () => {
  it('passes through a known theme id', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('light');
  });

  it('falls back to system for null, undefined, or an unknown value', () => {
    expect(normalizeTheme(null)).toBe('system');
    expect(normalizeTheme(undefined)).toBe('system');
    expect(normalizeTheme('midnight')).toBe('system');
    expect(normalizeTheme('')).toBe('system');
  });
});

describe('normalizeAccent', () => {
  it('passes through a known accent id', () => {
    expect(normalizeAccent('blue')).toBe('blue');
    expect(normalizeAccent('amber')).toBe('amber');
  });

  it('falls back to green for null, undefined, or an unknown value', () => {
    expect(normalizeAccent(null)).toBe('green');
    expect(normalizeAccent(undefined)).toBe('green');
    expect(normalizeAccent('magenta')).toBe('green');
  });
});

describe('label/swatch tables', () => {
  it('define exactly the 6 approved presets, no more no less', () => {
    expect(Object.keys(ACCENT_LABELS).sort()).toEqual(
      ['amber', 'blue', 'green', 'indigo', 'purple', 'teal'].sort()
    );
    expect(Object.keys(ACCENT_SWATCHES).sort()).toEqual(Object.keys(ACCENT_LABELS).sort());
  });

  it('define exactly the 3 theme options', () => {
    expect(Object.keys(THEME_LABELS).sort()).toEqual(['dark', 'light', 'system'].sort());
  });
});

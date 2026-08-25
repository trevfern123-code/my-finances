export type ThemeId = 'system' | 'light' | 'dark';
export type AccentId = 'green' | 'blue' | 'teal' | 'indigo' | 'purple' | 'amber';

const THEME_IDS: ThemeId[] = ['system', 'light', 'dark'];
const ACCENT_IDS: AccentId[] = ['green', 'blue', 'teal', 'indigo', 'purple', 'amber'];

export const THEME_LABELS: Record<ThemeId, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export const ACCENT_LABELS: Record<AccentId, string> = {
  green: 'Green',
  blue: 'Blue',
  teal: 'Teal',
  indigo: 'Indigo',
  purple: 'Purple',
  amber: 'Amber',
};

/** A representative swatch color per accent preset, for rendering the picker itself. Deliberately
 *  a single fixed value, not the same as the --accent CSS token (which varies by light/dark
 *  context) — a picker swatch just needs to look like "the blue one," not track the live theme. */
export const ACCENT_SWATCHES: Record<AccentId, string> = {
  green: '#22c55e',
  blue: '#2563eb',
  teal: '#14b8a6',
  indigo: '#4f46e5',
  purple: '#9333ea',
  amber: '#f59e0b',
};

export function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as string[]).includes(value);
}

export function isAccentId(value: string): value is AccentId {
  return (ACCENT_IDS as string[]).includes(value);
}

/** Falls back to the app default for anything unrecognized — a stale value from before a preset
 *  was renamed/removed, or a corrupted cache entry — rather than rendering broken. */
export function normalizeTheme(value: string | null | undefined): ThemeId {
  return value && isThemeId(value) ? value : 'system';
}

export function normalizeAccent(value: string | null | undefined): AccentId {
  return value && isAccentId(value) ? value : 'green';
}

/**
 * Applies the theme/accent choice to the document root as data attributes — the one thing every
 * token in App.css actually branches on. This is the one function in this module that touches
 * the DOM; everything else here is pure and platform-agnostic. A future mobile app would swap
 * this one function for its own native equivalent and reuse the rest as-is.
 *
 * `theme: 'system'` means "no attribute" — that's what lets the `@media (prefers-color-scheme)`
 * rules in App.css take over, rather than this function trying to resolve the OS preference itself.
 */
export function applyAppearanceToDocument(theme: ThemeId, accent: AccentId): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  root.setAttribute('data-accent', accent);
}

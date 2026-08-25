/** Curated category-color swatches — identity markers for telling categories apart at a glance,
 *  never a stand-in for the app's semantic colors (positive/danger/warn). Deliberately steers
 *  clear of red/orange/amber/green hues so a category dot never reads as a budget-health signal,
 *  and stays independent of the light/dark theme and accent-color system — a small dot doesn't
 *  need the text-level contrast tuning accent colors do, so one value per swatch is enough to
 *  stay legible on both light and dark surfaces. */
export const CATEGORY_COLOR_OPTIONS = [
  '#2563eb', // blue
  '#0284c7', // sky
  '#0891b2', // cyan
  '#4f46e5', // indigo
  '#7c3aed', // violet
  '#9333ea', // purple
  '#c026d3', // fuchsia
  '#db2777', // pink
  '#475569', // slate
  '#78716c', // stone
] as const;

export function isCategoryColorOption(value: string): boolean {
  return (CATEGORY_COLOR_OPTIONS as readonly string[]).includes(value);
}

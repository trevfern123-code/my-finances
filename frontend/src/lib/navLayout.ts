import { CUSTOMIZABLE_TAB_IDS, type CustomizableTabId } from './tabRegistry';

/** One customizable tab's saved state — mirrors DashboardCardEntry/DashboardCard's shape in
 *  lib/dashboardLayout.ts exactly. Only ever holds ids from CUSTOMIZABLE_TAB_IDS: Overview and
 *  Settings are structural anchors (see tabRegistry.ts) and are never represented here — this
 *  type has no slot for them at all, rather than relying on validation to keep them out. */
export interface NavTabEntry {
  id: CustomizableTabId;
  visible: boolean;
}

export const DEFAULT_NAV_LAYOUT: NavTabEntry[] = CUSTOMIZABLE_TAB_IDS.map((id) => ({ id, visible: true }));

function isCustomizableTabId(id: string): id is CustomizableTabId {
  return (CUSTOMIZABLE_TAB_IDS as string[]).includes(id);
}

/** Merges a saved layout against the known customizable-tab set — same reasoning and shape as
 *  mergeDashboardLayout (lib/dashboardLayout.ts): a tab the user has never seen (added after they
 *  last saved) is appended at the end, visible by default; a saved id that's no longer a real tab
 *  is dropped; an id that should never appear here at all (a structural anchor, or garbage from a
 *  hand-edited row) is dropped too. Anything that isn't a well-formed array at all — wrong shape,
 *  null, missing — resolves to the same default layout as a user who's never customized anything.
 *
 *  `visible` fails open: only an explicit `false` hides a tab. Anything else (missing, not a
 *  boolean, a stray string) is treated as visible — malformed data must never silently take a
 *  whole feature area out of the user's navigation; it can always be hidden again deliberately. */
export function mergeNavLayout(saved: { id: string; visible: boolean }[] | null | undefined): NavTabEntry[] {
  if (!Array.isArray(saved) || saved.length === 0) return DEFAULT_NAV_LAYOUT;

  const seen = new Set<CustomizableTabId>();
  const merged: NavTabEntry[] = [];

  for (const entry of saved) {
    if (!entry || typeof entry.id !== 'string' || !isCustomizableTabId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push({ id: entry.id, visible: entry.visible !== false });
  }
  for (const id of CUSTOMIZABLE_TAB_IDS) {
    if (!seen.has(id)) merged.push({ id, visible: true });
  }
  return merged;
}

export function toggleTabVisibility(layout: NavTabEntry[], id: CustomizableTabId): NavTabEntry[] {
  return layout.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t));
}

export function moveTab(layout: NavTabEntry[], id: CustomizableTabId, direction: 'up' | 'down'): NavTabEntry[] {
  const index = layout.findIndex((t) => t.id === id);
  if (index === -1) return layout;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= layout.length) return layout;
  const reordered = [...layout];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return reordered;
}

/** The ids TabNav should actually render, in order — hidden tabs are simply absent from this list.
 *  Nothing else about a hidden tab changes: it isn't in this list, but every render block, every
 *  calculation, and every internal `setActiveTab(...)` call is completely independent of it. */
export function getVisibleOrderedTabIds(layout: NavTabEntry[]): CustomizableTabId[] {
  return layout.filter((t) => t.visible).map((t) => t.id);
}

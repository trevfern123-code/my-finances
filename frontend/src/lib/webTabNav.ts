import { FIXED_FIRST_TAB, FIXED_LAST_TAB, TAB_REGISTRY, type CustomizableTabId } from './tabRegistry';
import type { Tab } from '../components/TabNav';

/**
 * The current web/PWA's own decision about primary-tab-bar order: Overview first, the user's
 * visible customizable tabs in their chosen order, Settings last. This is a presentation rule for
 * *this* platform only, deliberately kept separate from tabRegistry.ts's structural facts — a
 * future native client (e.g. a permanent profile icon opening an Account Hub that contains
 * Settings & Customization, Connected Institutions, Security & Privacy, etc.) reaches 'settings'
 * through its own, completely different arrangement and would supply its own equivalent of this
 * one small function, without tabRegistry.ts, navLayout.ts, or the 'structural' role changing at
 * all.
 */
export function buildWebTabList(visibleOrderedCustomTabIds: CustomizableTabId[]): Tab[] {
  const label = (id: string) => TAB_REGISTRY.find((t) => t.id === id)!.label;
  return [FIXED_FIRST_TAB.id, ...visibleOrderedCustomTabIds, FIXED_LAST_TAB.id].map((id) => ({
    id,
    label: label(id),
  }));
}

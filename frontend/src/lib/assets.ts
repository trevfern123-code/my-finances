import type { AssetGroup } from './api';

/** Checking + savings — the cash actually available to spend, as opposed to net worth (which
 *  also nets out investments, loans, and other illiquid balances). */
export function computeLiquidCash(groups: AssetGroup[]): number {
  return groups
    .filter((g) => g.category === 'checking' || g.category === 'savings')
    .reduce((sum, g) => sum + g.total, 0);
}

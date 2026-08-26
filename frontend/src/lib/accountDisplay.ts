/** An account's display name — its user-set nickname when there is one, falling back to Plaid's
 *  own name otherwise. Used everywhere an account name renders, so a nickname shows up
 *  consistently across the app rather than only in the one place it was set. */
export function accountDisplayName(account: { name: string; nickname: string | null }): string {
  return account.nickname ?? account.name;
}

/** Sorts a list of accounts by their manual sort_order, ascending — the shared ordering rule for
 *  any view that lists accounts within a natural grouping (an institution's accounts, an
 *  asset-category bucket). Stable for equal sort_order values (JS Array#sort is stable). */
export function sortAccountsByOrder<T extends { sort_order: number }>(accounts: T[]): T[] {
  return [...accounts].sort((a, b) => a.sort_order - b.sort_order);
}

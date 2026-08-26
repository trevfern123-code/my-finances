/** Shared reorder-by-one-position logic for any list of items with an `id` and a persisted
 *  `sort_order` — used by both budget-category and account reordering (previously duplicated
 *  near-identically in each component). Swaps the item at `id` with its neighbor in `direction`,
 *  then renumbers the whole list sequentially and returns only the rows whose sort_order actually
 *  changed, so a freshly-created set of items (where sort_order may all be 0) gets a real
 *  baseline from the first move rather than just the two swapped rows. Returns an empty array
 *  when the move isn't possible (id not found, or already at that end of the list). */
export function computeReorder<T extends { id: string; sort_order: number }>(
  items: T[],
  id: string,
  direction: 'up' | 'down'
): { id: string; sort_order: number }[] {
  const index = items.findIndex((item) => item.id === id);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= items.length) return [];

  const reordered = [...items];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  return reordered
    .map((item, i) => ({ id: item.id, sort_order: i }))
    .filter((update, i) => reordered[i].sort_order !== update.sort_order);
}

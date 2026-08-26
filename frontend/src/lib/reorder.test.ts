import { describe, expect, it } from 'vitest';
import { computeReorder } from './reorder';

function items(sortOrders: number[]) {
  return sortOrders.map((sort_order, i) => ({ id: `item-${i}`, sort_order }));
}

describe('computeReorder', () => {
  it('swaps an item up with its neighbor and renumbers sequentially', () => {
    const result = computeReorder(items([0, 1, 2]), 'item-1', 'up');
    // item-1 (index 1) swaps with item-0 (index 0) — new order: item-1, item-0, item-2.
    // item-2 stays at index 2 with the same sort_order it already had, so it's left out.
    expect(result).toEqual([
      { id: 'item-1', sort_order: 0 },
      { id: 'item-0', sort_order: 1 },
    ]);
  });

  it('swaps an item down with its neighbor and renumbers sequentially', () => {
    const result = computeReorder(items([0, 1, 2]), 'item-1', 'down');
    // item-1 (index 1) swaps with item-2 (index 2) — new order: item-0, item-2, item-1.
    // item-0 stays at index 0 with the same sort_order it already had, so it's left out.
    expect(result).toEqual([
      { id: 'item-2', sort_order: 1 },
      { id: 'item-1', sort_order: 2 },
    ]);
  });

  it('returns an empty array when already at the top', () => {
    expect(computeReorder(items([0, 1, 2]), 'item-0', 'up')).toEqual([]);
  });

  it('returns an empty array when already at the bottom', () => {
    expect(computeReorder(items([0, 1, 2]), 'item-2', 'down')).toEqual([]);
  });

  it('returns an empty array when the id is not found', () => {
    expect(computeReorder(items([0, 1, 2]), 'missing', 'up')).toEqual([]);
  });

  it('still fully establishes a real order when every sort_order starts at 0, writing only what must change', () => {
    // A freshly-created set where nothing has ever been reordered yet — moving item-0 down
    // should still end up with item-1 first, item-0 second, item-2 last.
    const result = computeReorder(items([0, 0, 0]), 'item-0', 'down');
    // item-1 lands at index 0, and its sort_order (0) already matches — no write needed for it.
    // item-0 and item-2 both need an explicit update to reach their new positions.
    expect(result).toEqual([
      { id: 'item-0', sort_order: 1 },
      { id: 'item-2', sort_order: 2 },
    ]);
  });

  it('only returns rows whose sort_order actually needs to change', () => {
    const result = computeReorder(items([5, 10, 20, 30]), 'item-1', 'up');
    // Every row's stored sort_order (5/10/20/30) differs from its new sequential position
    // (0/1/2/3) regardless of whether it moved, so every row is included here.
    expect(result).toEqual([
      { id: 'item-1', sort_order: 0 },
      { id: 'item-0', sort_order: 1 },
      { id: 'item-2', sort_order: 2 },
      { id: 'item-3', sort_order: 3 },
    ]);
  });
});

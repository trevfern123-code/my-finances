import { describe, expect, it } from 'vitest';
import {
  hydrateIfNeeded,
  INITIAL_NAV_LAYOUT_OWNER_STATE,
  resetForOwnerChange,
  type NavLayoutOwnerState,
} from './navLayoutOwner';
import { DEFAULT_NAV_LAYOUT } from './navLayout';

const A_SAVED = [{ id: 'loans', visible: false }];
const B_SAVED = [{ id: 'budget', visible: false }];

describe('resetForOwnerChange', () => {
  it('returns the same state reference when the owner has not changed', () => {
    const state: NavLayoutOwnerState = { ...INITIAL_NAV_LAYOUT_OWNER_STATE, ownerId: 'user-a' };
    expect(resetForOwnerChange(state, 'user-a')).toBe(state);
  });

  it('resets to a fresh, unhydrated, idle state on the very first identity (undefined -> id)', () => {
    const result = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    expect(result).toEqual({ ownerId: 'user-a', hydratedForOwner: false, layout: DEFAULT_NAV_LAYOUT, status: 'idle' });
  });

  it('resets on sign-out (id -> null)', () => {
    const hydratedA: NavLayoutOwnerState = {
      ownerId: 'user-a',
      hydratedForOwner: true,
      layout: [{ id: 'loans', visible: false }],
      status: 'saved',
    };
    const result = resetForOwnerChange(hydratedA, null);
    expect(result).toEqual({ ownerId: null, hydratedForOwner: false, layout: DEFAULT_NAV_LAYOUT, status: 'idle' });
  });

  it('resets on switching to a different account (A -> B)', () => {
    const hydratedA: NavLayoutOwnerState = {
      ownerId: 'user-a',
      hydratedForOwner: true,
      layout: [{ id: 'loans', visible: false }],
      status: 'saved',
    };
    const result = resetForOwnerChange(hydratedA, 'user-b');
    expect(result.ownerId).toBe('user-b');
    expect(result.hydratedForOwner).toBe(false);
    expect(result.layout).toEqual(DEFAULT_NAV_LAYOUT); // never A's leftover layout
    expect(result.status).toBe('idle'); // never A's leftover status
  });

  it('resets again when switching back to a previously seen account (A -> B -> A) — does not silently reuse A\'s old in-memory layout', () => {
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);
    expect(state.layout).toEqual(hydrateIfNeeded(state, 'user-a', A_SAVED).layout); // sanity

    state = resetForOwnerChange(state, 'user-b');
    state = hydrateIfNeeded(state, 'user-b', B_SAVED);

    const backToA = resetForOwnerChange(state, 'user-a');
    // Must start over unhydrated — not just silently keep whatever was in `layout` from the first
    // A session, and definitely not B's.
    expect(backToA.hydratedForOwner).toBe(false);
    expect(backToA.layout).toEqual(DEFAULT_NAV_LAYOUT);
  });
});

describe('hydrateIfNeeded', () => {
  it('hydrates from the current owner\'s own saved layout', () => {
    const state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    const result = hydrateIfNeeded(state, 'user-a', A_SAVED);
    expect(result.hydratedForOwner).toBe(true);
    expect(result.layout.find((t) => t.id === 'loans')).toEqual({ id: 'loans', visible: false });
  });

  it('does not hydrate while the fetch is still in flight (saved === undefined)', () => {
    const state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    expect(hydrateIfNeeded(state, 'user-a', undefined)).toBe(state);
  });

  it('does not hydrate when there is no authenticated owner', () => {
    const state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, null);
    expect(hydrateIfNeeded(state, null, A_SAVED)).toBe(state);
  });

  it('does not re-hydrate once already hydrated for the current owner (a later refetch does not clobber local edits)', () => {
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);
    const edited = { ...state, layout: [{ id: 'loans' as const, visible: true }] }; // simulate a local edit
    expect(hydrateIfNeeded(edited, 'user-a', A_SAVED)).toBe(edited);
  });

  it('refuses to hydrate a stale saved value that no longer matches the state\'s own owner — the core anti-leak guarantee', () => {
    // Simulates a preference fetch that was in flight for user A, resolving after the state has
    // already moved on to user B (state.ownerId === 'user-b'), even though this function is
    // (incorrectly, hypothetically) still called with A's saved data and userId 'user-a' — the
    // mismatch against state.ownerId is what must stop it.
    const stateForB = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-b');
    const result = hydrateIfNeeded(stateForB, 'user-a', A_SAVED);
    expect(result).toBe(stateForB); // unchanged — A's data never enters B's state
  });
});

describe('account-switch scenarios (combining resetForOwnerChange + hydrateIfNeeded)', () => {
  it('1. user A hydrates from A\'s own saved navigation', () => {
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);
    expect(state.ownerId).toBe('user-a');
    expect(state.layout.find((t) => t.id === 'loans')?.visible).toBe(false);
  });

  it('2. A logs out — state resets to idle/unhydrated/default', () => {
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);

    state = resetForOwnerChange(state, null);
    expect(state).toEqual({ ownerId: null, hydratedForOwner: false, layout: DEFAULT_NAV_LAYOUT, status: 'idle' });
  });

  it('3. B logs in — B\'s saved layout hydrates, not A\'s', () => {
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);
    state = resetForOwnerChange(state, null); // A logs out
    state = resetForOwnerChange(state, 'user-b'); // B logs in
    state = hydrateIfNeeded(state, 'user-b', B_SAVED);

    expect(state.ownerId).toBe('user-b');
    expect(state.layout.find((t) => t.id === 'budget')?.visible).toBe(false);
    expect(state.layout.find((t) => t.id === 'loans')?.visible).toBe(true); // A's hide never carried over
  });

  it('4. A -> B transition where both have different layouts', () => {
    let stateA = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    stateA = hydrateIfNeeded(stateA, 'user-a', A_SAVED);

    let stateB = resetForOwnerChange(stateA, 'user-b');
    stateB = hydrateIfNeeded(stateB, 'user-b', B_SAVED);

    expect(stateA.layout).not.toEqual(stateB.layout);
    expect(stateB.layout.find((t) => t.id === 'budget')?.visible).toBe(false);
    expect(stateB.layout.find((t) => t.id === 'loans')?.visible).toBe(true);
  });

  it('5. A -> B -> A rehydrates the correct layout each time', () => {
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);
    expect(state.layout.find((t) => t.id === 'loans')?.visible).toBe(false);

    state = resetForOwnerChange(state, 'user-b');
    state = hydrateIfNeeded(state, 'user-b', B_SAVED);
    expect(state.layout.find((t) => t.id === 'budget')?.visible).toBe(false);
    expect(state.layout.find((t) => t.id === 'loans')?.visible).toBe(true);

    state = resetForOwnerChange(state, 'user-a');
    expect(state.hydratedForOwner).toBe(false); // must rehydrate fresh, not reuse memory
    state = hydrateIfNeeded(state, 'user-a', A_SAVED);
    expect(state.layout.find((t) => t.id === 'loans')?.visible).toBe(false);
    expect(state.layout.find((t) => t.id === 'budget')?.visible).toBe(true); // B's hide didn't leak into A
  });

  it('regression: a stale fetch resolving for a superseded identity can never hydrate the new identity\'s state', () => {
    // A's fetch is "in flight" (not modeled here directly — see App.tsx's own requestedForUserId
    // guard for the async half of this protection) — this proves the independent, synchronous
    // second line of defense: even if a stale (userId, saved) pair for A reached this function
    // while state now belongs to B, it is refused.
    let state = resetForOwnerChange(INITIAL_NAV_LAYOUT_OWNER_STATE, 'user-a');
    state = resetForOwnerChange(state, 'user-b'); // B is now current; A's hydration never completed

    const result = hydrateIfNeeded(state, 'user-a', A_SAVED); // A's late-arriving response
    expect(result).toBe(state); // refused — B's state is untouched
    expect(result.hydratedForOwner).toBe(false);
  });
});

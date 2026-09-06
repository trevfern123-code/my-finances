import { describe, expect, it } from 'vitest';
import { currentGenerationValue, isNewAuthGeneration, nextAuthGeneration } from './authGeneration';

describe('isNewAuthGeneration', () => {
  it('is true for signed-out -> a user', () => {
    expect(isNewAuthGeneration(null, 'user-a')).toBe(true);
  });

  it('is true for a user -> signed-out', () => {
    expect(isNewAuthGeneration('user-a', null)).toBe(true);
  });

  it('is true for one user -> a different user', () => {
    expect(isNewAuthGeneration('user-a', 'user-b')).toBe(true);
  });

  it('is true for signed-out -> the same user again (a fresh login is still a new generation)', () => {
    expect(isNewAuthGeneration(null, 'user-a')).toBe(true); // (re-affirming: id equality is not the test)
  });

  it('is false when the user id is unchanged (e.g. a token refresh for the same continuous session)', () => {
    expect(isNewAuthGeneration('user-a', 'user-a')).toBe(false);
  });

  it('is false while remaining signed out', () => {
    expect(isNewAuthGeneration(null, null)).toBe(false);
  });
});

describe('nextAuthGeneration — full sequencing', () => {
  it('bumps across signed-out -> A, A -> signed-out, A -> B, and A -> B -> A, never reusing a generation for a repeat login', () => {
    let gen = 0;
    let prev: string | null = null;

    gen = nextAuthGeneration(gen, prev, 'user-a');
    prev = 'user-a';
    expect(gen).toBe(1); // signed-out -> A

    gen = nextAuthGeneration(gen, prev, null);
    prev = null;
    expect(gen).toBe(2); // A -> signed-out

    gen = nextAuthGeneration(gen, prev, 'user-a');
    prev = 'user-a';
    expect(gen).toBe(3); // signed-out -> A again — NOT the same generation as the first A session

    gen = nextAuthGeneration(gen, prev, 'user-b');
    prev = 'user-b';
    expect(gen).toBe(4); // A -> B

    gen = nextAuthGeneration(gen, prev, 'user-a');
    prev = 'user-a';
    expect(gen).toBe(5); // B -> A
  });

  it('does not bump for a same-user session refresh', () => {
    expect(nextAuthGeneration(3, 'user-a', 'user-a')).toBe(3);
  });

  it('does not bump while remaining signed out', () => {
    expect(nextAuthGeneration(0, null, null)).toBe(0);
  });
});

describe('currentGenerationValue — stale-fetch generation guard', () => {
  it('A1 fetch resolving after logout (generation has advanced) is rejected', () => {
    // A1's fetch tags its result with generation 1; by the time it resolves, current generation is
    // 2 (the user signed out).
    expect(currentGenerationValue(['A-data'], 1, 2)).toBeUndefined();
  });

  it('A1 -> B2: an old A1 response resolving under B\'s generation is rejected', () => {
    expect(currentGenerationValue(['A-data'], 1, 2)).toBeUndefined();
  });

  it('A1 -> B2 -> A3: an old A1 response is still rejected, even though generation 3 is A again', () => {
    expect(currentGenerationValue(['A-data'], 1, 3)).toBeUndefined();
  });

  it('A1 and B2 overlap and resolve out of order — only the response tagged with the current generation hydrates', () => {
    // B2's own response, tagged 2, arrives while current generation is 2 — usable.
    expect(currentGenerationValue(['B-data'], 2, 2)).toEqual(['B-data']);
    // A1's late arrival, tagged 1, arrives after B2 is already current (2) — rejected.
    expect(currentGenerationValue(['A-data'], 1, 2)).toBeUndefined();
  });

  it('B2 and A3 overlap and resolve out of order — only the response tagged with the current generation hydrates', () => {
    // A3's own response, tagged 3, arrives while current generation is 3 — usable.
    expect(currentGenerationValue(['A-data-3'], 3, 3)).toEqual(['A-data-3']);
    // B2's late arrival, tagged 2, arrives after A3 is already current (3) — rejected.
    expect(currentGenerationValue(['B-data'], 2, 3)).toBeUndefined();
  });

  it('only a response tagged with the exact current generation may hydrate', () => {
    expect(currentGenerationValue('x', 5, 5)).toBe('x');
    expect(currentGenerationValue('x', 4, 5)).toBeUndefined();
    expect(currentGenerationValue('x', 6, 5)).toBeUndefined();
  });

  it('a value never tagged at all (nothing fetched yet) is rejected', () => {
    expect(currentGenerationValue('x', undefined, 5)).toBeUndefined();
  });

  it('a legitimate null (fetched successfully, nothing saved) still passes through when tagged with the current generation', () => {
    expect(currentGenerationValue(null, 5, 5)).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualLoanInput } from './api';
import {
  acquirePendingManualLoanCreation,
  loadPendingManualLoanCreation,
  PendingCreationPersistenceError,
  releasePendingManualLoanCreation,
  type CrossContextLocks,
} from './pendingManualLoanCreation';
import { FakeLockManager } from '../testUtils/fakeWebLocks';

const input: ManualLoanInput = {
  name: 'Car',
  loan_type: 'personal',
  current_balance: 1200,
  origination_principal_amount: null,
  interest_rate_percentage: null,
  origination_date: null,
  term_months: null,
  minimum_payment_amount: null,
  next_payment_due_date: null,
  notes: null,
  match_text: null,
};
const otherInput: ManualLoanInput = { ...input, name: 'Boat', current_balance: 5 };

const SLOT = 'myfinances.pendingManualLoanCreation.user-a';

/** A stored envelope with any part overridden — used to build every malformed variant. */
function envelope(overrides: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, idempotencyKey: 'k0', input, ...overrides });
}

function withoutField(field: keyof ManualLoanInput): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...input };
  delete copy[field];
  return copy;
}

/** Runs the callback immediately and synchronously: "locking" that excludes nothing. Stands in for
 *  the Round 12 protocol (plain read-then-write) so the forced interleaving can show what the real
 *  lock prevents. */
const noExclusion: CrossContextLocks = {
  request: (_name, callback) => {
    try {
      return Promise.resolve(callback());
    } catch (err) {
      return Promise.reject(err);
    }
  },
};

/** Lets the first read of the slot observe storage, then runs `interleave` before the reader can act. */
function interleaveAfterFirstSlotRead(interleave: () => void) {
  const realGetItem = Storage.prototype.getItem;
  let armed = true;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    const observed = realGetItem.call(this, key);
    if (armed && key === SLOT) {
      armed = false;
      interleave();
    }
    return observed;
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acquirePendingManualLoanCreation — cross-context exclusivity (Round 13 remediation)', () => {
  it('REPRODUCTION: with no cross-context exclusion, two contenders that both read the empty slot BOTH acquire, and the second overwrites the first', async () => {
    let second: Promise<unknown> | undefined;
    interleaveAfterFirstSlotRead(() => {
      second = acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k2', input: otherInput }, noExclusion);
    });

    const first = await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, noExclusion);

    // This is the Round 12 race: two different keys each believe they own the slot, and whichever
    // wrote last silently replaced the other — two requests, two loans.
    expect(first).toMatchObject({ status: 'acquired' });
    expect(await second).toMatchObject({ status: 'acquired' });
    expect(JSON.parse(localStorage.getItem(SLOT)!).idempotencyKey).toBe('k1');
  });

  it('with Web Locks semantics, the same forced interleaving yields exactly ONE acquisition; the loser gets the winner, untouched', async () => {
    const locks = new FakeLockManager();
    let second: Promise<Awaited<ReturnType<typeof acquirePendingManualLoanCreation>>> | undefined;
    interleaveAfterFirstSlotRead(() => {
      second = acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k2', input: otherInput }, locks);
    });

    const first = await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, locks);
    const loser = await second!;

    expect(first).toEqual({ status: 'acquired', pending: { idempotencyKey: 'k1', input } });
    expect(loser).toEqual({ status: 'held-by-other', pending: { idempotencyKey: 'k1', input } });
    expect(localStorage.getItem(SLOT)).toBe(JSON.stringify({ version: 1, idempotencyKey: 'k1', input }));
    expect(locks.requested).toEqual([
      'myfinances.pendingManualLoanCreation.lock.user-a',
      'myfinances.pendingManualLoanCreation.lock.user-a',
    ]);
  });

  it('many simultaneous contenders: exactly one acquires, all others converge on its record', async () => {
    const locks = new FakeLockManager();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        acquirePendingManualLoanCreation('user-a', { idempotencyKey: `k${i}`, input: { ...input, name: `L${i}` } }, locks)
      )
    );

    const winners = results.filter((r) => r.status === 'acquired');
    expect(winners).toHaveLength(1);
    const winner = winners[0].pending;
    for (const r of results) expect(r.pending).toEqual(winner);
    expect(JSON.parse(localStorage.getItem(SLOT)!)).toEqual({ version: 1, ...winner });
  });

  it('users are independent: different users never contend for the same slot', async () => {
    const locks = new FakeLockManager();
    const [a, b] = await Promise.all([
      acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'ka', input }, locks),
      acquirePendingManualLoanCreation('user-b', { idempotencyKey: 'kb', input }, locks),
    ]);
    expect(a.status).toBe('acquired');
    expect(b.status).toBe('acquired');
  });

  it('re-acquiring the SAME key is a retry: acquired with the STORED payload, without rewriting', async () => {
    const locks = new FakeLockManager();
    await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, locks);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const retry = await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input: otherInput }, locks);

    expect(retry).toEqual({ status: 'acquired', pending: { idempotencyKey: 'k1', input } });
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{not json'],
    ['wrong key type', envelope({ idempotencyKey: 42 })],
    ['empty key', envelope({ idempotencyKey: '' })],
    ['missing input', JSON.stringify({ version: 1, idempotencyKey: 'k0' })],
    ['array input', envelope({ input: [] })],
    ['an unversioned (pre-Round 14) record', JSON.stringify({ idempotencyKey: 'k0', input })],
    ['an unsupported version', envelope({ version: 2 })],
    ['a non-numeric version', envelope({ version: '1' })],
    ['an extra envelope field', JSON.stringify({ version: 1, idempotencyKey: 'k0', input, extra: true })],
    ['an empty payload object ({ input: {} })', envelope({ input: {} })],
    ['a payload missing a required field', envelope({ input: withoutField('current_balance') })],
    ['a payload with a string balance', envelope({ input: { ...input, current_balance: '1200' } })],
    ['a payload with a numeric name', envelope({ input: { ...input, name: 7 } })],
    ['a payload with null where a string is required', envelope({ input: { ...input, name: null } })],
    ['a payload with null where a number is required', envelope({ input: { ...input, current_balance: null } })],
    ['a payload with an Infinity balance (1e999)', envelope({ input }).replace('"current_balance":1200', '"current_balance":1e999')],
    ['a payload with an unknown extra field', envelope({ input: { ...input, surprise: 1 } })],
    ['a payload failing a semantic rule (negative balance)', envelope({ input: { ...input, current_balance: -1 } })],
    ['a different shape entirely', '{"version":2,"attempt":{}}'],
    // Round 15: keys the backend rejects (its check is trim()-based) and a PostgreSQL-invalid year.
    ['a whitespace-only key', envelope({ idempotencyKey: ' ' })],
    ['a tab/newline-only key', envelope({ idempotencyKey: '\t\n ' })],
    ['a year-zero origination_date', envelope({ input: { ...input, origination_date: '0000-01-01' } })],
    ['a year-zero next_payment_due_date', envelope({ input: { ...input, next_payment_due_date: '0000-06-15' } })],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('a non-empty slot holding %s fails closed and is not overwritten', async (_label, corrupt) => {
    localStorage.setItem(SLOT, corrupt);

    await expect(
      acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, new FakeLockManager())
    ).rejects.toThrow(/unreadable/);
    expect(localStorage.getItem(SLOT)).toBe(corrupt);
  });

  it('without Web Locks nothing is read or written and acquisition is refused', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await expect(acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, null)).rejects.toThrow(
      PendingCreationPersistenceError
    );
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('defaults to navigator.locks, and refuses when the browser does not provide it', async () => {
    // jsdom provides no navigator.locks — exactly the unsupported-browser case.
    expect((navigator as Navigator & { locks?: unknown }).locks).toBeUndefined();
    await expect(acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input })).rejects.toThrow(
      "can't coordinate"
    );
  });

  it('fails closed when setItem throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    await expect(
      acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, new FakeLockManager())
    ).rejects.toThrow(PendingCreationPersistenceError);
  });

  it('fails closed when the write does not read back identically', async () => {
    const realGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      const value = realGetItem.call(this, key);
      return value === null ? null : value.replace('"k1"', '"corrupted"');
    });
    await expect(
      acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, new FakeLockManager())
    ).rejects.toThrow(PendingCreationPersistenceError);
  });

  it('fails closed when storage itself is inaccessible', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });
    await expect(
      acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, new FakeLockManager())
    ).rejects.toThrow(PendingCreationPersistenceError);
  });

  it.each([
    ['a single space', ' '],
    ['only whitespace characters', ' \t\n\r '],
  ])('Round 15: a fresh acquisition with a key of %s is REJECTED before anything is written — never trimmed', async (_label, key) => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await expect(
      acquirePendingManualLoanCreation('user-a', { idempotencyKey: key, input }, new FakeLockManager())
    ).rejects.toThrow(PendingCreationPersistenceError);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it('Round 15: a key with surrounding whitespace but real content is kept EXACTLY as given, not normalized', async () => {
    const key = '  7f3c9e2a-1b4d-4c8e-9a6f-2d5b8e1c0a47  ';
    const result = await acquirePendingManualLoanCreation('user-a', { idempotencyKey: key, input }, new FakeLockManager());
    expect(result).toEqual({ status: 'acquired', pending: { idempotencyKey: key, input } });
    expect(JSON.parse(localStorage.getItem(SLOT)!).idempotencyKey).toBe(key);
  });

  it('Round 15: an ordinary UUID key round-trips unchanged through storage and back', async () => {
    const key = crypto.randomUUID();
    const locks = new FakeLockManager();
    await acquirePendingManualLoanCreation('user-a', { idempotencyKey: key, input }, locks);
    expect(loadPendingManualLoanCreation('user-a')).toEqual({ idempotencyKey: key, input });
    // A retry under the same key finds it as its own attempt.
    expect(await acquirePendingManualLoanCreation('user-a', { idempotencyKey: key, input }, locks)).toEqual({
      status: 'acquired',
      pending: { idempotencyKey: key, input },
    });
  });

  it('the stored record survives a module reload (durable, not in memory)', async () => {
    await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, new FakeLockManager());
    vi.resetModules();
    const reloaded = await import('./pendingManualLoanCreation');
    expect(reloaded.loadPendingManualLoanCreation('user-a')).toEqual({ idempotencyKey: 'k1', input });
  });
});

describe('releasePendingManualLoanCreation (Round 13 remediation)', () => {
  it('removes the record only when it still holds the confirmed key', async () => {
    const locks = new FakeLockManager();
    await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k2', input }, locks);

    await releasePendingManualLoanCreation('user-a', 'k1', locks);
    expect(loadPendingManualLoanCreation('user-a')?.idempotencyKey).toBe('k2');

    await releasePendingManualLoanCreation('user-a', 'k2', locks);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it('never removes a record whose PAYLOAD is malformed, even when its key matches', async () => {
    const corrupt = envelope({ idempotencyKey: 'k1', input: {} });
    localStorage.setItem(SLOT, corrupt);
    await releasePendingManualLoanCreation('user-a', 'k1', new FakeLockManager());
    expect(localStorage.getItem(SLOT)).toBe(corrupt);
  });

  it.each([
    ['a whitespace-only key', envelope({ idempotencyKey: ' ' }), ' '],
    ['a year-zero origination_date', envelope({ idempotencyKey: 'k1', input: { ...input, origination_date: '0000-01-01' } }), 'k1'],
    ['a year-zero next_payment_due_date', envelope({ idempotencyKey: 'k1', input: { ...input, next_payment_due_date: '0000-06-15' } }), 'k1'],
  ])('Round 15: never removes a stored record with %s, even when released with its exact key', async (_label, corrupt, key) => {
    localStorage.setItem(SLOT, corrupt);
    await releasePendingManualLoanCreation('user-a', key, new FakeLockManager());
    expect(localStorage.getItem(SLOT)).toBe(corrupt);
  });

  it('never removes a record it cannot read', async () => {
    localStorage.setItem(SLOT, '{not json');
    await releasePendingManualLoanCreation('user-a', 'k1', new FakeLockManager());
    expect(localStorage.getItem(SLOT)).toBe('{not json');
  });

  it('a release racing a new acquisition never erases the new attempt, in either order', async () => {
    for (const releaseFirst of [true, false]) {
      localStorage.clear();
      const locks = new FakeLockManager();
      await acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input }, locks);

      const release = () => releasePendingManualLoanCreation('user-a', 'k1', locks);
      const acquire = () => acquirePendingManualLoanCreation('user-a', { idempotencyKey: 'k2', input: otherInput }, locks);
      const [a, b] = releaseFirst ? [release(), acquire()] : [acquire(), release()];
      await Promise.all([a, b]);
      const acquired = await (releaseFirst ? b : a);

      const stored = loadPendingManualLoanCreation('user-a');
      if ((acquired as { status: string }).status === 'acquired') {
        // Release ran first: k1 retired, then k2 took the empty slot and must still be there.
        expect(stored?.idempotencyKey).toBe('k2');
      } else {
        // Acquire ran first and lost to k1; the release then retired k1. k2 was never written.
        expect(stored).toBeNull();
      }
    }
  });

  it('is a no-op without Web Locks (the record survives; retrying it only replays the result)', async () => {
    localStorage.setItem(SLOT, JSON.stringify({ version: 1, idempotencyKey: 'k1', input }));
    await releasePendingManualLoanCreation('user-a', 'k1', null);
    expect(loadPendingManualLoanCreation('user-a')?.idempotencyKey).toBe('k1');
  });
});

describe('loadPendingManualLoanCreation (display-only read)', () => {
  it('is scoped per user and ignores malformed records', () => {
    localStorage.setItem(SLOT, JSON.stringify({ version: 1, idempotencyKey: 'k1', input }));
    expect(loadPendingManualLoanCreation('user-a')?.idempotencyKey).toBe('k1');
    expect(loadPendingManualLoanCreation('user-b')).toBeNull();
    localStorage.setItem(SLOT, '{not json');
    expect(loadPendingManualLoanCreation('user-a')).toBeNull();
  });
});

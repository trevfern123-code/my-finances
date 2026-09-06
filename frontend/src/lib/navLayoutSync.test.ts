import { describe, expect, it, vi } from 'vitest';
import { NavLayoutSync } from './navLayoutSync';
import type { NavTabEntry } from './navLayout';
import type { SaveStatus } from './saveStatus';

/** A promise whose resolve/reject can be triggered manually from outside — same helper shape as
 *  saveStatus.test.ts, so these tests can observe state *during* a save, not just its end state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const LAYOUT_A: NavTabEntry[] = [{ id: 'loans', visible: false }];
const LAYOUT_B: NavTabEntry[] = [{ id: 'loans', visible: true }];
const LAYOUT_C: NavTabEntry[] = [{ id: 'budget', visible: false }];

function makeSync(save: (layout: NavTabEntry[]) => Promise<unknown>, savedDisplayMs = 2000) {
  const statuses: SaveStatus[] = [];
  const sync = new NavLayoutSync({ save, onStatusChange: (s) => statuses.push(s), savedDisplayMs });
  return { sync, statuses };
}

describe('NavLayoutSync — at most one write in flight', () => {
  it('dispatches immediately when nothing is in flight', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A);
    expect(statuses).toEqual(['saving']);
  });

  it('does not call save again while one is already in flight', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const { sync } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.submit(LAYOUT_B);

    expect(save).toHaveBeenCalledTimes(1); // B is queued, not dispatched yet
  });

  it('dispatches the queued layout automatically once the in-flight one settles', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const { sync } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.submit(LAYOUT_B);
    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_B);
  });

  it('intermediate layouts are dropped when superseded — only the newest is ever sent', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const { sync } = makeSync(save);

    sync.submit(LAYOUT_A); // dispatched immediately
    sync.submit(LAYOUT_B); // superseded before ever being sent
    sync.submit(LAYOUT_C); // the only one that matters once A settles

    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_C); // B was never sent to the server at all
  });

  it('final server-write ordering is always exactly [firstDispatched, ..., latestSubmitted]', async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { sync } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.submit(LAYOUT_B);
    sync.submit(LAYOUT_C); // supersedes B before B is ever dispatched

    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();
    b.resolve();
    await b.promise;
    await Promise.resolve();

    // save() was called exactly twice, strictly in order: A first (already in flight when B/C
    // arrived), then C (the final state) — never both concurrently, and B never at all. A slow
    // A cannot land after a fast C because C is never even dispatched until A finishes.
    expect(save.mock.calls).toEqual([[LAYOUT_A], [LAYOUT_C]]);
  });
});

describe('NavLayoutSync — status transitions', () => {
  it('success with nothing pending: saving -> saved -> idle after the delay', async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const { sync, statuses } = makeSync(save, 2000);

    sync.submit(LAYOUT_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['saving', 'saved']);

    await vi.advanceTimersByTimeAsync(1999);
    expect(statuses).toEqual(['saving', 'saved']); // not idle yet

    await vi.advanceTimersByTimeAsync(1);
    expect(statuses).toEqual(['saving', 'saved', 'idle']);
    vi.useRealTimers();
  });

  it('success with a newer submit pending at completion stays "saving" — never flashes "saved"', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.submit(LAYOUT_B); // queued before A resolves
    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'saving']); // re-enters 'saving' for B, never 'saved' for A
  });

  it('failure with nothing pending shows error', async () => {
    const save = vi.fn(() => Promise.reject(new Error('network down')));
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'error']);
  });

  it('failure with a newer submit pending is swallowed — never surfaced, moves straight to the newer layout', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.submit(LAYOUT_B);
    a.reject(new Error('stale failure'));
    await a.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'saving']); // never visits 'error' for the superseded attempt
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_B);
  });
});

describe('NavLayoutSync — retry', () => {
  it('retries the exact layout that failed', async () => {
    const save = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error('fail once')))
      .mockReturnValueOnce(Promise.resolve());
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('error');

    sync.retry();
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_A);
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('saved');
  });

  it('is a no-op if nothing has ever been submitted', () => {
    const save = vi.fn(() => Promise.resolve());
    const { sync, statuses } = makeSync(save);

    sync.retry();

    expect(save).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
});

describe('NavLayoutSync — dispose', () => {
  it('cancels the pending idle-reset timer', async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const { sync, statuses } = makeSync(save, 1000);

    sync.submit(LAYOUT_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('saved');

    sync.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses.at(-1)).toBe('saved'); // never reached 'idle' — timer was cancelled
    vi.useRealTimers();
  });

  it('discards a queued, not-yet-sent layout — it can never be dispatched', () => {
    const a = deferred<void>();
    const save = vi.fn(() => a.promise);
    const { sync } = makeSync(save);

    sync.submit(LAYOUT_A); // dispatched immediately, still in flight
    sync.submit(LAYOUT_B); // queued, never sent yet

    sync.dispose();

    // Even if the in-flight A request later settles, there is nothing queued left to dispatch —
    // B (the unsent layout) was discarded the instant dispose() ran, not merely left pending.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A);
  });

  it('an in-flight request settling after dispose cannot trigger another dispatch or status callback', async () => {
    const a = deferred<void>();
    const save = vi.fn(() => a.promise);
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A); // dispatched, in flight
    sync.submit(LAYOUT_B); // queued behind it

    sync.dispose(); // discards the queued B; leaves A's in-flight request to finish on its own
    const statusesAtDispose = [...statuses];

    a.resolve(); // A's request — dispatched legitimately before dispose — finishes normally
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1); // B was never dispatched
    expect(statuses).toEqual(statusesAtDispose); // no further status callback fired after dispose
  });

  it('an in-flight request rejecting after dispose cannot emit an error status or retry state', async () => {
    const a = deferred<void>();
    const save = vi.fn(() => a.promise);
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.dispose();
    const statusesAtDispose = [...statuses];

    a.reject(new Error('finishes after dispose'));
    await a.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(statusesAtDispose); // never reaches 'error' after disposal
  });

  it('rejects new submissions after disposal', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const { sync } = makeSync(save);

    sync.dispose();
    sync.submit(LAYOUT_A);

    expect(save).not.toHaveBeenCalled();
  });

  it('rejects retry() after disposal', async () => {
    const save = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error('fail once')));
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('error');

    sync.dispose();
    sync.retry();

    expect(save).toHaveBeenCalledTimes(1); // retry() after dispose never re-invokes save
  });
});

describe('NavLayoutSync — simulated account switch (A disposed mid-flight, B gets a fresh instance)', () => {
  it('6. A has one request in flight and another A layout pending, then "logs out" before the first settles — the pending A layout is discarded and never sent', () => {
    const aInFlight = deferred<void>();
    const saveA = vi.fn(() => aInFlight.promise);
    const { sync: syncA } = makeSync(saveA);

    syncA.submit(LAYOUT_A); // dispatched, in flight
    syncA.submit(LAYOUT_B); // queued — represents a second A edit made just before logout

    syncA.dispose(); // "A logs out" — happens before aInFlight ever settles

    expect(saveA).toHaveBeenCalledTimes(1); // only the in-flight A request was ever sent
    expect(saveA).toHaveBeenCalledWith(LAYOUT_A); // LAYOUT_B (queued) was discarded, never dispatched
  });

  it('7. following logout and a B login, no A-derived write is ever dispatched under B\'s own sync instance', async () => {
    const aInFlight = deferred<void>();
    const saveA = vi.fn(() => aInFlight.promise);
    const { sync: syncA } = makeSync(saveA);

    syncA.submit(LAYOUT_A);
    syncA.submit(LAYOUT_B);
    syncA.dispose(); // A logs out — B's own useNavLayout render would construct a brand-new instance

    const saveB = vi.fn(() => Promise.resolve());
    const { sync: syncB, statuses: statusesB } = makeSync(saveB);
    syncB.submit(LAYOUT_C); // B's own, unrelated edit

    await Promise.resolve();
    await Promise.resolve();

    // B's own save() only ever receives B's own layout — never anything A queued or attempted.
    expect(saveB).toHaveBeenCalledTimes(1);
    expect(saveB).toHaveBeenCalledWith(LAYOUT_C);
    expect(statusesB).toEqual(['saving', 'saved']);

    // Completing A's stale in-flight request afterward changes nothing about B's instance.
    aInFlight.resolve();
    await aInFlight.promise;
    await Promise.resolve();
    expect(saveB).toHaveBeenCalledTimes(1);
  });

  it('8. completion of A\'s already-in-flight request after disposal cannot update B\'s save status or trigger another dispatch', async () => {
    const aInFlight = deferred<void>();
    const saveA = vi.fn(() => aInFlight.promise);
    const { sync: syncA, statuses: statusesA } = makeSync(saveA);

    syncA.submit(LAYOUT_A);
    syncA.dispose();
    const statusesAAtDispose = [...statusesA];

    const saveB = vi.fn(() => new Promise(() => {}));
    const { sync: syncB, statuses: statusesB } = makeSync(saveB);
    syncB.submit(LAYOUT_C);
    const statusesBBeforeASettles = [...statusesB];

    aInFlight.resolve(); // A's stale request finally settles
    await aInFlight.promise;
    await Promise.resolve();
    await Promise.resolve();

    // A's own (disposed) instance emitted nothing further...
    expect(statusesA).toEqual(statusesAAtDispose);
    // ...and, since A and B are entirely separate instances/closures, B's status and save() calls
    // are completely unaffected by A's settlement.
    expect(statusesB).toEqual(statusesBBeforeASettles);
    expect(saveB).toHaveBeenCalledTimes(1);
  });
});

describe('NavLayoutSync — synchronous save() throw', () => {
  it('is treated the same as a rejected promise — status becomes error, not stuck on saving', async () => {
    const save = vi.fn(() => {
      throw new Error('synchronous failure');
    });
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'error']);
  });

  it('does not wedge the queue — a subsequent submit still dispatches normally', async () => {
    const save = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('synchronous failure');
      })
      .mockReturnValueOnce(Promise.resolve());
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('error');

    sync.submit(LAYOUT_B);
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_B);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('a synchronous throw superseded by a newer pending submit is swallowed, same as a rejected promise', async () => {
    const save = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('synchronous failure');
      })
      .mockReturnValueOnce(new Promise(() => {}));
    const { sync, statuses } = makeSync(save);

    sync.submit(LAYOUT_A);
    sync.submit(LAYOUT_B); // queued before A's synchronous throw is even processed
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'saving']); // never visits 'error'
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_B);
  });
});

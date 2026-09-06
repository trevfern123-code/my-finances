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
});

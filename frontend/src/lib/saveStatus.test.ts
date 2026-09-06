import { describe, expect, it, vi } from 'vitest';
import { getSaveStatusDisplay, SaveStatusTracker, type SaveStatus } from './saveStatus';

/** A promise whose resolve/reject can be triggered manually from outside — lets these tests
 *  observe the tracker's state *before* a save settles, not just its end state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTracker(overrides: Partial<ConstructorParameters<typeof SaveStatusTracker>[0]> = {}) {
  const statuses: SaveStatus[] = [];
  const tracker = new SaveStatusTracker({
    onStatusChange: (status) => statuses.push(status),
    savedDisplayMs: 2000,
    ...overrides,
  });
  return { tracker, statuses };
}

describe('SaveStatusTracker', () => {
  it('idle initially, saving immediately when track() is called', () => {
    const { tracker, statuses } = makeTracker();
    expect(tracker.getStatus()).toBe('idle');

    const { promise } = deferred<void>();
    tracker.track(() => promise);

    expect(tracker.getStatus()).toBe('saving');
    expect(statuses).toEqual(['saving']);
  });

  it('only becomes saved after the tracked promise actually resolves, not before', async () => {
    const { tracker } = makeTracker();
    const { promise, resolve } = deferred<void>();

    tracker.track(() => promise);
    expect(tracker.getStatus()).toBe('saving'); // still saving — nothing has resolved yet

    resolve();
    await promise;
    await Promise.resolve(); // let the tracker's own .then() callback run
    expect(tracker.getStatus()).toBe('saved');
  });

  it('a rejected save becomes error, not saved', async () => {
    const { tracker } = makeTracker();
    const { promise, reject } = deferred<void>();

    tracker.track(() => promise);
    reject(new Error('network down'));
    await promise.catch(() => {});
    await Promise.resolve();

    expect(tracker.getStatus()).toBe('error');
  });

  it('saved returns to idle after the configured delay, not before', async () => {
    vi.useFakeTimers();
    const { tracker } = makeTracker({ savedDisplayMs: 2000 });
    tracker.track(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(0); // let the immediate resolve's .then() run
    expect(tracker.getStatus()).toBe('saved');

    await vi.advanceTimersByTimeAsync(1999);
    expect(tracker.getStatus()).toBe('saved'); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(tracker.getStatus()).toBe('idle');
    vi.useRealTimers();
  });

  it('retry() invokes the exact same thunk as the last attempt', () => {
    const { tracker } = makeTracker();
    const thunk = vi.fn(() => Promise.resolve());

    tracker.track(thunk);
    expect(thunk).toHaveBeenCalledTimes(1);

    tracker.retry();
    expect(thunk).toHaveBeenCalledTimes(2); // the identical function reference, called again
  });

  it('retry() is a no-op if nothing has ever been tracked', () => {
    const { tracker, statuses } = makeTracker();
    tracker.retry();
    expect(tracker.getStatus()).toBe('idle');
    expect(statuses).toEqual([]);
  });

  it('a successful retry after a failure transitions to saved', async () => {
    const { tracker } = makeTracker();
    let attempt = 0;
    const thunk = vi.fn(() => (attempt++ === 0 ? Promise.reject(new Error('fail once')) : Promise.resolve()));

    tracker.track(thunk);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();
    expect(tracker.getStatus()).toBe('error');

    tracker.retry();
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getStatus()).toBe('saved');
  });

  it('a stale, slow-resolving attempt can never overwrite a newer attempt\'s status', async () => {
    const { tracker } = makeTracker();
    const stale = deferred<void>();
    const fresh = deferred<void>();

    tracker.track(() => stale.promise); // attempt A — will resolve late
    tracker.track(() => fresh.promise); // attempt B — supersedes A before A settles
    expect(tracker.getStatus()).toBe('saving');

    // Fresh (B) rejects first — status should become 'error'.
    fresh.reject(new Error('B failed'));
    await fresh.promise.catch(() => {});
    await Promise.resolve();
    expect(tracker.getStatus()).toBe('error');

    // Stale (A) resolves after B already settled — must NOT flip status back to 'saved'.
    stale.resolve();
    await stale.promise;
    await Promise.resolve();
    expect(tracker.getStatus()).toBe('error');
  });

  it('starting a new attempt cancels the pending idle-reset timer from a previous saved state', async () => {
    vi.useFakeTimers();
    const { tracker } = makeTracker({ savedDisplayMs: 1000 });

    tracker.track(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.getStatus()).toBe('saved');

    await vi.advanceTimersByTimeAsync(500); // halfway through the reset-to-idle timer
    tracker.track(() => new Promise(() => {})); // a new attempt starts, never resolves
    expect(tracker.getStatus()).toBe('saving');

    await vi.advanceTimersByTimeAsync(1000); // if the old timer weren't cleared, this would fire it
    expect(tracker.getStatus()).toBe('saving'); // unaffected by the earlier attempt's stale timer
    vi.useRealTimers();
  });
});

describe('getSaveStatusDisplay', () => {
  it('idle is not visible', () => {
    expect(getSaveStatusDisplay('idle')).toEqual({ visible: false, text: '', showRetry: false });
  });

  it('saving shows "Saving…" without a retry action', () => {
    const display = getSaveStatusDisplay('saving');
    expect(display.visible).toBe(true);
    expect(display.text).toBe('Saving…');
    expect(display.showRetry).toBe(false);
  });

  it('saved shows "Saved ✓" without a retry action', () => {
    const display = getSaveStatusDisplay('saved');
    expect(display.visible).toBe(true);
    expect(display.text).toBe('Saved ✓');
    expect(display.showRetry).toBe(false);
  });

  it('error is visible and offers retry', () => {
    const display = getSaveStatusDisplay('error');
    expect(display.visible).toBe(true);
    expect(display.showRetry).toBe(true);
  });
});

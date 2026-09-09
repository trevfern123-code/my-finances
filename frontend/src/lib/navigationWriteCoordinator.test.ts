import { describe, expect, it, vi } from 'vitest';
import { NavigationWriteCoordinator } from './navigationWriteCoordinator';
import type { NavTabEntry } from './navLayout';
import type { SaveStatus } from './saveStatus';

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

const ALWAYS_VALID = () => true;

function makeCoordinator(save: (layout: NavTabEntry[], verify: (s: unknown) => boolean) => Promise<unknown>, savedDisplayMs = 2000) {
  return new NavigationWriteCoordinator({ save: save as never, savedDisplayMs });
}

function attachRecorder(coordinator: NavigationWriteCoordinator, sessionId: string) {
  const statuses: SaveStatus[] = [];
  coordinator.attach(sessionId, (s) => statuses.push(s));
  return statuses;
}

describe('NavigationWriteCoordinator — single-scope behavior (preserving NavLayoutSync\'s proven contract)', () => {
  it('dispatches immediately when nothing is in flight', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const statuses = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A, ALWAYS_VALID);
    expect(statuses).toEqual(['saving']);
  });

  it('does not call save again while one is already in flight', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', ALWAYS_VALID);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('dispatches the queued layout automatically once the in-flight one settles', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', ALWAYS_VALID);
    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_B, ALWAYS_VALID);
  });

  it('intermediate layouts are dropped when superseded — only the newest is ever sent', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', ALWAYS_VALID);
    coordinator.submit(LAYOUT_C, 'sid-1', ALWAYS_VALID);
    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_C, ALWAYS_VALID);
  });

  it('success with nothing pending: saving -> saved -> idle after the delay', async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.resolve());
    const coordinator = makeCoordinator(save, 2000);
    const statuses = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['saving', 'saved']);

    await vi.advanceTimersByTimeAsync(1999);
    expect(statuses).toEqual(['saving', 'saved']);

    await vi.advanceTimersByTimeAsync(1);
    expect(statuses).toEqual(['saving', 'saved', 'idle']);
    vi.useRealTimers();
  });

  it('failure with nothing pending shows error', async () => {
    const save = vi.fn(() => Promise.reject(new Error('network down')));
    const coordinator = makeCoordinator(save);
    const statuses = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'error']);
  });

  it('a synchronous save() throw is treated the same as a rejected promise — not stuck on saving', async () => {
    const save = vi.fn(() => {
      throw new Error('synchronous failure');
    });
    const coordinator = makeCoordinator(save);
    const statuses = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'error']);
  });

  it('retry() re-submits the exact layout and verify that failed', async () => {
    const verifyA = () => true;
    const save = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error('fail once')))
      .mockReturnValueOnce(Promise.resolve());
    const coordinator = makeCoordinator(save);
    const statuses = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', verifyA);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('error');

    coordinator.retry('sid-1');
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_A, verifyA);
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('saved');
  });

  it('retry() is a no-op if nothing has ever been submitted', () => {
    const save = vi.fn(() => Promise.resolve());
    const coordinator = makeCoordinator(save);
    const statuses = attachRecorder(coordinator, 'sid-1');

    coordinator.retry('sid-1');

    expect(save).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
});

describe('NavigationWriteCoordinator — Cases A/B/C (cross-lifecycle ordering)', () => {
  it('Case A — an unsent pending layout is discarded when a new session attaches', () => {
    const inFlight = deferred<void>();
    const save = vi.fn(() => inFlight.promise);
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID); // dispatched, in flight
    coordinator.submit(LAYOUT_B, 'sid-1', ALWAYS_VALID); // queued — never sent yet

    attachRecorder(coordinator, 'sid-3'); // a new lifecycle attaches before A's queued edit ever sends

    expect(save).toHaveBeenCalledTimes(1); // only the already-in-flight sid-1 request was ever sent
    expect(save).toHaveBeenCalledWith(LAYOUT_A, ALWAYS_VALID); // LAYOUT_B was discarded, never dispatched
  });

  it('Case B — an already-issued old-lifecycle write settles before the newest new-lifecycle write is sent; final wire order ends with the newest', async () => {
    const a1 = deferred<void>();
    const verifyA1 = () => true;
    const verifyA3 = () => true;
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(Promise.resolve());
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', verifyA1); // A1's write is on the wire

    const statusesA3 = attachRecorder(coordinator, 'sid-3'); // A3 attaches while A1 still in flight
    coordinator.submit(LAYOUT_C, 'sid-3', verifyA3); // A3's own newer edit — queued behind A1

    expect(save).toHaveBeenCalledTimes(1); // A3's write has NOT been sent yet — A1 is still on the wire

    a1.resolve(); // A1's already-issued write settles normally
    await a1.promise;
    await Promise.resolve();
    await Promise.resolve();

    // Final wire order: A1 first (already in flight when A3 attached), then A3 — never concurrently,
    // and A3 was never sent before A1 settled.
    expect(save.mock.calls).toEqual([
      [LAYOUT_A, verifyA1],
      [LAYOUT_C, verifyA3],
    ]);
    expect(statusesA3.at(-1)).toBe('saved'); // A3's own save is what's truthfully reported as saved
  });

  it('Case C — ownership verification rejects the old-lifecycle write before fetch; the coordinator proceeds to the newest current-session layout', async () => {
    const sessionLookup = deferred<unknown>();
    // save() simulates authedFetch: awaits a session lookup, then checks `verify` against it.
    const save = vi.fn((layout: NavTabEntry[], verify: (s: unknown) => boolean) =>
      sessionLookup.promise.then((session) => {
        if (!verify(session)) throw new Error('Session no longer matches the expected authenticated owner');
        return { ok: true };
      })
    );
    const coordinator = makeCoordinator(save as never);
    attachRecorder(coordinator, 'sid-1');

    const verifyA1 = vi.fn(() => false); // simulates: returned session's session_id no longer matches sid-1
    coordinator.submit(LAYOUT_A, 'sid-1', verifyA1); // A1 dispatched, awaiting the session lookup

    const statusesA3 = attachRecorder(coordinator, 'sid-3'); // A3 becomes current while A1 awaits lookup
    const verifyA3 = vi.fn(() => true);
    coordinator.submit(LAYOUT_C, 'sid-3', verifyA3); // A3's own edit — queued behind A1

    sessionLookup.resolve({ user: { id: 'user-a' } }); // the session A1's lookup finally observes
    await sessionLookup.promise;
    // verifyA1 rejects (Case C), the coordinator moves straight to A3's queued layout.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(verifyA1).toHaveBeenCalled();
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_C, verifyA3);
    expect(statusesA3.at(-1)).toBe('saved');
  });

  it('A3 cannot Retry A1\'s failed attempt', async () => {
    const save = vi.fn().mockReturnValueOnce(Promise.reject(new Error('A1 failed')));
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    const statusesA3 = attachRecorder(coordinator, 'sid-3'); // A3 attaches after A1's failure
    coordinator.retry('sid-3'); // A3 attempts to retry — but nothing of A3's has ever failed

    expect(save).toHaveBeenCalledTimes(1); // no second call — A1's layout was never resubmitted
    expect(statusesA3).toEqual([]); // A3 never even sees a status update from this no-op
  });

  it('a stale old-lifecycle completion cannot change the new lifecycle\'s status', async () => {
    const a1 = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const statusesA1 = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    const statusesA3 = attachRecorder(coordinator, 'sid-3'); // A1 detached implicitly by re-attach
    const statusesA3Snapshot = [...statusesA3];

    a1.resolve(); // A1's stale in-flight request finally settles
    await a1.promise;
    await Promise.resolve();
    await Promise.resolve();

    // A1's own (now-detached) status recorder never received anything further, and — more
    // importantly — A3's status recorder was not affected by A1's settlement either, since A1 had
    // nothing pending and A3 hadn't submitted anything of its own yet.
    expect(statusesA1).toEqual(['saving']);
    expect(statusesA3).toEqual(statusesA3Snapshot);
  });

  it('rapid edits within one lifecycle still coalesce to the newest, unaffected by cross-scope promotion', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(Promise.resolve());
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', ALWAYS_VALID);
    coordinator.submit(LAYOUT_C, 'sid-1', ALWAYS_VALID);

    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_C, ALWAYS_VALID);
  });
});

describe('NavigationWriteCoordinator — user isolation', () => {
  it('User A\'s in-flight settlement never leaks into User B\'s attached status', async () => {
    const aInFlight = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(aInFlight.promise).mockResolvedValueOnce(undefined);
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-userA-1');

    coordinator.submit(LAYOUT_A, 'sid-userA-1', ALWAYS_VALID);

    // User A signs out, User B (a different person entirely) signs in.
    const statusesB = attachRecorder(coordinator, 'sid-userB-1');
    coordinator.submit(LAYOUT_C, 'sid-userB-1', ALWAYS_VALID);

    aInFlight.resolve();
    await aInFlight.promise;
    await Promise.resolve();
    await Promise.resolve();

    // Only B's own submission's outcome ever reaches B's status callback.
    expect(statusesB).toEqual(['saving', 'saved']);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_C, ALWAYS_VALID);
  });

  it('a pending layout submitted under User A is never sent as User B\'s', () => {
    const inFlight = deferred<void>();
    const save = vi.fn(() => inFlight.promise);
    const coordinator = makeCoordinator(save);
    attachRecorder(coordinator, 'sid-userA-1');

    coordinator.submit(LAYOUT_A, 'sid-userA-1', ALWAYS_VALID); // dispatched
    coordinator.submit(LAYOUT_B, 'sid-userA-1', ALWAYS_VALID); // queued, User A's own second edit

    attachRecorder(coordinator, 'sid-userB-1'); // User B attaches — discards A's queued edit (Case A)

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A, ALWAYS_VALID); // B never receives A's queued layout
  });
});

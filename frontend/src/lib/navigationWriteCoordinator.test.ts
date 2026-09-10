import { describe, expect, it, vi } from 'vitest';
import { NavigationWriteCoordinator, type AttachmentId } from './navigationWriteCoordinator';
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
  const attachmentId = coordinator.attach(sessionId, (s) => statuses.push(s));
  return { statuses, attachmentId };
}

describe('NavigationWriteCoordinator — single-scope behavior (preserving NavLayoutSync\'s proven contract)', () => {
  it('dispatches immediately when nothing is in flight', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A, ALWAYS_VALID);
    expect(statuses).toEqual(['saving']);
  });

  it('does not call save again while one is already in flight', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('dispatches the queued layout automatically once the in-flight one settles', async () => {
    const a = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID);
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
    const { attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID);
    coordinator.submit(LAYOUT_C, 'sid-1', attachmentId, ALWAYS_VALID);
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
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
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
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    expect(statuses).toEqual(['saving', 'error']);
  });

  it('a synchronous save() throw is treated the same as a rejected promise — not stuck on saving', async () => {
    const save = vi.fn(() => {
      throw new Error('synchronous failure');
    });
    const coordinator = makeCoordinator(save);
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
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
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, verifyA);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('error');

    coordinator.retry('sid-1', attachmentId);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_A, verifyA);
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.at(-1)).toBe('saved');
  });

  it('retry() is a no-op if nothing has ever been submitted', () => {
    const save = vi.fn(() => Promise.resolve());
    const coordinator = makeCoordinator(save);
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.retry('sid-1', attachmentId);

    expect(save).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
});

describe('NavigationWriteCoordinator — Cases A/B/C (cross-lifecycle ordering)', () => {
  it('Case A — an unsent pending layout is discarded when a new session attaches', () => {
    const inFlight = deferred<void>();
    const save = vi.fn(() => inFlight.promise);
    const coordinator = makeCoordinator(save);
    const { attachmentId: a1 } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', a1, ALWAYS_VALID); // dispatched, in flight
    coordinator.submit(LAYOUT_B, 'sid-1', a1, ALWAYS_VALID); // queued — never sent yet

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
    const { attachmentId: attachment1 } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachment1, verifyA1); // A1's write is on the wire

    const { statuses: statusesA3, attachmentId: attachment3 } = attachRecorder(coordinator, 'sid-3'); // A3 attaches while A1 still in flight
    coordinator.submit(LAYOUT_C, 'sid-3', attachment3, verifyA3); // A3's own newer edit — queued behind A1

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
    const { attachmentId: attachment1 } = attachRecorder(coordinator, 'sid-1');

    const verifyA1 = vi.fn(() => false); // simulates: returned session's session_id no longer matches sid-1
    coordinator.submit(LAYOUT_A, 'sid-1', attachment1, verifyA1); // A1 dispatched, awaiting the session lookup

    const { statuses: statusesA3, attachmentId: attachment3 } = attachRecorder(coordinator, 'sid-3'); // A3 becomes current while A1 awaits lookup
    const verifyA3 = vi.fn(() => true);
    coordinator.submit(LAYOUT_C, 'sid-3', attachment3, verifyA3); // A3's own edit — queued behind A1

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
    const { attachmentId: attachment1 } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachment1, ALWAYS_VALID);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    const { statuses: statusesA3, attachmentId: attachment3 } = attachRecorder(coordinator, 'sid-3'); // A3 attaches after A1's failure
    coordinator.retry('sid-3', attachment3); // A3 attempts to retry — but nothing of A3's has ever failed

    expect(save).toHaveBeenCalledTimes(1); // no second call — A1's layout was never resubmitted
    expect(statusesA3).toEqual([]); // A3 never even sees a status update from this no-op
  });

  it('a stale old-lifecycle completion cannot change the new lifecycle\'s status', async () => {
    const a1 = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { statuses: statusesA1, attachmentId: attachment1 } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachment1, ALWAYS_VALID);
    const { statuses: statusesA3 } = attachRecorder(coordinator, 'sid-3'); // A1 detached implicitly by re-attach
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
    const { attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID);
    coordinator.submit(LAYOUT_C, 'sid-1', attachmentId, ALWAYS_VALID);

    a.resolve();
    await a.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, LAYOUT_C, ALWAYS_VALID);
  });
});

describe('NavigationWriteCoordinator — Saved -> Idle timer does not outlive its own attempt (Blocker 2)', () => {
  it('a later failure is not clobbered back to idle by an earlier success\'s stale timer, and Retry still works', async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve()) // Save #1 succeeds
      .mockImplementationOnce(() => Promise.reject(new Error('Save #2 failed'))) // Save #2 fails
      .mockImplementationOnce(() => Promise.resolve()); // the eventual Retry succeeds
    const coordinator = makeCoordinator(save, 2000);
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID); // Save #1
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['saving', 'saved']); // Save #1's own idle-reset timer is now pending

    await vi.advanceTimersByTimeAsync(500); // well before Save #1's 2000ms deadline
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID); // Save #2 begins — reports 'saving' synchronously
    expect(statuses.at(-1)).toBe('saving');
    await vi.advanceTimersByTimeAsync(0); // let Save #2's rejection settle
    expect(statuses.at(-1)).toBe('error');

    // Advance past where Save #1's original timer would have fired (500 + 1500 = 2000ms from Save #1).
    await vi.advanceTimersByTimeAsync(1500);
    // The stale timer must never fire — status must still read 'error', not be clobbered to 'idle'.
    expect(statuses.at(-1)).toBe('error');

    // Retry is still available and functional.
    coordinator.retry('sid-1', attachmentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('saved');

    vi.useRealTimers();
  });

  it('Save #2 succeeding schedules its own idle-reset timer; nothing fires before its own deadline', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockReturnValueOnce(Promise.resolve()).mockReturnValueOnce(Promise.resolve());
    const coordinator = makeCoordinator(save, 2000);
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID); // Save #1 succeeds
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['saving', 'saved']);

    await vi.advanceTimersByTimeAsync(1000); // halfway to Save #1's own idle deadline
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID); // Save #2 begins — cancels Save #1's timer
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('saved'); // Save #2 also succeeded, scheduling its OWN new timer

    // Advance to where Save #1's ORIGINAL timer would have fired (1000ms elapsed + 1000ms more) —
    // it must not, since dispatchNext() cancelled it the instant Save #2 began.
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses.at(-1)).toBe('saved'); // still 'saved' — Save #2's own timer isn't due yet either

    // Advance to Save #2's own 2000ms deadline (started at t=1000, due at t=3000; we're at t=2000 now).
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses.at(-1)).toBe('idle'); // only Save #2's own timer ever produces idle
    expect(statuses).toEqual(['saving', 'saved', 'saving', 'saved', 'idle']);

    vi.useRealTimers();
  });

  it('a Retry begun while an earlier Saved timer would otherwise still be pending is not clobbered', async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve()) // Save #1 succeeds
      .mockImplementationOnce(() => Promise.reject(new Error('fails once'))) // Save #2 fails
      .mockImplementationOnce(() => Promise.resolve()); // Retry succeeds
    const coordinator = makeCoordinator(save, 2000);
    const { statuses, attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['saving', 'saved']);

    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID); // Save #2, immediately after Save #1's success
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('error');

    coordinator.retry('sid-1', attachmentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('saved');

    // Advance well past where Save #1's original timer would have fired — only Retry's own success
    // and its own idle-reset are in play now, nothing stale from Save #1.
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses.at(-1)).toBe('idle');

    vi.useRealTimers();
  });
});

describe('NavigationWriteCoordinator — detach() drops this scope\'s own unsent work (Blocker 3)', () => {
  it('a pending-but-unsent layout is dropped immediately on detach, even if nothing attaches afterward', async () => {
    const inFlight = deferred<void>();
    const save = vi.fn(() => inFlight.promise);
    const coordinator = makeCoordinator(save);
    const { attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID); // dispatched, in flight
    coordinator.submit(LAYOUT_B, 'sid-1', attachmentId, ALWAYS_VALID); // queued, never sent

    coordinator.detach('sid-1', attachmentId); // sid-1 signs out — nothing else attaches afterward

    inFlight.resolve(); // the already-issued A1 request settles normally
    await inFlight.promise;
    await Promise.resolve();
    await Promise.resolve();

    // LAYOUT_B was dropped at detach — it must never be dispatched, even after the in-flight
    // request that was ahead of it in the queue settles.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A, ALWAYS_VALID);
  });

  it('Retry is unavailable immediately after detach — nothing can retry a detached scope\'s failure', async () => {
    const save = vi.fn().mockReturnValueOnce(Promise.reject(new Error('fails')));
    const coordinator = makeCoordinator(save);
    const { attachmentId } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', attachmentId, ALWAYS_VALID);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    coordinator.detach('sid-1', attachmentId);
    coordinator.retry('sid-1', attachmentId); // sid-1/this attachment is no longer attached — no-op

    expect(save).toHaveBeenCalledTimes(1); // no resubmission
  });
});

describe('NavigationWriteCoordinator — user isolation', () => {
  it('User A\'s in-flight settlement never leaks into User B\'s attached status', async () => {
    const aInFlight = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(aInFlight.promise).mockResolvedValueOnce(undefined);
    const coordinator = makeCoordinator(save);
    const { attachmentId: attachmentA } = attachRecorder(coordinator, 'sid-userA-1');

    coordinator.submit(LAYOUT_A, 'sid-userA-1', attachmentA, ALWAYS_VALID);

    // User A signs out, User B (a different person entirely) signs in.
    const { statuses: statusesB, attachmentId: attachmentB } = attachRecorder(coordinator, 'sid-userB-1');
    coordinator.submit(LAYOUT_C, 'sid-userB-1', attachmentB, ALWAYS_VALID);

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
    const { attachmentId: attachmentA } = attachRecorder(coordinator, 'sid-userA-1');

    coordinator.submit(LAYOUT_A, 'sid-userA-1', attachmentA, ALWAYS_VALID); // dispatched
    coordinator.submit(LAYOUT_B, 'sid-userA-1', attachmentA, ALWAYS_VALID); // queued, User A's own second edit

    attachRecorder(coordinator, 'sid-userB-1'); // User B attaches — discards A's queued edit (Case A)

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(LAYOUT_A, ALWAYS_VALID); // B never receives A's queued layout
  });
});

// A full NavLayoutScope remount can happen while the very same Supabase session stays active (e.g.
// a full top-level App remount) — producing two distinct *attachments* that share one identical
// `sessionId`. This describe block is specifically what the previous round's cross-lifecycle tests
// above did NOT cover (they all used a genuinely different sessionId for the "new" side): every
// case here keeps `sessionId` fixed at 'sid-1' throughout and varies only `attachmentId`.
describe('NavigationWriteCoordinator — same-session remount (attachment identity)', () => {
  it('an old attachment\'s late success is never reported into a new attachment sharing the same sessionId', async () => {
    const a1 = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { statuses: statusesOld, attachmentId: oldAttachment } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', oldAttachment, ALWAYS_VALID); // old attachment's write is on the wire
    coordinator.detach('sid-1', oldAttachment); // old scope unmounts — the write is already in flight

    // New scope mounts under the *same* sessionId — a distinct attachment.
    const { statuses: statusesNew } = attachRecorder(coordinator, 'sid-1');

    a1.resolve(); // the old attachment's request finally settles successfully
    await a1.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(statusesNew).not.toContain('saved'); // the new attachment never sees the old one's success
    expect(statusesOld).toEqual(['saving']); // the old (detached) recorder never received anything further
  });

  it('an old attachment\'s late failure is never reported into a new attachment sharing the same sessionId', async () => {
    const a1 = deferred<never>();
    const save = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { attachmentId: oldAttachment } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', oldAttachment, ALWAYS_VALID);
    coordinator.detach('sid-1', oldAttachment);

    const { statuses: statusesNew } = attachRecorder(coordinator, 'sid-1'); // new attachment, same sessionId

    a1.reject(new Error('stale network failure')); // the old attachment's request finally fails
    await a1.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    // The false-error/nonfunctional-Retry scenario Codex reproduced is impossible: the new
    // attachment never even sees an 'error' it didn't cause, so there's no broken Retry to worry
    // about — nothing was ever reported into it in the first place.
    expect(statusesNew).not.toContain('error');
    expect(statusesNew).toEqual([]);
  });

  it('a new attachment cannot Retry an old attachment\'s failed layout, even sharing the same sessionId', async () => {
    const save = vi.fn().mockReturnValueOnce(Promise.reject(new Error('old attachment failed')));
    const coordinator = makeCoordinator(save);
    const { attachmentId: oldAttachment } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', oldAttachment, ALWAYS_VALID);
    await Promise.resolve().catch(() => {});
    await Promise.resolve();

    const { statuses: statusesNew, attachmentId: newAttachment } = attachRecorder(coordinator, 'sid-1');
    coordinator.retry('sid-1', newAttachment); // the new attachment has nothing of its own to retry

    expect(save).toHaveBeenCalledTimes(1); // no resubmission of the old attachment's layout
    expect(statusesNew).toEqual([]);
  });

  it('same-session remount while an old request is in flight: the new attachment\'s write waits, and wire order is old -> new', async () => {
    const oldInFlight = deferred<void>();
    const verifyOld = () => true;
    const verifyNew = () => true;
    const save = vi.fn().mockReturnValueOnce(oldInFlight.promise).mockReturnValueOnce(Promise.resolve());
    const coordinator = makeCoordinator(save);
    const { attachmentId: oldAttachment } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', oldAttachment, verifyOld); // old attachment's write is on the wire
    coordinator.detach('sid-1', oldAttachment); // old scope unmounts mid-flight

    const { statuses: statusesNew, attachmentId: newAttachment } = attachRecorder(coordinator, 'sid-1');
    coordinator.submit(LAYOUT_C, 'sid-1', newAttachment, verifyNew); // new attachment's own edit — queued

    expect(save).toHaveBeenCalledTimes(1); // the new attachment's write has NOT gone out yet

    oldInFlight.resolve(); // the old attachment's already-issued request settles
    await oldInFlight.promise;
    await Promise.resolve();
    await Promise.resolve();

    // Wire order: old attachment's request first, new attachment's second — never concurrently.
    expect(save.mock.calls).toEqual([
      [LAYOUT_A, verifyOld],
      [LAYOUT_C, verifyNew],
    ]);
    // Status ownership: the old attachment's settlement never reported into the new one, and the
    // new attachment's own eventual save IS what it sees.
    expect(statusesNew).toEqual(['saving', 'saved']);
  });

  it('a stale detach() bound to an old attachment id cannot detach a newer attachment sharing the same sessionId', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const coordinator = makeCoordinator(save);
    const { attachmentId: oldAttachment } = attachRecorder(coordinator, 'sid-1');
    const { statuses: statusesNew, attachmentId: newAttachment } = attachRecorder(coordinator, 'sid-1'); // supersedes oldAttachment

    // A stale/delayed cleanup bound to the OLD attachment id fires after the new one is already current.
    coordinator.detach('sid-1', oldAttachment);

    // The new attachment must still be fully attached and usable.
    coordinator.submit(LAYOUT_A, 'sid-1', newAttachment, ALWAYS_VALID);
    expect(statusesNew).toEqual(['saving']);
  });

  it('mirrors React StrictMode setup -> cleanup -> setup: two attach() calls for the same sessionId, the second stays live', () => {
    const save = vi.fn(() => new Promise(() => {}));
    const coordinator = makeCoordinator(save);

    // setup #1
    const { attachmentId: attachment1 } = attachRecorder(coordinator, 'sid-1');
    // React's simulated cleanup for setup #1
    coordinator.detach('sid-1', attachment1);
    // setup #2 — the live, current attachment
    const { statuses: statuses2, attachmentId: attachment2 } = attachRecorder(coordinator, 'sid-1');

    expect(attachment2).not.toBe(attachment1); // distinct identities despite the identical sessionId

    coordinator.submit(LAYOUT_A, 'sid-1', attachment2, ALWAYS_VALID);
    expect(statuses2).toEqual(['saving']); // setup #2 is the one left live and usable

    // A stale attempt to act as setup #1 is correctly rejected.
    coordinator.submit(LAYOUT_B, 'sid-1', attachment1, ALWAYS_VALID);
    expect(save).toHaveBeenCalledTimes(1); // LAYOUT_B was never sent — attachment1 is no longer attached
  });

  it('an old attachment\'s Saved -> Idle timer cannot report idle into a new attachment sharing the same sessionId', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockReturnValueOnce(Promise.resolve()).mockReturnValueOnce(new Promise(() => {}));
    const coordinator = makeCoordinator(save, 2000);
    const { attachmentId: oldAttachment } = attachRecorder(coordinator, 'sid-1');

    coordinator.submit(LAYOUT_A, 'sid-1', oldAttachment, ALWAYS_VALID); // old attachment succeeds
    await vi.advanceTimersByTimeAsync(0); // schedules the old attachment's own idle-reset timer

    coordinator.detach('sid-1', oldAttachment); // old scope unmounts — detach() cancels its own timer

    const { statuses: statusesNew, attachmentId: newAttachment } = attachRecorder(coordinator, 'sid-1');
    coordinator.submit(LAYOUT_B, 'sid-1', newAttachment, ALWAYS_VALID); // new attachment's own in-flight save

    await vi.advanceTimersByTimeAsync(2000); // well past where the OLD timer would have fired
    // The new attachment must never see a spurious 'idle' that isn't its own — it's still 'saving'
    // (its own save() call was left permanently pending by this test on purpose).
    expect(statusesNew).toEqual(['saving']);

    vi.useRealTimers();
  });
});

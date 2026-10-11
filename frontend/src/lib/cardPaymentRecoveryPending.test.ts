// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryActionRequest } from './api';
import {
  COORDINATION_WAIT_MS,
  isInFlight,
  markInFlight,
  notePendingOperation,
  PENDING_FORMAT,
  pendingStorageKey,
  readPendingOperation,
  recordPendingOperation,
  resolvePendingOperation,
  subscribePendingOperations,
} from './cardPaymentRecoveryPending';

// The record of a payment-review change whose outcome is not known (I3A-R packet 2-A, correction C2): written
// before the request is sent, kept until the server answers that operation, one user's never another's, never
// replaced, never dropped on its own, and never trusted when it cannot be read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
const K = '33333333-3333-4333-8333-333333333333';
const W = '44444444-4444-4444-8444-444444444444';

const request = (operationId: string, over: Partial<RecoveryActionRequest> = {}): RecoveryActionRequest => ({
  operationId,
  expectedInputVersion: 7,
  expectedReviewRevision: 3,
  action: { type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: -250 },
  ...over,
});
const record = (ownerUserId: string, operationId: string) => recordPendingOperation({ ownerUserId, operationId, label: 'Match these two', request: request(operationId) });
const raw = (ownerUserId: string) => localStorage.getItem(pendingStorageKey(ownerUserId));

/**
 * A stand-in for the browser's Web Locks API, which jsdom does not have: one holder per lock name, the others
 * wait in turn, and a waiting request ends when its signal aborts. It lets these tests run the coordinated code.
 * It is NOT evidence of what a browser guarantees.
 */
function installWebLocks() {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const request = vi.fn(
    (name: string, options: { mode?: string; signal?: AbortSignal }, callback: (lock: { name: string; mode: string }) => unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const run = () => {
          Promise.resolve()
            .then(() => callback({ name, mode: options.mode ?? 'exclusive' }))
            .then(resolve, reject)
            .finally(() => {
              const next = queues.get(name)?.shift();
              if (next) next();
              else held.delete(name);
            });
        };
        if (!held.has(name)) {
          held.add(name);
          run();
          return;
        }
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        queue.push(run);
        options.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(run);
          if (at < 0) return;
          queue.splice(at, 1);
          reject(new DOMException('The request was aborted.', 'AbortError'));
        });
      })
  );
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request } });
  return request;
}

beforeEach(() => {
  localStorage.clear();
  installWebLocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis.navigator, 'locks');
});

describe('recorded before it is sent', () => {
  it('nothing recorded: none', async () => {
    expect(readPendingOperation(A)).toEqual({ kind: 'none' });
  });

  it('keeps the user, the operation id, the label and the request EXACTLY as given — the versions seen, the action, an accepted difference', async () => {
    expect(await record(A, OP1)).toEqual({ ok: true });
    const read = readPendingOperation(A);
    expect(read.kind).toBe('pending');
    if (read.kind !== 'pending') return;
    expect(read.operation).toMatchObject({ format: PENDING_FORMAT, ownerUserId: A, operationId: OP1, label: 'Match these two', status: 'sending', last: 'none' });
    expect(read.operation.request).toEqual(request(OP1));
    expect(read.operation.request.action).toEqual({ type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: -250 });
    expect(Number.isNaN(Date.parse(read.operation.recordedAt))).toBe(false);
  });

  it('is in the browser\'s storage under that user, and holds nothing but what reconciliation needs', async () => {
    await record(A, OP1);
    expect(Object.keys(localStorage)).toEqual([`my-finances:card-payment-recovery:pending:v1:${A}`]);
    const stored = JSON.parse(raw(A) ?? '{}');
    expect(Object.keys(stored).sort()).toEqual(['format', 'label', 'last', 'operationId', 'ownerUserId', 'recordedAt', 'request', 'status']);
    expect(Object.keys(stored.request).sort()).toEqual(['action', 'expectedInputVersion', 'expectedReviewRevision', 'operationId']);
    expect(raw(A)).not.toMatch(/token|bearer|password|secret|session|eyJ/i);
  });

  it.each([
    ['confirm_unlinked', { type: 'confirm_unlinked', transactionId: K }],
    ['dismiss_candidate', { type: 'dismiss_candidate', transactionId: K, candidateTransactionId: W }],
    ['undo_decision', { type: 'undo_decision', decisionId: W }],
    ['reject_suggestion', { type: 'reject_suggestion', transactionId: K, candidateTransactionId: W }],
    ['defer', { type: 'defer', transactionId: K }],
  ] as const)('every action the review can send is kept and read back unchanged: %s', async (_name, action) => {
    const wanted = request(OP1, { action });
    expect(await recordPendingOperation({ ownerUserId: A, operationId: OP1, label: 'x', request: wanted })).toEqual({ ok: true });
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.request).toEqual(wanted);
  });

  it('a request this version could not read back is not recorded (so it is not sent)', async () => {
    const bad = { ...request(OP1), action: { type: 'pair_current', transactionId: K, counterpartTransactionId: 'not-an-id', acceptedDifferenceCents: 0 } } as RecoveryActionRequest;
    expect(await recordPendingOperation({ ownerUserId: A, operationId: OP1, label: 'x', request: bad })).toEqual({ ok: false, reason: 'storage_failed' });
    expect(raw(A)).toBeNull();
    expect(await recordPendingOperation({ ownerUserId: A, operationId: OP1, label: 'x', request: request(OP2) })).toEqual({ ok: false, reason: 'storage_failed' });
    expect(raw(A)).toBeNull();
  });
});

describe('never replaced, never dropped on its own', () => {
  it('ANOTHER operation of the same user is refused while one is unresolved, and the first is byte for byte as it was', async () => {
    await record(A, OP1);
    const before = raw(A);
    expect(await record(A, OP2)).toEqual({ ok: false, reason: 'another_operation_pending' });
    expect(raw(A)).toBe(before);
  });

  it('the same operation id with a DIFFERENT request is refused too: an id names one intent', async () => {
    await record(A, OP1);
    const before = raw(A);
    expect(await recordPendingOperation({ ownerUserId: A, operationId: OP1, label: 'x', request: request(OP1, { expectedInputVersion: 8 }) })).toEqual({ ok: false, reason: 'another_operation_pending' });
    expect(raw(A)).toBe(before);
  });

  it('recording the SAME operation again is accepted and keeps when it was first recorded and what was last found', async () => {
    await record(A, OP1);
    await notePendingOperation(A, OP1, 'unknown', 'no_record');
    const first = readPendingOperation(A);
    expect(await record(A, OP1)).toEqual({ ok: true });
    const again = readPendingOperation(A);
    expect(first.kind === 'pending' && again.kind === 'pending' && again.operation.recordedAt === first.operation.recordedAt && again.operation.last === 'no_record').toBe(true);
  });

  it('nothing expires: a record made years ago is still the unresolved operation', async () => {
    await record(A, OP1);
    localStorage.setItem(pendingStorageKey(A), JSON.stringify({ ...JSON.parse(raw(A) ?? '{}'), recordedAt: '2019-01-01T00:00:00.000Z' }));
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.operationId).toBe(OP1);
    expect(await record(A, OP2)).toEqual({ ok: false, reason: 'another_operation_pending' });
  });

  it('noting "no answer" or "no record yet" changes those two fields and nothing else', async () => {
    await record(A, OP1);
    const before = JSON.parse(raw(A) ?? '{}');
    expect(await notePendingOperation(A, OP1, 'unknown', 'no_record')).toEqual({ ok: true });
    expect(JSON.parse(raw(A) ?? '{}')).toEqual({ ...before, status: 'unknown', last: 'no_record' });
  });

  it('a note or a resolution for ANOTHER operation id does nothing', async () => {
    await record(A, OP1);
    const before = raw(A);
    expect(await notePendingOperation(A, OP2, 'unknown', 'unreachable')).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(await resolvePendingOperation(A, OP2)).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(raw(A)).toBe(before);
  });

  it('only the server\'s answer to THAT operation removes it: resolved by its own id, then nothing is left and another change can be recorded', async () => {
    await record(A, OP1);
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: true });
    expect(readPendingOperation(A)).toEqual({ kind: 'none' });
    expect(Object.keys(localStorage)).toEqual([]);
    expect(await record(A, OP2)).toEqual({ ok: true });
  });
});

describe('one user\'s record is never another\'s', () => {
  it('another user sees nothing of it, records and resolves their own, and cannot resolve or note the first user\'s', async () => {
    await record(A, OP1);
    const before = raw(A);
    expect(readPendingOperation(B)).toEqual({ kind: 'none' });
    expect(await record(B, OP2)).toEqual({ ok: true });
    expect(await resolvePendingOperation(B, OP1)).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(await notePendingOperation(B, OP1, 'unknown', 'no_record')).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(await resolvePendingOperation(B, OP2)).toEqual({ ok: true });
    expect(raw(A)).toBe(before);
    const back = readPendingOperation(A);
    expect(back.kind === 'pending' && back.operation.operationId).toBe(OP1);
  });

  it('an entry filed under one user that names another user inside is not that user\'s record: unreadable, and left alone', async () => {
    await record(A, OP1);
    const moved = raw(A) ?? '';
    localStorage.clear();
    localStorage.setItem(pendingStorageKey(B), moved);
    expect(readPendingOperation(B)).toEqual({ kind: 'unusable', reason: 'unreadable_record' });
    expect(await record(B, OP2)).toEqual({ ok: false, reason: 'unreadable_record' });
    expect(raw(B)).toBe(moved);
  });
});

describe('a record that cannot be read is not trusted, not overwritten and not deleted', () => {
  type Stored = Record<string, any>;
  /** A record exactly as the module writes it. */
  const goodRecord = async (): Promise<Stored> => {
    await record(A, OP1);
    const value = JSON.parse(raw(A) ?? '{}');
    localStorage.clear();
    return value;
  };
  it.each([
    ['not JSON', (_good: Stored) => '{"format":1,"ownerUserId"'],
    ['a format this version does not know', (good: Stored) => JSON.stringify({ ...good, format: 2 })],
    ['a field too many', (good: Stored) => JSON.stringify({ ...good, accessToken: 'x' })],
    ['a field missing', (good: Stored) => JSON.stringify((({ label: _label, ...rest }: Stored) => rest)(good))],
    ['an operation id that is not an id', (good: Stored) => JSON.stringify({ ...good, operationId: 'op-1' })],
    ['a request for another operation id', (good: Stored) => JSON.stringify({ ...good, request: { ...good.request, operationId: OP2 } })],
    ['an action this version cannot send', (good: Stored) => JSON.stringify({ ...good, request: { ...good.request, action: { type: 'retire_record', transactionId: K } } })],
    ['an action with a field too many', (good: Stored) => JSON.stringify({ ...good, request: { ...good.request, action: { type: 'defer', transactionId: K, userId: B } } })],
    ['a version that is not a whole number', (good: Stored) => JSON.stringify({ ...good, request: { ...good.request, expectedInputVersion: 7.5 } })],
    ['an accepted difference that is not a whole number of cents', (good: Stored) => JSON.stringify({ ...good, request: { ...good.request, action: { ...good.request.action, acceptedDifferenceCents: 2.5 } } })],
    ['a status this version does not know', (good: Stored) => JSON.stringify({ ...good, status: 'forgotten' })],
    ['a date that is not a date', (good: Stored) => JSON.stringify({ ...good, recordedAt: 'yesterday' })],
    ['an empty value', (_good: Stored) => ''],
  ] as Array<[string, (good: Stored) => string]>)('%s', async (_name, make) => {
    const broken = make(await goodRecord());
    localStorage.clear();
    localStorage.setItem(pendingStorageKey(A), broken);
    expect(readPendingOperation(A)).toEqual({ kind: 'unusable', reason: 'unreadable_record' });
    expect(await record(A, OP2)).toEqual({ ok: false, reason: 'unreadable_record' });
    expect(await notePendingOperation(A, OP1, 'unknown', 'no_record')).toEqual({ ok: false, reason: 'unreadable_record' });
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: false, reason: 'unreadable_record' });
    expect(raw(A)).toBe(broken);
    // It is this user's problem only.
    expect(readPendingOperation(B)).toEqual({ kind: 'none' });
  });
});

describe('when the browser cannot keep it, nothing is recorded — there is no fallback', () => {
  it('no storage at all (blocked for this page): unusable, and a change is refused', async () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(readPendingOperation(A)).toEqual({ kind: 'unusable', reason: 'storage_unavailable' });
    expect(await record(A, OP1)).toEqual({ ok: false, reason: 'storage_unavailable' });
    expect(await notePendingOperation(A, OP1, 'unknown', 'none')).toEqual({ ok: false, reason: 'storage_unavailable' });
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: false, reason: 'storage_unavailable' });
  });

  it('storage that is full: refused, and nothing is left behind', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(await record(A, OP1)).toEqual({ ok: false, reason: 'storage_failed' });
    vi.restoreAllMocks();
    expect(readPendingOperation(A)).toEqual({ kind: 'none' });
  });

  it('storage that accepts and does not keep: refused (what was written must read back)', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(await record(A, OP1)).toEqual({ ok: false, reason: 'storage_failed' });
  });

  it('a record that cannot be removed stays the unresolved operation', async () => {
    await record(A, OP1);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: false, reason: 'storage_failed' });
    vi.restoreAllMocks();
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.operationId).toBe(OP1);
  });

  it('reading that fails is "unavailable", never "none"', async () => {
    await record(A, OP1);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readPendingOperation(A)).toEqual({ kind: 'unusable', reason: 'storage_unavailable' });
  });
});

describe('everyone who shows it hears when it changes', () => {
  it('a listener is told of a record, a note, a resolution and an in-flight change — and no longer after it unsubscribes', async () => {
    const heard = vi.fn();
    const stop = subscribePendingOperations(heard);
    await record(A, OP1);
    expect(heard).toHaveBeenCalledTimes(1);
    await notePendingOperation(A, OP1, 'unknown', 'no_record');
    expect(heard).toHaveBeenCalledTimes(2);
    markInFlight(A, OP1, true);
    markInFlight(A, OP1, false);
    expect(heard).toHaveBeenCalledTimes(4);
    await resolvePendingOperation(A, OP1);
    expect(heard).toHaveBeenCalledTimes(5);
    stop();
    await record(A, OP2);
    expect(heard).toHaveBeenCalledTimes(5);
  });

  it('a refused write tells no one (nothing changed)', async () => {
    await record(A, OP1);
    const heard = vi.fn();
    const stop = subscribePendingOperations(heard);
    await record(A, OP2);
    await resolvePendingOperation(A, OP2);
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it('one listener that throws does not keep the others from hearing', async () => {
    const heard = vi.fn();
    const stopBad = subscribePendingOperations(() => {
      throw new Error('listener failed');
    });
    const stop = subscribePendingOperations(heard);
    expect(await record(A, OP1)).toEqual({ ok: true });
    expect(heard).toHaveBeenCalledTimes(1);
    stopBad();
    stop();
  });

  it('a change made in ANOTHER tab reaches this one (the browser\'s storage event), and unrelated storage does not', async () => {
    const heard = vi.fn();
    const stop = subscribePendingOperations(heard);
    window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key' }));
    expect(heard).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: pendingStorageKey(A) }));
    expect(heard).toHaveBeenCalledTimes(1);
    // Storage cleared as a whole (key null): everything may have changed.
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('what a reload keeps and what it does not', () => {
  it('"on its way" is per user and operation, and belongs to the page that sent it', async () => {
    markInFlight(A, OP1, true);
    expect(isInFlight(A, OP1)).toBe(true);
    expect(isInFlight(B, OP1)).toBe(false);
    expect(isInFlight(A, OP2)).toBe(false);
    markInFlight(A, OP1, false);
    expect(isInFlight(A, OP1)).toBe(false);
  });

  it('a FRESH copy of the module (a reload, an app update) finds the record in the browser — and nothing "on its way"', async () => {
    await record(A, OP1);
    markInFlight(A, OP1, true);
    vi.resetModules();
    const fresh = await import('./cardPaymentRecoveryPending');
    const read = fresh.readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation).toMatchObject({ operationId: OP1, status: 'sending' });
    expect(read.kind === 'pending' && read.operation.request).toEqual(request(OP1));
    expect(fresh.isInFlight(A, OP1)).toBe(false);
    // And it is still never replaced.
    expect(await fresh.recordPendingOperation({ ownerUserId: A, operationId: OP2, label: 'x', request: request(OP2) })).toEqual({ ok: false, reason: 'another_operation_pending' });
    markInFlight(A, OP1, false);
  });

  it('storage the user cleared is gone: none — this module cannot bring back what was erased', async () => {
    await record(A, OP1);
    localStorage.clear();
    expect(readPendingOperation(A)).toEqual({ kind: 'none' });
  });
});

// ---- v4: every change of one user's entry is made one at a time, across tabs ------------------------------
// Two tabs of the same user share the entry. A change is a read, a decision and a write: unless nothing else can
// change the entry in between, a tab decides on what is no longer there. The module takes an exclusive lock of
// that user's journal (Web Locks) around the whole of it and reads AGAIN inside. These tests put another tab's
// change exactly in that gap.

const LOCK = (ownerUserId: string) => `my-finances:card-payment-recovery:pending-journal:v1:${ownerUserId}`;
const requestY = request(OP2, { expectedInputVersion: 8, action: { type: 'defer', transactionId: K } });
type Tab = typeof import('./cardPaymentRecoveryPending');
/** Another tab: its own copy of the app's code, the same browser storage and the same lock manager. */
async function anotherTab(): Promise<Tab> {
  vi.resetModules();
  return import('./cardPaymentRecoveryPending');
}
const recordY = (tab: Tab, ownerUserId = A) => tab.recordPendingOperation({ ownerUserId, operationId: OP2, label: 'Decide later', request: requestY });
/** Runs `step` ONCE: when this user's entry has just been read, and before anything is done with what was read. */
function rightAfterTheNextRead(ownerUserId: string, step: () => void) {
  const original = Storage.prototype.getItem;
  let done = false;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    const value = original.call(this, key);
    if (!done && key === pendingStorageKey(ownerUserId)) {
      done = true;
      step();
    }
    return value;
  });
}
/** Holds this user's journal lock, as a tab does while it changes the entry, until `release` is called. */
async function holdTheJournal(ownerUserId: string) {
  let release!: () => void;
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = navigator.locks.request(LOCK(ownerUserId), { mode: 'exclusive' }, () => {
    entered();
    return until;
  });
  await holding;
  return { release, done };
}
const settled = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('two tabs of the same user: the entry is changed by one of them at a time', () => {
  it('ADMISSION — both tabs saw no entry; while one records X, the other tries Y: exactly ONE is admitted, X is not overwritten, Y is refused', async () => {
    const tabB = await anotherTab();
    // What each tab saw before it acted: nothing recorded.
    expect(readPendingOperation(A)).toEqual({ kind: 'none' });
    expect(tabB.readPendingOperation(A)).toEqual({ kind: 'none' });
    let y: ReturnType<typeof recordY> | undefined;
    // Tab B's attempt lands exactly between tab A's read of the entry and tab A's write of X.
    rightAfterTheNextRead(A, () => {
      y = recordY(tabB);
    });
    const x = await record(A, OP1);
    const other = await y;
    expect([x.ok, other?.ok].filter(Boolean), 'exactly one of the two competing changes may be admitted (an admitted change is sent)').toHaveLength(1);
    expect(x).toEqual({ ok: true });
    expect(other).toEqual({ ok: false, reason: 'another_operation_pending' });
    // X is the durable entry, with its exact request: Y did not overwrite it.
    const read = tabB.readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.operationId).toBe(OP1);
    expect(read.kind === 'pending' && read.operation.request).toEqual(request(OP1));
  });

  it('STALE RESOLUTION — while one tab resolves X, another has resolved X and recorded Y: the late resolution of X does not remove Y', async () => {
    const tabB = await anotherTab();
    await record(A, OP1);
    let others: Promise<unknown> | undefined;
    // Exactly between tab A's read of the entry (X) and tab A's removal: tab B resolves X on the server's answer
    // and records the user's next change, Y.
    rightAfterTheNextRead(A, () => {
      others = Promise.all([tabB.resolvePendingOperation(A, OP1), recordY(tabB)]);
    });
    await resolvePendingOperation(A, OP1);
    await others;
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.operationId, 'Y must still be the recorded operation after the late resolution of X').toBe(OP2);
    expect(read.kind === 'pending' && read.operation).toMatchObject({ ownerUserId: A, operationId: OP2, label: 'Decide later', status: 'sending', last: 'none', request: requestY });
  });

  it('STALE UPDATE — while one tab notes "no answer" for X, another has resolved X and recorded Y: the late note does not put X back over Y, and does not touch Y', async () => {
    const tabB = await anotherTab();
    await record(A, OP1);
    let others: Promise<unknown> | undefined;
    rightAfterTheNextRead(A, () => {
      others = Promise.all([tabB.resolvePendingOperation(A, OP1), recordY(tabB)]);
    });
    await notePendingOperation(A, OP1, 'unknown', 'unreachable');
    await others;
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.operationId, 'Y must still be the recorded operation after the late note for X').toBe(OP2);
    // Y exactly as it was recorded: not downgraded to "unknown", nothing of X's note on it.
    expect(read.kind === 'pending' && read.operation).toMatchObject({ ownerUserId: A, operationId: OP2, status: 'sending', last: 'none', request: requestY });
  });

  it('a late result for X that reaches the journal AFTER Y was recorded changes nothing and says so', async () => {
    const tabB = await anotherTab();
    await record(A, OP1);
    await tabB.resolvePendingOperation(A, OP1);
    await recordY(tabB);
    const before = raw(A);
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(await notePendingOperation(A, OP1, 'unknown', 'no_record')).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(raw(A)).toBe(before);
  });
});

describe('how the exclusion is taken: the browser\'s Web Locks, one lock per user\'s journal', () => {
  it('recording, noting and resolving each take THAT user\'s journal lock, exclusively — and no other lock', async () => {
    const request = installWebLocks();
    await record(A, OP1);
    await notePendingOperation(A, OP1, 'unknown', 'no_record');
    await resolvePendingOperation(A, OP1);
    await record(B, OP2);
    expect(request.mock.calls.map(([name, options]) => [name, options.mode])).toEqual([
      [LOCK(A), 'exclusive'],
      [LOCK(A), 'exclusive'],
      [LOCK(A), 'exclusive'],
      [LOCK(B), 'exclusive'],
    ]);
  });

  it('a change WAITS for the tab that is changing the entry, and reads the entry again when its turn comes', async () => {
    const holder = await holdTheJournal(A);
    const waiting = recordY(await anotherTab());
    let answered = false;
    void waiting.then(() => {
      answered = true;
    });
    await settled();
    expect(answered).toBe(false);
    // What the holding tab writes while it holds the lock: X. (Written by this test in the form the module writes.)
    const x = { format: PENDING_FORMAT, ownerUserId: A, operationId: OP1, label: 'Match these two', request: request(OP1), status: 'sending', last: 'none', recordedAt: '2026-10-10T00:00:00.000Z' };
    localStorage.setItem(pendingStorageKey(A), JSON.stringify(x));
    holder.release();
    expect(await waiting).toEqual({ ok: false, reason: 'another_operation_pending' });
    expect(raw(A)).toBe(JSON.stringify(x));
  });

  it('a resolution and a note that waited find another operation in X\'s place when their turn comes: nothing is removed or written', async () => {
    await record(A, OP1);
    const holder = await holdTheJournal(A);
    const lateResolution = resolvePendingOperation(A, OP1);
    const lateNote = notePendingOperation(A, OP1, 'unknown', 'unreachable');
    await settled();
    // While they wait, the holding tab resolves X and records Y.
    const y = { format: PENDING_FORMAT, ownerUserId: A, operationId: OP2, label: 'Decide later', request: requestY, status: 'sending', last: 'none', recordedAt: '2026-10-10T00:00:01.000Z' };
    localStorage.setItem(pendingStorageKey(A), JSON.stringify(y));
    holder.release();
    expect(await lateResolution).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(await lateNote).toEqual({ ok: false, reason: 'not_this_operation' });
    expect(raw(A)).toBe(JSON.stringify(y));
  });

  it('one user\'s journal lock does not hold up another user\'s change', async () => {
    const holder = await holdTheJournal(A);
    expect(await record(B, OP2)).toEqual({ ok: true });
    holder.release();
    await holder.done;
  });

  it('the lock is held for the change itself and nothing else: what runs inside it returns at once, not a promise', async () => {
    const real = installWebLocks();
    const returned: unknown[] = [];
    const watching = vi.fn((name: string, options: { mode?: string; signal?: AbortSignal }, callback: (lock: { name: string; mode: string }) => unknown) =>
      real(name, options, (lock) => {
        const value = callback(lock);
        returned.push(value);
        return value;
      })
    );
    Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request: watching } });
    await record(A, OP1);
    await notePendingOperation(A, OP1, 'unknown', 'none');
    await resolvePendingOperation(A, OP1);
    expect(returned).toHaveLength(3);
    for (const value of returned) expect(typeof (value as { then?: unknown } | undefined)?.then).not.toBe('function');
  });

  it('a failure inside a change releases the lock: the next change is not held up', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(await record(A, OP1)).toEqual({ ok: false, reason: 'storage_failed' });
    expect(await record(A, OP1)).toEqual({ ok: true });
  });
});

describe('when the exclusion cannot be had, nothing is changed — there is no uncoordinated fallback', () => {
  const withoutLocks = (value: unknown) => Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value });

  it.each([
    ['a browser without Web Locks', () => withoutLocks(undefined)],
    ['a lock manager that is not one', () => withoutLocks({})],
    [
      'a browser that refuses the lock (a rejected request)',
      () =>
        withoutLocks({
          request: () => Promise.reject(new DOMException('The request was denied.', 'SecurityError')),
        }),
    ],
    [
      'a lock manager that throws',
      () =>
        withoutLocks({
          request: () => {
            throw new DOMException('The document is not fully active.', 'InvalidStateError');
          },
        }),
    ],
  ])('%s: a new change is refused (so it is not sent), and an existing record is neither noted nor removed', async (_name, breakIt) => {
    await record(A, OP1);
    const before = raw(A);
    breakIt();
    expect(await recordY(await anotherTab(), B)).toEqual({ ok: false, reason: 'coordination_unavailable' });
    expect(raw(B)).toBeNull();
    expect(await record(A, OP1)).toEqual({ ok: false, reason: 'coordination_unavailable' });
    expect(await notePendingOperation(A, OP1, 'unknown', 'no_record')).toEqual({ ok: false, reason: 'coordination_unavailable' });
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: false, reason: 'coordination_unavailable' });
    // The record is exactly as it was, and is still read (reading needs no lock).
    expect(raw(A)).toBe(before);
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation.operationId).toBe(OP1);
  });

  it('a lock that does not come in time: refused, nothing written — and the change does NOT happen later when the lock is free', async () => {
    vi.useFakeTimers();
    try {
      await record(A, OP1);
      const before = raw(A);
      const holder = await holdTheJournal(A);
      const tabB = await anotherTab();
      const lateY = recordY(tabB);
      const lateResolution = resolvePendingOperation(A, OP1);
      await vi.advanceTimersByTimeAsync(COORDINATION_WAIT_MS + 1);
      expect(await lateY).toEqual({ ok: false, reason: 'coordination_unavailable' });
      expect(await lateResolution).toEqual({ ok: false, reason: 'coordination_unavailable' });
      expect(raw(A)).toBe(before);
      // The holder lets go. A wait that was given up is over: it does not act on the entry afterwards.
      holder.release();
      await holder.done;
      await settled();
      expect(raw(A)).toBe(before);
      // Waiting too long is not an answer of the server: the operation is still the unresolved one.
      const read = readPendingOperation(A);
      expect(read.kind === 'pending' && read.operation.operationId).toBe(OP1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a record written before this version is still that user\'s unresolved operation', () => {
  it('the v3 form is read, noted and resolved as it is — nothing is cleared because the code changed', async () => {
    // Exactly what v3 wrote (same key, same eight fields, format 1).
    const v3 = `{"format":1,"ownerUserId":"${A}","operationId":"${OP1}","label":"Match these two","request":{"operationId":"${OP1}","expectedInputVersion":5,"expectedReviewRevision":3,"action":{"type":"pair_current","transactionId":"${K}","counterpartTransactionId":"${W}","acceptedDifferenceCents":0}},"status":"unknown","last":"no_record","recordedAt":"2026-10-10T07:21:59.600Z"}`;
    localStorage.setItem(`my-finances:card-payment-recovery:pending:v1:${A}`, v3);
    const read = readPendingOperation(A);
    expect(read.kind === 'pending' && read.operation).toMatchObject({ operationId: OP1, status: 'unknown', last: 'no_record', recordedAt: '2026-10-10T07:21:59.600Z' });
    expect(read.kind === 'pending' && read.operation.request.expectedInputVersion).toBe(5);
    expect(await recordY(await anotherTab())).toEqual({ ok: false, reason: 'another_operation_pending' });
    expect(raw(A)).toBe(v3);
    expect(await notePendingOperation(A, OP1, 'unknown', 'unreachable')).toEqual({ ok: true });
    expect(JSON.parse(raw(A) ?? '{}')).toEqual({ ...JSON.parse(v3), last: 'unreachable' });
    expect(await resolvePendingOperation(A, OP1)).toEqual({ ok: true });
    expect(raw(A)).toBeNull();
  });
});

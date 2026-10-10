import { describe, expect, it, vi } from 'vitest';

// The worker imports the service, which imports the Supabase client; no test here reaches it (every call is
// injected), and the worker itself must not read the environment at all.
vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: vi.fn() } }));
const envRead = vi.hoisted(() => ({ count: 0 }));
vi.mock('../config/env', () => ({
  get env() {
    envRead.count += 1;
    return { cardPaymentSyncEvaluationEnabled: false };
  },
}));

import {
  createRecoveryWorker,
  RECOVERY_WORKER_CLAIM_LIMIT,
  RECOVERY_WORKER_ERROR_BACKOFF_MS,
  RECOVERY_WORKER_MAX_BACKOFF_MS,
  RECOVERY_WORKER_POLL_INTERVAL_MS,
  type RecoveryWorkerDeps,
} from './cardPaymentRecoveryWorker';
import type { RecoveryClaim, RecoveryRefreshStatus, RecoveryResult } from '../services/cardPaymentRecovery';

const claimOf = (n: number): RecoveryClaim => ({ userId: `user-${n}`, leaseToken: `lease-${n}`, targetVersion: n, attempts: 0 });
const ok = <T,>(value: T): RecoveryResult<T> => ({ kind: 'ok', value });

/** A hand-driven scheduler: `schedule` records the request; `fire()` runs the pending one. */
function harness(over: Partial<RecoveryWorkerDeps> = {}) {
  const scheduled: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const logs: Array<{ message: string; detail: Record<string, unknown> }> = [];
  const deps: RecoveryWorkerDeps = {
    claim: vi.fn(async () => ok<RecoveryClaim[]>([])),
    refresh: vi.fn(async () => ok<{ status: RecoveryRefreshStatus }>({ status: 'fresh' })),
    schedule: (run, delayMs) => {
      const entry = { run, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    log: (message, detail) => logs.push({ message, detail }),
    ...over,
  };
  const pending = () => scheduled.filter((s) => !s.cancelled);
  return { deps, scheduled, logs, pending };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('one poll', () => {
  it('claims once with its token and the bounded limit, then refreshes each claim with its own lease', async () => {
    const h = harness({ claim: vi.fn(async () => ok([claimOf(1), claimOf(2), claimOf(3)])) });
    const worker = createRecoveryWorker({ deps: h.deps, workerToken: 'worker-a' });
    const summary = await worker.runOnce();
    expect(h.deps.claim).toHaveBeenCalledTimes(1);
    expect(h.deps.claim).toHaveBeenCalledWith('worker-a', RECOVERY_WORKER_CLAIM_LIMIT);
    expect(vi.mocked(h.deps.refresh).mock.calls).toEqual([
      ['user-1', 'lease-1'],
      ['user-2', 'lease-2'],
      ['user-3', 'lease-3'],
    ]);
    expect(summary).toEqual({ claim: 'ok', claimed: 3, fresh: 3, pending: 0, superseded: 0, leaseLost: 0, unanswered: 0 });
  });

  it('never asks for more than ten claims, whatever it is configured with', async () => {
    const h = harness();
    await createRecoveryWorker({ deps: h.deps, claimLimit: 500 }).runOnce();
    expect(h.deps.claim).toHaveBeenCalledWith(expect.any(String), 10);
    expect(RECOVERY_WORKER_CLAIM_LIMIT).toBe(10);
  });

  it('never refreshes more than was asked for, nor the same owner twice in one poll, whatever came back', async () => {
    const many = Array.from({ length: 30 }, (_, i) => claimOf(i));
    const h = harness({ claim: vi.fn(async () => ok([claimOf(1), claimOf(1), ...many])) });
    const summary = await createRecoveryWorker({ deps: h.deps, claimLimit: 4 }).runOnce();
    expect(summary.claimed).toBe(4);
    const owners = vi.mocked(h.deps.refresh).mock.calls.map(([user]) => user);
    expect(new Set(owners).size).toBe(owners.length);
    expect(owners).toHaveLength(4);
  });

  it('runs at most `concurrency` refreshes at a time', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const h = harness({
      claim: vi.fn(async () => ok(Array.from({ length: 7 }, (_, i) => claimOf(i)))),
      refresh: vi.fn(
        () =>
          new Promise<RecoveryResult<{ status: RecoveryRefreshStatus }>>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            release.push(() => {
              active -= 1;
              resolve(ok({ status: 'fresh' as const }));
            });
          })
      ),
    });
    const run = createRecoveryWorker({ deps: h.deps, concurrency: 2 }).runOnce();
    for (let done = 0; done < 7; done += 1) {
      await settle();
      expect(active).toBeLessThanOrEqual(2);
      release.shift()!();
    }
    expect((await run).fresh).toBe(7);
    expect(peak).toBe(2);
  });

  it('counts what each refresh answered; a failed one is NOT retried in the poll — the work stays in the queue', async () => {
    const answers: Array<RecoveryResult<{ status: RecoveryRefreshStatus }>> = [
      ok({ status: 'fresh' }),
      ok({ status: 'pending' }),
      ok({ status: 'superseded' }),
      ok({ status: 'lease_lost' }),
      { kind: 'outcome_unknown' },
      { kind: 'unavailable', reason: 'request_failed' },
    ];
    const h = harness({
      claim: vi.fn(async () => ok(answers.map((_, i) => claimOf(i)))),
      refresh: vi.fn(async (userId: string) => answers[Number(userId.slice(5))]),
    });
    const summary = await createRecoveryWorker({ deps: h.deps, concurrency: 1 }).runOnce();
    expect(summary).toEqual({ claim: 'ok', claimed: 6, fresh: 1, pending: 1, superseded: 1, leaseLost: 1, unanswered: 2 });
    expect(h.deps.refresh).toHaveBeenCalledTimes(6);
  });

  it('a refresh that throws does not stop the others', async () => {
    const h = harness({
      claim: vi.fn(async () => ok([claimOf(1), claimOf(2), claimOf(3)])),
      refresh: vi.fn(async (userId: string) => {
        if (userId === 'user-2') throw new Error('socket hang up');
        return ok({ status: 'fresh' as const });
      }),
    });
    expect(await createRecoveryWorker({ deps: h.deps, concurrency: 1 }).runOnce()).toMatchObject({ claimed: 3, fresh: 2, unanswered: 1 });
  });

  it('when the queue cannot be read nothing is refreshed, and the log carries a code, not a message', async () => {
    const h = harness({ claim: vi.fn(async (): Promise<RecoveryResult<RecoveryClaim[]>> => ({ kind: 'unavailable', reason: 'objects_missing' })) });
    const summary = await createRecoveryWorker({ deps: h.deps }).runOnce();
    expect(summary).toMatchObject({ claim: 'unreachable', claimed: 0 });
    expect(h.deps.refresh).not.toHaveBeenCalled();
    expect(h.logs).toEqual([{ message: expect.stringContaining('could not be read'), detail: { outcome: 'unavailable', reason: 'objects_missing' } }]);
  });

  it('a claim that throws is the same: unreachable, nothing refreshed, never a rejection', async () => {
    const h = harness({
      claim: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    await expect(createRecoveryWorker({ deps: h.deps }).runOnce()).resolves.toMatchObject({ claim: 'unreachable' });
  });
});

describe('the loop', () => {
  it('start polls AT ONCE — outstanding work is found on restart without waiting for anything', async () => {
    const h = harness({ claim: vi.fn(async () => ok([claimOf(1)])) });
    const worker = createRecoveryWorker({ deps: h.deps });
    worker.start();
    await settle();
    expect(h.deps.claim).toHaveBeenCalledTimes(1);
    expect(h.deps.refresh).toHaveBeenCalledWith('user-1', 'lease-1');
    await worker.stop();
  });

  it('after a quiet poll it waits the poll interval; after a full batch it asks again at once', async () => {
    const batches = [Array.from({ length: 10 }, (_, i) => claimOf(i)), [claimOf(11)], []];
    const h = harness({ claim: vi.fn(async () => ok(batches.shift() ?? [])) });
    const worker = createRecoveryWorker({ deps: h.deps });
    worker.start();
    await settle();
    expect(h.pending().at(-1)?.delayMs).toBe(0);
    h.pending().at(-1)!.run();
    await settle();
    expect(h.pending().at(-1)?.delayMs).toBe(RECOVERY_WORKER_POLL_INTERVAL_MS);
    await worker.stop();
  });

  it('while the queue is unreachable it backs off, doubling, at most five minutes — and recovers by itself', async () => {
    let reachable = false;
    const h = harness({ claim: vi.fn(async (): Promise<RecoveryResult<RecoveryClaim[]>> => (reachable ? ok([]) : { kind: 'unavailable', reason: 'request_failed' })) });
    const worker = createRecoveryWorker({ deps: h.deps });
    worker.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await settle();
      const next = h.scheduled.at(-1)!;
      delays.push(next.delayMs);
      next.run();
    }
    expect(delays.slice(0, 5)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000].map((ms) => Math.min(ms, RECOVERY_WORKER_MAX_BACKOFF_MS)));
    expect(delays[0]).toBe(RECOVERY_WORKER_ERROR_BACKOFF_MS);
    expect(Math.max(...delays)).toBe(RECOVERY_WORKER_MAX_BACKOFF_MS);
    reachable = true;
    await settle();
    h.scheduled.at(-1)!.run();
    await settle();
    expect(h.scheduled.at(-1)!.delayMs).toBe(RECOVERY_WORKER_POLL_INTERVAL_MS);
    await worker.stop();
  });

  it('stop cancels the next poll and waits for the one in flight', async () => {
    let finish!: () => void;
    const h = harness({
      claim: vi.fn(async () => ok([claimOf(1)])),
      refresh: vi.fn(() => new Promise<RecoveryResult<{ status: RecoveryRefreshStatus }>>((resolve) => (finish = () => resolve(ok({ status: 'fresh' as const }))))),
    });
    const worker = createRecoveryWorker({ deps: h.deps });
    worker.start();
    await settle();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    await settle();
    expect(h.pending()).toHaveLength(0);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);
  });

  it('start twice is one loop', async () => {
    const h = harness();
    const worker = createRecoveryWorker({ deps: h.deps });
    worker.start();
    worker.start();
    await settle();
    expect(h.deps.claim).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('two workers have two tokens: a restart never reuses a dead process\'s leases', async () => {
    const tokens: string[] = [];
    const claim = vi.fn(async (token: string) => {
      tokens.push(token);
      return ok<RecoveryClaim[]>([]);
    });
    await createRecoveryWorker({ deps: harness({ claim }).deps }).runOnce();
    await createRecoveryWorker({ deps: harness({ claim }).deps }).runOnce();
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('independence', () => {
  it('does not read the environment: no sync flag, and no other flag, can switch its work off once started', async () => {
    const before = envRead.count;
    const h = harness({ claim: vi.fn(async () => ok([claimOf(1)])) });
    const worker = createRecoveryWorker({ deps: h.deps });
    worker.start();
    await settle();
    await worker.stop();
    expect(envRead.count).toBe(before);
    expect(h.deps.refresh).toHaveBeenCalledTimes(1);
  });
});

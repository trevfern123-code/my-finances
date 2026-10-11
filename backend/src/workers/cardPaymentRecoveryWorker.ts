import { randomUUID } from 'node:crypto';
import {
  claimRecoveryRefresh,
  refreshRecoveryOwner,
  type RecoveryClaim,
  type RecoveryRefreshStatus,
  type RecoveryResult,
} from '../services/cardPaymentRecovery';

/**
 * The durable refresh worker (Financial Semantics Phase B, I3A-R packet 2-A; PHASE_B_I3A_R_PACKET_2A_REVIEW.md §8).
 *
 * WHAT IT IS FOR. An owner under review must not stay without current figures because nothing happened to
 * trigger an evaluation. The database registers refresh work whenever such an owner's inputs change (a trigger,
 * in the writer's own transaction), when an action commits without a fresh evaluation, and when the owner asks.
 * This worker claims that work and has it evaluated. It is INDEPENDENT of bank syncs and of
 * `CARD_PAYMENT_SYNC_EVALUATION_ENABLED`: neither a sync nor that flag is needed for a refresh to happen.
 *
 * WHAT IT DOES, and nothing else. In a loop: one CLAIM call (a short transaction of its own: at most ten
 * leases), then one REFRESH call per claim (the evaluation, fenced by the lease). It holds no state that
 * matters: all work is rows in the database, so a restart loses nothing — the first poll after a start finds
 * whatever is outstanding, including work whose lease a dead worker left to expire. It never retries inside a
 * poll: a refresh that fails stays in the queue, where the database applies the back-off (5 s doubling, at most
 * five minutes) and, after eight failures in a row, stops handing the row out until the owner asks again.
 *
 * BOUNDS. At most `claimLimit` (≤ 10) claims per poll; at most `concurrency` refreshes at a time, and never two
 * for one owner (a claim is one row per owner); every call has a timeout shorter than the 120 s lease; the
 * database's own lock wait inside a refresh is limited to 10 s. A refresh that this worker stopped waiting for
 * may still finish on the server: its acknowledgement is fenced there, so it cannot remove newer work.
 *
 * WHAT A RESULT MEANS. Nothing here decides freshness, and nothing here is reported to a user: the database's
 * versions decide what is current. The summary of a poll is for logs and tests.
 *
 * When the recovery functions are missing (the migration is not applied) the worker logs that once per
 * occurrence and waits longer before asking again; it never stops by itself.
 */

export const RECOVERY_WORKER_POLL_INTERVAL_MS = 5_000;
export const RECOVERY_WORKER_CLAIM_LIMIT = 10;
export const RECOVERY_WORKER_CONCURRENCY = 2;
/** After a poll that could not reach the queue at all: wait this long, doubling, at most five minutes. */
export const RECOVERY_WORKER_ERROR_BACKOFF_MS = 15_000;
export const RECOVERY_WORKER_MAX_BACKOFF_MS = 5 * 60_000;

export interface RecoveryWorkerDeps {
  claim: (workerToken: string, limit: number) => Promise<RecoveryResult<RecoveryClaim[]>>;
  refresh: (userId: string, leaseToken: string) => Promise<RecoveryResult<{ status: RecoveryRefreshStatus }>>;
  /** Schedules the next poll; returns a function that cancels it. */
  schedule: (run: () => void, delayMs: number) => () => void;
  log: (message: string, detail: Record<string, unknown>) => void;
}

export interface RecoveryWorkerOptions {
  pollIntervalMs?: number;
  claimLimit?: number;
  concurrency?: number;
  deps?: Partial<RecoveryWorkerDeps>;
  /** Tests only: a fixed worker token. */
  workerToken?: string;
}

export interface RecoveryPollSummary {
  /** `ok`: the queue was reached. `unreachable`: the claim obtained no usable answer; nothing was claimed. */
  claim: 'ok' | 'unreachable';
  claimed: number;
  fresh: number;
  pending: number;
  superseded: number;
  leaseLost: number;
  /** Refresh calls that obtained no usable answer or whose outcome is unknown. The work stays queued. */
  unanswered: number;
}

export interface RecoveryWorker {
  /** Polls now, then keeps polling. Idempotent. */
  start(): void;
  /** Stops scheduling and resolves when the poll in flight, if any, has finished. */
  stop(): Promise<void>;
  /** One claim and its refreshes. Never throws. */
  runOnce(): Promise<RecoveryPollSummary>;
}

const defaultSchedule: RecoveryWorkerDeps['schedule'] = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  // The worker must never keep the process alive on its own.
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function createRecoveryWorker(options: RecoveryWorkerOptions = {}): RecoveryWorker {
  const pollIntervalMs = options.pollIntervalMs ?? RECOVERY_WORKER_POLL_INTERVAL_MS;
  const claimLimit = Math.max(1, Math.min(options.claimLimit ?? RECOVERY_WORKER_CLAIM_LIMIT, RECOVERY_WORKER_CLAIM_LIMIT));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? RECOVERY_WORKER_CONCURRENCY, claimLimit));
  const deps: RecoveryWorkerDeps = {
    claim: options.deps?.claim ?? ((token, limit) => claimRecoveryRefresh(token, limit)),
    refresh: options.deps?.refresh ?? ((userId, leaseToken) => refreshRecoveryOwner(userId, leaseToken)),
    schedule: options.deps?.schedule ?? defaultSchedule,
    log: options.deps?.log ?? ((message, detail) => console.warn(message, detail)),
  };
  // A new token per process start: a lease taken by an earlier process is simply left to expire.
  const workerToken = options.workerToken ?? randomUUID();

  let running = false;
  let cancelNext: (() => void) | null = null;
  let inFlight: Promise<RecoveryPollSummary> | null = null;
  let consecutiveUnreachable = 0;

  async function runOnce(): Promise<RecoveryPollSummary> {
    const summary: RecoveryPollSummary = { claim: 'ok', claimed: 0, fresh: 0, pending: 0, superseded: 0, leaseLost: 0, unanswered: 0 };
    let claims: RecoveryClaim[];
    try {
      const claimed = await deps.claim(workerToken, claimLimit);
      if (claimed.kind !== 'ok') {
        summary.claim = 'unreachable';
        deps.log('Recovery worker: the refresh queue could not be read; nothing was claimed', {
          outcome: claimed.kind,
          reason: claimed.kind === 'unavailable' ? claimed.reason : claimed.kind === 'refused' ? claimed.code : 'unknown',
        });
        return summary;
      }
      // Never more than was asked for, whatever came back; never the same owner twice in one poll.
      const seen = new Set<string>();
      claims = claimed.value.filter((c) => (seen.has(c.userId) ? false : (seen.add(c.userId), true))).slice(0, claimLimit);
    } catch {
      summary.claim = 'unreachable';
      deps.log('Recovery worker: the claim threw; nothing was claimed', { outcome: 'request_failed' });
      return summary;
    }
    summary.claimed = claims.length;

    // A fixed number of lanes, each taking the next claim: at most `concurrency` refreshes at a time.
    let next = 0;
    const lane = async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= claims.length) return;
        const claim = claims[index];
        try {
          const result = await deps.refresh(claim.userId, claim.leaseToken);
          if (result.kind !== 'ok') {
            // No answer, or an unknown outcome: the work is still in the queue under its lease, which expires.
            summary.unanswered += 1;
            deps.log('Recovery worker: a refresh obtained no usable answer; the work stays queued', {
              outcome: result.kind,
              reason: result.kind === 'unavailable' ? result.reason : result.kind === 'refused' ? result.code : 'unknown',
            });
          } else if (result.value.status === 'fresh') summary.fresh += 1;
          else if (result.value.status === 'pending') summary.pending += 1;
          else if (result.value.status === 'superseded') summary.superseded += 1;
          else summary.leaseLost += 1;
        } catch {
          summary.unanswered += 1;
          deps.log('Recovery worker: a refresh threw; the work stays queued', { outcome: 'request_failed' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, lane));
    return summary;
  }

  function scheduleNext(delayMs: number) {
    if (!running) return;
    cancelNext = deps.schedule(() => {
      cancelNext = null;
      void poll();
    }, delayMs);
  }

  async function poll() {
    if (!running || inFlight !== null) return;
    inFlight = runOnce();
    let summary: RecoveryPollSummary;
    try {
      summary = await inFlight;
    } finally {
      inFlight = null;
    }
    if (summary.claim === 'unreachable') {
      consecutiveUnreachable += 1;
      scheduleNext(Math.min(RECOVERY_WORKER_ERROR_BACKOFF_MS * 2 ** Math.min(consecutiveUnreachable - 1, 10), RECOVERY_WORKER_MAX_BACKOFF_MS));
      return;
    }
    consecutiveUnreachable = 0;
    // A full batch means more may be waiting: ask again at once. Otherwise wait for the poll interval.
    scheduleNext(summary.claimed >= claimLimit ? 0 : pollIntervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      // The first poll runs now: whatever was outstanding before this process started is found here.
      void poll();
    },
    async stop() {
      running = false;
      cancelNext?.();
      cancelNext = null;
      if (inFlight !== null) await inFlight.catch(() => undefined);
    },
    runOnce,
  };
}

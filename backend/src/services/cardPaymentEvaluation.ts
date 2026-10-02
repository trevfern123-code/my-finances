import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';

/**
 * End-of-sync card-payment matching evaluation (Financial Semantics Phase B, packet 2b-2a;
 * CARD_PAYMENT_PAIRING_DESIGN.md §3.7 "Where it runs").
 *
 * One best-effort call of the existing `try_evaluate_card_payments(user)` RPC (migration
 * 20260930120000). It recomputes the matching states of the WHOLE user — every account and item, not
 * only the item that just synced — and publishes them stamped with the input version it read under its
 * locks. This module never changes the sync cursor, a transaction, a classification, a matching input
 * or a version counter itself; the RPC writes only derived matching state and its own bookkeeping.
 *
 * What a result means — and does not mean:
 * - `evaluated`: that evaluation committed fresh states for the inputs committed before it. Any input
 *   change committed afterwards (a concurrent sync of another item, a user action) bumps the version
 *   and makes the states unreadable again until the next evaluation. It is NOT a guarantee that
 *   matching is fresh "after this sync", and nothing reports it as one.
 * - every other outcome: the user's states stay (or become) stale. Readers never see stale states as
 *   fresh — that is enforced by the version mechanism in the database, not by this call. The next
 *   successful sync tries again; there is no retry loop here and no background recovery (retry-on-read
 *   and evaluation after other user actions are later Phase B work).
 *
 * Disabled (the default: `CARD_PAYMENT_SYNC_EVALUATION_ENABLED` is not "true", compared case-insensitively
 * with surrounding whitespace ignored): no RPC call at all, so no Phase B database object is required.
 *
 * Frequency: one call per successful item sync. A manual sync of a user with K items runs K item syncs in
 * turn, so it makes K whole-user evaluations. Each one is invalidated by the next item's batch, and only the
 * last can leave the user fresh.
 *
 * The call never throws: false results, returned PostgREST errors, a missing function, rejected
 * requests, timeouts and unexpected responses all resolve to an outcome and a sanitized log line (an
 * outcome plus an error code or error name — never a message, payload or user data).
 *
 * Timeout: the request is abandoned after `CARD_PAYMENT_EVALUATION_TIMEOUT_MS` through the
 * installed postgrest-js `abortSignal()` support. Abandoning the request stops the CLIENT waiting; it is
 * not proof that the server rolled back. The server-side evaluation may still finish and commit
 * (publishing states for the inputs it read) or fail and roll back — either way the version mechanism
 * keeps reads correct, and the sync is unaffected.
 */

/**
 * 10 s.
 * - **Measured locally** (PHASE_B_MATCHING_ENGINE_HANDOFF.md §10, synthetic data, median of 5): a
 *   full-user evaluation takes ~0.14 s at 10k transactions and ~0.29 s at 20k. Slice 2a measured
 *   ~0.7 s at 50k.
 * - **Headroom:** 10 s is about 30× the 20k-row time, leaving room for network latency and a cold
 *   cache. Real users are far smaller today (221 transactions in the last 12 months at the 2026-09-26
 *   audit).
 * - **What it bounds:** only how long one sync can be held up by a slow or hung evaluation. A timeout
 *   leaves the user stale, never wrong.
 */
export const CARD_PAYMENT_EVALUATION_TIMEOUT_MS = 10_000;

export type CardPaymentEvaluationOutcome =
  /** The flag is off: no RPC call was made. */
  | 'disabled'
  /** The RPC returned true: an evaluation committed. */
  | 'evaluated'
  /** The RPC returned false: the evaluation failed and rolled back alone; the database recorded a
   *  sanitized SQLSTATE in card_payment_eval_versions.last_error_code. */
  | 'evaluation_failed'
  /** The flag is on but the database has no try_evaluate_card_payments: a configuration/dependency
   *  problem (the Phase B migrations are not applied), not an evaluation failure. */
  | 'rpc_missing'
  /** PostgREST returned another error. */
  | 'rpc_error'
  /** The request was abandoned after the timeout (outcome on the server unknown). */
  | 'timeout'
  /** The request never got a response: a network failure (the installed postgrest-js resolves it as an
   *  error with HTTP status 0 and no code), or a value thrown by the client. */
  | 'request_failed'
  /** A response that is neither true nor false. */
  | 'unexpected_response';

/** PostgREST's "function not found in the schema cache", and PostgreSQL's undefined_function. */
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883']);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownThrownValue';
}

export async function evaluateCardPaymentsAfterSync(
  userId: string,
  options: { enabled?: boolean; timeoutMs?: number } = {}
): Promise<CardPaymentEvaluationOutcome> {
  const enabled = options.enabled ?? env.cardPaymentSyncEvaluationEnabled;
  if (!enabled) return 'disabled';

  const timeoutMs = options.timeoutMs ?? CARD_PAYMENT_EVALUATION_TIMEOUT_MS;
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const { data, error, status } = await supabaseAdmin
      .rpc('try_evaluate_card_payments', { p_user_id: userId })
      .abortSignal(signal);

    if (error) {
      const code = errorCode(error);
      if (signal.aborted) {
        console.warn('Card-payment matching evaluation timed out after sync; matching stays stale until a later evaluation', {
          outcome: 'timeout',
          timeoutMs,
        });
        return 'timeout';
      }
      if (status === 0 && code === undefined) {
        // postgrest-js reports a fetch that never reached the server (without throwOnError) this way.
        console.warn('Card-payment matching evaluation request failed after sync; matching stays stale', {
          outcome: 'request_failed',
          errorName: 'FetchError',
        });
        return 'request_failed';
      }
      if (code !== undefined && MISSING_FUNCTION_CODES.has(code)) {
        console.warn(
          'Card-payment matching evaluation is enabled (CARD_PAYMENT_SYNC_EVALUATION_ENABLED) but the database has no ' +
            'try_evaluate_card_payments: apply the Phase B matching migrations or turn the flag off. No evaluation ran.',
          { outcome: 'rpc_missing', code }
        );
        return 'rpc_missing';
      }
      console.warn('Card-payment matching evaluation request returned an error after sync; matching stays stale', {
        outcome: 'rpc_error',
        code: code ?? 'none',
      });
      return 'rpc_error';
    }
    if (data === true) return 'evaluated';
    if (data === false) {
      console.warn(
        'Card-payment matching evaluation failed after sync (rolled back alone; the database recorded its SQLSTATE); matching stays stale',
        { outcome: 'evaluation_failed' }
      );
      return 'evaluation_failed';
    }
    console.warn('Card-payment matching evaluation returned an unexpected response after sync; treated as not evaluated', {
      outcome: 'unexpected_response',
      responseType: data === null ? 'null' : typeof data,
    });
    return 'unexpected_response';
  } catch (err) {
    if (signal?.aborted) {
      console.warn('Card-payment matching evaluation timed out after sync; matching stays stale until a later evaluation', {
        outcome: 'timeout',
        timeoutMs,
      });
      return 'timeout';
    }
    console.warn('Card-payment matching evaluation request failed after sync; matching stays stale', {
      outcome: 'request_failed',
      errorName: errorName(err),
    });
    return 'request_failed';
  }
}

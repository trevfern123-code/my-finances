import { supabaseAdmin } from '../config/supabase';
import type { CardLegStateInput, CardPaymentStates } from './semanticAggregation';

/**
 * The stored card-payment matching state, as the application reads it (Financial Semantics Phase B,
 * integration slice I1; CARD_PAYMENT_PAIRING_DESIGN.md §3.7 "Reading").
 *
 * - `parseCardPaymentStates` validates the payload of `get_card_payment_states` (migration
 *   20260930120000). The role-aware read path receives that payload INSIDE the financial snapshot
 *   (`financialSnapshot.ts`), so the states and the transactions they describe are one database
 *   snapshot. States are present ONLY when `evaluated_version = input_version`; otherwise
 *   `fresh = false` and no states.
 * - `readCardPaymentStates` calls the reader on its own. The read path uses it only as a cheap poll of
 *   the versions while it waits, briefly, for an evaluation that may already be running; it never
 *   computes a figure from this call.
 *
 * What an outcome means — and does not mean:
 * - `fresh` / `stale` are what the DATABASE said about the stored versions. Nothing else decides
 *   freshness: not an earlier evaluation's result, not elapsed time, not a completed sync.
 * - `unavailable` means THIS read obtained no usable answer (the function or table is missing, the
 *   request failed or timed out, or the answer was not in the expected shape). It establishes nothing
 *   about the stored state — not that it is stale, and not that it is fresh — so no figure may be
 *   computed from it, and no leg may be treated as matched or unmatched because of it. A timed-out
 *   read has simply not been answered; the caller reports the figures as unavailable and a later read
 *   tries again.
 *
 * The read never throws, retries, evaluates or writes. Failures are logged with an outcome and an
 * error code only — never a message, a payload or a user id.
 */

/** How long one state read may take before the client stops waiting. Both reads are single,
 *  index-backed statements over a handful of rows per month; this bounds a hung connection, nothing
 *  else. Abandoning the request says nothing about the stored state. */
export const CARD_PAYMENT_STATE_READ_TIMEOUT_MS = 10_000;

export type CardPaymentStateUnavailableReason =
  /** The database has no such function: the Phase B migrations are not applied. A configuration
   *  problem, not a stale state. */
  | 'objects_missing'
  /** PostgREST returned another error. */
  | 'request_error'
  /** The request was abandoned after the timeout. */
  | 'timeout'
  /** No usable response and the timeout had not fired: an error with HTTP status 0 and no code, or a
   *  thrown value. */
  | 'request_failed'
  /** A response that is not in the documented shape. */
  | 'unexpected_response';

export type CardPaymentStateRead =
  | {
      kind: 'fresh';
      /** The version the states were computed at; equal to the input version at this snapshot. */
      inputVersion: number;
      states: CardPaymentStates;
    }
  | {
      kind: 'stale';
      /** Null when the user has no version row yet (nothing was ever evaluated). */
      inputVersion: number | null;
      evaluatedVersion: number | null;
      /** The sanitized SQLSTATE of the last failed evaluation, if one is recorded. */
      lastErrorCode: string | null;
    }
  | { kind: 'unavailable'; reason: CardPaymentStateUnavailableReason };

/** PostgREST's "function not found in the schema cache", and PostgreSQL's undefined_function. */
const MISSING_OBJECT_CODES = new Set(['PGRST202', '42883']);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownThrownValue';
}

/** Logs why a read obtained no usable answer: an outcome and a code or error name, never a message. */
export function warnUnreadable(read: string, reason: CardPaymentStateUnavailableReason, detail: Record<string, unknown>): void {
  console.warn(`A Phase B read obtained no usable answer (${read}); the figures that depend on it are unavailable for this request`, {
    outcome: reason,
    ...detail,
  });
}
const warn = warnUnreadable;

/** Classifies an error a PostgREST call RETURNED. Shared with the financial snapshot read. */
export function classifyReadError(read: string, error: unknown, status: number | undefined, signal: AbortSignal): CardPaymentStateUnavailableReason {
  const code = errorCode(error);
  if (signal.aborted) {
    warn(read, 'timeout', {});
    return 'timeout';
  }
  if (status === 0 && code === undefined) {
    warn(read, 'request_failed', { errorName: 'FetchError' });
    return 'request_failed';
  }
  if (code !== undefined && MISSING_OBJECT_CODES.has(code)) {
    warn(read, 'objects_missing', { code });
    return 'objects_missing';
  }
  warn(read, 'request_error', { code: code ?? 'none' });
  return 'request_error';
}

/** Classifies a value a PostgREST call THREW. Shared with the financial snapshot read. */
export function classifyThrownRead(read: string, err: unknown, signal: AbortSignal | undefined): CardPaymentStateUnavailableReason {
  if (signal?.aborted) {
    warn(read, 'timeout', {});
    return 'timeout';
  }
  warn(read, 'request_failed', { errorName: errorName(err) });
  return 'request_failed';
}

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isVersionOrNull = (value: unknown): value is number | null => value === null || isVersion(value);
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One leg of the reader's payload, or null when it is not in the documented shape. Only the fields the
 *  aggregation reads are kept; labels and candidates are for the review UI (a later slice). */
function parseLeg(value: unknown): CardLegStateInput | null {
  if (!isRecord(value)) return null;
  const { transactionId, accountId, amountCents, side, accountIncluded, state, reason, effectCents, lowCents, highCents, cashExcessCents, cardExcessCents } =
    value;
  if (typeof transactionId !== 'string' || typeof accountId !== 'string') return null;
  if (typeof side !== 'string' || typeof state !== 'string' || typeof reason !== 'string') return null;
  if (typeof accountIncluded !== 'boolean') return null;
  if (!isCents(amountCents) || !isCents(lowCents) || !isCents(highCents) || !isCents(cashExcessCents) || !isCents(cardExcessCents)) return null;
  if (effectCents !== null && !isCents(effectCents)) return null;
  return { transactionId, accountId, amountCents, side, accountIncluded, state, reason, effectCents, lowCents, highCents, cashExcessCents, cardExcessCents };
}

/** The reader's `jsonb`, validated field by field. Anything outside the documented shape is
 *  `unexpected_response` — it is never coerced into a state. */
export function parseCardPaymentStates(payload: unknown): Exclude<CardPaymentStateRead, { kind: 'unavailable' }> | null {
  if (!isRecord(payload)) return null;
  const { fresh, inputVersion, evaluatedVersion } = payload;
  if (fresh === false) {
    // The key is absent from a fresh payload and may be null here.
    const lastErrorCode = payload.lastErrorCode ?? null;
    if (!isVersionOrNull(inputVersion ?? null) || !isVersionOrNull(evaluatedVersion ?? null)) return null;
    if (lastErrorCode !== null && typeof lastErrorCode !== 'string') return null;
    return {
      kind: 'stale',
      inputVersion: (inputVersion ?? null) as number | null,
      evaluatedVersion: (evaluatedVersion ?? null) as number | null,
      lastErrorCode: lastErrorCode === '' ? null : lastErrorCode,
    };
  }
  if (fresh !== true) return null;
  // "Fresh" is only what the database says together with equal versions: a payload claiming fresh
  // with different versions is not believed.
  if (!isVersion(inputVersion) || !isVersion(evaluatedVersion) || inputVersion !== evaluatedVersion) return null;
  if (!Array.isArray(payload.legs)) return null;
  const legs: CardLegStateInput[] = [];
  for (const raw of payload.legs) {
    const leg = parseLeg(raw);
    if (leg === null) return null;
    legs.push(leg);
  }
  // The reader builds the key with to_jsonb(uuid[]); a NULL array column would arrive as null.
  const superseded = payload.supersededTransactionIds ?? [];
  if (!Array.isArray(superseded) || !superseded.every((id) => typeof id === 'string')) return null;
  return { kind: 'fresh', inputVersion, states: { legs, supersededTransactionIds: superseded as string[] } };
}

export interface CardPaymentStateReadOptions {
  timeoutMs?: number;
}

/**
 * The stored states of the user's card-payment legs dated in [from, to) — `to` omitted for an
 * open-ended range. One snapshot. Never throws.
 */
export async function readCardPaymentStates(
  userId: string,
  range: { from: string; to?: string },
  options: CardPaymentStateReadOptions = {}
): Promise<CardPaymentStateRead> {
  const timeoutMs = options.timeoutMs ?? CARD_PAYMENT_STATE_READ_TIMEOUT_MS;
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const { data, error, status } = await supabaseAdmin
      .rpc('get_card_payment_states', { p_user_id: userId, p_from: range.from, p_to: range.to ?? null })
      .abortSignal(signal);
    if (error) return { kind: 'unavailable', reason: classifyReadError('card-payment states', error, status, signal) };
    const parsed = parseCardPaymentStates(data);
    if (parsed === null) {
      warn('card-payment states', 'unexpected_response', { responseType: data === null ? 'null' : typeof data });
      return { kind: 'unavailable', reason: 'unexpected_response' };
    }
    return parsed;
  } catch (err) {
    return { kind: 'unavailable', reason: classifyThrownRead('card-payment states', err, signal) };
  }
}

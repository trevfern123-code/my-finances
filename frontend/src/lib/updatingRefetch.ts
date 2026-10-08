/**
 * Financial Semantics Phase B, integration slice I2 — the client's refetch after an `updating`
 * answer (CARD_PAYMENT_PAIRING_DESIGN.md §6.2: "the client retries after `retryAfterMs`").
 *
 * `updating` means the server read the data but its card-payment matching state is not fresh, so it
 * withheld the figures and sent `retry_after_ms`. This client then asks AGAIN, by itself, a small
 * number of times. That is all it does: a read. It evaluates nothing and asks the server to evaluate
 * nothing; if matching becomes fresh some other way (a sync, an evaluation elsewhere), a later read
 * sees it. Nothing here applies to `unavailable`, a refusal, an integrity error or any failed
 * request: those wait for the user.
 *
 * Policy, the same for every view that can be `updating`:
 * - at most `UPDATING_REFETCH_MAX_ATTEMPTS` automatic refetches per load. A load is what the user,
 *   a range change or a sign-in started; the automatic refetches belong to it and never start a
 *   new one;
 * - each waits for the server's hint, kept within `[MIN, MAX]`, so a zero, tiny or absurd hint can
 *   neither spin nor stall;
 * - one timer and one request at a time: the next wait starts only when an answer has arrived;
 * - a new load, another query, a sign-in change or an unmount cancels the pending wait, and a late
 *   answer of a superseded request is dropped;
 * - figures stay withheld the whole time, and after the last attempt the view offers a manual retry.
 */
export const UPDATING_REFETCH_MAX_ATTEMPTS = 3;
export const UPDATING_REFETCH_MIN_DELAY_MS = 1_000;
export const UPDATING_REFETCH_MAX_DELAY_MS = 30_000;

/** How long to wait before refetching, from the server's `retry_after_ms`. */
export function updatingRefetchDelayMs(retryAfterMs: number): number {
  if (!Number.isFinite(retryAfterMs)) return UPDATING_REFETCH_MIN_DELAY_MS;
  return Math.min(Math.max(retryAfterMs, UPDATING_REFETCH_MIN_DELAY_MS), UPDATING_REFETCH_MAX_DELAY_MS);
}

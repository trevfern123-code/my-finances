/**
 * Financial Semantics Foundation, Phase A — bounded relational reconciliation.
 *
 * Stage 1 (transactionClassifier.ts's classifyCore, run at ingestion — see dataService.ts's
 * applyTransactionChanges) is pure and does no database work: a transaction whose true role
 * depends on evidence elsewhere (an internal-transfer counterpart leg) is always given a
 * complete, safe sign-based fallback role immediately, tagged `transfer_like_unconfirmed` — never
 * left unclassified. An ordinary negative amount classifies directly and finally as
 * `income`/`sign_default` — there is no separate "refund candidate" tag (Round 2 remediation §2);
 * reconciliation below independently reconsiders any `sign_default` negative row against real
 * refund evidence, with no classifier-level bookkeeping needed for that.
 *
 * Stage 2 is this module: `reconcileRelationalRoles`, called once per persisted sync/backfill
 * batch (right after it commits — see syncService.ts's own comment at the call site), which is
 * the ONLY place any relational (cross-transaction) database query happens for classification
 * purposes. Bounded by construction: every query is restricted to a fixed ±3-day (transfer) or
 * 120-day (refund) date window, and either a specific candidate id/account or a conservative
 * role_source tag — never a full-table scan, never O(N²).
 *
 * `repairExistingRelationalRoles` (Round 3 remediation §2/§3/§4/§6) is the second entry point,
 * replacing Round 2's `reconcileAroundTransactionChange`. That earlier approach captured the
 * changed transaction's OLD identity (account/amount/date) and searched for a stale counterpart
 * anchored on those old coordinates — which cannot survive a retry (a second sync attempt sees
 * the row already updated to its NEW values, so an old-vs-new comparison reports "unchanged" and
 * silently skips the repair forever), and cannot handle a Plaid DELETION at all (there is no "new
 * row" to compare against).
 *
 * The sweep-based design here needs no old-identity snapshot at all: whenever a sync batch
 * contains any modified or removed transaction (see syncService.ts's own comment at its call
 * site), this re-validates EVERY one of the user's EXISTING `account_pair_match`/`refund_match`
 * rows directly against CURRENT data, in bounded pages. For each `account_pair_match` row, it
 * re-runs the exact same candidate query originally used to establish that pairing, relative to
 * the row's own CURRENT (possibly just-changed) identity; if a unique valid counterpart no longer
 * exists, the row is reset to a fresh row-level classification. `refund_match` rows are
 * re-validated the same way against `findRefundOriginalCandidates`. This is naturally:
 *
 *  - retry-safe: the trigger is "did this batch touch anything," not "did a same-attempt
 *    before/after comparison detect a change" — a retry whose DB state already reflects the new
 *    values still re-triggers and still completes the sweep;
 *  - deletion-safe: a deleted row simply won't be found as a valid counterpart/original when the
 *    SURVIVING side of a pair re-validates itself — no separate deletion-specific logic needed;
 *  - symmetric: both members of a broken pair are independently caught on their own turn through
 *    the sweep, with no need to explicitly locate "the former partner."
 *
 * Both entry points support an `apply` flag: when false, every read/ranking step runs exactly as
 * normal, but no write ever happens — the function returns what it WOULD have done instead. This
 * is what backfillTransactionSemantics.ts's dry-run mode uses for a genuinely truthful relational
 * preview, reusing this module's own logic rather than a separate, divergence-prone
 * reimplementation. An optional `pool` parameter (Round 3 remediation §7) additionally lets a
 * caller supply same-batch, freshly-computed-but-not-yet-persisted classifications (backfill's
 * dry-run mode, where nothing is actually written) so a same-batch pair previews identically to
 * how it would resolve under `--apply` — see `mergeWithPool` below.
 *
 * Per the approved Phase A contract: a row with `user_role_override` set MAY still have its
 * `auto_role`/`role_source`/`role_confidence` refreshed here (auto_role keeps improving under an
 * override, so clearing the override later reveals the best available automatic classification,
 * not a stale one) — this module never reads or writes `user_role_override` itself.
 *
 * Ownership (Round 2 remediation §8): every call here is scoped to one `userId`, threaded through
 * to every underlying query — a wrong-user id can never be read, matched, or updated.
 */

import * as dataService from './dataService';
import { classifyRowLevel, CURRENT_CLASSIFIER_VERSION, type RoleConfidence, type SemanticRole } from './transactionClassifier';
import type { ReconciliationRow } from './dataService';

const TRANSFER_WINDOW_DAYS = 3;
const REFUND_WINDOW_DAYS = 120;
const REPAIR_PAGE_SIZE = 200;

export interface RoleFieldsUpdate {
  auto_role: SemanticRole;
  role_source: string;
  role_confidence: RoleConfidence;
  classifier_version: number;
}

/** One outcome the reconciliation pass produced or would produce — used both for real writes and
 *  for a truthful dry-run preview (see this module's own doc comment). */
export interface ReconciliationOutcome {
  id: string;
  fields: RoleFieldsUpdate;
}

export interface ReconciliationResult {
  /** Rows that were (or, in dry-run, would be) updated. */
  resolved: ReconciliationOutcome[];
  /** Ambiguous or evidence-free candidates considered but left unresolved, for dry-run reporting. */
  unresolved: { id: string; reason: 'ambiguous_transfer_candidates' | 'no_refund_evidence' | 'no_transfer_evidence' }[];
}

function addDaysUtc(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizedIdentity(row: { name: string; merchant_name: string | null }): string {
  return (row.merchant_name ?? row.name).trim().toLowerCase();
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / msPerDay;
}

function mergeResults(target: ReconciliationResult, extra: ReconciliationResult): void {
  target.resolved.push(...extra.resolved);
  target.unresolved.push(...extra.unresolved);
}

/** Overlays `pool` (same-batch, possibly-unwritten hypothetical rows) onto `dbRows`, pool entries
 *  winning on id collision — Round 3 remediation §7. Used both to see a same-batch row's OWN
 *  hypothetical state (instead of its stale/null pre-classification DB state) and to let a
 *  same-batch row serve as a CANDIDATE for another row's match even though it was never actually
 *  persisted this run. */
function mergeWithPool(dbRows: ReconciliationRow[], pool: ReconciliationRow[]): ReconciliationRow[] {
  if (pool.length === 0) return dbRows;
  const byId = new Map(dbRows.map((r) => [r.id, r]));
  for (const row of pool) byId.set(row.id, row);
  return Array.from(byId.values());
}

/**
 * Deterministic candidate ranking for a transfer counterpart (Round 2 remediation §4): among
 * candidates already filtered to an exact opposite-amount match within the window, prefer the
 * closest date. If two or more candidates are tied for closest date, the pair is genuinely
 * ambiguous and must NOT be guessed — stable id ordering is used only to make iteration
 * deterministic, never as grounds to accept an otherwise-tied match.
 */
function rankTransferCandidates(
  anchorDate: string,
  candidates: ReconciliationRow[]
): { winner: ReconciliationRow; confidence: RoleConfidence } | { ambiguous: true } | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const byDistance = daysBetween(anchorDate, a.date) - daysBetween(anchorDate, b.date);
    return byDistance !== 0 ? byDistance : a.id.localeCompare(b.id);
  });
  const best = sorted[0];
  const bestDistance = daysBetween(anchorDate, best.date);
  const tiedWithBest = sorted.filter((c) => daysBetween(anchorDate, c.date) === bestDistance);
  if (tiedWithBest.length > 1) return { ambiguous: true };
  return { winner: best, confidence: bestDistance === 0 ? 'high' : 'medium' };
}

/** Deterministic candidate ranking for a refund original (Round 2 remediation §6): among
 *  candidates already filtered to eligible ordinary expenses with a compatible amount, require a
 *  normalized name/merchant match first, then prefer an exact amount match over a partial one,
 *  then the closest prior date. A meaningful tie is left unresolved rather than guessed. */
function rankRefundCandidates(
  refundRow: { amount: number; date: string; name: string; merchant_name: string | null },
  candidates: ReconciliationRow[]
): { winner: ReconciliationRow; confidence: RoleConfidence } | { ambiguous: true } | null {
  const nameMatched = candidates.filter((c) => normalizedIdentity(c) === normalizedIdentity(refundRow));
  if (nameMatched.length === 0) return null;

  const refundAbs = Math.abs(refundRow.amount);
  const exact = nameMatched.filter((c) => c.amount === refundAbs);
  const pool = exact.length > 0 ? exact : nameMatched;

  const sorted = [...pool].sort((a, b) => {
    const byDistance = daysBetween(refundRow.date, a.date) - daysBetween(refundRow.date, b.date);
    return byDistance !== 0 ? byDistance : a.id.localeCompare(b.id);
  });
  const best = sorted[0];
  const bestDistance = daysBetween(refundRow.date, best.date);
  const tiedWithBest = sorted.filter((c) => daysBetween(refundRow.date, c.date) === bestDistance);
  if (tiedWithBest.length > 1) return { ambiguous: true };

  return { winner: best, confidence: exact.length > 0 ? 'high' : 'medium' };
}

/** Whether `row` is eligible to serve as a refund's original purchase (Round 3 remediation §5) —
 *  `effective_role` (the generated `coalesce(user_role_override, auto_role)` column), never
 *  `auto_role` alone, so a user override away from `expense` (e.g. `internal_transfer`) correctly
 *  disqualifies the row even though its underlying `auto_role` might still say `expense`. Used
 *  consistently by every eligibility check in this module: the forward pass, the dangling-refund
 *  pass, dry-run preview, and the repair sweep all call this one function. */
function isEligibleRefundOriginal(row: ReconciliationRow): boolean {
  return row.effective_role === 'expense' && row.manual_loan_id === null;
}

async function resolveTransferCandidate(
  userId: string,
  row: ReconciliationRow,
  apply: boolean,
  pool: ReconciliationRow[]
): Promise<ReconciliationResult> {
  const windowStart = addDaysUtc(row.date, -TRANSFER_WINDOW_DAYS);
  const windowEnd = addDaysUtc(row.date, TRANSFER_WINDOW_DAYS);
  const dbCandidates = await dataService.findTransferCounterpartCandidates(
    userId,
    row,
    windowStart,
    windowEnd,
    'transfer_like_unconfirmed'
  );
  // Mirrors findTransferCounterpartCandidates' own filter, applied in-memory to the same-batch
  // pool (Round 3 remediation §7) — a pool row can't be found by the DB query above since it was
  // never (or not yet) persisted with this role_source.
  const poolCandidates = pool.filter(
    (p) =>
      p.id !== row.id &&
      p.account_id !== row.account_id &&
      p.amount === -row.amount &&
      p.role_source === 'transfer_like_unconfirmed' &&
      p.date >= windowStart &&
      p.date <= windowEnd
  );
  const candidates = mergeWithPool(dbCandidates, poolCandidates);
  const ranked = rankTransferCandidates(row.date, candidates);

  if (ranked === null) return { resolved: [], unresolved: [{ id: row.id, reason: 'no_transfer_evidence' }] };
  if ('ambiguous' in ranked) return { resolved: [], unresolved: [{ id: row.id, reason: 'ambiguous_transfer_candidates' }] };

  const fields: RoleFieldsUpdate = {
    auto_role: 'internal_transfer',
    role_source: 'account_pair_match',
    role_confidence: ranked.confidence,
    classifier_version: CURRENT_CLASSIFIER_VERSION,
  };

  if (!apply) {
    return { resolved: [{ id: row.id, fields }, { id: ranked.winner.id, fields }], unresolved: [] };
  }

  // One atomic RPC call covering both ids — Round 3 remediation §1: ownership is verified and
  // both rows are locked and updated inside a single Postgres transaction, never two separate
  // requests that could leave the pair half-resolved if the second one failed.
  const ok = await dataService.applyTransactionSemanticRoles(userId, [row.id, ranked.winner.id], fields);
  if (!ok) {
    // The RPC's own integrity check failed (ownership mismatch, or a row no longer exists) — the
    // pair is NOT considered resolved. No partial state is left durable: the RPC either matched
    // both rows inside its own transaction or it rolled back entirely.
    return { resolved: [], unresolved: [{ id: row.id, reason: 'ambiguous_transfer_candidates' }] };
  }
  return { resolved: [{ id: row.id, fields }, { id: ranked.winner.id, fields }], unresolved: [] };
}

async function resolveRefundCandidate(
  userId: string,
  row: ReconciliationRow,
  apply: boolean,
  pool: ReconciliationRow[]
): Promise<ReconciliationResult> {
  const windowStart = addDaysUtc(row.date, -REFUND_WINDOW_DAYS);
  const dbCandidates = await dataService.findRefundOriginalCandidates(userId, row, windowStart);
  const poolCandidates = pool.filter(
    (p) =>
      p.id !== row.id &&
      p.account_id === row.account_id &&
      p.effective_role === 'expense' &&
      p.manual_loan_id === null &&
      p.amount >= Math.abs(row.amount) &&
      p.date >= windowStart &&
      p.date <= row.date
  );
  const candidates = mergeWithPool(dbCandidates, poolCandidates);
  const ranked = rankRefundCandidates(row, candidates);

  if (ranked === null) return { resolved: [], unresolved: [{ id: row.id, reason: 'no_refund_evidence' }] };
  if ('ambiguous' in ranked) return { resolved: [], unresolved: [{ id: row.id, reason: 'no_refund_evidence' }] };

  const fields: RoleFieldsUpdate = {
    auto_role: 'refund',
    role_source: 'refund_match',
    role_confidence: ranked.confidence,
    classifier_version: CURRENT_CLASSIFIER_VERSION,
  };
  if (apply) {
    const ok = await dataService.applyTransactionSemanticRoles(userId, [row.id], fields);
    if (!ok) return { resolved: [], unresolved: [{ id: row.id, reason: 'no_refund_evidence' }] };
  }
  return { resolved: [{ id: row.id, fields }], unresolved: [] };
}

/** The one asymmetric direction: a freshly-touched ordinary expense may itself be the original
 *  purchase an EXISTING, still-dangling `sign_default` negative transaction (from an earlier
 *  batch) has been waiting to match against — "the purchase syncs after its own refund." The
 *  purchase row's own role is never changed by this — only the dangling refund's, if found. */
async function resolveDanglingRefunds(
  userId: string,
  row: ReconciliationRow,
  apply: boolean,
  pool: ReconciliationRow[]
): Promise<ReconciliationResult> {
  const windowEnd = addDaysUtc(row.date, REFUND_WINDOW_DAYS);
  const dbCandidates = await dataService.findNegativeCandidatesReferencingOriginal(userId, row, windowEnd, 'sign_default');
  const poolCandidates = pool.filter(
    (p) =>
      p.id !== row.id &&
      p.account_id === row.account_id &&
      p.amount < 0 &&
      p.amount >= -row.amount &&
      p.role_source === 'sign_default' &&
      p.date >= row.date &&
      p.date <= windowEnd
  );
  const candidates = mergeWithPool(dbCandidates, poolCandidates);
  const result: ReconciliationResult = { resolved: [], unresolved: [] };

  for (const candidate of candidates) {
    if (normalizedIdentity(candidate) !== normalizedIdentity(row)) continue;
    const ranked = rankRefundCandidates(candidate, [row]);
    if (ranked === null || 'ambiguous' in ranked) continue;
    const fields: RoleFieldsUpdate = {
      auto_role: 'refund',
      role_source: 'refund_match',
      role_confidence: ranked.confidence,
      classifier_version: CURRENT_CLASSIFIER_VERSION,
    };
    if (apply) {
      const ok = await dataService.applyTransactionSemanticRoles(userId, [candidate.id], fields);
      if (!ok) continue;
    }
    result.resolved.push({ id: candidate.id, fields });
  }
  return result;
}

/**
 * Runs the forward-looking pass over exactly the transactions touched by one persisted batch —
 * never a broader scan. Safe to call with an empty list (no-op). Every write goes only to
 * auto_role/role_source/role_confidence/classifier_version; user_role_override is never read or
 * written. `apply: false` (default true) previews every outcome without writing anything — see
 * this module's own doc comment. `pool` (Round 3 remediation §7) additionally supplies same-batch
 * hypothetical rows for a truthful dry-run preview.
 */
export async function reconcileRelationalRoles(
  userId: string,
  touchedTransactionIds: string[],
  apply = true,
  pool: ReconciliationRow[] = []
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  if (touchedTransactionIds.length === 0) return result;
  const dbTouched = await dataService.getTransactionsForReconciliation(userId, touchedTransactionIds);
  const touched = mergeWithPool(
    dbTouched,
    pool.filter((p) => touchedTransactionIds.includes(p.id))
  );

  // Guards against double-resolving the SAME pair/row twice in one pass — e.g. both legs of a
  // same-batch transfer pair are independently iterated, and each would otherwise find the OTHER
  // as its own valid counterpart (in apply mode this is normally harmless since the first leg's
  // write already lands in the DB before the second leg's query runs, so the second query no
  // longer finds a `transfer_like_unconfirmed` counterpart — but with the dry-run pool (Round 3
  // remediation §7) nothing is ever written, so without this guard both iterations would report
  // the pair as independently resolved, duplicating it in the result).
  const alreadyResolved = new Set<string>();
  for (const row of touched) {
    if (alreadyResolved.has(row.id)) continue;
    if (row.role_source === 'transfer_like_unconfirmed') {
      const outcome = await resolveTransferCandidate(userId, row, apply, pool);
      mergeResults(result, outcome);
      for (const o of outcome.resolved) alreadyResolved.add(o.id);
    }
    if (row.amount < 0 && row.role_source === 'sign_default') {
      const outcome = await resolveRefundCandidate(userId, row, apply, pool);
      mergeResults(result, outcome);
      for (const o of outcome.resolved) alreadyResolved.add(o.id);
    }
    // Round 3 remediation §5: eligibility to serve as a refund original must key off
    // effective_role (via isEligibleRefundOriginal), not auto_role alone — a user override away
    // from `expense` must disqualify the row even if its auto_role still says `expense`.
    if (row.amount > 0 && isEligibleRefundOriginal(row)) {
      const outcome = await resolveDanglingRefunds(userId, row, apply, pool);
      mergeResults(result, outcome);
      for (const o of outcome.resolved) alreadyResolved.add(o.id);
    }
  }
  return result;
}

async function resetRowToFreshClassification(
  userId: string,
  row: ReconciliationRow,
  apply: boolean
): Promise<ReconciliationOutcome | null> {
  const fresh = classifyRowLevel({
    amount: row.amount,
    personalFinanceCategoryPrimary: row.category,
    personalFinanceCategoryDetailed: row.personal_finance_category_detailed,
    personalFinanceCategoryConfidence: row.personal_finance_category_confidence,
    manualLoanId: row.manual_loan_id,
  });
  const fields: RoleFieldsUpdate = {
    auto_role: fresh.autoRole,
    role_source: fresh.roleSource,
    role_confidence: fresh.roleConfidence,
    classifier_version: fresh.classifierVersion,
  };
  if (apply) {
    const ok = await dataService.applyTransactionSemanticRoles(userId, [row.id], fields);
    if (!ok) return null;
  }
  return { id: row.id, fields };
}

/** Re-validates every one of the user's EXISTING `account_pair_match` rows against CURRENT data
 *  (Round 3 remediation §2/§3/§4) — bounded, paginated, same-user-scoped. A row whose unique
 *  valid counterpart no longer exists (amount/date/account changed out from under it, its
 *  counterpart was deleted, or the pairing is now ambiguous) is reset to a fresh row-level
 *  classification. Both members of a broken pair are independently caught on their own turn
 *  through this sweep — no need to explicitly locate "the former partner." */
async function repairAccountPairMatches(userId: string, apply: boolean): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  let afterId: string | null = null;
  for (;;) {
    const page = await dataService.getRelationallyClassifiedTransactionsPage(userId, 'account_pair_match', REPAIR_PAGE_SIZE, afterId);
    if (page.length === 0) break;

    for (const row of page) {
      const windowStart = addDaysUtc(row.date, -TRANSFER_WINDOW_DAYS);
      const windowEnd = addDaysUtc(row.date, TRANSFER_WINDOW_DAYS);
      const candidates = await dataService.findTransferCounterpartCandidates(
        userId,
        row,
        windowStart,
        windowEnd,
        'account_pair_match'
      );
      const ranked = rankTransferCandidates(row.date, candidates);
      const stillValid = ranked !== null && !('ambiguous' in ranked);
      if (!stillValid) {
        const outcome = await resetRowToFreshClassification(userId, row, apply);
        if (outcome) result.resolved.push(outcome);
      }
    }

    if (page.length < REPAIR_PAGE_SIZE) break;
    afterId = page[page.length - 1].id;
  }
  return result;
}

/** Re-validates every one of the user's EXISTING `refund_match` rows against CURRENT data (Round
 *  3 remediation §2/§3/§4) — same bounded, paginated, same-user-scoped shape as
 *  `repairAccountPairMatches`. A refund whose eligible original no longer exists (the original
 *  was deleted, stopped being an ordinary expense, or got overridden away from `expense` — see
 *  `isEligibleRefundOriginal`, enforced here via `findRefundOriginalCandidates`'s own
 *  effective_role/manual_loan_id filter) is reset to a fresh row-level classification. */
async function repairRefundMatches(userId: string, apply: boolean): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  let afterId: string | null = null;
  for (;;) {
    const page = await dataService.getRelationallyClassifiedTransactionsPage(userId, 'refund_match', REPAIR_PAGE_SIZE, afterId);
    if (page.length === 0) break;

    for (const row of page) {
      const windowStart = addDaysUtc(row.date, -REFUND_WINDOW_DAYS);
      const candidates = await dataService.findRefundOriginalCandidates(userId, row, windowStart);
      const ranked = rankRefundCandidates(row, candidates);
      const stillValid = ranked !== null && !('ambiguous' in ranked);
      if (!stillValid) {
        const outcome = await resetRowToFreshClassification(userId, row, apply);
        if (outcome) result.resolved.push(outcome);
      }
    }

    if (page.length < REPAIR_PAGE_SIZE) break;
    afterId = page[page.length - 1].id;
  }
  return result;
}

/**
 * Re-validates ALL of a user's existing relationally-classified rows (`account_pair_match` and
 * `refund_match`) against current data — see this module's own doc comment for the full
 * sweep-based design this replaces Round 2's `reconcileAroundTransactionChange` with. Call this
 * whenever a sync/backfill batch contained any modified transaction, removed transaction, or
 * manual-loan link/unlink (see syncService.ts, loans.ts, manualLoanController.ts for the call
 * sites), BEFORE the caller advances any cursor — a failure here must gate cursor advancement
 * exactly like the ordinary forward pass.
 */
export async function repairExistingRelationalRoles(userId: string, apply = true): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  mergeResults(result, await repairAccountPairMatches(userId, apply));
  mergeResults(result, await repairRefundMatches(userId, apply));
  return result;
}

/**
 * Convenience wrapper for the three "one transaction just had a semantic-relevant relational
 * state change" call sites (manual-loan link, manual-loan unlink) — runs the ordinary
 * forward-looking pass for the changed row itself (it may now be newly matchable, e.g. an
 * unlinked payment reclassified back to `transfer_like_unconfirmed`/`sign_default`) AND the full
 * repair sweep (the changed row may have just invalidated some OTHER row that depended on its
 * OLD state, e.g. it was previously serving as a transfer counterpart or refund original before
 * being linked to a loan). Replaces Round 2's `reconcileAroundTransactionChange` at every call
 * site with the same `(userId, transactionId)` calling convention.
 */
export async function reconcileAfterRelationalStateChange(
  userId: string,
  transactionId: string,
  apply = true
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  mergeResults(result, await reconcileRelationalRoles(userId, [transactionId], apply));
  mergeResults(result, await repairExistingRelationalRoles(userId, apply));
  return result;
}

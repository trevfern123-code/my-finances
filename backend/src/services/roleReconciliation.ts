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
 * `repairExistingRelationalRoles` (Round 3 remediation §2/§3/§4/§6, sweep design further
 * corrected in Round 4 remediation §3/§5) is the second entry point, replacing Round 2's
 * `reconcileAroundTransactionChange`. Whenever a sync batch contains any modified or removed
 * transaction, this re-validates EVERY one of the user's EXISTING `account_pair_match`/
 * `refund_match` rows directly against CURRENT data, in bounded pages. This is naturally:
 *
 *  - retry-safe: the trigger is "did this batch touch anything," not "did a same-attempt
 *    before/after comparison detect a change" — a retry whose DB state already reflects the new
 *    values still re-triggers and still completes the sweep;
 *  - deletion-safe: a deleted row simply won't be found as a valid counterpart/original when the
 *    SURVIVING side of a pair re-validates itself — no separate deletion-specific logic needed.
 *
 * TRANSFER pairing (both the forward pass and the sweep) must additionally be RECIPROCAL —
 * one-to-one — not merely "this row's own search turned up a unique winner" (Round 4 remediation
 * §3). Three rows A(+500)/B(-500)/C(+500) illustrate why: both A and C independently see B as
 * their sole opposite-amount candidate, but B can only genuinely belong to ONE of them.
 * `resolveReciprocalTransferPartner` fixes this: it accepts row's own best match W only if W's
 * OWN independently-computed best match is ALSO row. This is a pure function of current
 * pool/DB state (no mutation, no ordering dependence) — if A and B are truly each other's unique
 * best match, that fact is symmetric and gets discovered from either side; if C's only candidate
 * B has a TRULY closer partner A, C's reciprocal check fails no matter what order rows are
 * visited in, and C correctly stays unresolved. This is also what makes same-page/same-pool
 * transfer resolution single-pass-safe (Round 4 remediation §4) without needing an explicit
 * "candidate already consumed" ledger — the check is self-consistent by construction.
 *
 * The sweep's account_pair_match repair additionally loops in bounded passes (Round 4 remediation
 * §5): resetting one row can be exactly what makes ANOTHER row's own reciprocal check newly fail
 * (or newly succeed) within the same page, so one full pass is repeated (capped at
 * MAX_REPAIR_PASSES, never unbounded) until a pass makes no further changes. `refund_match` rows
 * have no such reciprocal/chained concern — one original can legitimately support several
 * distinct refund transactions — so `repairRefundMatches` stays single-pass.
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
 * A mutation that reaches `dataService.applyTransactionSemanticRoles` and fails there (an
 * ownership/count-mismatch integrity failure inside the atomic RPC) is a HARD failure — that call
 * now throws `SemanticRoleMutationError` rather than returning `false` (Round 4 remediation §6),
 * and nothing in this module catches it: it propagates out of whichever reconciliation/repair
 * pass was running, which propagates out of syncService.ts/backfillTransactionSemantics.ts,
 * aborting the sync/backfill page and leaving its cursor unadvanced — exactly like any other
 * reconciliation failure. This is deliberately distinct from candidate ambiguity/no-evidence,
 * which are ordinary, expected outcomes discovered BEFORE ever calling that function and are
 * never converted into an error.
 *
 * Per the approved Phase A contract: a row with `user_role_override` set MAY still have its
 * `auto_role`/`role_source`/`role_confidence` refreshed here (auto_role keeps improving under an
 * override, so clearing the override later reveals the best available automatic classification,
 * not a stale one) — this module never WRITES `user_role_override` itself. It does, however, READ
 * it for one purpose (Round 4 remediation §3): `isEligibleTransferParticipant` disqualifies a row
 * the user has overridden away from `internal_transfer` from ever being auto-paired again — an
 * override that contradicts being a transfer must stick, not get silently re-paired.
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
/** Bounds the account_pair_match sweep's repeat-until-stable loop (Round 4 remediation §5) —
 *  scoped strictly to this one repair (not a general fixed-point engine), and small enough that
 *  even a genuinely pathological input can't spin unboundedly: each pass only ever resets rows
 *  that just became invalid, so real convergence in personal-finance-scale data happens in 1-2
 *  passes: this is a safety margin, not an expected count. */
const MAX_REPAIR_PASSES = 5;

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

/** Whether `row` may participate — as either the row being resolved or a candidate offered to
 *  some OTHER row — in automatic transfer pairing (Round 4 remediation §3). A row the user has
 *  overridden to anything OTHER than `internal_transfer` has taken an explicit, contradictory
 *  position on its own role; auto-matching must never silently pair it into an internal_transfer
 *  relationship despite that. No override at all, or an override that already agrees
 *  (`internal_transfer`), leaves the row eligible — auto_role may still keep improving under an
 *  override per this module's own doc comment; only a genuinely CONTRADICTORY override disqualifies. */
function isEligibleTransferParticipant(row: ReconciliationRow): boolean {
  return row.user_role_override === null || row.user_role_override === 'internal_transfer';
}

/** Every credible transfer-counterpart candidate for `row` tagged `roleSourceFilter`, from the DB
 *  plus the in-memory `pool` (Round 3 remediation §7), filtered to only rows still eligible to
 *  participate (Round 4 remediation §3) — an overridden-away-from-transfer row is never offered
 *  as a candidate to anyone else, exactly as it's never itself resolved as an anchor. */
async function findEligibleTransferCandidates(
  userId: string,
  row: ReconciliationRow,
  roleSourceFilter: string,
  pool: ReconciliationRow[]
): Promise<ReconciliationRow[]> {
  const windowStart = addDaysUtc(row.date, -TRANSFER_WINDOW_DAYS);
  const windowEnd = addDaysUtc(row.date, TRANSFER_WINDOW_DAYS);
  const dbCandidates = await dataService.findTransferCounterpartCandidates(userId, row, windowStart, windowEnd, roleSourceFilter);
  // Mirrors findTransferCounterpartCandidates' own filter, applied in-memory to the same-batch
  // pool — a pool row can't be found by the DB query above since it was never (or not yet)
  // persisted with this role_source.
  const poolCandidates = pool.filter(
    (p) =>
      p.id !== row.id &&
      p.account_id !== row.account_id &&
      p.amount === -row.amount &&
      p.role_source === roleSourceFilter &&
      p.date >= windowStart &&
      p.date <= windowEnd
  );
  return mergeWithPool(
    dbCandidates.filter(isEligibleTransferParticipant),
    poolCandidates.filter(isEligibleTransferParticipant)
  );
}

/** `row`'s own best transfer-counterpart candidate tagged `roleSourceFilter` — a one-SIDED
 *  computation (see `resolveReciprocalTransferPartner` for the two-sided confirmation built on
 *  top of this). Returns `null` (no evidence), `'ambiguous'` (a genuine, unresolvable tie), or a
 *  unique winner with its confidence. */
async function findBestTransferPartner(
  userId: string,
  row: ReconciliationRow,
  roleSourceFilter: string,
  pool: ReconciliationRow[]
): Promise<{ winner: ReconciliationRow; confidence: RoleConfidence } | 'ambiguous' | null> {
  const candidates = await findEligibleTransferCandidates(userId, row, roleSourceFilter, pool);
  const ranked = rankTransferCandidates(row.date, candidates);
  if (ranked === null) return null;
  if ('ambiguous' in ranked) return 'ambiguous';
  return ranked;
}

/**
 * Confirms a transfer pair only if BOTH sides independently pick each other as their unique best
 * match (Round 4 remediation §3) — a one-sided "I found a unique winner" is NOT sufficient, since
 * that winner might itself have a different, truly-closer best match elsewhere (the classic
 * A(+500)/B(-500)/C(+500) shape: both A and C see B as their sole candidate, but B's own search
 * picks whichever of A/C is actually closest — only THAT side reciprocates).
 *
 * This is a pure function of the current pool/DB state — no mutation, no shared "already
 * consumed" ledger needed, and no dependence on iteration order (Round 4 remediation §4): if A and
 * B are genuinely each other's best match, both directions independently confirm it regardless of
 * which one is evaluated first; if a row's only candidate does NOT reciprocate, that row correctly
 * stays unresolved no matter how many times or in what order it's re-checked. Returns `null`
 * (including for a one-sided failure — the row simply has no CONFIRMED partner, not an ambiguous
 * tie), `'ambiguous'`, or the confirmed pair.
 */
async function resolveReciprocalTransferPartner(
  userId: string,
  row: ReconciliationRow,
  roleSourceFilter: string,
  pool: ReconciliationRow[]
): Promise<{ winner: ReconciliationRow; confidence: RoleConfidence } | 'ambiguous' | null> {
  if (!isEligibleTransferParticipant(row)) return null;

  const best = await findBestTransferPartner(userId, row, roleSourceFilter, pool);
  if (best === null || best === 'ambiguous') return best;

  const reciprocal = await findBestTransferPartner(userId, best.winner, roleSourceFilter, pool);
  if (reciprocal === null || reciprocal === 'ambiguous' || reciprocal.winner.id !== row.id) {
    // One-sided: row's best match does not itself agree — not a confirmed pair. The genuine
    // reciprocal partner (if any) will independently confirm itself when IT is evaluated.
    return null;
  }
  return best;
}

async function resolveTransferCandidate(
  userId: string,
  row: ReconciliationRow,
  apply: boolean,
  pool: ReconciliationRow[]
): Promise<ReconciliationResult> {
  const resolved = await resolveReciprocalTransferPartner(userId, row, 'transfer_like_unconfirmed', pool);

  if (resolved === null) return { resolved: [], unresolved: [{ id: row.id, reason: 'no_transfer_evidence' }] };
  if (resolved === 'ambiguous') return { resolved: [], unresolved: [{ id: row.id, reason: 'ambiguous_transfer_candidates' }] };

  const fields: RoleFieldsUpdate = {
    auto_role: 'internal_transfer',
    role_source: 'account_pair_match',
    role_confidence: resolved.confidence,
    classifier_version: CURRENT_CLASSIFIER_VERSION,
  };

  if (!apply) {
    return { resolved: [{ id: row.id, fields }, { id: resolved.winner.id, fields }], unresolved: [] };
  }

  // One atomic RPC call covering both ids — Round 3 remediation §1: ownership is verified and
  // both rows are locked and updated inside a single Postgres transaction, never two separate
  // requests that could leave the pair half-resolved if the second one failed. Round 4
  // remediation §6: this now THROWS on any RPC-reported failure rather than returning a boolean —
  // deliberately not caught here, so an integrity failure aborts this whole reconciliation pass.
  await dataService.applyTransactionSemanticRoles(userId, [row.id, resolved.winner.id], fields);
  return { resolved: [{ id: row.id, fields }, { id: resolved.winner.id, fields }], unresolved: [] };
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
    await dataService.applyTransactionSemanticRoles(userId, [row.id], fields);
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
      await dataService.applyTransactionSemanticRoles(userId, [candidate.id], fields);
    }
    result.resolved.push({ id: candidate.id, fields });
  }
  return result;
}

/**
 * Runs the forward-looking pass over exactly the transactions touched by one persisted batch —
 * never a broader scan. Safe to call with an empty list (no-op). Every write goes only to
 * auto_role/role_source/role_confidence/classifier_version; user_role_override is never written
 * (only read, for transfer-eligibility — see isEligibleTransferParticipant). `apply: false`
 * (default true) previews every outcome without writing anything — see this module's own doc
 * comment. `pool` (Round 3 remediation §7) additionally supplies same-batch hypothetical rows for
 * a truthful dry-run preview.
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

  // Skips a row already confirmed as part of a resolved pair/refund earlier in THIS pass — pure
  // deduplication/efficiency (Round 4 remediation §3's reciprocal check is correct regardless of
  // visit order on its own; this just avoids re-deriving the same answer and issuing a redundant
  // duplicate write for the other leg of an already-confirmed pair).
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

async function resetRowToFreshClassification(userId: string, row: ReconciliationRow, apply: boolean): Promise<ReconciliationOutcome> {
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
    // Round 4 remediation §6: throws (SemanticRoleMutationError) rather than returning false on
    // an RPC integrity failure — deliberately not caught, so a failure here aborts the whole
    // repair sweep rather than silently skipping this row.
    await dataService.applyTransactionSemanticRoles(userId, [row.id], fields);
  }
  return { id: row.id, fields };
}

/** One pass over every page of the user's EXISTING `account_pair_match` rows, re-validating each
 *  via the SAME reciprocal one-to-one check the forward pass uses (Round 4 remediation §3) — not
 *  merely "does this row's own search still turn up a unique candidate," which cannot detect a
 *  triangle (three rows where two independently, one-sidedly, both look valid against a shared
 *  third). A row that fails the reciprocal check (no confirmed partner, or now-ambiguous) is reset
 *  to a fresh row-level classification. Returns however many rows were reset THIS pass — the
 *  caller (`repairAccountPairMatches`) uses that count to decide whether another pass is needed. */
async function repairAccountPairMatchesOnePass(userId: string, apply: boolean): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  let afterId: string | null = null;
  for (;;) {
    const page = await dataService.getRelationallyClassifiedTransactionsPage(userId, 'account_pair_match', REPAIR_PAGE_SIZE, afterId);
    if (page.length === 0) break;

    for (const row of page) {
      const reciprocal = await resolveReciprocalTransferPartner(userId, row, 'account_pair_match', []);
      const stillValid = reciprocal !== null && reciprocal !== 'ambiguous';
      if (!stillValid) {
        result.resolved.push(await resetRowToFreshClassification(userId, row, apply));
      }
    }

    if (page.length < REPAIR_PAGE_SIZE) break;
    afterId = page[page.length - 1].id;
  }
  return result;
}

/** Re-validates every one of the user's EXISTING `account_pair_match` rows against CURRENT data
 *  (Round 3 remediation §2/§3/§4; reciprocal-matching + fixed-point correction in Round 4
 *  remediation §3/§5). A row whose unique, RECIPROCALLY-confirmed counterpart no longer exists
 *  (amount/date/account changed out from under it, its counterpart was deleted, the pairing is
 *  now ambiguous, or either side got overridden away from internal_transfer) is reset to a fresh
 *  row-level classification.
 *
 *  Repeats the full page-traversal in bounded passes (capped at MAX_REPAIR_PASSES) until a pass
 *  resets nothing further, in `apply` mode — resetting one row can change whether ANOTHER row's
 *  own reciprocal check newly succeeds or fails within the same sweep (Round 4 remediation §5), so
 *  a single pass is not always sufficient to reach a stable, fully-corrected state. In dry-run
 *  mode nothing is ever actually written, so a second pass over the SAME unmodified DB state
 *  would just rediscover (and duplicate-report) the exact same rows — dry-run always runs exactly
 *  one pass. */
async function repairAccountPairMatches(userId: string, apply: boolean): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const passResult = await repairAccountPairMatchesOnePass(userId, apply);
    mergeResults(result, passResult);
    if (passResult.resolved.length === 0) break; // stable — nothing left to fix
    if (!apply) break; // dry-run: nothing changed, so a further pass would only duplicate this one
  }
  return result;
}

/** Re-validates every one of the user's EXISTING `refund_match` rows against CURRENT data (Round
 *  3 remediation §2/§3/§4). A refund whose eligible original no longer exists (the original was
 *  deleted, stopped being an ordinary expense, or got overridden away from `expense` — see
 *  `isEligibleRefundOriginal`, enforced here via `findRefundOriginalCandidates`'s own
 *  effective_role/manual_loan_id filter) is reset to a fresh row-level classification. No
 *  reciprocal/chained concern applies here (unlike transfers): one original can legitimately
 *  support several distinct refund transactions, so this stays single-pass. */
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
        result.resolved.push(await resetRowToFreshClassification(userId, row, apply));
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
 * Convenience wrapper for the "one transaction just had a semantic-relevant relational state
 * change" call sites (manual-loan link, manual-loan unlink) — runs the ordinary forward-looking
 * pass for the changed row itself (it may now be newly matchable, e.g. an unlinked payment
 * reclassified back to `transfer_like_unconfirmed`/`sign_default`) AND the full repair sweep (the
 * changed row may have just invalidated some OTHER row that depended on its OLD state, e.g. it
 * was previously serving as a transfer counterpart or refund original before being linked to a
 * loan). Replaces Round 2's `reconcileAroundTransactionChange` at every call site with the same
 * `(userId, transactionId)` calling convention.
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

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
 * `reconcileAroundTransactionChange` (Round 2 remediation §1/§3) is the second entry point,
 * called whenever a transaction's own semantic-relevant inputs change AFTER it may have already
 * participated in a relational match — a manual-loan link/unlink, or a resync that materially
 * changes amount/account/date/merchant/category. It re-evaluates the changed row itself, AND
 * looks for a stale transfer counterpart or stale refund match that had previously relied on this
 * row's old state — resetting those to a fresh classification before re-running the normal
 * forward-looking pass over everything affected. This reuses the exact same bounded queries and
 * windows as the ordinary pass; it is not a second mechanism.
 *
 * Both entry points support a `dryRun` flag: when true, every read/ranking step runs exactly as
 * normal, but no write ever happens — the function returns what it WOULD have done instead. This
 * is what backfillTransactionSemantics.ts's dry-run mode uses for a genuinely truthful relational
 * preview, reusing this module's own logic rather than a separate, divergence-prone reimplementation.
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

async function resolveTransferCandidate(
  userId: string,
  row: ReconciliationRow,
  apply: boolean
): Promise<ReconciliationResult> {
  const windowStart = addDaysUtc(row.date, -TRANSFER_WINDOW_DAYS);
  const windowEnd = addDaysUtc(row.date, TRANSFER_WINDOW_DAYS);
  const candidates = await dataService.findTransferCounterpartCandidates(
    userId,
    row,
    windowStart,
    windowEnd,
    'transfer_like_unconfirmed'
  );
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

  // One atomic UPDATE...WHERE id IN (both ids) — Round 2 remediation §5: never two separate
  // requests that could leave the pair half-resolved if the second one failed.
  const affected = await dataService.updateTransferPairRoleFields(userId, [row.id, ranked.winner.id], fields);
  if (affected.length !== 2) {
    // Fewer than both intended rows were affected (ownership mismatch, or a row no longer
    // exists) — the pair is NOT considered resolved. No partial state is left durable: the
    // single statement either matched both rows or it didn't touch the ones it couldn't verify.
    return { resolved: [], unresolved: [{ id: row.id, reason: 'ambiguous_transfer_candidates' }] };
  }
  return { resolved: [{ id: row.id, fields }, { id: ranked.winner.id, fields }], unresolved: [] };
}

async function resolveRefundCandidate(userId: string, row: ReconciliationRow, apply: boolean): Promise<ReconciliationResult> {
  const windowStart = addDaysUtc(row.date, -REFUND_WINDOW_DAYS);
  const candidates = await dataService.findRefundOriginalCandidates(userId, row, windowStart);
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
    const ok = await dataService.updateTransactionRoleFields(userId, row.id, fields);
    if (!ok) return { resolved: [], unresolved: [{ id: row.id, reason: 'no_refund_evidence' }] };
  }
  return { resolved: [{ id: row.id, fields }], unresolved: [] };
}

/** The one asymmetric direction: a freshly-touched ordinary expense may itself be the original
 *  purchase an EXISTING, still-dangling `sign_default` negative transaction (from an earlier
 *  batch) has been waiting to match against — "the purchase syncs after its own refund." The
 *  purchase row's own role is never changed by this — only the dangling refund's, if found. */
async function resolveDanglingRefunds(userId: string, row: ReconciliationRow, apply: boolean): Promise<ReconciliationResult> {
  const windowEnd = addDaysUtc(row.date, REFUND_WINDOW_DAYS);
  const candidates = await dataService.findNegativeCandidatesReferencingOriginal(userId, row, windowEnd, 'sign_default');
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
      const ok = await dataService.updateTransactionRoleFields(userId, candidate.id, fields);
      if (!ok) continue;
    }
    result.resolved.push({ id: candidate.id, fields });
  }
  return result;
}

function isEligibleRefundOriginal(row: ReconciliationRow): boolean {
  return row.effective_role === 'expense' && row.manual_loan_id === null;
}

/**
 * Runs the forward-looking pass over exactly the transactions touched by one persisted batch —
 * never a broader scan. Safe to call with an empty list (no-op). Every write goes only to
 * auto_role/role_source/role_confidence/classifier_version; user_role_override is never read or
 * written. `apply: false` (default true) previews every outcome without writing anything —
 * see this module's own doc comment.
 */
export async function reconcileRelationalRoles(
  userId: string,
  touchedTransactionIds: string[],
  apply = true
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { resolved: [], unresolved: [] };
  if (touchedTransactionIds.length === 0) return result;
  const touched = await dataService.getTransactionsForReconciliation(userId, touchedTransactionIds);

  for (const row of touched) {
    if (row.role_source === 'transfer_like_unconfirmed') {
      mergeResults(result, await resolveTransferCandidate(userId, row, apply));
    }
    if (row.amount < 0 && row.role_source === 'sign_default') {
      mergeResults(result, await resolveRefundCandidate(userId, row, apply));
    }
    if (row.amount > 0 && row.auto_role === 'expense') {
      mergeResults(result, await resolveDanglingRefunds(userId, row, apply));
    }
  }
  return result;
}

/**
 * Re-evaluates one transaction after a semantic-relevant change to it (a manual-loan link/unlink,
 * or a resync that materially changed amount/account/date/merchant/category — see
 * dataService.ts's applyTransactionChanges and linkTransactionToLoan/unlinkPaymentFromLoan for the
 * call sites). Beyond re-running the forward pass on the changed row itself, this also looks for:
 *
 *  (B) a stale transfer counterpart — an existing `account_pair_match` row that was paired
 *      against this transaction's OLD state and may no longer be a valid pair now;
 *  (C) a stale refund match — an existing `refund_match` row that had used this transaction as
 *      its original purchase and may no longer be eligible to (it stopped being an ordinary
 *      expense, e.g. because it just became a transfer or got linked to a manual loan).
 *
 * Any stale row found is reset to a fresh row-level classification (from its own currently-stored
 * fields) and included in the same bounded forward re-resolution pass as the changed row itself —
 * so a previously-matched partner that's no longer valid doesn't stay incorrectly classified
 * indefinitely, without ever scanning beyond this row's own fixed-window neighborhood.
 */
export async function reconcileAroundTransactionChange(
  userId: string,
  transactionId: string,
  apply = true
): Promise<ReconciliationResult> {
  const [row] = await dataService.getTransactionsForReconciliation(userId, [transactionId]);
  if (!row) return { resolved: [], unresolved: [] };

  const idsToReconcile = new Set<string>([transactionId]);
  const resetOutcomes: ReconciliationOutcome[] = [];

  const transferWindowStart = addDaysUtc(row.date, -TRANSFER_WINDOW_DAYS);
  const transferWindowEnd = addDaysUtc(row.date, TRANSFER_WINDOW_DAYS);
  const staleCounterparts = await dataService.findTransferCounterpartCandidates(
    userId,
    row,
    transferWindowStart,
    transferWindowEnd,
    'account_pair_match'
  );
  for (const stale of staleCounterparts) {
    const fresh = classifyRowLevel({
      amount: stale.amount,
      personalFinanceCategoryPrimary: stale.category,
      personalFinanceCategoryDetailed: stale.personal_finance_category_detailed,
      personalFinanceCategoryConfidence: stale.personal_finance_category_confidence,
      manualLoanId: stale.manual_loan_id,
    });
    const fields: RoleFieldsUpdate = {
      auto_role: fresh.autoRole,
      role_source: fresh.roleSource,
      role_confidence: fresh.roleConfidence,
      classifier_version: fresh.classifierVersion,
    };
    if (apply) await dataService.updateTransactionRoleFields(userId, stale.id, fields);
    resetOutcomes.push({ id: stale.id, fields });
    idsToReconcile.add(stale.id);
  }

  if (isEligibleRefundOriginal(row)) {
    // row is (still) a valid original — nothing stale to clean up on the refund side; its
    // dependents, if any, remain correctly matched.
  } else {
    const refundWindowEnd = addDaysUtc(row.date, REFUND_WINDOW_DAYS);
    const staleRefunds = await dataService.findNegativeCandidatesReferencingOriginal(
      userId,
      row,
      refundWindowEnd,
      'refund_match'
    );
    for (const stale of staleRefunds) {
      if (normalizedIdentity(stale) !== normalizedIdentity(row)) continue;
      const fresh = classifyRowLevel({
        amount: stale.amount,
        personalFinanceCategoryPrimary: stale.category,
        personalFinanceCategoryDetailed: stale.personal_finance_category_detailed,
        personalFinanceCategoryConfidence: stale.personal_finance_category_confidence,
        manualLoanId: stale.manual_loan_id,
      });
      const fields: RoleFieldsUpdate = {
        auto_role: fresh.autoRole,
        role_source: fresh.roleSource,
        role_confidence: fresh.roleConfidence,
        classifier_version: fresh.classifierVersion,
      };
      if (apply) await dataService.updateTransactionRoleFields(userId, stale.id, fields);
      resetOutcomes.push({ id: stale.id, fields });
      idsToReconcile.add(stale.id);
    }
  }

  const forwardPass = await reconcileRelationalRoles(userId, Array.from(idsToReconcile), apply);
  return { resolved: [...resetOutcomes, ...forwardPass.resolved], unresolved: forwardPass.unresolved };
}

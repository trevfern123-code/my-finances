/**
 * Financial Semantics Foundation, Phase A — the bounded, two-stage relational reconciliation pass.
 *
 * Stage 1 (transactionClassifier.ts's classifyCore, run at ingestion — see dataService.ts's
 * applyTransactionChanges) is pure and does no database work: a transaction whose true role
 * depends on evidence elsewhere (an internal-transfer counterpart leg, or an earlier purchase a
 * refund might net against) is always given a complete, safe sign-based fallback role immediately,
 * tagged `transfer_like_unconfirmed` or `refund_candidate_unconfirmed` — never left unclassified.
 *
 * Stage 2 is this module: `reconcileRelationalRoles`, called once per persisted sync/backfill
 * batch (right after it commits — see syncService.ts's own comment at the call site), which is
 * the ONLY place any relational (cross-transaction) database query happens for classification
 * purposes. This is a deliberate simplification of the originally-specified split (stage 1
 * "attempting" relational evidence immediately, stage 2 as a separate safety net): since stage 2
 * always runs synchronously right after persistence anyway, giving it sole ownership of every
 * relational query avoids implementing (and testing) the same transfer/refund matching logic
 * twice. It still satisfies every named scenario — both transfer legs in one batch, a leg arriving
 * in a later sync, a counterpart that already existed, a refund and its purchase arriving in
 * either order, cross-backfill-batch pairs — because it is always invoked immediately after every
 * batch, live sync or backfill alike, and its queries search the full table (scoped by user, date
 * window, and a conservative candidate tag), not just the rows in the current batch.
 *
 * Bounded by construction: every query here is restricted to (a) a fixed ±3-day (transfer) or
 * 120-day (refund) date window, and (b) either a specific candidate id/account or the
 * `transfer_like_unconfirmed`/`refund_candidate_unconfirmed` tag — never a full-table scan, never
 * O(N²). A row not touched by this batch and not carrying one of those tags is never queried,
 * never updated, and never churns.
 *
 * Per the approved Phase A contract: a row with `user_role_override` set MAY still have its
 * `auto_role`/`role_source`/`role_confidence` refreshed here (auto_role keeps improving under an
 * override, so clearing the override later reveals the best available automatic classification,
 * not a stale one) — this module never reads or writes `user_role_override` itself.
 */

import * as dataService from './dataService';
import { CURRENT_CLASSIFIER_VERSION, type RoleConfidence } from './transactionClassifier';
import type { ReconciliationRow } from './dataService';

const TRANSFER_WINDOW_DAYS = 3;
const REFUND_WINDOW_DAYS = 120;

function addDaysUtc(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizedIdentity(row: { name: string; merchant_name: string | null }): string {
  return (row.merchant_name ?? row.name).trim().toLowerCase();
}

async function resolveTransferCandidate(userId: string, row: ReconciliationRow): Promise<void> {
  const windowStart = addDaysUtc(row.date, -TRANSFER_WINDOW_DAYS);
  const windowEnd = addDaysUtc(row.date, TRANSFER_WINDOW_DAYS);
  const match = await dataService.findTransferCounterpartCandidate(userId, row, windowStart, windowEnd);
  if (!match) return;

  const confidence: RoleConfidence = match.date === row.date ? 'high' : 'medium';
  const fields = {
    auto_role: 'internal_transfer' as const,
    role_source: 'account_pair_match',
    role_confidence: confidence,
    classifier_version: CURRENT_CLASSIFIER_VERSION,
  };
  // Both legs of the same transfer are updated together — this is the one relational match where
  // the evidence resolves two rows at once, not just the one being examined.
  await dataService.updateTransactionRoleFields(row.id, fields);
  await dataService.updateTransactionRoleFields(match.id, fields);
}

async function resolveRefundCandidate(userId: string, row: ReconciliationRow): Promise<void> {
  const windowStart = addDaysUtc(row.date, -REFUND_WINDOW_DAYS);
  const candidates = await dataService.findRefundOriginalCandidates(userId, row, windowStart);
  const original = candidates.find((c) => normalizedIdentity(c) === normalizedIdentity(row));
  if (!original) return;

  const confidence: RoleConfidence = Math.abs(row.amount) === original.amount ? 'high' : 'medium';
  await dataService.updateTransactionRoleFields(row.id, {
    auto_role: 'refund',
    role_source: 'refund_match',
    role_confidence: confidence,
    classifier_version: CURRENT_CLASSIFIER_VERSION,
  });
}

/** The one asymmetric direction: a freshly-touched ordinary positive expense may itself be the
 *  original purchase an EXISTING, still-dangling refund candidate (from an earlier batch) has been
 *  waiting to match against — "the purchase syncs after its own refund." The purchase row's own
 *  role is never changed by this — only the dangling refund's, if found. */
async function resolveDanglingRefunds(userId: string, row: ReconciliationRow): Promise<void> {
  const windowEnd = addDaysUtc(row.date, REFUND_WINDOW_DAYS);
  const candidates = await dataService.findDanglingRefundCandidates(userId, row, windowEnd);
  const refund = candidates.find((c) => normalizedIdentity(c) === normalizedIdentity(row));
  if (!refund) return;

  const confidence: RoleConfidence = Math.abs(refund.amount) === row.amount ? 'high' : 'medium';
  await dataService.updateTransactionRoleFields(refund.id, {
    auto_role: 'refund',
    role_source: 'refund_match',
    role_confidence: confidence,
    classifier_version: CURRENT_CLASSIFIER_VERSION,
  });
}

/**
 * Runs stage 2 over exactly the transactions touched by one persisted batch — never a broader
 * scan. Safe to call with an empty list (no-op). Every write here goes only to
 * auto_role/role_source/role_confidence/classifier_version; user_role_override is never read or
 * written.
 */
export async function reconcileRelationalRoles(userId: string, touchedTransactionIds: string[]): Promise<void> {
  if (touchedTransactionIds.length === 0) return;
  const touched = await dataService.getTransactionsForReconciliation(touchedTransactionIds);

  for (const row of touched) {
    if (row.role_source === 'transfer_like_unconfirmed') {
      await resolveTransferCandidate(userId, row);
    }
    if (row.role_source === 'refund_candidate_unconfirmed') {
      await resolveRefundCandidate(userId, row);
    }
    if (row.amount > 0 && row.auto_role === 'expense') {
      await resolveDanglingRefunds(userId, row);
    }
  }
}

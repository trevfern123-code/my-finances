import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import {
  applyRecoveryAction,
  isUuid,
  parseRecoveryActionRequest,
  parseRefreshRetryRequest,
  parseReviewsQuery,
  readRecoveryAction,
  readRecoveryReviews,
  requestRecoveryRefresh,
  type RecoveryActionAnswer,
  type RecoveryFreshness,
  type RecoveryReceipt,
  type RecoveryRefusalCode,
  type RecoveryResult,
} from '../services/cardPaymentRecovery';

/**
 * The recovery endpoints (Financial Semantics Phase B, I3A-R packet 2-A; PHASE_B_I3A_R_PACKET_2A_REVIEW.md §6):
 *
 *   GET  /api/card-payment-recovery/reviews?cursor=&limit=     the legs under review, with their history
 *   POST /api/card-payment-recovery/actions                    one current-payment action
 *   GET  /api/card-payment-recovery/actions/:operationId       the receipt of an operation, or found: false
 *   POST /api/card-payment-recovery/refresh-retries            queue a refresh of the figures (it runs nothing itself)
 *
 * THE OWNER is `req.user.id`, set by requireAuth from the verified session. No field of a body, a query or a
 * path is ever read as an owner.
 *
 * ACTIONS CAN BE SWITCHED OFF (`CARD_PAYMENT_RECOVERY_ACTIONS_ENABLED`, default off). That refuses POST
 * /actions, and nothing else: the protection is in the database and does not depend on this switch; the
 * reviews, the receipts and the refresh-only retry stay available, so an owner whose figures are not current
 * can always ask for them to be refreshed. The retry is not a payment action and needs no such permission.
 *
 * STATUS CODES. 200 for every answered request — including `committed_pending` (the action committed; the
 * figures are not current and a refresh is QUEUED — whether a worker is running it is not known here) and
 * `found: false` (NO RECEIPT IS VISIBLE NOW: the operation's transaction may still be open, so this is not
 * "it was not saved"). 400 for a malformed request. 403 when actions are
 * off. 404 / 409 / 422 for a refusal, with a fixed `code`. 503 when no usable answer was obtained, and 504
 * `outcome_unknown` when the request was abandoned: NOTHING is known then, and the client must ask again with
 * the same operation id (it is told so). No response carries a database message.
 */

const REFUSAL_STATUS: Record<RecoveryRefusalCode, number> = {
  stale_version: 409,
  stale_review: 409,
  operation_conflict: 409,
  counterpart_reserved: 409,
  pair_confirmed: 409,
  decision_replaced: 409,
  not_reviewable: 404,
  not_found: 404,
  invalid_action: 422,
  retry: 503,
};

const REFUSAL_MESSAGE: Record<RecoveryRefusalCode, string> = {
  stale_version: 'The figures changed since this was loaded. Reload and try again.',
  stale_review: 'This review changed since it was loaded. Reload and try again.',
  operation_conflict: 'This request id was already used for a different request.',
  counterpart_reserved: 'The chosen transaction belongs to another confirmed match. Undo that one first.',
  pair_confirmed: 'These transactions are a saved match. Undo the match first.',
  decision_replaced: 'That decision was replaced by a later one. Reload and try again.',
  not_reviewable: 'This payment is not under review.',
  not_found: 'That transaction or decision was not found.',
  invalid_action: 'This action cannot be applied to these transactions.',
  retry: 'The request could not be completed right now. Try again.',
};

function freshnessView(f: RecoveryFreshness) {
  return {
    fresh: f.fresh,
    input_version: f.inputVersion,
    evaluated_version: f.evaluatedVersion,
    review_revision: f.reviewRevision,
    last_error_code: f.lastErrorCode,
    refresh: { queued: f.refresh.queued, needs_attention: f.refresh.needsAttention, attempts: f.refresh.attempts },
  };
}

function receiptView(r: RecoveryReceipt) {
  return {
    operation_id: r.operationId,
    action: r.action,
    intent: r.intent,
    outcome: r.outcome,
    reason: r.reason,
    decision_id: r.decisionId,
    superseded_decision_ids: r.supersededDecisionIds,
    subject_transaction_ids: r.subjectTransactionIds,
    retained_obligation_ids: r.retainedObligationIds,
    permanent_retirement: r.permanentRetirement,
    expected_input_version: r.expectedInputVersion,
    expected_review_revision: r.expectedReviewRevision,
    committed_input_version: r.committedInputVersion,
    committed_review_revision: r.committedReviewRevision,
    committed_at: r.committedAt,
  };
}

function answerView(a: RecoveryActionAnswer) {
  return { status: a.status, receipt: receiptView(a.receipt), freshness: freshnessView(a.freshness) };
}

/** Sends every outcome that is not `ok`. Returns true when it sent one. */
function sendNotOk<T>(res: Response, result: RecoveryResult<T>, operationId: string | null): result is Exclude<RecoveryResult<T>, { kind: 'ok' }> {
  if (result.kind === 'ok') return false;
  if (result.kind === 'refused') {
    res.status(REFUSAL_STATUS[result.code]).json({ error: REFUSAL_MESSAGE[result.code], code: result.code, detail: result.detail });
    return true;
  }
  if (result.kind === 'outcome_unknown') {
    res.status(504).json({
      error: 'The outcome of this request is not known. It may have been saved. Check it before sending anything else.',
      code: 'outcome_unknown',
      operation_id: operationId,
    });
    return true;
  }
  res.status(503).json({ error: 'Payment review is not available right now.', code: 'recovery_unavailable', reason: result.reason });
  return true;
}

export async function getReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const page = parseReviewsQuery(req.query);
    if (page === null) {
      res.status(400).json({ error: 'cursor or limit is not valid', code: 'invalid_request' });
      return;
    }
    const result = await readRecoveryReviews(req.user!.id, page);
    if (sendNotOk(res, result, null)) return;
    const { value } = result;
    res.json({
      fresh: value.fresh,
      freshness: freshnessView(value.freshness),
      affected_payment_count: value.affectedPaymentCount,
      next_cursor: value.nextCursor,
      actions_enabled: env.cardPaymentRecoveryActionsEnabled,
      reviews: value.reviews.map((r) => ({
        transaction_id: r.transactionId,
        account_id: r.accountId,
        date: r.date,
        amount_cents: r.amountCents,
        pending: r.pending,
        side: r.side,
        direction: r.direction,
        account_included: r.accountIncluded,
        state: r.state,
        reason: r.reason,
        detail: r.detail,
        effect_cents: r.effectCents,
        low_cents: r.lowCents,
        high_cents: r.highCents,
        partner_transaction_id: r.partnerTransactionId,
        guard_withheld: r.guardWithheld,
        withheld_partner_transaction_id: r.withheldPartnerTransactionId,
        coverage_gap: r.coverageGap,
        deferred: r.deferred,
        controlling_decision:
          r.controllingDecision === null
            ? null
            : {
                decision_id: r.controllingDecision.decisionId,
                kind: r.controllingDecision.kind,
                status: r.controllingDecision.status,
                detail: r.controllingDecision.detail,
                user_decision: r.controllingDecision.userDecision,
              },
        obligations: r.obligations.map((o) => ({
          obligation_id: o.obligationId,
          origin: o.origin,
          completeness: o.completeness,
          gap_reason: o.gapReason,
          removal_id: o.removalId,
          institution_name: o.institutionName,
          removed_on: o.removedOn,
          known_surviving_edge_count: o.knownSurvivingEdgeCount,
          sources: o.sources.map((s) => ({
            evidence_kind: s.evidenceKind,
            decision_id: s.decisionId,
            decision_kind: s.decisionKind,
            decision_status: s.decisionStatus,
            source_relation: s.sourceRelation,
            source_date: s.sourceDate,
            source_cents: s.sourceCents,
            source_known: s.sourceKnown,
          })),
        })),
        candidates: r.candidates.map((c) => ({
          transaction_id: c.transactionId,
          account_id: c.accountId,
          date: c.date,
          amount_cents: c.amountCents,
          pending: c.pending,
          account_included: c.accountIncluded,
          kind: c.kind,
          distance_days: c.distanceDays,
          difference_cents: c.differenceCents,
          withheld_by_guard: c.withheldByGuard,
          suggestion_only: c.suggestionOnly,
          rejected: c.rejected,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function postAction(req: Request, res: Response, next: NextFunction) {
  try {
    if (!env.cardPaymentRecoveryActionsEnabled) {
      res.status(403).json({
        error: 'Changing a payment from review is switched off. You can still read the review and ask for the figures to be refreshed.',
        code: 'recovery_actions_disabled',
      });
      return;
    }
    const request = parseRecoveryActionRequest(req.body);
    if (request === null) {
      res.status(400).json({ error: 'The action request is not valid', code: 'invalid_request' });
      return;
    }
    // ONE call. Everything the action writes is written by that one database transaction.
    const result = await applyRecoveryAction(req.user!.id, request);
    if (sendNotOk(res, result, request.operationId)) return;
    res.json(answerView(result.value));
  } catch (err) {
    next(err);
  }
}

export async function getAction(req: Request, res: Response, next: NextFunction) {
  try {
    const { operationId } = req.params;
    if (!isUuid(operationId)) {
      res.status(400).json({ error: 'operationId is not valid', code: 'invalid_request' });
      return;
    }
    const result = await readRecoveryAction(req.user!.id, operationId);
    if (sendNotOk(res, result, operationId)) return;
    const { value } = result;
    res.json({ found: value.found, receipt: value.receipt === null ? null : receiptView(value.receipt), freshness: freshnessView(value.freshness) });
  } catch (err) {
    next(err);
  }
}

/** The refresh-only retry. Not gated by the actions switch: it is not a payment action. */
export async function postRefreshRetry(req: Request, res: Response, next: NextFunction) {
  try {
    const request = parseRefreshRetryRequest(req.body);
    if (request === null) {
      res.status(400).json({ error: 'operationId is required', code: 'invalid_request' });
      return;
    }
    const result = await requestRecoveryRefresh(req.user!.id, request.operationId);
    if (sendNotOk(res, result, request.operationId)) return;
    res.json(answerView(result.value));
  } catch (err) {
    next(err);
  }
}

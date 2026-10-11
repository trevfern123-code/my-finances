import { supabaseAdmin } from '../config/supabase';
import { SUPPORTED_EVALUATOR_CONTRACT } from './cardPaymentStateReader';

/**
 * Guarded manual recovery after an institution removal (Financial Semantics Phase B, I3A-R packet 2-A;
 * PHASE_B_I3A_R_PACKET_2A_REVIEW.md; migration 20261009120000).
 *
 * This module is the ONLY caller of the recovery database functions. It never decides anything financial:
 *   - a REVIEW is read with one call (`get_card_payment_recovery_reviews`): one statement, one snapshot;
 *   - an ACTION is one call of ONE database function (`apply_card_payment_recovery_action`), which is one
 *     transaction: the decision, its receipt and the refresh work commit together or not at all. There is
 *     no sequence of writes here and there must never be one;
 *   - a RECEIPT is read by its operation id (`get_card_payment_recovery_action`);
 *   - a REFRESH-ONLY RETRY (`request_card_payment_recovery_refresh`) asks for the figures to be brought up
 *     to date. It is not a payment action: it decides nothing, releases nothing and changes no version;
 *   - the worker's two calls (`claim_card_payment_recovery_refresh`, `refresh_card_payment_recovery_owner`).
 *
 * THE OWNER. Every function takes the user id the caller passes, and the callers pass the id of the
 * verified session (`req.user.id`) or, in the worker, the id the database handed out with a lease. Nothing
 * in a request body is ever read as an owner: the request parsers below copy named fields and nothing else.
 *
 * WHAT AN ANSWER MEANS.
 *   - `ok`: the database answered in the documented shape. For an action that is `committed_fresh`,
 *     `committed_pending` (committed; the figures are not current yet) or `replayed` (this operation id was
 *     committed before; here is its receipt). None of the three carries a figure: figures are read fresh.
 *   - `refused`: the database refused, and wrote nothing. `code` says why, from a fixed list.
 *   - `outcome_unknown`: the request was abandoned (a timeout) or cancelled on the server. NOTHING is known:
 *     the action may have committed. The client asks again with the SAME operation id — a replay returns the
 *     receipt, an absent operation can be sent again. It is never reported as a failure or as a rollback.
 *   - `unavailable`: no usable answer (the functions are missing, the request failed, the answer was not in
 *     the documented shape). It establishes nothing either.
 * No database message is ever forwarded: a refusal is mapped to a code, and logs carry codes only.
 */

export const RECOVERY_READ_TIMEOUT_MS = 10_000;
/** One action is one database transaction that includes a whole-user evaluation. */
export const RECOVERY_ACTION_TIMEOUT_MS = 20_000;
/** The worker's refresh: shorter than the 120 s lease the database hands out. */
export const RECOVERY_REFRESH_TIMEOUT_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^\d{4}-\d{2}-\d{2}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isUuidOrNull = (value: unknown): value is string | null => value === null || isUuid(value);

// ---- Requests ------------------------------------------------------------------------------------

export const RECOVERY_ACTION_TYPES = ['pair_current', 'confirm_unlinked', 'dismiss_candidate', 'undo_decision', 'reject_suggestion', 'defer'] as const;
export type RecoveryActionType = (typeof RECOVERY_ACTION_TYPES)[number];

/** The intent of one action, exactly as the database hashes it: the action's own fields and nothing else. */
export type RecoveryIntent =
  | { action: 'pair_current'; transactionId: string; counterpartTransactionId: string; acceptedDifferenceCents: number }
  | { action: 'confirm_unlinked'; transactionId: string }
  | { action: 'dismiss_candidate'; transactionId: string; candidateTransactionId: string }
  | { action: 'undo_decision'; decisionId: string }
  | { action: 'reject_suggestion'; transactionId: string; candidateTransactionId: string }
  | { action: 'defer'; transactionId: string };

export interface RecoveryActionRequest {
  operationId: string;
  expectedInputVersion: number;
  expectedReviewRevision: number;
  intent: RecoveryIntent;
}

/**
 * Validates an action request body. Returns null for anything that is not exactly a known action with its
 * own fields well-formed. Fields the action does not have — an owner, a user id, anything else — are not
 * rejected and not read: they are simply not copied, so they cannot reach the database.
 */
export function parseRecoveryActionRequest(body: unknown): RecoveryActionRequest | null {
  if (!isRecord(body)) return null;
  const { operationId, expectedInputVersion, expectedReviewRevision, action } = body;
  if (!isUuid(operationId) || !isVersion(expectedInputVersion) || !isVersion(expectedReviewRevision) || !isRecord(action)) return null;
  const type = action.type;
  let intent: RecoveryIntent | null = null;
  if (type === 'pair_current') {
    if (isUuid(action.transactionId) && isUuid(action.counterpartTransactionId) && isCents(action.acceptedDifferenceCents)) {
      intent = {
        action: type,
        transactionId: action.transactionId,
        counterpartTransactionId: action.counterpartTransactionId,
        acceptedDifferenceCents: action.acceptedDifferenceCents,
      };
    }
  } else if (type === 'confirm_unlinked' || type === 'defer') {
    if (isUuid(action.transactionId)) intent = { action: type, transactionId: action.transactionId };
  } else if (type === 'dismiss_candidate' || type === 'reject_suggestion') {
    if (isUuid(action.transactionId) && isUuid(action.candidateTransactionId)) {
      intent = { action: type, transactionId: action.transactionId, candidateTransactionId: action.candidateTransactionId };
    }
  } else if (type === 'undo_decision') {
    if (isUuid(action.decisionId)) intent = { action: type, decisionId: action.decisionId };
  }
  if (intent === null) return null;
  return { operationId, expectedInputVersion, expectedReviewRevision, intent };
}

/** A refresh-only retry names an operation id and nothing else. */
export function parseRefreshRetryRequest(body: unknown): { operationId: string } | null {
  if (!isRecord(body) || !isUuid(body.operationId)) return null;
  return { operationId: body.operationId };
}

export function parseReviewsQuery(query: unknown): { cursor: string | null; limit: number } | null {
  if (!isRecord(query)) return null;
  const { cursor, limit } = query;
  if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return null;
  let parsedLimit = 20;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^[1-9][0-9]?$/.test(limit)) return null;
    parsedLimit = Number(limit);
    if (parsedLimit > 50) return null;
  }
  return { cursor: typeof cursor === 'string' ? cursor : null, limit: parsedLimit };
}

// ---- Answers -------------------------------------------------------------------------------------

/** What the database says NOW about the owner's figures. Never taken from a receipt. */
export interface RecoveryFreshness {
  fresh: boolean;
  inputVersion: number | null;
  evaluatedVersion: number | null;
  reviewRevision: number;
  /** A sanitized SQLSTATE of the last failed evaluation, if one is recorded. */
  lastErrorCode: string | null;
  refresh: { queued: boolean; needsAttention: boolean; attempts: number };
}

/** The committed facts of one operation. Immutable while retained. It carries no figure. */
export interface RecoveryReceipt {
  operationId: string;
  action: RecoveryActionType | 'refresh_retry';
  intent: Record<string, string | number>;
  outcome: 'saved' | 'unchanged' | 'undone' | 'queued';
  reason: string | null;
  decisionId: string | null;
  supersededDecisionIds: string[];
  subjectTransactionIds: string[];
  /** The review obligations on the legs concerned. They all REMAIN: no action retires one. */
  retainedObligationIds: string[];
  permanentRetirement: false;
  expectedInputVersion: number | null;
  expectedReviewRevision: number | null;
  committedInputVersion: number | null;
  committedReviewRevision: number;
  committedAt: string;
}

export interface RecoveryCandidate {
  transactionId: string;
  accountId: string;
  date: string;
  amountCents: number;
  pending: boolean;
  accountIncluded: boolean;
  kind: string;
  distanceDays: number;
  differenceCents: number;
  /** The relink-review guard withheld the automatic pair with this candidate. */
  withheldByGuard: boolean;
  /** Always true: a candidate is what the matcher sees today. It is not verified and never applied alone. */
  suggestionOnly: true;
  /** The user rejected this suggestion at these amounts and dates (workflow only). */
  rejected: boolean;
}

export interface RecoveryObligationSource {
  /**
   * graph_source: a removed candidate the removal read from the eligible graph and wrote NO decision for. It
   * names no decision (decisionId and decisionKind are null). Every other kind names the decision it came from.
   */
  evidenceKind: 'ambiguity_hold' | 'removed_destination' | 'preserved_confirmation' | 'graph_source';
  decisionId: string | null;
  decisionKind: string | null;
  /** The decision's status in this evaluation; null when there is no decision or it no longer exists. */
  decisionStatus: string | null;
  sourceRelation: string | null;
  sourceDate: string | null;
  sourceCents: number | null;
  /** False when what the decision depended on was not recorded (history written before provenance). */
  sourceKnown: boolean;
}

export interface RecoveryObligation {
  obligationId: string;
  origin: 'captured' | 'seeded' | 'gap';
  completeness: 'complete' | 'observed_only' | 'unknown';
  gapReason: 'unattributed_decision' | 'unrecorded_removal' | null;
  removalId: string | null;
  institutionName: string | null;
  removedOn: string | null;
  sources: RecoveryObligationSource[];
  knownSurvivingEdgeCount: number;
}

export interface RecoveryReview {
  transactionId: string;
  accountId: string;
  date: string;
  amountCents: number;
  pending: boolean;
  side: 'cash' | 'credit';
  direction: 'payment' | 'return';
  accountIncluded: boolean;
  state: string;
  reason: string;
  detail: string | null;
  effectCents: number | null;
  lowCents: number;
  highCents: number;
  partnerTransactionId: string | null;
  guardWithheld: boolean;
  withheldPartnerTransactionId: string | null;
  coverageGap: boolean;
  controllingDecision: { decisionId: string; kind: string; status: string; detail: string | null; userDecision: boolean } | null;
  deferred: boolean;
  obligations: RecoveryObligation[];
  candidates: RecoveryCandidate[];
}

export interface RecoveryReviewsPage {
  fresh: boolean;
  freshness: RecoveryFreshness;
  /** Empty unless `fresh`: a review is never shown with figures that are not current. */
  reviews: RecoveryReview[];
  nextCursor: string | null;
  affectedPaymentCount: number;
}

export interface RecoveryActionAnswer {
  status: 'committed_fresh' | 'committed_pending' | 'replayed' | 'queued';
  receipt: RecoveryReceipt;
  freshness: RecoveryFreshness;
}

export const RECOVERY_REFUSAL_CODES = [
  'stale_version',
  'stale_review',
  'operation_conflict',
  'not_reviewable',
  'not_found',
  'invalid_action',
  'counterpart_reserved',
  'pair_confirmed',
  'decision_replaced',
  'retry',
] as const;
export type RecoveryRefusalCode = (typeof RECOVERY_REFUSAL_CODES)[number];

export type RecoveryUnavailableReason = 'objects_missing' | 'request_error' | 'request_failed' | 'unexpected_response';

export type RecoveryResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused'; code: RecoveryRefusalCode; detail: string | null }
  | { kind: 'outcome_unknown' }
  | { kind: 'unavailable'; reason: RecoveryUnavailableReason };

// ---- Parsing what the database returned -----------------------------------------------------------

function parseFreshness(value: unknown): RecoveryFreshness | null {
  if (!isRecord(value) || typeof value.fresh !== 'boolean') return null;
  const inputVersion = value.inputVersion ?? null;
  const evaluatedVersion = value.evaluatedVersion ?? null;
  const lastErrorCode = value.lastErrorCode ?? null;
  const refresh = value.refresh;
  if ((inputVersion !== null && !isVersion(inputVersion)) || (evaluatedVersion !== null && !isVersion(evaluatedVersion))) return null;
  if (!isVersion(value.reviewRevision) || !isStringOrNull(lastErrorCode)) return null;
  if (!isRecord(refresh) || typeof refresh.queued !== 'boolean' || typeof refresh.needsAttention !== 'boolean' || !isVersion(refresh.attempts)) return null;
  // "Fresh" is believed only together with equal versions.
  if (value.fresh && (inputVersion === null || inputVersion !== evaluatedVersion)) return null;
  return {
    fresh: value.fresh,
    inputVersion: inputVersion as number | null,
    evaluatedVersion: evaluatedVersion as number | null,
    reviewRevision: value.reviewRevision,
    // A SQLSTATE is five characters of [0-9A-Z]; anything else is not forwarded.
    lastErrorCode: typeof lastErrorCode === 'string' && /^[0-9A-Z]{5}$/.test(lastErrorCode) ? lastErrorCode : null,
    refresh: { queued: refresh.queued, needsAttention: refresh.needsAttention, attempts: refresh.attempts },
  };
}

const RECEIPT_ACTIONS = new Set<string>([...RECOVERY_ACTION_TYPES, 'refresh_retry']);
const RECEIPT_OUTCOMES = new Set(['saved', 'unchanged', 'undone', 'queued']);
const uuidArray = (value: unknown): string[] | null => (Array.isArray(value) && value.every(isUuid) ? (value as string[]) : null);

function parseReceipt(value: unknown): RecoveryReceipt | null {
  if (!isRecord(value)) return null;
  if (!isUuid(value.operationId) || typeof value.action !== 'string' || !RECEIPT_ACTIONS.has(value.action)) return null;
  if (typeof value.outcome !== 'string' || !RECEIPT_OUTCOMES.has(value.outcome)) return null;
  if (!isRecord(value.intent) || value.intent.action !== value.action) return null;
  const intent: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(value.intent)) {
    if (typeof field !== 'string' && !isCents(field)) return null;
    intent[key] = field;
  }
  const superseded = uuidArray(value.supersededDecisionIds);
  const subjects = uuidArray(value.subjectTransactionIds);
  const retained = uuidArray(value.retainedObligationIds);
  if (superseded === null || subjects === null || retained === null) return null;
  // Packet 2-A retires nothing. A receipt that says otherwise is not one this backend understands.
  if (value.permanentRetirement !== false) return null;
  const expectedInputVersion = value.expectedInputVersion ?? null;
  const expectedReviewRevision = value.expectedReviewRevision ?? null;
  const committedInputVersion = value.committedInputVersion ?? null;
  if (expectedInputVersion !== null && !isVersion(expectedInputVersion)) return null;
  if (expectedReviewRevision !== null && !isVersion(expectedReviewRevision)) return null;
  if (committedInputVersion !== null && !isVersion(committedInputVersion)) return null;
  if (!isVersion(value.committedReviewRevision) || typeof value.committedAt !== 'string') return null;
  if (!isStringOrNull(value.reason ?? null) || !isUuidOrNull(value.decisionId ?? null)) return null;
  return {
    operationId: value.operationId,
    action: value.action as RecoveryReceipt['action'],
    intent,
    outcome: value.outcome as RecoveryReceipt['outcome'],
    reason: (value.reason ?? null) as string | null,
    decisionId: (value.decisionId ?? null) as string | null,
    supersededDecisionIds: superseded,
    subjectTransactionIds: subjects,
    retainedObligationIds: retained,
    permanentRetirement: false,
    expectedInputVersion: expectedInputVersion as number | null,
    expectedReviewRevision: expectedReviewRevision as number | null,
    committedInputVersion: committedInputVersion as number | null,
    committedReviewRevision: value.committedReviewRevision,
    committedAt: value.committedAt,
  };
}

const ANSWER_STATUSES = new Set(['committed_fresh', 'committed_pending', 'replayed', 'queued']);

function parseActionAnswer(value: unknown): RecoveryActionAnswer | null {
  if (!isRecord(value) || typeof value.status !== 'string' || !ANSWER_STATUSES.has(value.status)) return null;
  const receipt = parseReceipt(value.receipt);
  const freshness = parseFreshness(value.freshness);
  if (receipt === null || freshness === null) return null;
  // "committed_fresh" is believed only when the database also says the figures are current.
  if (value.status === 'committed_fresh' && !freshness.fresh) return null;
  return { status: value.status as RecoveryActionAnswer['status'], receipt, freshness };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

const EVIDENCE_KINDS = new Set(['ambiguity_hold', 'removed_destination', 'preserved_confirmation', 'graph_source']);
const dateOrNull = (value: unknown): value is string | null => value === null || (typeof value === 'string' && DATE_ONLY.test(value));

function parseSource(value: unknown): RecoveryObligationSource | null {
  if (!isRecord(value) || typeof value.evidenceKind !== 'string' || !EVIDENCE_KINDS.has(value.evidenceKind)) return null;
  if (typeof value.sourceKnown !== 'boolean') return null;
  const decisionId = value.decisionId ?? null;
  const decisionKind = value.decisionKind ?? null;
  // A graph-observed source names no decision, and nothing else may come without one.
  if (value.evidenceKind === 'graph_source') {
    if (decisionId !== null || decisionKind !== null) return null;
  } else if (!isUuid(decisionId) || typeof decisionKind !== 'string') {
    return null;
  }
  const sourceCents = value.sourceCents ?? null;
  if (!isStringOrNull(value.decisionStatus ?? null) || !isStringOrNull(value.sourceRelation ?? null)) return null;
  if (!dateOrNull(value.sourceDate ?? null) || (sourceCents !== null && !isCents(sourceCents))) return null;
  return {
    evidenceKind: value.evidenceKind as RecoveryObligationSource['evidenceKind'],
    decisionId: decisionId as string | null,
    decisionKind: decisionKind as string | null,
    decisionStatus: (value.decisionStatus ?? null) as string | null,
    sourceRelation: (value.sourceRelation ?? null) as string | null,
    sourceDate: (value.sourceDate ?? null) as string | null,
    sourceCents: sourceCents as number | null,
    sourceKnown: value.sourceKnown,
  };
}

const ORIGINS = new Set(['captured', 'seeded', 'gap']);
const COMPLETENESS = new Set(['complete', 'observed_only', 'unknown']);
const GAP_REASONS = new Set(['unattributed_decision', 'unrecorded_removal']);

function parseObligation(value: unknown): RecoveryObligation | null {
  if (!isRecord(value) || !isUuid(value.obligationId)) return null;
  if (typeof value.origin !== 'string' || !ORIGINS.has(value.origin)) return null;
  if (typeof value.completeness !== 'string' || !COMPLETENESS.has(value.completeness)) return null;
  const gapReason = value.gapReason ?? null;
  if (gapReason !== null && (typeof gapReason !== 'string' || !GAP_REASONS.has(gapReason))) return null;
  // A gap is exactly an obligation with a gap reason.
  if ((value.origin === 'gap') !== (gapReason !== null)) return null;
  if (!isUuidOrNull(value.removalId ?? null) || !isStringOrNull(value.institutionName ?? null) || !dateOrNull(value.removedOn ?? null)) return null;
  const sources = parseList(value.sources, parseSource);
  if (sources === null || !isVersion(value.knownSurvivingEdgeCount)) return null;
  return {
    obligationId: value.obligationId,
    origin: value.origin as RecoveryObligation['origin'],
    completeness: value.completeness as RecoveryObligation['completeness'],
    gapReason: gapReason as RecoveryObligation['gapReason'],
    removalId: (value.removalId ?? null) as string | null,
    institutionName: (value.institutionName ?? null) as string | null,
    removedOn: (value.removedOn ?? null) as string | null,
    sources,
    knownSurvivingEdgeCount: value.knownSurvivingEdgeCount,
  };
}

function parseCandidate(value: unknown): RecoveryCandidate | null {
  if (!isRecord(value) || !isUuid(value.transactionId) || !isUuid(value.accountId)) return null;
  if (typeof value.date !== 'string' || !DATE_ONLY.test(value.date) || !isCents(value.amountCents)) return null;
  if (typeof value.pending !== 'boolean' || typeof value.accountIncluded !== 'boolean' || typeof value.kind !== 'string') return null;
  if (!isVersion(value.distanceDays) || !isCents(value.differenceCents)) return null;
  if (typeof value.withheldByGuard !== 'boolean' || typeof value.rejected !== 'boolean') return null;
  // A candidate that is not marked as a suggestion is not something this backend may pass on.
  if (value.suggestionOnly !== true) return null;
  return {
    transactionId: value.transactionId,
    accountId: value.accountId,
    date: value.date,
    amountCents: value.amountCents,
    pending: value.pending,
    accountIncluded: value.accountIncluded,
    kind: value.kind,
    distanceDays: value.distanceDays,
    differenceCents: value.differenceCents,
    withheldByGuard: value.withheldByGuard,
    suggestionOnly: true,
    rejected: value.rejected,
  };
}

function parseReview(value: unknown): RecoveryReview | null {
  if (!isRecord(value) || !isUuid(value.transactionId) || !isUuid(value.accountId)) return null;
  if (typeof value.date !== 'string' || !DATE_ONLY.test(value.date) || !isCents(value.amountCents)) return null;
  if (typeof value.pending !== 'boolean' || typeof value.accountIncluded !== 'boolean') return null;
  if (value.side !== 'cash' && value.side !== 'credit') return null;
  if (value.direction !== 'payment' && value.direction !== 'return') return null;
  if (typeof value.state !== 'string' || typeof value.reason !== 'string' || !isStringOrNull(value.detail ?? null)) return null;
  const effectCents = value.effectCents ?? null;
  if ((effectCents !== null && !isCents(effectCents)) || !isCents(value.lowCents) || !isCents(value.highCents) || value.lowCents > value.highCents) return null;
  // A definite effect lies within its own bounds; an unresolved counted leg has none.
  if (effectCents !== null && (effectCents !== value.lowCents || effectCents !== value.highCents)) return null;
  if (!isUuidOrNull(value.partnerTransactionId ?? null) || !isUuidOrNull(value.withheldPartnerTransactionId ?? null)) return null;
  if (typeof value.guardWithheld !== 'boolean' || typeof value.coverageGap !== 'boolean' || typeof value.deferred !== 'boolean') return null;
  if (value.guardWithheld !== ((value.withheldPartnerTransactionId ?? null) !== null)) return null;
  // The guard withholds a pair: a withheld leg has no partner.
  if (value.guardWithheld && (value.partnerTransactionId ?? null) !== null) return null;
  let controllingDecision: RecoveryReview['controllingDecision'] = null;
  const decision = value.controllingDecision ?? null;
  if (decision !== null) {
    if (!isRecord(decision) || !isUuid(decision.decisionId) || typeof decision.kind !== 'string' || typeof decision.status !== 'string') return null;
    if (!isStringOrNull(decision.detail ?? null) || typeof decision.userDecision !== 'boolean') return null;
    controllingDecision = {
      decisionId: decision.decisionId,
      kind: decision.kind,
      status: decision.status,
      detail: (decision.detail ?? null) as string | null,
      userDecision: decision.userDecision,
    };
  }
  const obligations = parseList(value.obligations, parseObligation);
  const candidates = parseList(value.candidates, parseCandidate);
  if (obligations === null || candidates === null) return null;
  return {
    transactionId: value.transactionId,
    accountId: value.accountId,
    date: value.date,
    amountCents: value.amountCents,
    pending: value.pending,
    side: value.side,
    direction: value.direction,
    accountIncluded: value.accountIncluded,
    state: value.state,
    reason: value.reason,
    detail: (value.detail ?? null) as string | null,
    effectCents: effectCents as number | null,
    lowCents: value.lowCents,
    highCents: value.highCents,
    partnerTransactionId: (value.partnerTransactionId ?? null) as string | null,
    guardWithheld: value.guardWithheld,
    withheldPartnerTransactionId: (value.withheldPartnerTransactionId ?? null) as string | null,
    coverageGap: value.coverageGap,
    controllingDecision,
    deferred: value.deferred,
    obligations,
    candidates,
  };
}

/** The review reader's `jsonb`, validated field by field. Anything outside the documented shape is null. */
export function parseRecoveryReviews(payload: unknown): RecoveryReviewsPage | null {
  if (!isRecord(payload) || typeof payload.fresh !== 'boolean') return null;
  const freshness = parseFreshness(payload.freshness);
  const reviews = parseList(payload.reviews, parseReview);
  const nextCursor = payload.nextCursor ?? null;
  if (freshness === null || reviews === null || !isVersion(payload.affectedPaymentCount)) return null;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !CURSOR.test(nextCursor))) return null;
  // The two statements of freshness must agree, and a list that is not fresh carries no review.
  if (payload.fresh !== freshness.fresh || (!payload.fresh && (reviews.length > 0 || nextCursor !== null))) return null;
  return { fresh: payload.fresh, freshness, reviews, nextCursor: nextCursor as string | null, affectedPaymentCount: payload.affectedPaymentCount };
}

// ---- Calling the database --------------------------------------------------------------------------

const MISSING_OBJECT_CODES = new Set(['PGRST202', '42883', '42P01']);
/** A cancelled or timed-out statement: the transaction was aborted on the server, but which statement it
 *  was — before or after a commit could have happened — is not something this module infers. */
const CANCELLED_CODES = new Set(['57014', '57P01']);
/** Serialization failure, deadlock detected, lock not available: nothing was written; the request can be sent again. */
const RETRY_CODES = new Set(['40001', '40P01', '55P03']);

/** The fixed prefixes the database functions raise, and the code each becomes. Order matters: the longer
 *  prefixes first. */
const REFUSALS: ReadonlyArray<readonly [string, RecoveryRefusalCode]> = [
  ['card_payment_recovery_stale_review', 'stale_review'],
  ['card_payment_recovery_operation_conflict', 'operation_conflict'],
  ['card_payment_recovery_not_reviewable', 'not_reviewable'],
  ['card_payment_recovery_invalid', 'invalid_action'],
  ['card_payment_recovery_retry', 'retry'],
  ['card_payment_stale_version', 'stale_version'],
  ['card_payment_not_found', 'not_found'],
  ['card_payment_counterpart_reserved', 'counterpart_reserved'],
  ['card_payment_pair_confirmed', 'pair_confirmed'],
  ['card_payment_decision_replaced', 'decision_replaced'],
  ['card_payment_invalid', 'invalid_action'],
  ['card_payment_ineligible', 'invalid_action'],
];
/** The named reasons a refusal may carry on to the client: fixed words, never a database message. */
const REFUSAL_DETAILS = [
  'difference_not_accepted',
  'sides_not_opposite',
  'direction_mismatch',
  'same_transaction',
  'not_cash_side',
  'system_decision',
  'not_a_suggestion',
  'lineage_ambiguous',
  'superseded',
  'not_card_payment',
  'zero_amount',
  'invalid_cursor',
  'malformed_request',
] as const;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

function classifyError<T>(call: string, error: unknown, status: number | undefined, signal: AbortSignal): RecoveryResult<T> {
  const code = errorCode(error);
  if (signal.aborted) {
    console.warn(`Recovery: ${call} was abandoned after its timeout; the server outcome is unknown`, { outcome: 'outcome_unknown' });
    return { kind: 'outcome_unknown' };
  }
  if (code !== undefined && CANCELLED_CODES.has(code)) {
    console.warn(`Recovery: ${call} was cancelled on the server; its outcome is unknown`, { outcome: 'outcome_unknown', code });
    return { kind: 'outcome_unknown' };
  }
  if (code !== undefined && RETRY_CODES.has(code)) return { kind: 'refused', code: 'retry', detail: null };
  if (status === 0 && code === undefined) {
    console.warn(`Recovery: ${call} obtained no answer`, { outcome: 'request_failed' });
    return { kind: 'unavailable', reason: 'request_failed' };
  }
  if (code !== undefined && MISSING_OBJECT_CODES.has(code)) {
    console.warn(`Recovery: ${call} found no such database object; the recovery migration is not applied`, { outcome: 'objects_missing', code });
    return { kind: 'unavailable', reason: 'objects_missing' };
  }
  const message = errorMessage(error);
  for (const [prefix, refusal] of REFUSALS) {
    if (message.startsWith(`${prefix}:`)) {
      const detail = REFUSAL_DETAILS.find((word) => message.includes(word)) ?? null;
      return { kind: 'refused', code: refusal, detail };
    }
  }
  console.warn(`Recovery: ${call} returned an error`, { outcome: 'request_error', code: code ?? 'none' });
  return { kind: 'unavailable', reason: 'request_error' };
}

async function call<T>(name: string, args: Record<string, unknown>, timeoutMs: number, parse: (data: unknown) => T | null): Promise<RecoveryResult<T>> {
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(timeoutMs);
    const { data, error, status } = await supabaseAdmin.rpc(name, args).abortSignal(signal);
    if (error) return classifyError(name, error, status, signal);
    const parsed = parse(data);
    if (parsed === null) {
      console.warn(`Recovery: ${name} answered outside its documented shape`, { outcome: 'unexpected_response', responseType: data === null ? 'null' : typeof data });
      return { kind: 'unavailable', reason: 'unexpected_response' };
    }
    return { kind: 'ok', value: parsed };
  } catch (err) {
    if (signal?.aborted) {
      console.warn(`Recovery: ${name} was abandoned after its timeout; the server outcome is unknown`, { outcome: 'outcome_unknown' });
      return { kind: 'outcome_unknown' };
    }
    console.warn(`Recovery: ${name} obtained no answer`, { outcome: 'request_failed', errorName: err instanceof Error ? err.name : 'UnknownThrownValue' });
    return { kind: 'unavailable', reason: 'request_failed' };
  }
}

export interface RecoveryCallOptions {
  timeoutMs?: number;
}

/** The legs under review for this user: the affected payments and the legs the guard withheld. One snapshot. */
export function readRecoveryReviews(
  userId: string,
  page: { cursor: string | null; limit: number },
  options: RecoveryCallOptions = {}
): Promise<RecoveryResult<RecoveryReviewsPage>> {
  return call(
    'get_card_payment_recovery_reviews',
    { p_user_id: userId, p_cursor: page.cursor, p_limit: page.limit },
    options.timeoutMs ?? RECOVERY_READ_TIMEOUT_MS,
    parseRecoveryReviews
  );
}

/** One action: ONE database call, ONE transaction. */
export function applyRecoveryAction(userId: string, request: RecoveryActionRequest, options: RecoveryCallOptions = {}): Promise<RecoveryResult<RecoveryActionAnswer>> {
  return call(
    'apply_card_payment_recovery_action',
    {
      p_user_id: userId,
      p_operation_id: request.operationId,
      p_expected_input_version: request.expectedInputVersion,
      p_expected_review_revision: request.expectedReviewRevision,
      p_action: request.intent,
    },
    options.timeoutMs ?? RECOVERY_ACTION_TIMEOUT_MS,
    (data) => {
      const answer = parseActionAnswer(data);
      // An action answers committed_fresh, committed_pending or replayed — and its receipt is this operation's.
      if (answer === null || answer.status === 'queued' || answer.receipt.operationId !== request.operationId) return null;
      return answer;
    }
  );
}

export interface RecoveryActionLookup {
  found: boolean;
  receipt: RecoveryReceipt | null;
  freshness: RecoveryFreshness;
}

/**
 * The receipt of an operation, or `found: false`. After an unknown outcome a client asks here — but only a
 * receipt is an answer. `found: false` says that no receipt is VISIBLE now: the operation's transaction writes
 * its receipt with its decision and may not have committed yet, or the request may not have arrived. It is not
 * "nothing was saved".
 */
export function readRecoveryAction(userId: string, operationId: string, options: RecoveryCallOptions = {}): Promise<RecoveryResult<RecoveryActionLookup>> {
  return call(
    'get_card_payment_recovery_action',
    { p_user_id: userId, p_operation_id: operationId },
    options.timeoutMs ?? RECOVERY_READ_TIMEOUT_MS,
    (data) => {
      if (!isRecord(data) || typeof data.found !== 'boolean') return null;
      const freshness = parseFreshness(data.freshness);
      if (freshness === null) return null;
      if (!data.found) return (data.receipt ?? null) === null ? { found: false, receipt: null, freshness } : null;
      const receipt = parseReceipt(data.receipt);
      if (receipt === null || receipt.operationId !== operationId) return null;
      return { found: true, receipt, freshness };
    }
  );
}

/** The refresh-only retry: registers refresh work for the server's current version of this owner. */
export function requestRecoveryRefresh(userId: string, operationId: string, options: RecoveryCallOptions = {}): Promise<RecoveryResult<RecoveryActionAnswer>> {
  return call(
    'request_card_payment_recovery_refresh',
    { p_user_id: userId, p_operation_id: operationId },
    options.timeoutMs ?? RECOVERY_READ_TIMEOUT_MS,
    (data) => {
      const answer = parseActionAnswer(data);
      // A refresh request answers queued or replayed, with a refresh receipt — never a payment action's.
      if (answer === null || (answer.status !== 'queued' && answer.status !== 'replayed')) return null;
      if (answer.receipt.action !== 'refresh_retry' || answer.receipt.operationId !== operationId) return null;
      return answer;
    }
  );
}

// ---- The worker's two calls ------------------------------------------------------------------------

export interface RecoveryClaim {
  userId: string;
  leaseToken: string;
  targetVersion: number;
  attempts: number;
}

export function claimRecoveryRefresh(workerToken: string, limit: number, options: RecoveryCallOptions = {}): Promise<RecoveryResult<RecoveryClaim[]>> {
  return call(
    'claim_card_payment_recovery_refresh',
    { p_worker_token: workerToken, p_limit: limit },
    options.timeoutMs ?? RECOVERY_READ_TIMEOUT_MS,
    (data) => {
      if (!isRecord(data)) return null;
      return parseList(data.claims, (item): RecoveryClaim | null => {
        if (!isRecord(item) || !isUuid(item.userId) || !isUuid(item.leaseToken) || !isVersion(item.targetVersion) || !isVersion(item.attempts)) return null;
        return { userId: item.userId, leaseToken: item.leaseToken, targetVersion: item.targetVersion, attempts: item.attempts };
      });
    }
  );
}

export type RecoveryRefreshStatus = 'fresh' | 'pending' | 'superseded' | 'lease_lost';

export function refreshRecoveryOwner(userId: string, leaseToken: string, options: RecoveryCallOptions = {}): Promise<RecoveryResult<{ status: RecoveryRefreshStatus }>> {
  return call(
    'refresh_card_payment_recovery_owner',
    { p_user_id: userId, p_lease_token: leaseToken },
    options.timeoutMs ?? RECOVERY_REFRESH_TIMEOUT_MS,
    (data) => {
      if (!isRecord(data)) return null;
      const { status } = data;
      if (status !== 'fresh' && status !== 'pending' && status !== 'superseded' && status !== 'lease_lost') return null;
      return { status };
    }
  );
}

/** For tests and the packet note: the contract this module was written against. */
export const RECOVERY_EVALUATOR_CONTRACT = SUPPORTED_EVALUATOR_CONTRACT;

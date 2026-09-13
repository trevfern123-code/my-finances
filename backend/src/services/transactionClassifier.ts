/**
 * Financial Semantics Foundation, Phase A — the canonical, centralized semantic-role classifier.
 * See the approved Financial Semantics Foundation Design (+ corrections + pre-implementation
 * contract + Round 2 remediation) for the full rationale; this file implements exactly that
 * precedence and nothing more.
 *
 * `classifyCore` is a pure function: given one transaction's own fields (no database access), it
 * either returns a final classification (precedence steps A–D, F) or a "relational candidate" —
 * a transaction whose true role depends on evidence elsewhere in the database (an
 * internal-transfer counterpart leg). A relational candidate still carries a complete, safe
 * classification of its own (the sign-based fallback) — it is never left unclassified —
 * `roleReconciliation.ts` is what may later *upgrade* it once relational evidence is checked (see
 * that module's own doc comment for the two-stage design).
 *
 * Round 2 remediation: an earlier version of this classifier treated EVERY negative amount not
 * otherwise classified as a "refund candidate" (tagged `refund_candidate_unconfirmed`), even
 * ordinary income like a paycheck with no refund evidence anywhere near it — incorrect
 * provenance, since there was no actual evidence of a refund at that point, only a sign. An
 * ordinary negative amount now classifies directly and finally as `income`/`sign_default` (step
 * F below), identical in spirit to how an ordinary positive amount classifies as
 * `expense`/`sign_default`. Refund detection is now entirely reconciliation's responsibility
 * (see roleReconciliation.ts): it considers ANY negative, `sign_default`-classified transaction
 * as a potential refund each time it's touched, and only ever upgrades it to `refund`/
 * `refund_match` once real relational evidence (a matching earlier ordinary expense) is found —
 * there is no separate "candidate" tag or classifier-level bookkeeping for this, exactly as
 * required ("do not create another speculative refund candidate source").
 *
 * Nothing in this file is wired into any ingestion, sync, or aggregation path yet — Phase A only
 * establishes the classifier and its persistence; no existing financial calculation consumes its
 * output (that is Phase B+, deliberately deferred).
 */

export const CURRENT_CLASSIFIER_VERSION = 1;

export type SemanticRole =
  | 'expense'
  | 'income'
  | 'internal_transfer'
  | 'credit_card_payment'
  | 'debt_payment'
  | 'refund';

export type RoleSource =
  | 'manual_loan_link'
  | 'category_detailed'
  | 'category_primary_fallback'
  | 'category_detailed_account_transfer'
  | 'account_pair_match'
  | 'refund_match'
  | 'transfer_like_unconfirmed'
  | 'sign_default';

export type RoleConfidence = 'high' | 'medium' | 'low';

export interface RoleClassification {
  autoRole: SemanticRole;
  roleSource: RoleSource;
  roleConfidence: RoleConfidence;
  classifierVersion: number;
}

/** The subset of a transaction's own fields the row-level classifier needs — deliberately not
 *  `TransactionRow` itself, so this module has no dependency on the DB layer's types and stays a
 *  pure, trivially-testable function of plain values. */
export interface ClassifierRowInput {
  amount: number;
  /** Plaid's `personal_finance_category.primary` — already persisted today as `category`. */
  personalFinanceCategoryPrimary: string | null;
  /** Plaid's `personal_finance_category.detailed` — newly persisted in Phase A. */
  personalFinanceCategoryDetailed: string | null;
  /** Plaid's raw `personal_finance_category.confidence_level` (`VERY_HIGH`/`HIGH`/`MEDIUM`/`LOW`/`UNKNOWN`). */
  personalFinanceCategoryConfidence: string | null;
  /** Non-null iff this transaction is currently linked to a manual loan — precedence step A. */
  manualLoanId: string | null;
}

/** A row-level classification result that still needs a relational (database) check before it can
 *  be considered final — the classifier has already assigned the safe fallback role so the row is
 *  never unclassified in the meantime. Transfers are the only kind produced at classification
 *  time; refund evidence is checked by reconciliation against any ordinary sign_default negative
 *  transaction directly, with no separate candidate tag (see this file's own doc comment). */
export interface RelationalCandidate {
  kind: 'transfer';
  fallback: RoleClassification;
}

export type ClassifyCoreResult =
  | { status: 'final'; result: RoleClassification }
  | { status: 'relational_candidate'; candidate: RelationalCandidate };

const HIGH_CONFIDENCE = new Set(['VERY_HIGH', 'HIGH']);

const ACCOUNT_TRANSFER_DETAILED = new Set(['TRANSFER_IN_ACCOUNT_TRANSFER', 'TRANSFER_OUT_ACCOUNT_TRANSFER']);

function isHighConfidence(raw: string | null): boolean {
  return raw !== null && HIGH_CONFIDENCE.has(raw);
}

function signFallback(amount: number, source: RoleSource): RoleClassification {
  return {
    autoRole: amount > 0 ? 'expense' : 'income',
    roleSource: source,
    roleConfidence: 'low',
    classifierVersion: CURRENT_CLASSIFIER_VERSION,
  };
}

/**
 * Row-level precedence (steps A–D, F of the approved design; step E is relational and handled by
 * the caller via the returned candidate — see roleReconciliation.ts). Pure: no I/O, no Date.now,
 * fully deterministic from its input.
 */
export function classifyCore(input: ClassifierRowInput): ClassifyCoreResult {
  // A — manual-loan link always wins, regardless of category. Detailed principal/interest
  // reporting is handled later by getSemanticEffects(), not represented as a distinct role here —
  // this scalar role is only ever the whole-row summary (indexing/UI), see semanticEffects.ts.
  if (input.manualLoanId !== null) {
    return {
      status: 'final',
      result: {
        autoRole: 'debt_payment',
        roleSource: 'manual_loan_link',
        roleConfidence: 'high',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    };
  }

  // B — high-confidence credit-card payment.
  if (
    input.personalFinanceCategoryDetailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' &&
    isHighConfidence(input.personalFinanceCategoryConfidence)
  ) {
    return {
      status: 'final',
      result: {
        autoRole: 'credit_card_payment',
        roleSource: 'category_detailed',
        roleConfidence: 'high',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    };
  }

  // C — any other loan payment (detailed missing/unrecognized/low-confidence) falls back to the
  // broader debt_payment role rather than ordinary expense — still correctly excluded from spend.
  if (input.personalFinanceCategoryPrimary === 'LOAN_PAYMENTS') {
    return {
      status: 'final',
      result: {
        autoRole: 'debt_payment',
        roleSource: 'category_primary_fallback',
        roleConfidence: 'low',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    };
  }

  // D — Plaid's own high-confidence "this is between your own accounts" signal.
  if (
    input.personalFinanceCategoryDetailed !== null &&
    ACCOUNT_TRANSFER_DETAILED.has(input.personalFinanceCategoryDetailed) &&
    isHighConfidence(input.personalFinanceCategoryConfidence)
  ) {
    return {
      status: 'final',
      result: {
        autoRole: 'internal_transfer',
        roleSource: 'category_detailed_account_transfer',
        roleConfidence: 'high',
        classifierVersion: CURRENT_CLASSIFIER_VERSION,
      },
    };
  }

  // E — ambiguous transfer-shaped category: never auto-classify as internal_transfer on category
  // alone. Falls back to the ordinary sign-based role now, tagged as a relational candidate so
  // roleReconciliation.ts can attempt an account-pair match and upgrade it later.
  if (
    input.personalFinanceCategoryPrimary === 'TRANSFER_IN' ||
    input.personalFinanceCategoryPrimary === 'TRANSFER_OUT'
  ) {
    return {
      status: 'relational_candidate',
      candidate: { kind: 'transfer', fallback: signFallback(input.amount, 'transfer_like_unconfirmed') },
    };
  }

  // F — plain sign-based fallback: a positive amount is an ordinary expense, a negative amount is
  // ordinary income, final either way. This is a genuine, final classification, not a "candidate"
  // — most negative amounts (paychecks, direct deposits, etc.) really are just income with no
  // refund evidence anywhere nearby, and tagging them as speculative refund candidates would be
  // incorrect provenance (see this file's own doc comment). Reconciliation still independently
  // reconsiders any sign_default negative row against real refund evidence each time it's
  // touched — it just doesn't need a classifier-level tag to know which rows are eligible.
  return { status: 'final', result: signFallback(input.amount, 'sign_default') };
}

/** Convenience wrapper for callers that don't need to distinguish "final" from "relational
 *  candidate" themselves and are fine taking the candidate's safe fallback as-is — used by
 *  ingestion (which always defers the actual relational check to the reconciliation pass that
 *  runs immediately afterward, see roleReconciliation.ts's own doc comment for why). */
export function classifyRowLevel(input: ClassifierRowInput): RoleClassification {
  const core = classifyCore(input);
  return core.status === 'final' ? core.result : core.candidate.fallback;
}

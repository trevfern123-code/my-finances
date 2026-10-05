import { AggregateSnapshotUnavailableError, AggregateTooLargeError } from '../services/fetchAllPages';
import {
  CardPaymentStateIntegrityError,
  SemanticAggregationIntegrityError,
  SplitAllocationMismatchError,
} from '../services/semanticAggregation';
import { SemanticIntegrityError } from '../services/semanticEffects';

/**
 * Financial Semantics Phase B, integration slice I1 — the explicit failures of the role-aware read
 * path (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §4.1 R9, §7.4, §13 Q3; CARD_PAYMENT_PAIRING_DESIGN.md
 * §3.2).
 *
 * An integrity failure fails the request: it is never turned into a plausible figure, and never
 * replaced by the sign-based one. Each body is a FIXED message and a machine-readable code; the only
 * data relayed is the id of the user's OWN transaction. The underlying message — which can quote
 * amounts — is never sent.
 */

/**
 * The frozen and the role-aware halves of one response, computed from the same snapshot, disagree
 * about something they cannot disagree about (which months exist). That is a defect, not a data
 * state: the request fails rather than publish either half as if it were coherent.
 */
export class SemanticResultInconsistentError extends Error {
  readonly code = 'semantic_result_inconsistent';
  constructor(detail: string) {
    super(`semantic_result_inconsistent: ${detail}`);
  }
}

export interface SplitMismatchFields {
  code: 'split_allocation_mismatch';
  /** The first affected transaction. */
  transaction_id: string;
  mismatches: { transaction_id: string; parent_amount: number; split_total: number | null }[];
}

export function splitMismatchFields(err: SplitAllocationMismatchError): SplitMismatchFields {
  return {
    code: 'split_allocation_mismatch',
    transaction_id: err.transactionId,
    mismatches: err.mismatches.map((m) => ({
      transaction_id: m.transactionId,
      parent_amount: m.parentAmount,
      // A split amount that is not a finite number has no total (JSON cannot carry NaN).
      split_total: Number.isFinite(m.splitTotal) ? m.splitTotal : null,
    })),
  };
}

export interface SemanticErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

const INCONSISTENT_DATA = 'One transaction has inconsistent data, so these figures are paused.';

/** The response for a failure of the role-aware read path, or null for any other error. */
export function semanticErrorResponse(err: unknown): SemanticErrorResponse | null {
  if (err instanceof SemanticAggregationIntegrityError) {
    return { status: 500, body: { error: INCONSISTENT_DATA, code: 'semantic_integrity_error', transaction_id: err.transactionId } };
  }
  if (err instanceof SemanticIntegrityError) {
    return { status: 500, body: { error: INCONSISTENT_DATA, code: 'semantic_integrity_error' } };
  }
  if (err instanceof CardPaymentStateIntegrityError) {
    return {
      status: 500,
      body: {
        error: 'A card payment has no usable matching state, so these figures are paused.',
        code: err.code,
        transaction_id: err.transactionId,
      },
    };
  }
  if (err instanceof SplitAllocationMismatchError) {
    return {
      status: 409,
      body: {
        error: 'A split transaction no longer adds up, so budget figures are paused until its splits are corrected.',
        ...splitMismatchFields(err),
      },
    };
  }
  if (err instanceof AggregateTooLargeError) {
    return {
      status: 500,
      body: { error: 'This range has too many transactions to total; nothing partial was returned.', code: err.code },
    };
  }
  if (err instanceof AggregateSnapshotUnavailableError) {
    return {
      status: 500,
      body: { error: 'This range could not be read as one consistent set; nothing partial was returned.', code: err.code },
    };
  }
  if (err instanceof SemanticResultInconsistentError) {
    return {
      status: 500,
      body: { error: 'These figures could not be assembled consistently, so none were returned.', code: err.code },
    };
  }
  return null;
}

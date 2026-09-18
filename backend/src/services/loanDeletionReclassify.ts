import { classifyRowLevel } from './transactionClassifier';

/** The classifier inputs of one transaction currently linked to a manual loan being deleted. */
export interface LinkedTransactionClassifierInputs {
  id: string;
  amount: number;
  category: string | null;
  personal_finance_category_detailed: string | null;
  personal_finance_category_confidence: string | null;
}

export interface LoanDeletionReclassifyRow {
  id: string;
  auto_role: string;
  role_source: string;
  role_confidence: string;
  classifier_version: number;
  exp_amount: number;
  exp_category: string | null;
  exp_pfc_detailed: string | null;
  exp_pfc_confidence: string | null;
}

/**
 * Builds `delete_manual_loan_atomic`'s `p_reclassify` payload: each linked row's post-unlink role,
 * plus the exact classifier inputs that role was computed from (the exp_* fields).
 *
 * The exp_* fields are what make the RPC's decision safe. Classification runs here, outside the
 * RPC's lock, so the RPC compares every exp_* value against the locked row and rejects the whole
 * deletion if any changed in between — a concurrent resync re-categorizing a linked payment would
 * otherwise have its new category silently overwritten by a role computed from the old one.
 *
 * Kept free of any database import so it can be exercised directly, including by the committed
 * PostgreSQL harness (supabase/tests/phase_a), which drives the real compiled classifier.
 */
export function buildLoanDeletionReclassifyPayload(
  rows: LinkedTransactionClassifierInputs[]
): LoanDeletionReclassifyRow[] {
  return rows.map((row) => {
    const classification = classifyRowLevel({
      amount: row.amount,
      personalFinanceCategoryPrimary: row.category,
      personalFinanceCategoryDetailed: row.personal_finance_category_detailed,
      personalFinanceCategoryConfidence: row.personal_finance_category_confidence,
      manualLoanId: null,
    });
    return {
      id: row.id,
      auto_role: classification.autoRole,
      role_source: classification.roleSource,
      role_confidence: classification.roleConfidence,
      classifier_version: classification.classifierVersion,
      exp_amount: row.amount,
      exp_category: row.category,
      exp_pfc_detailed: row.personal_finance_category_detailed,
      exp_pfc_confidence: row.personal_finance_category_confidence,
    };
  });
}

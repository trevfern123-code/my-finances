/**
 * Financial Semantics Foundation, Phase A — historical backfill.
 *
 * Classifies every existing `transactions` row that doesn't have an `auto_role` yet, using the
 * exact same classifier (transactionClassifier.ts) and the exact same bounded relational
 * reconciliation pass (roleReconciliation.ts) live sync uses — no separate logic path. Processes
 * oldest-first, in bounded batches, and is trivially resumable/idempotent: each batch's rows are
 * classified before the next batch is fetched, so the same underlying query
 * (`getUnclassifiedTransactionsBatch`, `auto_role IS NULL`) naturally returns the next page on its
 * own — an interrupted run just needs to be started again with the same arguments.
 *
 * Never touches category_mappings, transaction_splits, manual_loans, principal_portion, or
 * user_role_override — it only ever writes auto_role/role_source/role_confidence/
 * classifier_version, the same four fields ingestion and reconciliation write. A row already
 * linked to a manual loan classifies immediately via precedence step A (manual_loan_link), exactly
 * as it would have at ingestion time had this feature existed then.
 *
 * Historical rows synced before Phase A never received personal_finance_category_detailed/
 * confidence_level (that field wasn't being persisted) — this script does NOT invent them or make
 * a fresh Plaid call to backfill them; it classifies from whatever is already stored (sign,
 * .primary, manual-loan state, and — via the reconciliation pass — relational evidence already in
 * the database). Those rows simply classify at lower confidence until a future resync happens to
 * touch them again, or a user corrects one manually. No Plaid relinking is ever required.
 *
 * Dry run by default (no `--apply`, no writes at all — the whole classify+reconcile pipeline still
 * runs, so a dry run's logged counts are a real preview, not a guess). Safe to interrupt
 * (SIGINT/SIGTERM) between batches; a batch already in flight finishes before stopping.
 */

import * as dataService from '../services/dataService';
import { classifyRowLevel } from '../services/transactionClassifier';
import { reconcileRelationalRoles } from '../services/roleReconciliation';

const DEFAULT_BATCH_SIZE = 500;

export interface ParsedArgs {
  batchSize: number;
  apply: boolean;
}

export class ArgError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  let batchSize = DEFAULT_BATCH_SIZE;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--batch-size') {
      const raw = argv[i + 1];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        throw new ArgError('--batch-size requires a positive integer.');
      }
      batchSize = parsed;
      i++;
    } else {
      throw new ArgError(`Unrecognized argument: ${arg}`);
    }
  }

  return { batchSize, apply };
}

interface LogFields {
  stage: string;
  outcome: string;
  batch?: number;
  count?: number;
  byRole?: Record<string, number>;
}

export function logEntry(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

let interruptRequested = false;
function installSignalHandlers(): void {
  const onSignal = (signal: string) => {
    interruptRequested = true;
    logEntry({ stage: 'signal', outcome: `received_${signal.toLowerCase()}` });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

/** Exposed only for tests, which can't send this process a real OS signal. */
export function __setInterruptedForTests(value: boolean): void {
  interruptRequested = value;
}

/** Classifies and (if `apply`) persists one batch, then (if `apply`) runs the same reconciliation
 *  pass live sync uses, grouped per user (reconciliation is user-scoped). Returns how many rows
 *  were processed and a role-count breakdown, for logging — the caller decides whether to continue. */
export async function processBatch(batchSize: number, apply: boolean): Promise<{ processed: number; byRole: Record<string, number> }> {
  const batch = await dataService.getUnclassifiedTransactionsBatch(batchSize);
  const byRole: Record<string, number> = {};
  const touchedIdsByUser = new Map<string, string[]>();

  for (const row of batch) {
    const classification = classifyRowLevel({
      amount: row.amount,
      personalFinanceCategoryPrimary: row.category,
      personalFinanceCategoryDetailed: row.personal_finance_category_detailed,
      personalFinanceCategoryConfidence: row.personal_finance_category_confidence,
      manualLoanId: row.manual_loan_id,
    });
    byRole[classification.autoRole] = (byRole[classification.autoRole] ?? 0) + 1;

    if (apply) {
      await dataService.updateTransactionRoleFields(row.id, {
        auto_role: classification.autoRole,
        role_source: classification.roleSource,
        role_confidence: classification.roleConfidence,
        classifier_version: classification.classifierVersion,
      });
      const existing = touchedIdsByUser.get(row.user_id) ?? [];
      existing.push(row.id);
      touchedIdsByUser.set(row.user_id, existing);
    }
  }

  if (apply) {
    for (const [userId, ids] of touchedIdsByUser) {
      try {
        await reconcileRelationalRoles(userId, ids);
      } catch (err) {
        logEntry({ stage: 'reconcile', outcome: 'failed_non_fatal' });
        console.error(`Reconciliation failed for user ${userId} during backfill:`, err);
      }
    }
  }

  return { processed: batch.length, byRole };
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logEntry({ stage: 'startup', outcome: `failed:${err instanceof Error ? err.message : 'invalid_arguments'}` });
    return 1;
  }

  installSignalHandlers();
  logEntry({ stage: 'startup', outcome: args.apply ? 'apply_mode' : 'dry_run_mode' });

  let batchNumber = 0;
  let totalProcessed = 0;
  const totalByRole: Record<string, number> = {};

  for (;;) {
    if (interruptRequested) {
      logEntry({ stage: 'run', outcome: 'interrupted', batch: batchNumber, count: totalProcessed });
      return 1;
    }

    batchNumber++;
    const { processed, byRole } = await processBatch(args.batchSize, args.apply);
    totalProcessed += processed;
    for (const [role, count] of Object.entries(byRole)) {
      totalByRole[role] = (totalByRole[role] ?? 0) + count;
    }
    logEntry({ stage: 'batch', outcome: 'processed', batch: batchNumber, count: processed, byRole });

    if (processed === 0) break; // no more unclassified rows
    if (processed < args.batchSize) break; // last (partial) page
  }

  logEntry({
    stage: 'done',
    outcome: args.apply ? 'apply_complete' : 'dry_run_complete',
    count: totalProcessed,
    byRole: totalByRole,
  });
  return 0;
}

/* istanbul ignore next -- exercised via a process spawned in manual/production use, not unit tests */
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      logEntry({ stage: 'fatal', outcome: 'failed:unexpected_error' });
      console.error(err);
      process.exitCode = 1;
    });
}

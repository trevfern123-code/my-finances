/**
 * Financial Semantics Foundation, Phase A — historical backfill (Round 2 remediation §10-§13).
 *
 * Classifies existing `transactions` rows using the exact same classifier
 * (transactionClassifier.ts) and the exact same bounded reconciliation pass
 * (roleReconciliation.ts) live sync uses — no separate logic path.
 *
 * Traversal is deterministic KEYSET pagination over (date, id) — never OFFSET over a mutating
 * result set, and never gated on `auto_role IS NULL` (an earlier version of this script paged by
 * re-querying "still unclassified" rows, which meant a page whose reconciliation step failed
 * AFTER its rows already had `auto_role` written would silently disappear from all future runs —
 * permanently skipped, exactly the defect this traversal is designed to make impossible). Every
 * row in the traversal range is visited on every run; a write only happens when the row actually
 * needs one (`auto_role IS NULL`, or `classifier_version` behind `--target-version`, or `--force`)
 * — but reconciliation is always (re-)attempted for the whole page, so a page whose reconciliation
 * previously failed gets retried on the next run, safely (row-level writes are idempotent no-ops
 * the second time; reconciliation's own matching queries are read-heavy and re-running them is
 * exactly the repair mechanism).
 *
 * Dry run by default (no `--apply`, no writes at all) — reuses the identical traversal and the
 * identical reconciliation logic in preview mode (`apply: false`, see roleReconciliation.ts), so
 * its reported classifications and relational outcomes are genuinely truthful, not a guess.
 *
 * Never touches category_mappings, transaction_splits, manual_loans, principal_portion, or
 * user_role_override. No Plaid relinking is ever required — historical rows classify from
 * whatever is already stored (sign, .primary, manual-loan state, and relational evidence already
 * in the database); rows synced before personal_finance_category_detailed/confidence existed
 * simply classify at lower confidence until a future resync happens to touch them again.
 *
 * `--target-version <n>` (defaults to the classifier's own CURRENT_CLASSIFIER_VERSION, which
 * remains 1 for Phase A) makes a FUTURE classifier-version upgrade backfill possible — rows whose
 * `classifier_version` is behind the target get reclassified — without this ordinary run ever
 * reclassifying current rows.
 *
 * A reconciliation failure during an apply run is NOT treated as success: the script logs the
 * failure and exits non-zero. Safe to interrupt (SIGINT/SIGTERM, checked between pages) and rerun.
 */

import * as dataService from '../services/dataService';
import type { BackfillCandidateRow, BackfillPageCursor } from '../services/dataService';
import { classifyRowLevel, CURRENT_CLASSIFIER_VERSION } from '../services/transactionClassifier';
import { reconcileRelationalRoles } from '../services/roleReconciliation';

const DEFAULT_BATCH_SIZE = 500;

export interface ParsedArgs {
  batchSize: number;
  apply: boolean;
  force: boolean;
  targetVersion: number;
  after: BackfillPageCursor | null;
}

export class ArgError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  let batchSize = DEFAULT_BATCH_SIZE;
  let apply = false;
  let force = false;
  let targetVersion = CURRENT_CLASSIFIER_VERSION;
  let afterDate: string | null = null;
  let afterId: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--batch-size') {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        throw new ArgError('--batch-size requires a positive integer.');
      }
      batchSize = parsed;
    } else if (arg === '--target-version') {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        throw new ArgError('--target-version requires a positive integer.');
      }
      targetVersion = parsed;
    } else if (arg === '--after-date') {
      afterDate = argv[++i];
      if (afterDate === undefined) throw new ArgError('--after-date requires a value.');
    } else if (arg === '--after-id') {
      afterId = argv[++i];
      if (afterId === undefined) throw new ArgError('--after-id requires a value.');
    } else {
      throw new ArgError(`Unrecognized argument: ${arg}`);
    }
  }

  if ((afterDate === null) !== (afterId === null)) {
    throw new ArgError('--after-date and --after-id must be supplied together (a resume cursor is both or neither).');
  }

  return {
    batchSize,
    apply,
    force,
    targetVersion,
    after: afterDate !== null && afterId !== null ? { date: afterDate, id: afterId } : null,
  };
}

interface LogFields {
  stage: string;
  outcome: string;
  page?: number;
  count?: number;
  classified?: number;
  byRole?: Record<string, number>;
  resolved?: number;
  unresolved?: number;
  cursor?: BackfillPageCursor | null;
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

function needsClassification(row: BackfillCandidateRow, targetVersion: number, force: boolean): boolean {
  if (force) return true;
  if (row.auto_role === null) return true;
  return row.classifier_version < targetVersion;
}

export interface PageResult {
  page: BackfillCandidateRow[];
  classified: number;
  byRole: Record<string, number>;
  resolvedCount: number;
  unresolvedCount: number;
  nextCursor: BackfillPageCursor | null;
}

/** Processes exactly one page of the keyset traversal: classifies rows that need it, then runs
 *  reconciliation over the WHOLE page's ids (grouped per user) regardless of which rows needed a
 *  fresh classification — a page whose evidence changed (a counterpart classified in the same
 *  page, for instance) still deserves a reconciliation attempt even for rows that didn't need
 *  their own row-level rewrite this run. `apply: false` performs the identical reads/ranking with
 *  no writes at all (see roleReconciliation.ts). */
export async function processPage(
  cursor: BackfillPageCursor | null,
  batchSize: number,
  apply: boolean,
  force: boolean,
  targetVersion: number
): Promise<PageResult> {
  const page = await dataService.getTransactionsBackfillPage(batchSize, cursor);
  const byRole: Record<string, number> = {};
  let classified = 0;
  const idsByUser = new Map<string, string[]>();

  for (const row of page) {
    if (needsClassification(row, targetVersion, force)) {
      const classification = classifyRowLevel({
        amount: row.amount,
        personalFinanceCategoryPrimary: row.category,
        personalFinanceCategoryDetailed: row.personal_finance_category_detailed,
        personalFinanceCategoryConfidence: row.personal_finance_category_confidence,
        manualLoanId: row.manual_loan_id,
      });
      byRole[classification.autoRole] = (byRole[classification.autoRole] ?? 0) + 1;
      classified++;
      if (apply) {
        await dataService.updateTransactionRoleFields(row.user_id, row.id, {
          auto_role: classification.autoRole,
          role_source: classification.roleSource,
          role_confidence: classification.roleConfidence,
          classifier_version: classification.classifierVersion,
        });
      }
    }
    const existing = idsByUser.get(row.user_id) ?? [];
    existing.push(row.id);
    idsByUser.set(row.user_id, existing);
  }

  let resolvedCount = 0;
  let unresolvedCount = 0;
  for (const [userId, ids] of idsByUser) {
    const result = await reconcileRelationalRoles(userId, ids, apply);
    resolvedCount += result.resolved.length;
    unresolvedCount += result.unresolved.length;
  }

  const last = page[page.length - 1];
  return {
    page,
    classified,
    byRole,
    resolvedCount,
    unresolvedCount,
    nextCursor: last ? { date: last.date, id: last.id } : cursor,
  };
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
  logEntry({ stage: 'startup', outcome: args.apply ? 'apply_mode' : 'dry_run_mode', cursor: args.after });

  let cursor = args.after;
  let pageNumber = 0;
  let totalRows = 0;
  let totalClassified = 0;
  let totalResolved = 0;
  let totalUnresolved = 0;
  const totalByRole: Record<string, number> = {};

  for (;;) {
    if (interruptRequested) {
      logEntry({ stage: 'run', outcome: 'interrupted', page: pageNumber, cursor });
      return 1;
    }

    pageNumber++;
    let result: PageResult;
    try {
      result = await processPage(cursor, args.batchSize, args.apply, args.force, args.targetVersion);
    } catch (err) {
      // Round 2 remediation §12: a failure here is NOT success — `cursor` has not been advanced
      // past this page, so rerunning (with the same --after-date/--after-id, or from scratch)
      // safely retries exactly this work: row-level writes that already landed are idempotent
      // no-ops, and reconciliation's own matching queries are safe to re-run.
      logEntry({ stage: 'page', outcome: 'failed', page: pageNumber, cursor });
      console.error(err);
      return 1;
    }

    totalRows += result.page.length;
    totalClassified += result.classified;
    totalResolved += result.resolvedCount;
    totalUnresolved += result.unresolvedCount;
    for (const [role, count] of Object.entries(result.byRole)) {
      totalByRole[role] = (totalByRole[role] ?? 0) + count;
    }
    logEntry({
      stage: 'page',
      outcome: 'processed',
      page: pageNumber,
      count: result.page.length,
      classified: result.classified,
      byRole: result.byRole,
      resolved: result.resolvedCount,
      unresolved: result.unresolvedCount,
      cursor: result.nextCursor,
    });

    if (result.page.length === 0) break; // traversal exhausted
    cursor = result.nextCursor;
    if (result.page.length < args.batchSize) break; // last (partial) page
  }

  logEntry({
    stage: 'done',
    outcome: args.apply ? 'apply_complete' : 'dry_run_complete',
    count: totalRows,
    classified: totalClassified,
    byRole: totalByRole,
    resolved: totalResolved,
    unresolved: totalUnresolved,
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

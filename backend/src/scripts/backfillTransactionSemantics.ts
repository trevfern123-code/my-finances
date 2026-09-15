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
import type { BackfillCandidateRow, BackfillPageCursor, ReconciliationRow } from '../services/dataService';
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
      // Round 3 remediation §10: this binary can only ever WRITE classifications produced by its
      // own CURRENT_CLASSIFIER_VERSION — a target above that would ask the script to claim a
      // future algorithm version it doesn't actually implement.
      if (parsed > CURRENT_CLASSIFIER_VERSION) {
        throw new ArgError(
          `--target-version (${parsed}) cannot exceed the classifier's current version (${CURRENT_CLASSIFIER_VERSION}).`
        );
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

/**
 * Whether `row` should be (re)classified this run — Round 3 remediation §10. `currentVersion`
 * (defaulting to the real CURRENT_CLASSIFIER_VERSION, overridable only for tests that need to
 * simulate a future-version scenario without touching the real constant) is checked FIRST and
 * unconditionally: a row already at a classifier_version newer than what this binary can actually
 * produce must never be touched, even under `--force` — `--force` means "re-run the current
 * classifier on rows it's safe to re-run it on," never "downgrade a row to an older algorithm's
 * output."
 */
export function needsClassification(
  row: BackfillCandidateRow,
  targetVersion: number,
  force: boolean,
  currentVersion: number = CURRENT_CLASSIFIER_VERSION
): boolean {
  if (row.classifier_version > currentVersion) return false;
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

/** Per-user hypothetical-state pool, keyed by transaction id, that survives across MULTIPLE
 *  `processPage` calls for the same dry run (Round 4 remediation §10) — `main` owns one of these
 *  for the whole traversal and threads it through every page. Never populated/consulted in apply
 *  mode: the DB already reflects every prior page's writes by the time reconciliation re-fetches
 *  it there, so an accumulating in-memory pool would be redundant (and, over a large backfill,
 *  needlessly growing) — see `processPage`'s own doc comment. */
export type CumulativeDryRunPool = Map<string, Map<string, ReconciliationRow>>;

/** Processes exactly one page of the keyset traversal: classifies rows that need it, then runs
 *  reconciliation over the WHOLE page's ids (grouped per user) regardless of which rows needed a
 *  fresh classification — a page whose evidence changed (a counterpart classified in the same
 *  page, for instance) still deserves a reconciliation attempt even for rows that didn't need
 *  their own row-level rewrite this run. `apply: false` performs the identical reads/ranking with
 *  no writes at all (see roleReconciliation.ts).
 *
 *  Round 3 remediation §7 / Round 4 remediation §10: in dry-run mode, `cumulativePool` supplies
 *  (and accumulates) a hypothetical, freshly-computed-but-never-written classification per row
 *  visited so far in THIS ENTIRE RUN, not just this one page — a truthful preview needs a
 *  same-batch sibling's hypothetical state to survive page boundaries (leg A on page 1, leg B on
 *  page 2 must still preview as a resolved pair), and needs an EARLIER page's resolved outcome
 *  (a relational match, or a repair-sweep reset) to be visible to a LATER page's own candidate
 *  search, not just its initial row-level classification. `main` owns one `cumulativePool` for
 *  the whole traversal and passes it to every `processPage` call; omit it (or pass a fresh empty
 *  map) to preview a single page in isolation, e.g. in a test. */
export async function processPage(
  cursor: BackfillPageCursor | null,
  batchSize: number,
  apply: boolean,
  force: boolean,
  targetVersion: number,
  cumulativePool: CumulativeDryRunPool = new Map()
): Promise<PageResult> {
  const page = await dataService.getTransactionsBackfillPage(batchSize, cursor);
  const byRole: Record<string, number> = {};
  let classified = 0;
  const idsByUser = new Map<string, string[]>();

  for (const row of page) {
    let fields: { auto_role: ReturnType<typeof classifyRowLevel>['autoRole']; role_source: string; role_confidence: string; classifier_version: number } | null = null;
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
      fields = {
        auto_role: classification.autoRole,
        role_source: classification.roleSource,
        role_confidence: classification.roleConfidence,
        classifier_version: classification.classifierVersion,
      };
      if (apply) {
        await dataService.applyTransactionSemanticRoles(row.user_id, [row.id], fields);
      }
    }
    const existing = idsByUser.get(row.user_id) ?? [];
    existing.push(row.id);
    idsByUser.set(row.user_id, existing);

    // Round 4 remediation §11 (dry-run strictly zero-write): nothing below this line ever calls
    // a mutation boundary — it only ever builds/updates the in-memory `cumulativePool`, and only
    // when `!apply` (apply mode never touches or grows this map at all — see this function's own
    // doc comment for why it would be redundant there).
    if (!apply) {
      const autoRole = fields ? fields.auto_role : row.auto_role;
      const poolRow: ReconciliationRow = {
        id: row.id,
        account_id: row.account_id,
        amount: row.amount,
        date: row.date,
        name: row.name,
        merchant_name: row.merchant_name,
        category: row.category,
        personal_finance_category_detailed: row.personal_finance_category_detailed,
        personal_finance_category_confidence: row.personal_finance_category_confidence,
        manual_loan_id: row.manual_loan_id,
        auto_role: autoRole,
        role_source: fields ? fields.role_source : row.role_source,
        role_confidence: fields ? fields.role_confidence : null,
        effective_role: row.user_role_override ?? autoRole,
        user_role_override: row.user_role_override,
      };
      const userPool = cumulativePool.get(row.user_id) ?? new Map<string, ReconciliationRow>();
      userPool.set(row.id, poolRow);
      cumulativePool.set(row.user_id, userPool);
    }
  }

  let resolvedCount = 0;
  let unresolvedCount = 0;
  for (const [userId, ids] of idsByUser) {
    const userPoolMap = apply ? undefined : cumulativePool.get(userId);
    const pool = userPoolMap ? Array.from(userPoolMap.values()) : [];
    const result = await reconcileRelationalRoles(userId, ids, apply, pool);

    // Round 4 remediation §10: feed this page's relational outcome back into the cumulative pool
    // so a LATER page's own candidate search sees the RESOLVED hypothetical state (e.g. now
    // internal_transfer/refund) rather than the pre-resolution row-level snapshot recorded above.
    if (userPoolMap) {
      for (const outcome of result.resolved) {
        const existing = userPoolMap.get(outcome.id);
        if (existing) {
          userPoolMap.set(outcome.id, {
            ...existing,
            auto_role: outcome.fields.auto_role,
            role_source: outcome.fields.role_source,
            role_confidence: outcome.fields.role_confidence,
            effective_role: existing.user_role_override ?? outcome.fields.auto_role,
          });
        }
      }
    }

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
  // Round 4 remediation §10: one cumulative hypothetical-state pool for the WHOLE traversal,
  // threaded through every processPage call — see CumulativeDryRunPool's own doc comment.
  const cumulativePool: CumulativeDryRunPool = new Map();

  for (;;) {
    if (interruptRequested) {
      logEntry({ stage: 'run', outcome: 'interrupted', page: pageNumber, cursor });
      return 1;
    }

    pageNumber++;
    let result: PageResult;
    try {
      result = await processPage(cursor, args.batchSize, args.apply, args.force, args.targetVersion, cumulativePool);
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

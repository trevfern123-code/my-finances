import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import * as plaidService from '../services/plaidService';
import * as dataService from '../services/dataService';
import * as syncService from '../services/syncService';
import * as netWorthService from '../services/netWorth';
import { aggregateByMonth } from '../services/monthlyBreakdown';
import { normalizeToMonthlyAmount } from '../services/recurringStreams';
import { computePayoffProgressPct, refreshLoansForItem } from '../services/loans';
import { groupAccountsForAssetsSummary, type AssetAccount } from '../services/assetsSummary';
import { getCurrentMonthRange } from '../services/budgetPeriod';
import { isReportingRangeId, resolveReportingRange, type ResolvedRange } from '../services/reportingRange';
import { PlaidCredentialError } from '../services/tokenEncryption';
import { interpretHostedLinkSessions } from '../services/hostedLink';
import { summarizeErrorSafely } from '../services/errorSanitizer';
import { isSyncableItemStatus } from '../services/itemStatus';
import { ItemRemovalIncompleteError, runItemRemoval, toRemovalView } from '../services/itemRemoval';
import { env } from '../config/env';

/** Date-Range Customization v1: `range_id` (one of the 5 reporting-range presets) takes
 *  precedence when present and valid; falls back to the legacy `months` count (default 6,
 *  clamped 1-24) otherwise, preserving the exact pre-existing behavior for any caller that
 *  doesn't pass `range_id` — including this app's own frontend before it's updated, and any
 *  future client that only knows about `months`. */
function resolveRangeFromQuery(query: Request['query']): ResolvedRange {
  const rangeIdParam = query.range_id;
  if (isReportingRangeId(rangeIdParam)) {
    return resolveReportingRange(rangeIdParam);
  }
  const months = Math.min(Math.max(Number(query.months ?? 6), 1), 24);
  return { sinceDate: netWorthService.getMonthsAgoStart(months) };
}

function sumIncomeAndSpent(transactions: { amount: number }[]): { spent: number; income: number } {
  return transactions.reduce(
    (totals, t) => {
      // Plaid convention: positive amount = money out (spend), negative = money in (income/credit).
      if (t.amount >= 0) totals.spent += t.amount;
      else totals.income += -t.amount;
      return totals;
    },
    { spent: 0, income: 0 }
  );
}

export async function getSpendingSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { sinceDate, untilDate } = resolveRangeFromQuery(req.query);

    const accounts = await dataService.getAccountBalancesForUser(userId);
    const { assets, liabilities } = netWorthService.aggregateAssetsAndLiabilities(accounts);

    const transactions = await dataService.getTransactionsSince(userId, sinceDate, untilDate);

    const byMonth = new Map<string, { spent: number; income: number }>();
    for (const t of transactions) {
      const month = t.date.slice(0, 7);
      const bucket = byMonth.get(month) ?? { spent: 0, income: 0 };
      if (t.amount >= 0) bucket.spent += t.amount;
      else bucket.income += -t.amount;
      byMonth.set(month, bucket);
    }

    const monthlySpending = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, totals]) => ({ month, ...totals }));

    // Current-period operational metrics (Cash Flow Pace, Income & Savings' Savings Rate) mean
    // "how am I doing this month" intrinsically — that must stay true no matter what historical
    // reporting range the user has selected, so this is always its own explicit current-month
    // query rather than reused from whatever `monthly_spending` happens to contain (which, for
    // the 'last_month' preset, deliberately excludes the current month entirely).
    const currentRange = getCurrentMonthRange();
    const currentMonthTransactions = await dataService.getTransactionsSince(
      userId,
      currentRange.start,
      currentRange.end
    );

    res.json({
      net_worth: assets - liabilities,
      total_assets: assets,
      total_liabilities: liabilities,
      monthly_spending: monthlySpending,
      current_month: sumIncomeAndSpent(currentMonthTransactions),
    });
  } catch (err) {
    next(err);
  }
}

export async function getMonthlyBreakdown(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { sinceDate, untilDate } = resolveRangeFromQuery(req.query);

    const transactions = await dataService.getCategorizedTransactionsSince(userId, sinceDate, untilDate);

    res.json({ months: aggregateByMonth(transactions) });
  } catch (err) {
    next(err);
  }
}

export async function getRecurringStreams(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const streams = await dataService.getRecurringStreamsForUser(userId);

    const withMonthlyAmount = streams
      .map((stream) => ({
        ...stream,
        // Plaid convention: inflow amounts are negative, outflow positive — monthly_amount is a
        // display-oriented magnitude, so normalize to positive regardless of direction (which
        // already unambiguously says which way the money moves).
        monthly_amount: Math.abs(normalizeToMonthlyAmount(stream.average_amount, stream.frequency)),
      }))
      .sort((a, b) => b.monthly_amount - a.monthly_amount);

    const totalMonthlyOutflow = withMonthlyAmount
      .filter((s) => s.direction === 'outflow')
      .reduce((sum, s) => sum + s.monthly_amount, 0);
    const totalMonthlyInflow = withMonthlyAmount
      .filter((s) => s.direction === 'inflow')
      .reduce((sum, s) => sum + s.monthly_amount, 0);

    res.json({
      streams: withMonthlyAmount,
      total_monthly_outflow: totalMonthlyOutflow,
      total_monthly_inflow: totalMonthlyInflow,
    });
  } catch (err) {
    next(err);
  }
}

export async function getLoans(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const loans = await dataService.getLoansForUser(userId);

    const withProgress = loans.map((loan) => ({
      ...loan,
      payoff_progress_pct: computePayoffProgressPct(loan.origination_principal_amount, loan.current_balance),
    }));

    const totalDebt = withProgress.reduce((sum, l) => sum + (l.current_balance ?? 0), 0);
    const totalMinimumPayment = withProgress.reduce((sum, l) => sum + (l.minimum_payment_amount ?? 0), 0);

    res.json({ loans: withProgress, total_debt: totalDebt, total_minimum_payment: totalMinimumPayment });
  } catch (err) {
    next(err);
  }
}

export async function getAssetsSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const items = await dataService.getLinkedItemsForUser(userId);

    const accounts: AssetAccount[] = items.flatMap((item) =>
      item.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        official_name: account.official_name,
        type: account.type,
        subtype: account.subtype,
        current_balance: account.current_balance,
        iso_currency_code: account.iso_currency_code,
        institution_name: item.institution_name,
        savings_goal: account.savings_goal,
        nickname: account.nickname,
        color: account.color,
        icon: account.icon,
        sort_order: account.sort_order,
        hidden: account.hidden,
        exclude_from_net_worth: account.exclude_from_net_worth,
      }))
    );

    const groups = groupAccountsForAssetsSummary(accounts);
    const totalAssets = groups.reduce((sum, g) => sum + g.total, 0);

    res.json({ groups, total_assets: totalAssets });
  } catch (err) {
    next(err);
  }
}

export async function getNetWorthHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { sinceDate, untilDate } = resolveRangeFromQuery(req.query);

    const history = await dataService.getNetWorthHistory(userId, sinceDate, untilDate);

    res.json({ history });
  } catch (err) {
    next(err);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wave 1 (Hosted Link): starts linking a bank account. The backend creates a Plaid HOSTED Link
 * token and stores it — encrypted, never logged, never returned — in a one-time, 30-minute attempt
 * bound to the verified user AND login session (the verified token's `session_id`). The client
 * gets only the Hosted Link URL to open and the opaque attempt id to complete later.
 */
export async function createLinkToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { id: userId, sessionId } = req.user!;
    if (!sessionId) {
      res.status(401).json({ error: 'Sign in again before linking an account.', code: 'session_required' });
      return;
    }
    const attemptId = randomUUID();
    const { linkToken, hostedLinkUrl } = await plaidService.createHostedLinkToken(userId);
    const { expiresAt } = await dataService.createPlaidLinkAttempt({ attemptId, userId, sessionId, linkToken });
    res.json({ hosted_link_url: hostedLinkUrl, link_attempt_id: attemptId, expires_at: expiresAt });
  } catch (err) {
    if (err instanceof dataService.TooManyPlaidLinkAttemptsError) {
      res.status(429).json({ error: err.message, code: 'link_attempts_in_progress' });
      return;
    }
    next(err);
  }
}

/**
 * RETIRED (Wave 1 review P1). Accepting a public token from a client let one user exchange a public
 * token captured from another. Nothing reads the body — whatever it carries — and nothing reaches
 * the attempt store or Plaid; the route exists only so a cached pre-Hosted-Link frontend gets a
 * clear, permanent answer.
 */
export function exchangePublicToken(_req: Request, res: Response) {
  res.status(410).json({
    error: 'This page is out of date. Reload it and link the account again.',
    code: 'exchange_retired',
  });
}

/**
 * exchange_unknown: Plaid may have created the Item even though its access token was never stored
 * here, so the connection may exist at Plaid. Deliberately does NOT say it was not added, and does
 * NOT invite linking again — relinking before the uncertain Item is checked could create a
 * duplicate Item (and duplicate billing). It asks the user to wait and contact support instead.
 */
export const LINK_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether this bank connection was completed. Please don't try linking this bank again yet — contact support so the connection can be checked first.";

type AttemptRefusal ='invalid' | 'expired' | 'completed' | 'failed' | 'ambiguous' | 'exited' | 'exchange_unknown';

/** The fixed, non-sensitive refusal for each way an attempt cannot be completed. */
function attemptRefusal(res: Response, outcome: AttemptRefusal) {
  switch (outcome) {
    case 'invalid':
      res.status(409).json({
        error: 'This bank link is no longer valid for the signed-in account. Start linking the account again.',
        code: 'link_attempt_invalid',
      });
      return;
    case 'expired':
      res.status(410).json({
        error: 'This bank link took too long and expired. Start linking the account again.',
        code: 'link_attempt_expired',
      });
      return;
    case 'completed':
      res.status(409).json({ error: 'This bank link has already been completed.', code: 'link_attempt_already_completed' });
      return;
    case 'exited':
      res.status(409).json({ error: 'Linking was cancelled before it finished. Start again when you are ready.', code: 'link_attempt_exited' });
      return;
    case 'ambiguous':
      res.status(409).json({
        error: 'Plaid reported more than one account connection for this link. Start linking again.',
        code: 'link_attempt_ambiguous',
      });
      return;
    case 'failed':
      res.status(409).json({ error: 'This bank link did not finish. Start linking the account again.', code: 'link_attempt_failed' });
      return;
    case 'exchange_unknown':
      res.status(409).json({ error: LINK_OUTCOME_UNKNOWN_MESSAGE, code: 'link_attempt_outcome_unknown' });
      return;
  }
}

/** Responds to a claim that was not won: another call is on it (202), or it has already ended. */
function claimRefusal(res: Response, outcome: Exclude<dataService.PlaidLinkClaim['outcome'], 'claimed'>) {
  if (outcome === 'in_progress') {
    res.status(202).json({ status: 'completing' });
    return;
  }
  attemptRefusal(res, outcome);
}

function logLinkFailure(step: string, err: unknown) {
  // Never the raw error: a Plaid/Axios error carries the outgoing request (tokens included).
  console.error(`Plaid Link completion: ${step} failed:`, summarizeErrorSafely(err));
}

/**
 * Completes a Hosted Link attempt. The ONLY way a Plaid item is created:
 *  1. The attempt must be the caller's own — its verified user AND login session — or nothing is
 *     revealed or touched (409 link_attempt_invalid). Ended attempts get their final answer.
 *  2. The backend reads its OWN stored (encrypted) link token and asks Plaid (/link/token/get) for
 *     the public token of that link token's own session. No public token is ever taken from the
 *     request. Still in progress -> 202 pending; exited or ambiguous -> the attempt fails.
 *  3. Exactly one public token -> CLAIM (one conditional UPDATE, with a claim token): only the
 *     claimer continues. It then durably records that the exchange may start (exchanging) and only
 *     then calls /item/public_token/exchange — once. Plaid does not document re-exchanging a public
 *     token as safe, so an attempt that reached `exchanging` is never exchanged again.
 *  4. The Item is stored IMMEDIATELY after the exchange — encrypted access token, in the same
 *     database transaction that completes the attempt — before any other Plaid call. From then on
 *     it is linked: institution, accounts, initial sync, net-worth snapshot and liabilities are
 *     best-effort follow-ups that can be retried (Refresh balances / Sync transactions / webhooks)
 *     and never undo the link; the response lists any that did not finish (follow_up_incomplete).
 *  5. If the exchange is rejected by Plaid -> failed. If its outcome is unknown (network error,
 *     timeout) -> exchange_unknown. If the Item could not be stored and the database definitively
 *     stored nothing -> /item/remove at Plaid; failed if confirmed, exchange_unknown if not. If
 *     whether it was stored is itself unknown -> nothing is removed (it might be stored), and the
 *     attempt resolves on a later call: completed, or exchange_unknown once stale.
 *  6. Recovery: a claim older than two minutes whose exchange never began is safely re-claimed; an
 *     exchange older than two minutes with no stored item becomes exchange_unknown.
 */
export async function completeLinkAttempt(req: Request, res: Response, next: NextFunction) {
  const { id: userId, sessionId } = req.user!;
  const { attemptId } = req.params;
  if (typeof attemptId !== 'string' || !UUID_PATTERN.test(attemptId)) {
    attemptRefusal(res, 'invalid');
    return;
  }
  if (!sessionId) {
    res.status(401).json({ error: 'Sign in again before linking an account.', code: 'session_required' });
    return;
  }

  try {
    const attempt = await dataService.readPlaidLinkAttempt(attemptId, userId, sessionId);
    if (!attempt) return attemptRefusal(res, 'invalid');
    switch (attempt.status) {
      case 'completed':
      case 'failed':
      case 'exchange_unknown':
        return attemptRefusal(res, attempt.status);
      case 'exchanging':
        if (!attempt.stale) {
          res.status(202).json({ status: 'completing' });
          return;
        }
      {
        // Its process is presumed gone mid-exchange: the claim records exchange_unknown (or reports
        // completed, if that exchange's store committed meanwhile). Never re-claimed.
        const recovered = await dataService.claimPlaidLinkAttempt(attemptId, userId, sessionId);
        if (recovered.outcome === 'claimed') {
          res.status(202).json({ status: 'completing' }); // cannot happen for an exchanging attempt
          return;
        }
        return claimRefusal(res, recovered.outcome);
      }
      case 'claimed':
        if (!attempt.stale) {
          res.status(202).json({ status: 'completing' });
          return;
        }
        break; // Abandoned before its exchange began: safe to take over, like a pending attempt.
      case 'pending':
        break;
    }
    if (attempt.expired) return attemptRefusal(res, 'expired');

    const outcome = interpretHostedLinkSessions(await plaidService.getLinkTokenSessions(attempt.linkToken));
    if (outcome.kind === 'pending') {
      res.status(202).json({ status: 'pending' });
      return;
    }
    if (outcome.kind !== 'success') {
      await dataService.failPlaidLinkAttempt(attemptId, userId, sessionId, null, outcome.kind);
      return attemptRefusal(res, outcome.kind);
    }

    const claim = await dataService.claimPlaidLinkAttempt(attemptId, userId, sessionId);
    if (claim.outcome !== 'claimed') return claimRefusal(res, claim.outcome);
    const { claimToken } = claim;
    if (!(await dataService.beginPlaidLinkExchange(attemptId, userId, sessionId, claimToken))) {
      res.status(202).json({ status: 'completing' });
      return;
    }

    // ---- The exchange: attempted exactly once, never retried. -----------------------------------
    let exchanged: { accessToken: string; itemId: string };
    try {
      exchanged = await plaidService.exchangePublicToken(outcome.publicToken);
    } catch (err) {
      const rejected = plaidService.isDefinitivePlaidRejection(err);
      logLinkFailure(rejected ? 'exchange (rejected by Plaid)' : 'exchange (outcome unknown)', err);
      await dataService
        .failPlaidLinkAttempt(attemptId, userId, sessionId, claimToken, rejected ? 'exchange_rejected' : 'exchange_outcome_unknown')
        .catch((failErr) => logLinkFailure('recording the exchange failure', failErr));
      return attemptRefusal(res, rejected ? 'failed' : 'exchange_unknown');
    }
    const { accessToken, itemId } = exchanged;

    // ---- Durable immediately: item + completion in one transaction. ----------------------------
    let stored: Awaited<ReturnType<typeof dataService.storePlaidLinkItem>>;
    try {
      stored = await dataService.storePlaidLinkItem({ attemptId, userId, sessionId, claimToken, plaidItemId: itemId, accessToken });
    } catch (err) {
      if (err instanceof PlaidCredentialError) {
        // Encryption failed before anything was sent: definitively not stored.
        logLinkFailure('storing the item (encryption)', err);
        stored = { outcome: 'rejected' };
      } else {
        // Unknown whether it was stored, so it must NOT be removed at Plaid. The attempt stays
        // exchanging: a later call finds it completed, or (once stale) records exchange_unknown.
        logLinkFailure('storing the item (outcome unknown)', err);
        res.status(202).json({ status: 'completing' });
        return;
      }
    }
    if (stored.outcome !== 'stored') {
      // Definitively not stored: compensate at Plaid, and never claim success we cannot confirm.
      let removed = false;
      try {
        await plaidService.removeItem(accessToken);
        removed = true;
      } catch (err) {
        logLinkFailure('removing the unstored item at Plaid', err);
      }
      await dataService
        .failPlaidLinkAttempt(attemptId, userId, sessionId, claimToken, removed ? 'store_failed_item_removed' : 'store_failed_remove_unknown')
        .catch((failErr) => logLinkFailure('recording the store failure', failErr));
      return attemptRefusal(res, removed ? 'failed' : 'exchange_unknown');
    }
    const { itemRowId } = stored;

    // ---- Linked. Everything below is retryable follow-up work that never undoes the link. -------
    const followUpIncomplete: string[] = [];
    async function followUp<T>(step: string, work: () => Promise<T>): Promise<T | undefined> {
      try {
        return await work();
      } catch (err) {
        followUpIncomplete.push(step);
        logLinkFailure(`follow-up '${step}' for item ${itemRowId}`, err);
        return undefined;
      }
    }

    const institution = await followUp('institution', async () => {
      const found = await plaidService.getItemInstitution(accessToken);
      await dataService.updatePlaidItemInstitution(itemRowId, found.institutionId, found.institutionName);
      return found;
    });
    const accountRows = await followUp('accounts', async () =>
      dataService.upsertAccountsForItem(itemRowId, await plaidService.getAccounts(accessToken))
    );
    let transactionsSynced = 0;
    if (accountRows) {
      // Pull initial transaction history right away so the dashboard isn't empty until the
      // webhook (or a manual sync) delivers the next update.
      const synced = await followUp('transactions', () =>
        syncService.syncItemTransactions({ id: itemRowId, user_id: userId, access_token: accessToken, transactions_cursor: null })
      );
      transactionsSynced = synced?.added ?? 0;
    } else {
      followUpIncomplete.push('transactions');
    }
    // Today's net worth, now that the item exists — a total across all the user's items.
    await followUp('net_worth_snapshot', () => netWorthService.recordSnapshotForUser(userId));
    if (accountRows) {
      // Only produces data if the `liabilities` product is enabled and this item has loan accounts.
      const accountIdByPlaidId = new Map(accountRows.map((a) => [a.plaid_account_id, a.id]));
      await followUp('liabilities', () => refreshLoansForItem(itemRowId, accessToken, accountIdByPlaidId));
    } else {
      followUpIncomplete.push('liabilities');
    }

    // Neither the access token nor any Plaid token is ever included in the response.
    res.status(201).json({
      status: 'completed',
      item: {
        id: itemRowId,
        institution_id: institution?.institutionId ?? null,
        institution_name: institution?.institutionName ?? null,
      },
      accounts: accountRows ?? [],
      transactions_synced: transactionsSynced,
      follow_up_incomplete: followUpIncomplete,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * The user's connections, each with its removal operation (if one is under way), plus
 * `unfinished_removals`: every removal not yet complete — including one whose item is already deleted
 * but whose follow-ups still need to run, which would otherwise be invisible to the user.
 */
async function getConnectionsForUser(userId: string) {
  const [items, removals] = await Promise.all([
    dataService.getLinkedItemsForUser(userId),
    dataService.listUnfinishedItemRemovals(userId),
  ]);
  const removalByItemId = new Map(removals.map((r) => [r.item_id, toRemovalView(r)]));
  return {
    items: (items ?? []).map((item) => ({ ...item, removal: removalByItemId.get(item.id) ?? null })),
    unfinished_removals: removals.map(toRemovalView),
  };
}

/** A per-item failure during a sync/refresh loop that is only an item disappearing or leaving the
 *  syncable statuses mid-loop (a removal or revocation that started meanwhile) — skip it rather than
 *  failing the whole request for the user's other items. */
async function itemLeftSyncableState(itemId: string, userId: string): Promise<boolean> {
  const current = await dataService.getPlaidItemStatusForUser(itemId, userId);
  return !current || !isSyncableItemStatus(current.status);
}

export async function listLinkedItems(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const connections = await getConnectionsForUser(userId);
    res.json({ ...connections, is_sandbox: env.plaidEnv === 'sandbox' });
  } catch (err) {
    next(err);
  }
}

export async function refreshAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const items = await dataService.getPlaidItemsForUser(userId);
    // Wave 1: institution enrichment is a follow-up of linking; retry it for any item still missing it.
    const missingInstitution = await dataService.getPlaidItemIdsMissingInstitution(userId).catch((err) => {
      console.error('Failed to check items for missing institutions:', summarizeErrorSafely(err));
      return new Set<string>();
    });

    for (const item of items) {
      try {
        const plaidAccounts = await plaidService.getAccounts(item.access_token);
        const updatedAccounts = await dataService.upsertAccountsForItem(item.id, plaidAccounts);
        await dataService.transitionItemStatus(item.id, 'synced');

        if (missingInstitution.has(item.id)) {
          // Best-effort, like the webhook backfill below.
          await plaidService
            .getItemInstitution(item.access_token)
            .then((found) => dataService.updatePlaidItemInstitution(item.id, found.institutionId, found.institutionName))
            .catch((err) => console.error(`Failed to backfill institution for item ${item.id}:`, summarizeErrorSafely(err)));
        }

        // Best-effort: backfills the webhook URL onto items linked before webhooks were
        // configured. Not critical, so a failure here shouldn't fail the whole refresh.
        await plaidService.updateItemWebhook(item.access_token).catch((err) => {
          // Never log the raw error — a real Plaid/Axios rejection here carries the outgoing
          // request (access_token included) in its .config (see errorSanitizer.ts).
          console.error(`Failed to backfill webhook for item ${item.id}:`, summarizeErrorSafely(err));
        });

        // Also best-effort (see refreshLoansForItem) — only produces data once the
        // `liabilities` product is enabled and this item has qualifying loan accounts.
        const accountIdByPlaidId = new Map(updatedAccounts.map((a) => [a.plaid_account_id, a.id]));
        await refreshLoansForItem(item.id, item.access_token, accountIdByPlaidId);
      } catch (err) {
        if (err instanceof PlaidCredentialError) {
          // Not a bank-reconnect situation (§10 of the design doc) — the stored token may be
          // perfectly valid to Plaid, this app simply failed to read it. Never set
          // login_required for this; that would send the user through a reconnect flow that
          // can't fix anything and would misleadingly suggest their bank is the problem.
          console.error(`Plaid credential error refreshing item ${item.id}:`, err.name);
          await dataService.transitionItemStatus(item.id, 'credential_error');
        } else if (plaidService.isReauthRequiredError(err)) {
          // An item needing re-auth shouldn't break refreshing everyone else's accounts —
          // flag it and let the frontend prompt the user to reconnect that one institution.
          await dataService.transitionItemStatus(item.id, 'login_required');
        } else if (await itemLeftSyncableState(item.id, userId)) {
          continue;
        } else {
          throw err;
        }
      }
    }

    // Once per refresh, not once per item — net worth is a total across all the user's items.
    await netWorthService.recordSnapshotForUser(userId);

    const connections = await getConnectionsForUser(userId);
    res.json({ ...connections, is_sandbox: env.plaidEnv === 'sandbox' });
  } catch (err) {
    next(err);
  }
}

export async function updateAccountCreditLimit(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { accountId } = req.params;
    const { credit_limit: creditLimit } = req.body as { credit_limit?: number | null };

    if (creditLimit !== null && creditLimit !== undefined && typeof creditLimit !== 'number') {
      res.status(400).json({ error: 'credit_limit must be a number or null' });
      return;
    }

    const account = await dataService.updateAccountCreditLimit(accountId, userId, creditLimit ?? null);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
}

export async function updateAccountSavingsGoal(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { accountId } = req.params;
    const { savings_goal: savingsGoal } = req.body as { savings_goal?: number | null };

    if (savingsGoal !== null && savingsGoal !== undefined && typeof savingsGoal !== 'number') {
      res.status(400).json({ error: 'savings_goal must be a number or null' });
      return;
    }

    const account = await dataService.updateAccountSavingsGoal(accountId, userId, savingsGoal ?? null);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
}

export async function updateAccountCustomization(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { accountId } = req.params;
    const {
      nickname,
      color,
      icon,
      sort_order: sortOrder,
      hidden,
      exclude_from_net_worth: excludeFromNetWorth,
      exclude_from_cash_flow: excludeFromCashFlow,
    } = req.body as {
      nickname?: string | null;
      color?: string | null;
      icon?: string | null;
      sort_order?: number;
      hidden?: boolean;
      exclude_from_net_worth?: boolean;
      exclude_from_cash_flow?: boolean;
    };

    const fields: Record<string, unknown> = {};
    if (nickname !== undefined) fields.nickname = nickname;
    if (color !== undefined) fields.color = color;
    if (icon !== undefined) fields.icon = icon;
    if (sortOrder !== undefined) fields.sort_order = sortOrder;
    if (hidden !== undefined) fields.hidden = hidden;
    if (excludeFromNetWorth !== undefined) fields.exclude_from_net_worth = excludeFromNetWorth;
    if (excludeFromCashFlow !== undefined) fields.exclude_from_cash_flow = excludeFromCashFlow;

    const account = await dataService.updateAccountCustomization(accountId, userId, fields);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // Net worth is a recorded snapshot (not computed live for the history chart), so a change to
    // which accounts count toward it needs an immediate re-snapshot for today — otherwise the
    // chart would lag until the next natural sync/balance refresh. Historical snapshots from
    // earlier dates are never rewritten.
    if (excludeFromNetWorth !== undefined) {
      await netWorthService.recordSnapshotForUser(userId);
    }

    res.json({ account });
  } catch (err) {
    next(err);
  }
}

export async function syncTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const items = await dataService.getPlaidItemsForUser(userId);

    let addedCount = 0;
    let modifiedCount = 0;
    let removedCount = 0;

    for (const item of items) {
      try {
        const result = await syncService.syncItemTransactions(item);
        addedCount += result.added;
        modifiedCount += result.modified;
        removedCount += result.removed;
      } catch (err) {
        if (err instanceof PlaidCredentialError) {
          console.error(`Plaid credential error syncing item ${item.id}:`, err.name);
          await dataService.transitionItemStatus(item.id, 'credential_error');
        } else if (plaidService.isReauthRequiredError(err)) {
          await dataService.transitionItemStatus(item.id, 'login_required');
        } else if (await itemLeftSyncableState(item.id, userId)) {
          continue;
        } else {
          throw err;
        }
      }
    }

    res.json({ added: addedCount, modified: modifiedCount, removed: removedCount });
  } catch (err) {
    next(err);
  }
}

export async function createReauthLinkToken(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { itemId } = req.params;

    const item = await dataService.getPlaidItemForUser(itemId, userId);
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (item.status === 'removing') {
      res.status(409).json({ error: REMOVING_MESSAGE, code: 'connection_being_removed' });
      return;
    }

    let linkToken: string;
    try {
      linkToken = await plaidService.createReauthLinkToken(userId, item.access_token);
    } catch (err) {
      // Revoked access that Plaid will not even open Update Mode for cannot be restored in place.
      if (item.status === 'permission_revoked' && plaidService.isDefinitivePlaidRejection(err)) {
        console.error(`Plaid refused Update Mode for revoked item ${item.id}:`, summarizeErrorSafely(err));
        res.status(409).json({ error: RECONNECT_UNAVAILABLE_MESSAGE, code: 'reconnect_unavailable' });
        return;
      }
      throw err;
    }
    res.json({ link_token: linkToken });
  } catch (err) {
    next(err);
  }
}

const REMOVING_MESSAGE = 'This institution is being removed.';
const RECONNECT_UNAVAILABLE_MESSAGE =
  "This connection couldn't be restored. Remove the institution, then link the bank again.";

export async function sandboxResetLogin(req: Request, res: Response, next: NextFunction) {
  try {
    if (env.plaidEnv !== 'sandbox') {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const userId = req.user!.id;
    const { itemId } = req.params;

    const item = await dataService.getPlaidItemForUser(itemId, userId);
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    await plaidService.sandboxResetLogin(item.access_token);
    await dataService.transitionItemStatus(item.id, 'login_required');

    const { items } = await getConnectionsForUser(userId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
}

export async function sandboxFireWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    if (env.plaidEnv !== 'sandbox') {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const userId = req.user!.id;
    const { itemId } = req.params;

    const item = await dataService.getPlaidItemForUser(itemId, userId);
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    await plaidService.sandboxFireWebhook(item.access_token);
    res.json({ fired: true });
  } catch (err) {
    next(err);
  }
}

export async function completeReauth(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { itemId } = req.params;

    let item;
    try {
      item = await dataService.getPlaidItemForUser(itemId, userId);
    } catch (err) {
      if (err instanceof PlaidCredentialError) {
        // itemId (the route param) is already this row's own id, so unlike the webhook path
        // (§7 Phase 4, where only Plaid's own item_id is known until the row resolves) this
        // status update doesn't need the row object at all.
        console.error(`Plaid credential error completing reauth for item ${itemId}:`, err.name);
        await dataService.transitionItemStatus(itemId, 'credential_error');
        res.status(409).json({ error: 'This connection needs attention before it can be used again.' });
        return;
      }
      throw err;
    }
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (item.status === 'removing') {
      res.status(409).json({ error: REMOVING_MESSAGE, code: 'connection_being_removed' });
      return;
    }

    // Update Mode doesn't issue a new access token — confirm the existing one actually
    // works again before clearing the login_required / pending_expiration / permission_revoked flag.
    try {
      await plaidService.getAccounts(item.access_token);
    } catch (err) {
      if (item.status === 'permission_revoked' && plaidService.isDefinitivePlaidRejection(err)) {
        // Update Mode finished but access is still refused: revoked consent that cannot be restored.
        res.status(409).json({ error: RECONNECT_UNAVAILABLE_MESSAGE, code: 'reconnect_unavailable' });
        return;
      }
      if (plaidService.isReauthRequiredError(err)) {
        res.status(409).json({ error: 'Item still requires re-authentication' });
        return;
      }
      throw err;
    }

    // Conditional: never takes an item out of `removing` (a removal that began while Link was open).
    await dataService.transitionItemStatus(item.id, 'reauth_completed');
    const { items } = await getConnectionsForUser(userId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
}

// ---- Linked Institution Management V1: institution removal ------------------------------------------

const REMOVAL_REFUSALS = {
  not_found: { status: 404, error: 'Institution not found' },
  preview_stale: {
    status: 409,
    error: 'This institution changed since you reviewed it. Review the removal again before confirming.',
  },
  connection_needs_attention: {
    status: 409,
    error: "This connection can't be removed right now because its stored credential can't be read. We've been notified.",
  },
  manual_loan_reconciliation_required: {
    status: 409,
    error: "This institution has a loan payment whose applied amount wasn't recorded, so its loan balance can't be restored exactly. Nothing was removed.",
  },
  // Never names the other loan or its owner.
  manual_loan_ownership_mismatch: {
    status: 409,
    error: "This institution has a payment linked to a loan that doesn't belong to this account, so it can't be removed safely. Nothing was removed.",
  },
} as const;

/** Why this item cannot be removed right now, if anything — shown with the preview, before confirming.
 *  The blocker is the same check begin refuses on (plaid_item_removal_blocker). */
function removalBlockedReason(status: string, blocker: string | null | undefined): keyof typeof REMOVAL_REFUSALS | null {
  if (status === 'credential_error') return 'connection_needs_attention';
  if (blocker === 'manual_loan_ownership_mismatch' || blocker === 'manual_loan_reconciliation_required') return blocker;
  return null;
}

/** GET /items/:itemId/removal-preview — read-only: what removing the institution would delete and
 *  restore, and the digest the removal request must echo. */
export async function previewItemRemoval(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { itemId } = req.params;

    const existing = await dataService.getItemRemoval(userId, itemId);
    if (existing) {
      res.status(409).json({ error: 'This institution is already being removed.', code: 'removal_in_progress', removal: toRemovalView(existing) });
      return;
    }
    const preview = await dataService.previewItemRemoval(userId, itemId);
    if (!preview) {
      res.status(404).json({ error: REMOVAL_REFUSALS.not_found.error, code: 'not_found' });
      return;
    }
    const blocked = removalBlockedReason(preview.status, preview.blocker);
    res.json({
      preview,
      blocked_reason: blocked,
      blocked_message: blocked ? REMOVAL_REFUSALS[blocked].error : null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /items/:itemId/removal — starts the removal (body: { preview_digest } from the confirmed
 * preview) or resumes an existing one (the digest is then ignored). 200 when the removal is complete;
 * 202 when it stopped at a retryable point (Plaid's answer unknown, or a later step failed) — the same
 * request resumes it.
 */
export async function removeInstitution(req: Request, res: Response, next: NextFunction) {
  const userId = req.user!.id;
  const { itemId } = req.params;
  const rawDigest = (req.body as { preview_digest?: unknown } | undefined)?.preview_digest;
  const previewDigest = typeof rawDigest === 'string' && rawDigest.length <= 128 ? rawDigest : null;

  try {
    const result = await runItemRemoval(userId, itemId, previewDigest);
    if (result.kind !== 'progressed') {
      const refusal = REMOVAL_REFUSALS[result.kind];
      res.status(refusal.status).json({ error: refusal.error, code: result.kind });
      return;
    }
    res.status(result.removal.finished ? 200 : 202).json({ removal: result.removal });
  } catch (err) {
    if (err instanceof ItemRemovalIncompleteError) {
      // Never log the raw cause: it may be a Plaid/Axios error carrying the outgoing request.
      console.error(`Institution removal for item ${itemId} did not finish:`, summarizeErrorSafely(err.cause));
      res.status(202).json({ removal: err.removal, code: 'removal_incomplete' });
      return;
    }
    next(err);
  }
}

/** GET /items/:itemId/removal — the removal operation's state (works after the item is deleted). */
export async function getItemRemoval(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const removal = await dataService.getItemRemoval(userId, req.params.itemId);
    if (!removal) {
      res.status(404).json({ error: 'No removal for this institution', code: 'not_found' });
      return;
    }
    res.json({ removal: toRemovalView(removal) });
  } catch (err) {
    next(err);
  }
}

export async function listTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;
    // Optional, additive server-side range — not yet used by any frontend call site (the main
    // Transactions feed stays independent of the global reporting range by design), but keeps the
    // architecture ready for a future report drill-down or explicit date picker.
    const start = typeof req.query.start === 'string' ? req.query.start : undefined;
    const end = typeof req.query.end === 'string' ? req.query.end : undefined;

    const transactions = await dataService.getRecentTransactionsForUser(userId, limit, start, end);
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
}

export async function setTransactionCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { transactionId } = req.params;
    const { budget_category_id: budgetCategoryId } = req.body as { budget_category_id: string | null };

    const ownerId = await dataService.getTransactionOwnerId(transactionId);
    if (!ownerId || ownerId !== userId) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    if (budgetCategoryId !== null) {
      const belongsToUser = await dataService.budgetCategoryBelongsToUser(budgetCategoryId, userId);
      if (!belongsToUser) {
        res.status(400).json({ error: 'Invalid budget category' });
        return;
      }
    }

    const transaction = await dataService.setTransactionCategory(transactionId, budgetCategoryId);
    res.json({ transaction });
  } catch (err) {
    next(err);
  }
}

export async function approveTransaction(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { transactionId } = req.params;

    const ownerId = await dataService.getTransactionOwnerId(transactionId);
    if (!ownerId || ownerId !== userId) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    const transaction = await dataService.approveTransaction(transactionId);
    res.json({ transaction });
  } catch (err) {
    next(err);
  }
}

export async function setTransactionSplits(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { transactionId } = req.params;
    const { splits } = req.body as {
      splits?: { budget_category_id?: string; amount?: number; note?: string | null }[];
    };

    const ownerId = await dataService.getTransactionOwnerId(transactionId);
    if (!ownerId || ownerId !== userId) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    if (!Array.isArray(splits) || splits.length === 0) {
      res.status(400).json({ error: 'At least one split is required' });
      return;
    }

    for (const split of splits) {
      if (!split.budget_category_id || typeof split.amount !== 'number') {
        res.status(400).json({ error: 'Each split needs a budget_category_id and a numeric amount' });
        return;
      }
      const belongsToUser = await dataService.budgetCategoryBelongsToUser(split.budget_category_id, userId);
      if (!belongsToUser) {
        res.status(400).json({ error: 'Invalid budget category' });
        return;
      }
    }

    const saved = await dataService.setTransactionSplits(
      transactionId,
      userId,
      splits.map((s) => ({
        budgetCategoryId: s.budget_category_id!,
        amount: s.amount!,
        note: s.note ?? null,
      }))
    );
    res.status(201).json({ splits: saved });
  } catch (err) {
    next(err);
  }
}

export async function clearTransactionSplits(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { transactionId } = req.params;

    const ownerId = await dataService.getTransactionOwnerId(transactionId);
    if (!ownerId || ownerId !== userId) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    await dataService.clearTransactionSplits(transactionId, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

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

export async function createLinkToken(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const linkToken = await plaidService.createLinkToken(userId);
    res.json({ link_token: linkToken });
  } catch (err) {
    next(err);
  }
}

export async function exchangePublicToken(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { public_token: publicToken } = req.body as { public_token?: string };

    if (!publicToken) {
      res.status(400).json({ error: 'public_token is required' });
      return;
    }

    const { accessToken, itemId } = await plaidService.exchangePublicToken(publicToken);
    const { institutionId, institutionName } = await plaidService.getItemInstitution(accessToken);

    const itemRow = await dataService.insertPlaidItem({
      userId,
      itemId,
      accessToken,
      institutionId,
      institutionName,
    });

    const plaidAccounts = await plaidService.getAccounts(accessToken);
    const accountRows = await dataService.upsertAccountsForItem(itemRow.id, plaidAccounts);

    // Pull initial transaction history right away so the dashboard isn't empty until the
    // webhook (or a manual sync) delivers the next update.
    const { added } = await syncService.syncItemTransactions({
      id: itemRow.id,
      user_id: userId,
      access_token: accessToken,
      transactions_cursor: null,
    });

    // Record today's net worth now that we have fresh balances — covers both a user's very
    // first linked item and an additional one (net worth is a total across all their items).
    await netWorthService.recordSnapshotForUser(userId);

    // Best-effort: only produces data if the `liabilities` product is enabled and this item
    // actually has credit/mortgage/student-loan accounts.
    const accountIdByPlaidId = new Map(accountRows.map((a) => [a.plaid_account_id, a.id]));
    await refreshLoansForItem(itemRow.id, accessToken, accountIdByPlaidId);

    // Access token is intentionally never included in the response — it stays server-side.
    res.status(201).json({
      item: {
        id: itemRow.id,
        institution_id: itemRow.institution_id,
        institution_name: itemRow.institution_name,
      },
      accounts: accountRows,
      transactions_synced: added,
    });
  } catch (err) {
    next(err);
  }
}

export async function listLinkedItems(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const items = await dataService.getLinkedItemsForUser(userId);
    res.json({ items, is_sandbox: env.plaidEnv === 'sandbox' });
  } catch (err) {
    next(err);
  }
}

export async function refreshAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const items = await dataService.getPlaidItemsForUser(userId);

    for (const item of items) {
      try {
        const plaidAccounts = await plaidService.getAccounts(item.access_token);
        const updatedAccounts = await dataService.upsertAccountsForItem(item.id, plaidAccounts);
        await dataService.setItemStatus(item.id, 'active');

        // Best-effort: backfills the webhook URL onto items linked before webhooks were
        // configured. Not critical, so a failure here shouldn't fail the whole refresh.
        await plaidService.updateItemWebhook(item.access_token).catch((err) => {
          console.error(`Failed to backfill webhook for item ${item.id}:`, err);
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
          await dataService.setItemStatus(item.id, 'credential_error');
        } else if (plaidService.isReauthRequiredError(err)) {
          // An item needing re-auth shouldn't break refreshing everyone else's accounts —
          // flag it and let the frontend prompt the user to reconnect that one institution.
          await dataService.setItemStatus(item.id, 'login_required');
        } else {
          throw err;
        }
      }
    }

    // Once per refresh, not once per item — net worth is a total across all the user's items.
    await netWorthService.recordSnapshotForUser(userId);

    const refreshed = await dataService.getLinkedItemsForUser(userId);
    res.json({ items: refreshed, is_sandbox: env.plaidEnv === 'sandbox' });
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
          await dataService.setItemStatus(item.id, 'credential_error');
        } else if (plaidService.isReauthRequiredError(err)) {
          await dataService.setItemStatus(item.id, 'login_required');
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

    const linkToken = await plaidService.createReauthLinkToken(userId, item.access_token);
    res.json({ link_token: linkToken });
  } catch (err) {
    next(err);
  }
}

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
    await dataService.setItemStatus(item.id, 'login_required');

    const items = await dataService.getLinkedItemsForUser(userId);
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
        await dataService.setItemStatus(itemId, 'credential_error');
        res.status(409).json({ error: 'This connection needs attention before it can be used again.' });
        return;
      }
      throw err;
    }
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    // Update Mode doesn't issue a new access token — confirm the existing one actually
    // works again before clearing the login_required flag.
    try {
      await plaidService.getAccounts(item.access_token);
    } catch (err) {
      if (plaidService.isReauthRequiredError(err)) {
        res.status(409).json({ error: 'Item still requires re-authentication' });
        return;
      }
      throw err;
    }

    await dataService.setItemStatus(item.id, 'active');
    const items = await dataService.getLinkedItemsForUser(userId);
    res.json({ items });
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

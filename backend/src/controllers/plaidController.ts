import type { Request, Response, NextFunction } from 'express';
import * as plaidService from '../services/plaidService';
import * as dataService from '../services/dataService';
import * as syncService from '../services/syncService';
import * as netWorthService from '../services/netWorth';
import { aggregateByMonth } from '../services/monthlyBreakdown';
import { normalizeToMonthlyAmount } from '../services/recurringStreams';
import { computePayoffProgressPct, refreshLoansForItem } from '../services/loans';
import { groupAccountsForAssetsSummary, type AssetAccount } from '../services/assetsSummary';
import { env } from '../config/env';

export async function getSpendingSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const months = Math.min(Math.max(Number(req.query.months ?? 6), 1), 24);

    const accounts = await dataService.getAccountBalancesForUser(userId);
    const { assets, liabilities } = netWorthService.aggregateAssetsAndLiabilities(accounts);

    const sinceDate = netWorthService.getMonthsAgoStart(months);
    const transactions = await dataService.getTransactionsSince(userId, sinceDate);

    const byMonth = new Map<string, { spent: number; income: number }>();
    for (const t of transactions) {
      const month = t.date.slice(0, 7);
      const bucket = byMonth.get(month) ?? { spent: 0, income: 0 };
      // Plaid convention: positive amount = money out (spend), negative = money in (income/credit).
      if (t.amount >= 0) {
        bucket.spent += t.amount;
      } else {
        bucket.income += -t.amount;
      }
      byMonth.set(month, bucket);
    }

    const monthlySpending = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, totals]) => ({ month, ...totals }));

    res.json({
      net_worth: assets - liabilities,
      total_assets: assets,
      total_liabilities: liabilities,
      monthly_spending: monthlySpending,
    });
  } catch (err) {
    next(err);
  }
}

export async function getMonthlyBreakdown(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const months = Math.min(Math.max(Number(req.query.months ?? 6), 1), 24);

    const sinceDate = netWorthService.getMonthsAgoStart(months);
    const transactions = await dataService.getCategorizedTransactionsSince(userId, sinceDate);

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
    const months = Math.min(Math.max(Number(req.query.months ?? 6), 1), 24);

    const sinceDate = netWorthService.getMonthsAgoStart(months);
    const history = await dataService.getNetWorthHistory(userId, sinceDate);

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
        // An item needing re-auth shouldn't break refreshing everyone else's accounts —
        // flag it and let the frontend prompt the user to reconnect that one institution.
        if (plaidService.isReauthRequiredError(err)) {
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
        if (plaidService.isReauthRequiredError(err)) {
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

    const item = await dataService.getPlaidItemForUser(itemId, userId);
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

    const transactions = await dataService.getRecentTransactionsForUser(userId, limit);
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

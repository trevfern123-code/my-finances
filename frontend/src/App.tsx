import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient';
import {
  createBudgetCategory,
  createManualLoan,
  createManualPayment,
  deleteBudgetCategory,
  deleteManualLoan,
  deleteManualPayment,
  getAssetsSummary,
  getBudgetCategories,
  getLinkedItems,
  getLoanPayments,
  getLoans,
  getManualLoans,
  getMonthlyBreakdown,
  getNetWorthHistory,
  getRecurringStreams,
  getSpendingSummary,
  getTransactions,
  setTransactionCategory,
  syncTransactions as syncTransactionsRequest,
  unlinkLoanPayment,
  updateAccountCreditLimit,
  updateBudgetCategory,
  updateLinkedLoanPayment,
  updateManualLoan,
  updateManualPayment,
  type AssetGroup,
  type BudgetCategory,
  type LinkedItem,
  type Loan,
  type LoanPayment,
  type ManualLoan,
  type ManualLoanInput,
  type ManualPaymentInput,
  type MonthBreakdown,
  type NetWorthPoint,
  type RecurringStream,
  type SpendingSummary,
  type TransactionItem,
} from './lib/api';
import { Auth } from './components/Auth';
import { PlaidLink } from './components/PlaidLink';
import { LinkedAccounts } from './components/LinkedAccounts';
import { TransactionsFeed } from './components/TransactionsFeed';
import { BudgetCategories } from './components/BudgetCategories';
import { OverviewStats } from './components/OverviewStats';
import { CashFlowPace } from './components/CashFlowPace';
import { MonthlySpendingChart } from './components/MonthlySpendingChart';
import { NetWorthChart } from './components/NetWorthChart';
import { MonthlyBreakdown } from './components/MonthlyBreakdown';
import { SubscriptionsRecurring } from './components/SubscriptionsRecurring';
import { LoanProgress } from './components/LoanProgress';
import { IncomeSavings } from './components/IncomeSavings';
import { TabNav, type Tab } from './components/TabNav';
import './App.css';

const TABS: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'monthly', label: 'Monthly Breakdown' },
  { id: 'budget', label: 'Budget' },
  { id: 'recurring', label: 'Subscriptions & Recurring' },
  { id: 'loans', label: 'Loans' },
  { id: 'income', label: 'Income & Savings' },
  { id: 'accounts', label: 'Accounts' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [items, setItems] = useState<LinkedItem[]>([]);
  const [isSandbox, setIsSandbox] = useState(false);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [budgetCategories, setBudgetCategories] = useState<BudgetCategory[]>([]);
  const [summary, setSummary] = useState<SpendingSummary | null>(null);
  const [netWorthHistory, setNetWorthHistory] = useState<NetWorthPoint[]>([]);
  const [monthlyBreakdown, setMonthlyBreakdown] = useState<MonthBreakdown[]>([]);
  const [recurringStreams, setRecurringStreams] = useState<RecurringStream[]>([]);
  const [totalMonthlyOutflow, setTotalMonthlyOutflow] = useState(0);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [totalDebt, setTotalDebt] = useState(0);
  const [totalMinimumPayment, setTotalMinimumPayment] = useState(0);
  const [manualLoans, setManualLoans] = useState<ManualLoan[]>([]);
  const [assetGroups, setAssetGroups] = useState<AssetGroup[]>([]);
  const [totalAssets, setTotalAssets] = useState(0);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    // allSettled rather than all — one endpoint failing (e.g. a pending migration) shouldn't
    // blank the entire dashboard when the other calls succeeded fine.
    const [
      itemsRes,
      transactionsRes,
      categoriesRes,
      summaryRes,
      netWorthRes,
      breakdownRes,
      recurringRes,
      loansRes,
      assetsRes,
      manualLoansRes,
    ] = await Promise.allSettled([
      getLinkedItems(),
      getTransactions(),
      getBudgetCategories(),
      getSpendingSummary(),
      getNetWorthHistory(),
      getMonthlyBreakdown(),
      getRecurringStreams(),
      getLoans(),
      getAssetsSummary(),
      getManualLoans(),
    ]);

    if (itemsRes.status === 'fulfilled') {
      setItems(itemsRes.value.items);
      setIsSandbox(itemsRes.value.is_sandbox);
    }
    if (transactionsRes.status === 'fulfilled') setTransactions(transactionsRes.value.transactions);
    if (categoriesRes.status === 'fulfilled') setBudgetCategories(categoriesRes.value.categories);
    if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value);
    if (netWorthRes.status === 'fulfilled') setNetWorthHistory(netWorthRes.value.history);
    if (breakdownRes.status === 'fulfilled') setMonthlyBreakdown(breakdownRes.value.months);
    if (recurringRes.status === 'fulfilled') {
      setRecurringStreams(recurringRes.value.streams);
      setTotalMonthlyOutflow(recurringRes.value.total_monthly_outflow);
    }
    if (loansRes.status === 'fulfilled') {
      setLoans(loansRes.value.loans);
      setTotalDebt(loansRes.value.total_debt);
      setTotalMinimumPayment(loansRes.value.total_minimum_payment);
    }
    if (assetsRes.status === 'fulfilled') {
      setAssetGroups(assetsRes.value.groups);
      setTotalAssets(assetsRes.value.total_assets);
    }
    if (manualLoansRes.status === 'fulfilled') setManualLoans(manualLoansRes.value.loans);

    const failures = [
      itemsRes,
      transactionsRes,
      categoriesRes,
      summaryRes,
      netWorthRes,
      breakdownRes,
      recurringRes,
      loansRes,
      assetsRes,
      manualLoansRes,
    ].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('Some dashboard data failed to load:', failures.map((f) => f.reason));
      setActionError('Some dashboard data failed to load — see console for details.');
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (session) refreshAll();
  }, [session, refreshAll]);

  // Best-effort — account/transaction refresh already succeeded by the time this runs,
  // so a failure here shouldn't surface as an error for an action the user didn't take.
  async function refreshSummary() {
    try {
      setSummary(await getSpendingSummary());
    } catch {
      // ignore
    }
  }

  async function refreshNetWorthHistory() {
    try {
      const res = await getNetWorthHistory();
      setNetWorthHistory(res.history);
    } catch {
      // ignore
    }
  }

  async function refreshMonthlyBreakdown() {
    try {
      const res = await getMonthlyBreakdown();
      setMonthlyBreakdown(res.months);
    } catch {
      // ignore
    }
  }

  async function refreshRecurringStreams() {
    try {
      const res = await getRecurringStreams();
      setRecurringStreams(res.streams);
      setTotalMonthlyOutflow(res.total_monthly_outflow);
    } catch {
      // ignore
    }
  }

  async function refreshLoans() {
    try {
      const res = await getLoans();
      setLoans(res.loans);
      setTotalDebt(res.total_debt);
      setTotalMinimumPayment(res.total_minimum_payment);
    } catch {
      // ignore
    }
  }

  async function refreshAssetsSummary() {
    try {
      const res = await getAssetsSummary();
      setAssetGroups(res.groups);
      setTotalAssets(res.total_assets);
    } catch {
      // ignore
    }
  }

  // `spent`/`recent_avg_spent` are only computed on the list endpoint, not returned by the
  // create/update/categorize endpoints — anything that can change a category's spend needs to
  // refetch the list to stay accurate, rather than trying to patch the values in locally.
  async function refreshBudgetCategories() {
    try {
      const res = await getBudgetCategories();
      setBudgetCategories(res.categories);
    } catch {
      // ignore
    }
  }

  async function handleAccountsRefreshed(newItems: LinkedItem[]) {
    setItems(newItems);
    refreshSummary();
    // The backend records a net worth snapshot, refreshes loan/liability details, and this
    // view's grouping all depend on the same freshly-fetched balances — refetch all three.
    refreshNetWorthHistory();
    refreshLoans();
    refreshAssetsSummary();
  }

  async function handleUpdateCreditLimit(accountId: string, creditLimit: number | null) {
    setActionError(null);
    try {
      const res = await updateAccountCreditLimit(accountId, creditLimit);
      setItems((prev) =>
        prev.map((item) => ({
          ...item,
          accounts: item.accounts.map((a) => (a.id === accountId ? res.account : a)),
        }))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update credit limit');
    }
  }

  async function handleSyncTransactions() {
    setSyncing(true);
    setActionError(null);
    try {
      await syncTransactionsRequest();
      const res = await getTransactions();
      setTransactions(res.transactions);
      refreshSummary();
      refreshBudgetCategories();
      refreshMonthlyBreakdown();
      // Recurring-stream detection is also refreshed server-side as part of every sync
      // (manual or webhook-driven) — refetch here so this tab reflects that without a reload.
      refreshRecurringStreams();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to sync transactions');
    } finally {
      setSyncing(false);
    }
  }

  async function handleCategorize(transactionId: string, budgetCategoryId: string | null) {
    setActionError(null);
    try {
      // The PATCH response is a bare `transactions` row with no joined accounts/plaid_items,
      // unlike the list endpoint — merge just the changed field instead of replacing the item.
      await setTransactionCategory(transactionId, budgetCategoryId);
      setTransactions((prev) =>
        prev.map((t) => (t.id === transactionId ? { ...t, budget_category_id: budgetCategoryId } : t))
      );
      refreshBudgetCategories();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category');
    }
  }

  async function handleCreateCategory(name: string, budgetAmount: number) {
    setActionError(null);
    try {
      const res = await createBudgetCategory({ name, budget_amount: budgetAmount });
      // A brand-new category has no transactions assigned to it yet, so both derived fields
      // are always 0 — no need to refetch just to fill in values we already know.
      setBudgetCategories((prev) => [...prev, { ...res.category, spent: 0, recent_avg_spent: 0 }]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create category');
    }
  }

  async function handleUpdateCategory(id: string, budgetAmount: number) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { budget_amount: budgetAmount });
      // Merge rather than replace — the response has no spent/recent_avg_spent, and changing
      // budget_amount doesn't change how much has actually been spent, so keep what's there.
      setBudgetCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...res.category } : c))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category');
    }
  }

  async function handleDeleteCategory(id: string) {
    setActionError(null);
    try {
      await deleteBudgetCategory(id);
      setBudgetCategories((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete category');
    }
  }

  async function handleCreateManualLoan(input: ManualLoanInput) {
    setActionError(null);
    try {
      const res = await createManualLoan(input);
      setManualLoans((prev) => [...prev, res.loan]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add loan');
    }
  }

  async function handleUpdateManualLoan(id: string, input: ManualLoanInput) {
    setActionError(null);
    try {
      const res = await updateManualLoan(id, input);
      setManualLoans((prev) => prev.map((l) => (l.id === id ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update loan');
    }
  }

  async function handleDeleteManualLoan(id: string) {
    setActionError(null);
    try {
      await deleteManualLoan(id);
      setManualLoans((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete loan');
    }
  }

  async function handleFetchPayments(loanId: string): Promise<LoanPayment[]> {
    const res = await getLoanPayments(loanId);
    return res.payments;
  }

  async function handleUpdateLinkedPayment(loanId: string, transactionId: string, principalPortion: number) {
    setActionError(null);
    try {
      const res = await updateLinkedLoanPayment(loanId, transactionId, principalPortion);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update payment');
      throw err;
    }
  }

  async function handleUnlinkPayment(loanId: string, transactionId: string) {
    setActionError(null);
    try {
      const res = await unlinkLoanPayment(loanId, transactionId);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to unlink payment');
      throw err;
    }
  }

  async function handleCreateManualPayment(loanId: string, input: ManualPaymentInput) {
    setActionError(null);
    try {
      const res = await createManualPayment(loanId, input);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to log payment');
      throw err;
    }
  }

  async function handleUpdateManualPayment(loanId: string, paymentId: string, input: ManualPaymentInput) {
    setActionError(null);
    try {
      const res = await updateManualPayment(loanId, paymentId, input);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update payment');
      throw err;
    }
  }

  async function handleDeleteManualPayment(loanId: string, paymentId: string) {
    setActionError(null);
    try {
      const res = await deleteManualPayment(loanId, paymentId);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete payment');
      throw err;
    }
  }

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="dashboard">
      <header className="app-header">
        <h1>My Finances</h1>
        <div className="app-header-actions">
          <PlaidLink onLinked={refreshAll} />
          <button className="link-button" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {actionError && <p className="error">{actionError}</p>}

      {loading ? (
        <p className="hint">Loading...</p>
      ) : (
        <>
          <TabNav tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

          {activeTab === 'overview' && (
            <div className="tab-panel">
              {summary && (
                <OverviewStats
                  netWorth={summary.net_worth}
                  netWorthHistory={netWorthHistory}
                  assetGroups={assetGroups}
                  monthlySpending={summary.monthly_spending}
                />
              )}
              {summary && (
                <CashFlowPace
                  budgetCategories={budgetCategories}
                  currentMonthIncome={summary.monthly_spending[summary.monthly_spending.length - 1]?.income ?? 0}
                  currentMonthSpent={summary.monthly_spending[summary.monthly_spending.length - 1]?.spent ?? 0}
                />
              )}
              <div className="dashboard-grid">
                <div>{summary && <MonthlySpendingChart summary={summary} />}</div>
                <div>
                  <NetWorthChart history={netWorthHistory} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'monthly' && <MonthlyBreakdown months={monthlyBreakdown} />}

          {activeTab === 'budget' && (
            <BudgetCategories
              categories={budgetCategories}
              onCreate={handleCreateCategory}
              onUpdate={handleUpdateCategory}
              onDelete={handleDeleteCategory}
            />
          )}

          {activeTab === 'recurring' && (
            <SubscriptionsRecurring streams={recurringStreams} totalMonthlyOutflow={totalMonthlyOutflow} />
          )}

          {activeTab === 'loans' && (
            <LoanProgress
              loans={loans}
              manualLoans={manualLoans}
              totalDebt={totalDebt}
              totalMinimumPayment={totalMinimumPayment}
              onCreateManualLoan={handleCreateManualLoan}
              onUpdateManualLoan={handleUpdateManualLoan}
              onDeleteManualLoan={handleDeleteManualLoan}
              onFetchPayments={handleFetchPayments}
              onUpdateLinkedPayment={handleUpdateLinkedPayment}
              onUnlinkPayment={handleUnlinkPayment}
              onCreateManualPayment={handleCreateManualPayment}
              onUpdateManualPayment={handleUpdateManualPayment}
              onDeleteManualPayment={handleDeleteManualPayment}
            />
          )}

          {activeTab === 'income' && <IncomeSavings groups={assetGroups} totalAssets={totalAssets} />}

          {activeTab === 'accounts' && (
            <div className="tab-panel">
              <LinkedAccounts
                items={items}
                isSandbox={isSandbox}
                onRefreshed={handleAccountsRefreshed}
                onUpdateCreditLimit={handleUpdateCreditLimit}
              />
              <TransactionsFeed
                transactions={transactions}
                budgetCategories={budgetCategories}
                syncing={syncing}
                onSync={handleSyncTransactions}
                onCategorize={handleCategorize}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

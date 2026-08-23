import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient';
import {
  createBudgetCategory,
  deleteBudgetCategory,
  getBudgetCategories,
  getLinkedItems,
  getSpendingSummary,
  getTransactions,
  setTransactionCategory,
  syncTransactions as syncTransactionsRequest,
  updateBudgetCategory,
  type BudgetCategory,
  type LinkedItem,
  type SpendingSummary,
  type TransactionItem,
} from './lib/api';
import { Auth } from './components/Auth';
import { PlaidLink } from './components/PlaidLink';
import { LinkedAccounts } from './components/LinkedAccounts';
import { TransactionsFeed } from './components/TransactionsFeed';
import { BudgetCategories } from './components/BudgetCategories';
import { SpendingOverview } from './components/SpendingOverview';
import './App.css';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<LinkedItem[]>([]);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [budgetCategories, setBudgetCategories] = useState<BudgetCategory[]>([]);
  const [summary, setSummary] = useState<SpendingSummary | null>(null);
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
    try {
      const [itemsRes, transactionsRes, categoriesRes, summaryRes] = await Promise.all([
        getLinkedItems(),
        getTransactions(),
        getBudgetCategories(),
        getSpendingSummary(),
      ]);
      setItems(itemsRes.items);
      setTransactions(transactionsRes.transactions);
      setBudgetCategories(categoriesRes.categories);
      setSummary(summaryRes);
    } finally {
      setLoading(false);
    }
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

  async function handleAccountsRefreshed(newItems: LinkedItem[]) {
    setItems(newItems);
    refreshSummary();
  }

  async function handleSyncTransactions() {
    setSyncing(true);
    setActionError(null);
    try {
      await syncTransactionsRequest();
      const res = await getTransactions();
      setTransactions(res.transactions);
      refreshSummary();
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
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category');
    }
  }

  async function handleCreateCategory(name: string, budgetAmount: number) {
    setActionError(null);
    try {
      const res = await createBudgetCategory({ name, budget_amount: budgetAmount });
      setBudgetCategories((prev) => [...prev, res.category]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create category');
    }
  }

  async function handleUpdateCategory(id: string, budgetAmount: number) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { budget_amount: budgetAmount });
      setBudgetCategories((prev) => prev.map((c) => (c.id === id ? res.category : c)));
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

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="dashboard">
      <header>
        <h1>My Finances</h1>
        <button className="link-button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      <PlaidLink onLinked={refreshAll} />

      {actionError && <p className="error">{actionError}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          {summary && (
            <section>
              <SpendingOverview summary={summary} />
            </section>
          )}

          <section>
            <LinkedAccounts items={items} onRefreshed={handleAccountsRefreshed} />
          </section>

          <section>
            <TransactionsFeed
              transactions={transactions}
              budgetCategories={budgetCategories}
              syncing={syncing}
              onSync={handleSyncTransactions}
              onCategorize={handleCategorize}
            />
          </section>

          <section>
            <BudgetCategories
              categories={budgetCategories}
              transactions={transactions}
              onCreate={handleCreateCategory}
              onUpdate={handleUpdateCategory}
              onDelete={handleDeleteCategory}
            />
          </section>
        </>
      )}
    </div>
  );
}

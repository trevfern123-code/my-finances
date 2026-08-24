import { useState } from 'react';
import type { LinkedAccount, LinkedItem } from '../lib/api';
import { refreshAccountBalances, sandboxFireWebhook, sandboxResetLogin } from '../lib/api';
import { ReconnectButton } from './ReconnectButton';

function formatBalance(amount: number | null, currency: string | null) {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
  }).format(amount);
}

function creditUtilizationTier(balance: number, limit: number): 'good' | 'warn' | 'over' {
  const pct = balance / limit;
  if (pct > 0.5) return 'over';
  if (pct >= 0.3) return 'warn';
  return 'good';
}

function CreditUtilization({
  account,
  onUpdateCreditLimit,
}: {
  account: LinkedAccount;
  onUpdateCreditLimit: (accountId: string, creditLimit: number | null) => void;
}) {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const balance = account.current_balance ?? 0;
  const limit = account.credit_limit;
  const hasLimit = limit !== null && limit > 0;
  const pct = hasLimit ? Math.min((balance / limit) * 100, 100) : 0;
  const tier = hasLimit ? creditUtilizationTier(balance, limit) : 'good';

  return (
    <div className="credit-utilization">
      <div className="credit-utilization-header">
        <span className="hint">Credit limit</span>
        <input
          type="number"
          step="0.01"
          className="budget-amount-input"
          value={editing ?? limit ?? ''}
          placeholder="Not set"
          onChange={(e) => setEditing(e.target.value)}
          onBlur={() => {
            if (editing === undefined) return;
            const value = editing.trim() === '' ? null : Number(editing);
            if (value === null || !Number.isNaN(value)) onUpdateCreditLimit(account.id, value);
            setEditing(undefined);
          }}
        />
      </div>
      {hasLimit && (
        <>
          <div className="progress-track">
            <div className={`progress-fill progress-${tier}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="hint">{pct.toFixed(0)}% utilization</span>
        </>
      )}
    </div>
  );
}

export function LinkedAccounts({
  items,
  isSandbox,
  onRefreshed,
  onUpdateCreditLimit,
}: {
  items: LinkedItem[];
  isSandbox: boolean;
  onRefreshed: (items: LinkedItem[]) => void;
  onUpdateCreditLimit: (accountId: string, creditLimit: number | null) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await refreshAccountBalances();
      onRefreshed(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh balances');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSandboxReset(itemId: string) {
    setError(null);
    setHint(null);
    try {
      const res = await sandboxResetLogin(itemId);
      onRefreshed(res.items);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} (this only works against Plaid Sandbox)`
          : 'Failed to simulate reauth'
      );
    }
  }

  async function handleSandboxWebhook(itemId: string) {
    setError(null);
    setHint(null);
    try {
      await sandboxFireWebhook(itemId);
      setHint('Webhook fired — check Recent transactions in a few seconds.');
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} (this only works against Plaid Sandbox)`
          : 'Failed to fire webhook'
      );
    }
  }

  return (
    <div className="card">
      <div className="section-header">
        <h2>Linked accounts</h2>
        <button onClick={handleRefresh} disabled={refreshing || items.length === 0}>
          {refreshing ? 'Refreshing...' : 'Refresh balances'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {hint && <p className="hint">{hint}</p>}
      {items.length === 0 ? (
        <p>No accounts linked yet.</p>
      ) : (
        <div className="linked-accounts">
          {items.map((item) => (
            <div key={item.id} className="institution-card">
              <h3>{item.institution_name ?? 'Unknown institution'}</h3>
              {item.status === 'login_required' && (
                <ReconnectButton
                  itemId={item.id}
                  institutionName={item.institution_name}
                  onReconnected={onRefreshed}
                />
              )}
              <ul>
                {item.accounts.map((account) => (
                  <li key={account.id} className="account-list-item">
                    <div className="account-row">
                      <span>
                        {account.name} <span className="account-type">({account.subtype ?? account.type})</span>
                      </span>
                      <span className="balance">
                        {formatBalance(account.current_balance, account.iso_currency_code)}
                      </span>
                    </div>
                    {account.type === 'credit' && (
                      <CreditUtilization account={account} onUpdateCreditLimit={onUpdateCreditLimit} />
                    )}
                  </li>
                ))}
              </ul>
              {isSandbox && item.status === 'active' && (
                <div className="sandbox-test-actions">
                  <button className="link-button" onClick={() => handleSandboxReset(item.id)}>
                    Simulate reauth (sandbox test)
                  </button>
                  <button className="link-button" onClick={() => handleSandboxWebhook(item.id)}>
                    Simulate webhook (sandbox test)
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

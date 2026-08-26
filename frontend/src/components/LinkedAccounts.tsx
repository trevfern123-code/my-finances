import { useState } from 'react';
import type { LinkedAccount, LinkedItem } from '../lib/api';
import { refreshAccountBalances, sandboxFireWebhook, sandboxResetLogin } from '../lib/api';
import { accountDisplayName, sortAccountsByOrder } from '../lib/accountDisplay';
import { ReconnectButton } from './ReconnectButton';
import { EmojiPicker } from './EmojiPicker';
import { ColorPicker } from './ColorPicker';

type CustomizationFields = Partial<{
  nickname: string | null;
  color: string | null;
  icon: string | null;
  sort_order: number;
  hidden: boolean;
  exclude_from_net_worth: boolean;
  exclude_from_cash_flow: boolean;
}>;

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

/** Icon/color/nickname/reorder/hide/exclude controls for one account — organizational values
 *  only, kept visually distinct from the account's actual financial data above it. */
function AccountCustomizationRow({
  account,
  index,
  count,
  onMove,
  onUpdateCustomization,
}: {
  account: LinkedAccount;
  index: number;
  count: number;
  onMove: (accountId: string, direction: 'up' | 'down') => void;
  onUpdateCustomization: (accountId: string, fields: CustomizationFields) => void;
}) {
  const [nicknameDraft, setNicknameDraft] = useState<string | undefined>(undefined);

  return (
    <div className="account-customization">
      <div className="account-customization-main">
        <div className="account-reorder">
          <button
            type="button"
            className="reorder-btn"
            disabled={index === 0}
            onClick={() => onMove(account.id, 'up')}
            aria-label={`Move ${accountDisplayName(account)} up`}
          >
            ▲
          </button>
          <button
            type="button"
            className="reorder-btn"
            disabled={index === count - 1}
            onClick={() => onMove(account.id, 'down')}
            aria-label={`Move ${accountDisplayName(account)} down`}
          >
            ▼
          </button>
        </div>
        <EmojiPicker
          value={account.icon}
          onChange={(icon) => onUpdateCustomization(account.id, { icon })}
          label={`Choose an icon for ${accountDisplayName(account)}`}
        />
        <ColorPicker
          value={account.color}
          onChange={(color) => onUpdateCustomization(account.id, { color })}
          label={`Choose a color for ${accountDisplayName(account)}`}
        />
        <input
          type="text"
          className="account-nickname-input"
          value={nicknameDraft ?? account.nickname ?? ''}
          placeholder={account.name}
          onChange={(e) => setNicknameDraft(e.target.value)}
          onBlur={() => {
            if (nicknameDraft === undefined) return;
            const trimmed = nicknameDraft.trim();
            onUpdateCustomization(account.id, { nickname: trimmed === '' ? null : trimmed });
            setNicknameDraft(undefined);
          }}
          aria-label={`Nickname for ${account.name}`}
        />
        <button
          type="button"
          className="link-button"
          onClick={() => onUpdateCustomization(account.id, { hidden: !account.hidden })}
        >
          {account.hidden ? 'Unhide' : 'Hide'}
        </button>
      </div>
      <div className="account-customization-flags">
        <label className="account-flag">
          <input
            type="checkbox"
            checked={account.exclude_from_net_worth}
            onChange={(e) => onUpdateCustomization(account.id, { exclude_from_net_worth: e.target.checked })}
          />
          Exclude from net worth
        </label>
        <label className="account-flag">
          <input
            type="checkbox"
            checked={account.exclude_from_cash_flow}
            onChange={(e) => onUpdateCustomization(account.id, { exclude_from_cash_flow: e.target.checked })}
          />
          Exclude from spending &amp; cash flow
        </label>
        {account.hidden && <span className="account-flag-indicator">Hidden from dashboard</span>}
      </div>
    </div>
  );
}

export function LinkedAccounts({
  items,
  isSandbox,
  onRefreshed,
  onUpdateCreditLimit,
  onUpdateCustomization,
}: {
  items: LinkedItem[];
  isSandbox: boolean;
  onRefreshed: (items: LinkedItem[]) => void;
  onUpdateCreditLimit: (accountId: string, creditLimit: number | null) => void;
  onUpdateCustomization: (accountId: string, fields: CustomizationFields) => void;
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

  // Reordering is scoped to the account list it's rendered within (here, an institution's own
  // accounts) — renumbers sequentially and persists only what actually changed, same pattern as
  // budget category reordering.
  function handleMove(sorted: LinkedAccount[], accountId: string, direction: 'up' | 'down') {
    const index = sorted.findIndex((a) => a.id === accountId);
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || swapWith < 0 || swapWith >= sorted.length) return;

    const reordered = [...sorted];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

    reordered.forEach((a, i) => {
      if (a.sort_order !== i) onUpdateCustomization(a.id, { sort_order: i });
    });
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
          {items.map((item) => {
            const sorted = sortAccountsByOrder(item.accounts);
            return (
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
                  {sorted.map((account, index) => (
                    <li
                      key={account.id}
                      className={account.hidden ? 'account-list-item hidden' : 'account-list-item'}
                    >
                      <div className="account-row">
                        <span>
                          {account.icon && <span className="account-icon">{account.icon}</span>}
                          {accountDisplayName(account)}{' '}
                          <span className="account-type">({account.subtype ?? account.type})</span>
                        </span>
                        <span className="balance">
                          {formatBalance(account.current_balance, account.iso_currency_code)}
                        </span>
                      </div>
                      {account.type === 'credit' && (
                        <CreditUtilization account={account} onUpdateCreditLimit={onUpdateCreditLimit} />
                      )}
                      <AccountCustomizationRow
                        account={account}
                        index={index}
                        count={sorted.length}
                        onMove={(accountId, direction) => handleMove(sorted, accountId, direction)}
                        onUpdateCustomization={onUpdateCustomization}
                      />
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
            );
          })}
        </div>
      )}
    </div>
  );
}

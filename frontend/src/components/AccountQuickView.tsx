import type { AssetGroup } from '../lib/api';
import { accountDisplayName } from '../lib/accountDisplay';
import { formatCurrency } from '../lib/currency';

export function AccountQuickView({ assetGroups }: { assetGroups: AssetGroup[] }) {
  // hidden only affects what's *displayed* here — the group totals feeding Liquid Cash
  // elsewhere are computed over every account regardless of hidden status.
  const accounts = assetGroups
    .filter((g) => g.category === 'checking' || g.category === 'savings')
    .flatMap((g) => g.accounts)
    .filter((a) => !a.hidden);

  return (
    <div className="card">
      <h2>Accounts at a glance</h2>
      {accounts.length === 0 ? (
        <p className="hint">No checking or savings accounts linked yet.</p>
      ) : (
        <ul className="quick-view-list">
          {accounts.map((account) => (
            <li key={account.id} className="account-row">
              <span>
                {account.icon && <span className="account-icon">{account.icon}</span>}
                {accountDisplayName(account)}
                {account.institution_name && (
                  <span className="account-type"> — {account.institution_name}</span>
                )}
                {account.exclude_from_net_worth && (
                  <span className="account-flag-indicator"> · Excluded from net worth</span>
                )}
              </span>
              <span className="balance">
                {formatCurrency(account.current_balance, account.iso_currency_code)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

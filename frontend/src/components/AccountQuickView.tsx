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
    <div className="card account-quick-card">
      <h2>Accounts at a glance</h2>
      {accounts.length === 0 ? (
        <p className="hint">No checking or savings accounts to display.</p>
      ) : (
        <ul className="quick-view-list">
          {accounts.map((account) => {
            const details = [
              account.institution_name,
              account.exclude_from_net_worth ? 'Excluded from net worth' : null,
              account.current_balance === null ? 'Balance unavailable' : null,
            ].filter(Boolean);
            return (
              <li key={account.id} className="account-row account-quick-row">
                <span className="account-quick-main">
                  <span className="account-quick-name">
                    {account.icon && <span className="account-icon">{account.icon}</span>}
                    {accountDisplayName(account)}
                  </span>
                  {details.length > 0 && <span className="account-type">{details.join(' · ')}</span>}
                </span>
                <span className="balance">
                  {formatCurrency(account.current_balance, account.iso_currency_code)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint card-source-note">
        Shows the checking and savings accounts you haven't hidden. Hidden accounts can still count
        toward your totals.
      </p>
    </div>
  );
}

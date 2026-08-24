import type { AssetGroup } from '../lib/api';

function formatCurrency(amount: number | null, currency: string | null) {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(amount);
}

export function AccountQuickView({ assetGroups }: { assetGroups: AssetGroup[] }) {
  const accounts = assetGroups
    .filter((g) => g.category === 'checking' || g.category === 'savings')
    .flatMap((g) => g.accounts);

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
                {account.name}
                {account.institution_name && (
                  <span className="account-type"> — {account.institution_name}</span>
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

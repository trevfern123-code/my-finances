import type { AssetGroup } from '../lib/api';

function formatCurrency(amount: number | null, currency: string | null) {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(amount);
}

export function IncomeSavings({ groups, totalAssets }: { groups: AssetGroup[]; totalAssets: number }) {
  if (groups.length === 0) {
    return (
      <div className="card">
        <h2>Income &amp; savings</h2>
        <p className="hint">
          No asset accounts linked yet. Investment/401k accounts also require Plaid's
          Investments product to be enabled and a fresh link (or re-link) for the item — see the
          README for details.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="section-header">
          <h2>Income &amp; savings</h2>
          <span className="monthly-total-badge">{formatCurrency(totalAssets, 'USD')} total assets</span>
        </div>
      </div>

      <div className="asset-groups">
        {groups.map((group) => (
          <div key={group.category} className="card">
            <div className="section-header">
              <h3>{group.label}</h3>
              <span className="hint">{formatCurrency(group.total, 'USD')}</span>
            </div>
            <ul className="asset-account-list">
              {group.accounts.map((account) => (
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
          </div>
        ))}
      </div>
    </div>
  );
}

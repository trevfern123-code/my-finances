export interface AssetAccount {
  id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  current_balance: number | null;
  iso_currency_code: string | null;
  institution_name: string | null;
  savings_goal: number | null;
}

export type AssetCategory = 'checking' | 'savings' | 'investment' | 'other';

export interface AssetGroup {
  category: AssetCategory;
  label: string;
  total: number;
  accounts: AssetAccount[];
}

// Credit cards and loans are debt, not assets — this view is deliberately assets-only (they
// already have their own place: the liabilities side of net worth, and the Loan Progress tab).
const LIABILITY_TYPES = new Set(['credit', 'loan']);

const CATEGORY_LABELS: Record<AssetCategory, string> = {
  checking: 'Checking',
  savings: 'Savings',
  investment: 'Investments & Retirement',
  other: 'Other',
};

function categorize(account: AssetAccount): AssetCategory {
  if (account.type === 'investment') return 'investment';
  if (account.type === 'depository' && account.subtype === 'checking') return 'checking';
  if (account.type === 'depository' && account.subtype === 'savings') return 'savings';
  return 'other';
}

/** Groups accounts into checking/savings/investment/other, excluding liability-type accounts entirely. */
export function groupAccountsForAssetsSummary(accounts: AssetAccount[]): AssetGroup[] {
  const buckets: Record<AssetCategory, AssetAccount[]> = {
    checking: [],
    savings: [],
    investment: [],
    other: [],
  };

  for (const account of accounts) {
    if (LIABILITY_TYPES.has(account.type)) continue;
    buckets[categorize(account)].push(account);
  }

  return (Object.keys(buckets) as AssetCategory[])
    .filter((category) => buckets[category].length > 0)
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      total: buckets[category].reduce((sum, a) => sum + (a.current_balance ?? 0), 0),
      accounts: buckets[category],
    }));
}

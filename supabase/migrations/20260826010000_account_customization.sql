-- Account Customization v1: nickname/color/icon/ordering plus hide and two independent
-- exclusion flags, all user-owned fields that Plaid sync/refresh must never overwrite (see
-- upsertAccountsForItem's fixed update-field list, which deliberately omits every column here,
-- the same pattern already proven for credit_limit/savings_goal).
--
-- hidden is display-only: it never affects net worth, cash-flow calculations, sync, or historical
-- data — it only filters which accounts appear in glanceable summary widgets.
--
-- exclude_from_net_worth removes an account's balance from net-worth/liquid-cash calculations.
-- exclude_from_cash_flow removes an account's transactions/recurring streams from personal
-- spending/income aggregates (Monthly Spending, Monthly Breakdown, Budget spend, Cash Flow Pace,
-- Savings Rate, recurring summaries) without affecting net worth or hiding individual
-- transactions from the feed. The two flags are independent by design.
alter table public.accounts
  add column nickname text null,
  add column color text null,
  add column icon text null,
  add column sort_order integer not null default 0,
  add column hidden boolean not null default false,
  add column exclude_from_net_worth boolean not null default false,
  add column exclude_from_cash_flow boolean not null default false;

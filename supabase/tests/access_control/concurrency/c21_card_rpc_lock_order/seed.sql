-- Lock order of the decision RPCs (§3.7): L1 (the per-user advisory lock) strictly before L2 (the version row).
-- A session holding only L1 observes the RPC blocked on it, then takes L2 with NOWAIT: that succeeds only if
-- the waiting RPC holds no L2. Taking L2 first would deadlock with any RPC that holds L1 and then writes
-- an input (whose trigger bump needs L2) — the sync batch, for example.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000021c01', '00000000-0000-0000-0000-000000000001', 'c21-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000021c02', '00000000-0000-0000-0000-000000000001', 'c21-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000021c03', '00000000-0000-0000-0000-000000000001', 'c21-y', 'Card Y', 'credit');
-- p is 14 and 19 days from its two exact candidates, so nothing pairs automatically.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-000000021c01', 'c21-p', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000021c02', 'c21-x', -100, '2026-09-15', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000021c03', 'c21-y', -100, '2026-09-20', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
reset role;
-- The version both sessions' users saw, and each session's outcome.
create table public.th_c21_state as
  select evaluated_version as v from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c21_outcome (who text primary key, outcome text not null);
grant select on public.th_c21_state to service_role;
grant select, insert on public.th_c21_outcome to service_role;

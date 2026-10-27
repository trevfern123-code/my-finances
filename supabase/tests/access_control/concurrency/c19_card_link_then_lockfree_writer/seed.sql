-- A lock-free direct writer (an old backend or manual SQL) changing the counterpart's amount while a
-- confirmation holds its locks. The RPC takes no row lock on transactions, so this write cannot close a
-- cycle (an account or user delete can: c22). The writer's row update proceeds, its trigger bump waits
-- for the version row, and it commits after the RPC. The decision was valid for the version the user
-- saw; afterwards the user is stale, and re-evaluation marks the decision inactive (amount changed) —
-- never falsely fresh, never silently re-pointed.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000019c01', '00000000-0000-0000-0000-000000000001', 'c19-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000019c02', '00000000-0000-0000-0000-000000000001', 'c19-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000019c03', '00000000-0000-0000-0000-000000000001', 'c19-y', 'Card Y', 'credit');
-- p is 14 and 19 days from its two exact candidates, so nothing pairs automatically.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-000000019c01', 'c19-p', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000019c02', 'c19-x', -100, '2026-09-15', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000019c03', 'c19-y', -100, '2026-09-20', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
reset role;
-- The version both sessions' users saw, and each session's outcome.
create table public.th_c19_state as
  select evaluated_version as v from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c19_outcome (who text primary key, outcome text not null);
grant select on public.th_c19_state to service_role;
grant select, insert on public.th_c19_outcome to service_role;

-- The other order: a lock-free writer has changed the counterpart's amount (its bump holds the version row)
-- when the confirmation arrives. The RPC waits for the version row, then sees the advanced version and is
-- refused: a decision is never written against inputs the user did not see.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000020c01', '00000000-0000-0000-0000-000000000001', 'c20-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000020c02', '00000000-0000-0000-0000-000000000001', 'c20-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000020c03', '00000000-0000-0000-0000-000000000001', 'c20-y', 'Card Y', 'credit');
-- p is 14 and 19 days from its two exact candidates, so nothing pairs automatically.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-000000020c01', 'c20-p', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000020c02', 'c20-x', -100, '2026-09-15', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000020c03', 'c20-y', -100, '2026-09-20', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
reset role;
-- The version both sessions' users saw, and each session's outcome.
create table public.th_c20_state as
  select evaluated_version as v from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c20_outcome (who text primary key, outcome text not null);
grant select on public.th_c20_state to service_role;
grant select, insert on public.th_c20_outcome to service_role;

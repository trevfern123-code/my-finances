-- Acceptance test 21: two confirmations of one leg sent with the SAME expected version. The per-user lock
-- serializes them; the second finds the version advanced by the first and is refused — never applied to
-- state it did not see, never a second live claim.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000016c01', '00000000-0000-0000-0000-000000000001', 'c16-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000016c02', '00000000-0000-0000-0000-000000000001', 'c16-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000016c03', '00000000-0000-0000-0000-000000000001', 'c16-y', 'Card Y', 'credit');
-- p is 14 and 19 days from its two exact candidates, so nothing pairs automatically.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-000000016c01', 'c16-p', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000016c02', 'c16-x', -100, '2026-09-15', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000016c03', 'c16-y', -100, '2026-09-20', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
reset role;
-- The version both sessions' users saw, and each session's outcome.
create table public.th_c16_state as
  select evaluated_version as v from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c16_outcome (who text primary key, outcome text not null);
grant select on public.th_c16_state to service_role;
grant select, insert on public.th_c16_outcome to service_role;

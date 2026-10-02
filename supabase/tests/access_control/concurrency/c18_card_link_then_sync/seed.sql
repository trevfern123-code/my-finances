-- Acceptance test 21: the confirmation holds the per-user lock first; the sync batch waits, then commits. The
-- decision lands, survives the sync (no foreign key to transactions), and the sync's unevaluated change
-- leaves the user stale until the next evaluation, which keeps the decision.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000018c01', '00000000-0000-0000-0000-000000000001', 'c18-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000018c02', '00000000-0000-0000-0000-000000000001', 'c18-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000018c03', '00000000-0000-0000-0000-000000000001', 'c18-y', 'Card Y', 'credit');
-- p is 14 and 19 days from its two exact candidates, so nothing pairs automatically.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-000000018c01', 'c18-p', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000018c02', 'c18-x', -100, '2026-09-15', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000018c03', 'c18-y', -100, '2026-09-20', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
reset role;
-- The version both sessions' users saw, and each session's outcome.
create table public.th_c18_state as
  select evaluated_version as v from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c18_outcome (who text primary key, outcome text not null);
grant select on public.th_c18_state to service_role;
grant select, insert on public.th_c18_outcome to service_role;

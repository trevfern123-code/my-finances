-- Acceptance test 21 "a LIM removal vs a link on a leg of that card", removal first (20261006120000).
-- The removal completes and holds the per-user lock (L1) and the version row (L2). A confirmation that names
-- a leg of the removed card, made with the version the user saw, waits on L1. After the removal commits it is
-- REFUSED (card_payment_stale_version): the version moved, and the card leg no longer exists. Nothing is
-- written by it, and the removal's result stands, fresh.
--   p  C +100 / x X −100, 14 days apart: no automatic pair; the user is about to confirm it.
--   q  C  +60 / xq X −60,  1 day apart: a tier 1 pair, converted by the removal.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000026c01', '00000000-0000-0000-0000-000000000003', 'c26-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000026c02', '00000000-0000-0000-0000-000000000001', 'c26-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000026c03', '00000000-0000-0000-0000-000000000003', 'c26-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000026c01', 'c26-p', 100, '2026-09-01', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000026c02', 'c26-x', -100, '2026-09-15', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000026c01', 'c26-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000026c02', 'c26-xq', -60, '2026-09-04', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c26_state as
  select evaluated_version as v, (select id from public.transactions where plaid_transaction_id = 'c26-p') as p, (select id from public.transactions where plaid_transaction_id = 'c26-x') as x
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c26_outcome (who text primary key, outcome text not null);
grant select on public.th_c26_state to service_role;
grant select, insert on public.th_c26_outcome to service_role;

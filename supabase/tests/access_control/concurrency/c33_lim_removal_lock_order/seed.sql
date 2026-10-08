-- Lock order of the removal (20261006120000; design §3.7): L1 (the per-user advisory lock) strictly before L2
-- (the user's version row). A session holding ONLY L1 observes the removal blocked on it, then takes L2 with
-- NOWAIT: that succeeds only if the waiting removal holds no L2. Taking L2 before L1 would deadlock with any
-- RPC that holds L1 and then writes an input — the sync batch, a decision RPC.
--   q  C +60 / xq X −60, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000033c01', '00000000-0000-0000-0000-000000000003', 'c33-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000033c02', '00000000-0000-0000-0000-000000000001', 'c33-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000033c03', '00000000-0000-0000-0000-000000000003', 'c33-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000033c01', 'c33-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000033c02', 'c33-xq', -60, '2026-09-04', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c33_state as
  select evaluated_version as v
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c33_outcome (who text primary key, outcome text not null);
grant select on public.th_c33_state to service_role;
grant select, insert on public.th_c33_outcome to service_role;

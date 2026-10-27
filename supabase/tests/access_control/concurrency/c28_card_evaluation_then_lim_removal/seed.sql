-- Removal vs evaluation, evaluation first (20261006120000; design §3.7). A standalone evaluation of a user
-- who was never evaluated holds L1 and L2; the removal waits on L1 — it holds no version-row lock while it
-- waits. After the evaluation commits, the removal evaluates again itself, converts and publishes: the final
-- state is fresh at the removal's own final version.
--   q  C +60 / xq X −60, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000028c01', '00000000-0000-0000-0000-000000000003', 'c28-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000028c02', '00000000-0000-0000-0000-000000000001', 'c28-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000028c03', '00000000-0000-0000-0000-000000000003', 'c28-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000028c01', 'c28-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000028c02', 'c28-xq', -60, '2026-09-04', false, 'credit_card_payment');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c28_state as
  select input_version as v
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c28_outcome (who text primary key, outcome text not null);
grant select on public.th_c28_state to service_role;
grant select, insert on public.th_c28_outcome to service_role;

-- The removal's publication and a LOCK-FREE writer (20261006120000; design §3.7 "a lock-free direct update
-- during evaluation: the user ends stale, never falsely fresh"). The removal holds L2 from its first
-- evaluation to its commit. A direct UPDATE of a surviving, converted cash leg takes its row lock and then
-- waits on L2 for its trigger bump. After the removal commits, the bump lands: the user is STALE — the states
-- the removal published are not served for inputs they do not describe — until the next evaluation.
--   q  C +60 / xq X −60, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000032c01', '00000000-0000-0000-0000-000000000003', 'c32-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000032c02', '00000000-0000-0000-0000-000000000001', 'c32-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000032c03', '00000000-0000-0000-0000-000000000003', 'c32-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000032c01', 'c32-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000032c02', 'c32-xq', -60, '2026-09-04', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c32_state as
  select evaluated_version as v
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c32_outcome (who text primary key, outcome text not null);
grant select on public.th_c32_state to service_role;
grant select, insert on public.th_c32_outcome to service_role;

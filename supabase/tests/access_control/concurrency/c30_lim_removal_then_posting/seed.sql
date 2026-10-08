-- Removal vs the pending -> posted lifecycle, removal first (20261006120000; design §4.8). The surviving cash
-- leg is still PENDING when its card is removed: the record is written on the pending id. The sync batch
-- that posts it waits on L1, then commits. The posted row inherits the record through its lineage.
--   pend  C +120 pending / x X −120, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000030c01', '00000000-0000-0000-0000-000000000003', 'c30-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000030c02', '00000000-0000-0000-0000-000000000001', 'c30-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000030c03', '00000000-0000-0000-0000-000000000003', 'c30-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000030c01', 'c30-pend', 120, '2026-09-17', true, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000030c02', 'c30-x', -120, '2026-09-18', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c30_state as
  select evaluated_version as v
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c30_outcome (who text primary key, outcome text not null);
grant select on public.th_c30_state to service_role;
grant select, insert on public.th_c30_outcome to service_role;

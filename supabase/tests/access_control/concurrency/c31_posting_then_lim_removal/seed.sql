-- Removal vs the pending -> posted lifecycle, posting first (20261006120000; design §4.8). The sync batch that
-- posts the surviving cash leg holds L1; the removal waits. After the batch commits, the removal evaluates
-- the rows as they are now — the posted row is the leg — and writes the record on the posted row's own id.
--   pend  C +120 pending / x X −120, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000031c01', '00000000-0000-0000-0000-000000000003', 'c31-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000031c02', '00000000-0000-0000-0000-000000000001', 'c31-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000031c03', '00000000-0000-0000-0000-000000000003', 'c31-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000031c01', 'c31-pend', 120, '2026-09-17', true, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000031c02', 'c31-x', -120, '2026-09-18', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c31_state as
  select evaluated_version as v
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c31_outcome (who text primary key, outcome text not null);
grant select on public.th_c31_state to service_role;
grant select, insert on public.th_c31_outcome to service_role;

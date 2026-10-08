-- Acceptance test 21 "a LIM removal vs a link on a leg of that card", confirmation first (20261006120000).
-- The confirmation completes and holds L1 and L2; the removal waits on L1. After the confirmation commits
-- the removal evaluates the rows as they are NOW, finds the user pair it just missed, and preserves it: the
-- decision is never lost.
--   p  C +100 / x X −100, 14 days apart: paired only by the user's confirmation.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000027c01', '00000000-0000-0000-0000-000000000003', 'c27-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000027c02', '00000000-0000-0000-0000-000000000001', 'c27-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000027c03', '00000000-0000-0000-0000-000000000003', 'c27-y', 'Card Y', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000027c01', 'c27-p', 100, '2026-09-01', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000027c02', 'c27-x', -100, '2026-09-15', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
-- What both sessions saw before either ran, and each session's outcome.
create table public.th_c27_state as
  select evaluated_version as v
  from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c27_outcome (who text primary key, outcome text not null);
grant select on public.th_c27_state to service_role;
grant select, insert on public.th_c27_outcome to service_role;

-- The removal's lock order on the item's ACCOUNT rows (20261006120000; design §3.7; Trevor's decision of
-- 2026-10-06). A LOCK-FREE writer — the account-settings update that changes "exclude from cash flow", one
-- direct UPDATE with no advisory lock, as the backend runs it — holds an account row of the institution
-- being removed, and bumps the user's version row (L2) only in its trigger, at the end of the statement.
-- The removal must reach that row BEFORE it takes L2: then it simply waits, as the 20260926120000 body
-- did. If it took L2 first (its first evaluation), the two would wait for each other.
--   q  C +60 / xq X −60, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C stays (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000034c01', '00000000-0000-0000-0000-000000000003', 'c34-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000034c02', '00000000-0000-0000-0000-000000000001', 'c34-x', 'Card X', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000034c01', 'c34-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000034c02', 'c34-xq', -60, '2026-09-04', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
create table public.th_c34_outcome (who text primary key, outcome text not null);
grant select, insert on public.th_c34_outcome to service_role;

-- The removal's lock order on the item's ACCOUNT rows, against a writer that only REFERENCES the account
-- (20261006120000; design §3.7). A LOCK-FREE insert of a transaction on an account of the institution being
-- removed holds the foreign-key lock on that account row (KEY SHARE) and bumps the user's version row (L2)
-- in its trigger. The delete of the account conflicts with that lock, and the 20260926120000 body reached
-- it before taking L2. So the removal's early lock must be the delete's own (FOR UPDATE): a weaker one
-- (FOR SHARE) would let this insert through, and the removal would then hold L2 when it meets the row.
--   q  C +60 / xq X −60, 1 day apart: a tier 1 pair.
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C stays (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000035c01', '00000000-0000-0000-0000-000000000003', 'c35-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000035c02', '00000000-0000-0000-0000-000000000001', 'c35-x', 'Card X', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000035c01', 'c35-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000035c02', 'c35-xq', -60, '2026-09-04', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
create table public.th_c35_outcome (who text primary key, outcome text not null);
grant select, insert on public.th_c35_outcome to service_role;

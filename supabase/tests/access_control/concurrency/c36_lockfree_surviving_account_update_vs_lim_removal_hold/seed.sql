-- The removal's larger footprint on SURVIVING accounts (20261006120000, revision 5). The removal has always
-- inserted decisions that name surviving accounts (their foreign-key check takes KEY SHARE on those account
-- rows) while it holds the user's version row (L2). Revision 5 writes more of them: an ambiguity hold for a
-- payment that was matched automatically to the removed card names the KEPT card's account too. A LOCK-FREE
-- writer — the account-settings update that changes "exclude from cash flow", one direct UPDATE with no
-- advisory lock, as the backend runs it — holds that kept card's account row (FOR NO KEY UPDATE) and will bump
-- L2 only in its trigger. KEY SHARE does not conflict with NO KEY UPDATE: the removal must run to completion
-- while the writer still holds the row (no wait on it, so no cycle), and the writer's later bump must leave
-- the user STALE, never falsely fresh.
--   q  C +60 09-03 / xq X −60 09-04 (1 day: the automatic match, removed) / yq Y −60 09-06 (3 days: was already there)
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
-- C and Y stay (item 3); X is on the item being removed (item 1).
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000036c01', '00000000-0000-0000-0000-000000000003', 'c36-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000036c03', '00000000-0000-0000-0000-000000000003', 'c36-y', 'Kept Card Y', 'credit'),
  ('00000000-0000-0000-0000-000000036c02', '00000000-0000-0000-0000-000000000001', 'c36-x', 'Card X', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000036c01', 'c36-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000036c02', 'c36-xq', -60, '2026-09-04', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000036c03', 'c36-yq', -60, '2026-09-06', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((select count(*) = 1 from public.card_payment_auto_pairs p
                  join public.transactions t on t.id = p.cash_transaction_id join public.transactions k on k.id = p.credit_transaction_id
                  where t.plaid_transaction_id = 'c36-q' and k.plaid_transaction_id = 'c36-xq'),
  'fixture: the payment is matched automatically to the card that is about to be removed');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
reset role;
create table public.th_c36_outcome (who text primary key, outcome text not null);
grant select, insert on public.th_c36_outcome to service_role;

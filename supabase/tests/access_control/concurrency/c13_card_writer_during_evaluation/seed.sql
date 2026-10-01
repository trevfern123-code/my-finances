-- 16a (second half): a lock-free write that starts while an evaluation holds L2 waits for it, and then
-- leaves the user STALE — never falsely fresh with states that miss the write.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-00000000c131', '00000000-0000-0000-0000-000000000001', 'c13-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-00000000c132', '00000000-0000-0000-0000-000000000001', 'c13-x', 'Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000c131', 'c13-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000c132', 'c13-card', -100, '2026-09-02', 'credit_card_payment');

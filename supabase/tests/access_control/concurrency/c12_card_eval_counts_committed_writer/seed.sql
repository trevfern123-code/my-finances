-- 16a (first half): a lock-free write that commits while the evaluator waits for L2 is both COUNTED in
-- the published version and VISIBLE to the evaluation (READ COMMITTED; inputs read only after L2).
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-00000000c121', '00000000-0000-0000-0000-000000000001', 'c12-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-00000000c122', '00000000-0000-0000-0000-000000000001', 'c12-x', 'Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000c121', 'c12-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000c122', 'c12-card', -100, '2026-09-02', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');

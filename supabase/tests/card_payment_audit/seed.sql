-- Synthetic rows for the card-payment audit check (run.sh). THROWAWAY container only; no real data.
truncate auth.users cascade;
truncate public.plaid_items cascade;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'a@example.test'),
  ('00000000-0000-0000-0000-0000000000bb', 'b@example.test');
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_id, institution_name) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'item-a', 'placeholder', 'ins_109508', 'First Platypus Bank'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000bb', 'item-b', 'placeholder', 'ins_3', 'Harness Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'acc-c', 'Checking', 'depository', false),
  ('00000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000001', 'acc-x', 'Card', 'credit', false),
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000001', 'acc-e', 'Excluded card', 'credit', true),
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000002', 'acc-d', 'B checking', 'depository', false);

create temp table seed (n int, acct text, days_ago int, amount numeric, detailed text, confidence text,
                        category text, override text, stored boolean, pending boolean);
insert into seed values
  -- 1 paired
  (1, 'c', 100, 100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (2, 'x',  99, -100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 2 Codex: paired payment, reversal and return 6 days apart
  (3, 'c', 80, 200, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (4, 'x', 79, -200, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (5, 'x', 71, 200, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (6, 'c', 65, -200, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 3 late card leg (7 days)
  (7, 'c', 50, 300, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (8, 'x', 43, -300, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 4 fee-shaped difference
  (9, 'c', 40, 150, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (10, 'x', 39, -148, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 5 tie
  (11, 'c', 30, 400, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (12, 'c', 28, 400, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (13, 'x', 29, -400, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 6 excluded card
  (14, 'c', 20, 500, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (15, 'e', 19, -500, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 7 unlinked card, older; 8 recent
  (16, 'c', 60, 600, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  (17, 'c', 3, 700, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 9 externally funded
  (18, 'x', 45, -800, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- 10 low confidence -> classified elsewhere; 11 overridden away; detailed missing
  (19, 'c', 35, 900, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'LOW', 'LOAN_PAYMENTS', null, false, false),
  (20, 'c', 33, 1000, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', 'expense', false, false),
  (21, 'c', 34, 1300, null, null, 'LOAN_PAYMENTS', null, false, false),
  -- 12 override TO card payment + stored role
  (22, 'c', 25, 1100, 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'HIGH', 'TRANSFER_OUT', 'credit_card_payment', false, false),
  (23, 'x', 24, -1100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, true, false),
  -- 13 pending pair
  (24, 'c', 2, 1200, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, true),
  (25, 'x', 1, -1200, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- outside the period
  (26, 'c', 400, 100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- user B: no credit account at all
  (27, 'd', 10, 50, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false),
  -- ordinary expense: never in the audit
  (28, 'c', 12, 42, 'FOOD_AND_DRINK_GROCERIES', 'HIGH', 'FOOD_AND_DRINK', null, false, false);

insert into public.transactions (account_id, plaid_transaction_id, amount, date, category,
                                 personal_finance_category_detailed, personal_finance_category_confidence,
                                 user_role_override, auto_role, role_source, role_confidence, pending)
select ('00000000-0000-0000-0000-00000000000' || replace(s.acct, 'x', 'f'))::uuid, 'txn-' || s.n, s.amount, current_date - s.days_ago,
       s.category, s.detailed, s.confidence, s.override,
       case when s.stored then 'credit_card_payment' end,
       case when s.stored then 'category_detailed' end,
       case when s.stored then 'high' end,
       s.pending
from seed s;

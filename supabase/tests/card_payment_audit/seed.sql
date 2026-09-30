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
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000002', 'acc-d', 'B checking', 'depository', false),
  -- rev 2: a cash account whose Plaid type is NULL (cash side, as semanticAggregation.ts), and an
  -- excluded savings account.
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'acc-a', 'Untyped cash', null, false),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'acc-b', 'Excluded savings', 'depository', true);

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

-- rev 2 regression cases (Codex review of 5a6e831). from_start: days_ago is an offset from audit_start
-- (current_date − 12 months), so boundary cases sit exactly where the audit window begins.
alter table seed add column from_start boolean not null default false;
insert into seed (n, acct, days_ago, amount, detailed, confidence, category, override, stored, pending, from_start) values
  -- R1 NULL account type is the cash side: pairs with the card leg → confirmed_tracked_pair_5d, cash_side.
  (29, 'a', 8, 710, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false),
  (30, 'x', 7, -710, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false),
  -- R2 60-day boundary: the only exact candidate (start−58) is itself paired with start−62, which lies
  -- beyond start−60 → #31 must be unknown_no_candidate (rev 1 loaded too little and said possible).
  (31, 'c', 2, 333, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  (32, 'x', -58, -333, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  (33, 'c', -62, 333, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  -- R3 the mirror: the candidate (start−58) ties between start−62 and start−54, so it is unpaired and
  -- #34 is possible_exact_amount_6_to_60d (rev 1 missed start−62, paired the candidate, said unknown).
  (34, 'c', 2, 444, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  (35, 'x', -58, -444, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  (36, 'c', -62, 444, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  (37, 'c', -54, 444, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, true),
  -- R4 an excluded card leg ties with the included one: slice 1 (included-only) pairs #38 (effect 0) but
  -- its destination is not established → possible_tie, exposure 555 (slice1_effect and exposure differ).
  (38, 'c', 15, 555, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false),
  (39, 'x', 14, -555, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false),
  (40, 'e', 16, -555, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false),
  -- R5 an excluded cash account funds the included card → confirmed_funded_from_excluded_account_5d (0).
  (41, 'b', 22, 650, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false),
  (42, 'x', 21, -650, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, false, false, false);
  -- R7 (rev 3) an excluded card leg closer than the included one: checking +100 "Sep 1", included card
  -- −100 "Sep 3", excluded card −100 "Sep 2". Stored roles, so this is its own 'current' row.
  -- Slice 1 (included only) pairs checking with the included card → slice1_effect 0. The approved rule
  -- pairs it with the excluded card → proposed_effect −100, confirmed_difference −100, exposure 0.
insert into seed (n, acct, days_ago, amount, detailed, confidence, category, override, stored, pending, from_start) values
  (43, 'c', 50, 100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, true, false, false),
  (44, 'x', 48, -100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, true, false, false),
  (45, 'e', 49, -100, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'HIGH', 'LOAN_PAYMENTS', null, true, false, false);
  -- R6 (no new rows): #14/#15, a payment to an excluded card, is confirmed_untracked_partner_excluded_5d
  -- with exposure 0 — slice 1 already counts it correctly, so it is not exposure.

insert into public.transactions (account_id, plaid_transaction_id, amount, date, category,
                                 personal_finance_category_detailed, personal_finance_category_confidence,
                                 user_role_override, auto_role, role_source, role_confidence, pending)
select ('00000000-0000-0000-0000-00000000000' || replace(s.acct, 'x', 'f'))::uuid, 'txn-' || s.n, s.amount, case when s.from_start then (current_date - interval '12 months')::date + s.days_ago else current_date - s.days_ago end,
       s.category, s.detailed, s.confidence, s.override,
       case when s.stored then 'credit_card_payment' end,
       case when s.stored then 'category_detailed' end,
       case when s.stored then 'high' end,
       s.pending
from seed s;

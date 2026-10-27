-- Synthetic rows for the I1 read-path integration check. Run as supabase_admin against the throwaway
-- local stack only. Every token value is an obvious placeholder — no real credential is used.
--
-- User A (…aa): 1 500 generated transactions across 13 months (2025-09-01 … 2026-09-30) on two
--   INCLUDED accounts, plus two manual-loan payments, a tracked card payment, an unresolved one, and
--   1 002 splits (334 parents × 3). One EXCLUDED account with sentinel rows of 777 777.77.
-- User B (…bb): sentinel rows of 999 999.99 with a split and a category — must never appear for A.
-- User C (…cc): an empty account, filled by the check itself when it measures the limits.
truncate auth.users cascade;
truncate public.plaid_items cascade;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000bb', 'other@example.test'),
  ('00000000-0000-0000-0000-0000000000cc', 'large@example.test');

insert into public.plaid_items (id, user_id, plaid_item_id, access_token,
                                access_token_ciphertext, access_token_nonce, access_token_auth_tag,
                                access_token_key_id, access_token_enc_version) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'i1-item-a',
   'placeholder-plaintext-token-a', 'cGxhY2Vob2xkZXI=', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000bb', 'i1-item-b',
   'placeholder-plaintext-token-b', null, null, null, null, null),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000cc', 'i1-item-c',
   'placeholder-plaintext-token-c', null, null, null, null, null);

insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-000000000001', 'i1-a-checking', 'A Checking', 'depository', false),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-000000000001', 'i1-a-card', 'A Card', 'credit', false),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-000000000001', 'i1-a-excluded', 'A Excluded', 'depository', true),
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000002', 'i1-b-checking', 'B Checking', 'depository', false),
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-000000000003', 'i1-c-checking', 'C Checking', 'depository', false);

insert into public.budget_categories (id, user_id, name, sort_order) values
  ('00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-0000000000aa', 'I1 Groceries', 1),
  ('00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-0000000000aa', 'I1 Dining', 2),
  ('00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-0000000000aa', 'I1 Shopping', 3),
  ('00000000-0000-0000-0000-00000000ca04', '00000000-0000-0000-0000-0000000000aa', 'I1 Household', 4),
  ('00000000-0000-0000-0000-00000000cb01', '00000000-0000-0000-0000-0000000000bb', 'I1 B Category', 1),
  ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000000cc', 'I1 C Category', 1);

insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000aa', 'I1 Loan', 10000);

-- ---- User A: 1 500 generated transactions ------------------------------------------------------------
-- i % 10 = 0 → income (negative); i % 17 = 0 → refund (negative, on the card); otherwise an expense.
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category, budget_category_id,
                                 auto_role, role_source, role_confidence, classifier_version)
select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       case when i % 3 = 0 or i % 17 = 0 then '00000000-0000-0000-0000-00000000a002'::uuid else '00000000-0000-0000-0000-00000000a001'::uuid end,
       'i1-a-' || i,
       case when i % 10 = 0 then -(100 + (i % 50) + (i % 100) / 100.0)
            when i % 17 = 0 then -(5 + (i % 30) + (i % 100) / 100.0)
            else 5 + (i % 80) + (i % 100) / 100.0 end,
       date '2025-09-01' + (i % 395),
       'Synthetic ' || i,
       case i % 4 when 0 then 'FOOD_AND_DRINK' when 1 then 'GENERAL_MERCHANDISE' when 2 then 'TRANSPORTATION' else null end,
       case when i % 10 = 0 then null
            else case i % 5 when 0 then '00000000-0000-0000-0000-00000000ca01'::uuid
                            when 1 then '00000000-0000-0000-0000-00000000ca02'::uuid
                            when 2 then '00000000-0000-0000-0000-00000000ca03'::uuid
                            else null end end,
       case when i % 10 = 0 then 'income' when i % 17 = 0 then 'refund' else 'expense' end,
       case when i % 17 = 0 and i % 10 <> 0 then 'refund_match' else 'sign_default' end,
       'low', 1
from generate_series(1, 1500) i;

-- ---- User A: 1 002 splits — the first 334 expense rows, three ways, summing exactly to the parent ------
with parents as (
  select t.id, t.amount, row_number() over (order by t.plaid_transaction_id) as n
  from public.transactions t
  where t.plaid_transaction_id like 'i1-a-%' and t.auto_role = 'expense'
),
chosen as (select * from parents where n <= 334)
insert into public.transaction_splits (transaction_id, budget_category_id, amount, note)
select c.id, s.category, s.amount, s.note
from chosen c
cross join lateral (values
  ('00000000-0000-0000-0000-00000000ca01'::uuid, round(c.amount / 3, 2), 'first'),
  ('00000000-0000-0000-0000-00000000ca02'::uuid, round(c.amount / 3, 2), 'second'),
  ('00000000-0000-0000-0000-00000000ca04'::uuid, c.amount - 2 * round(c.amount / 3, 2), null)
) as s(category, amount, note);

-- ---- User A: two manual-loan payments (linked through the real RPC, principal 350 of 400 each) -------
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category,
                                 auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-4000-8000-000000009001', '00000000-0000-0000-0000-00000000a001', 'i1-a-loan-1', 400, '2026-09-12', 'Loan payment 1', 'LOAN_PAYMENTS', 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-4000-8000-000000009002', '00000000-0000-0000-0000-00000000a001', 'i1-a-loan-2', 400, '2026-09-13', 'Loan payment 2', 'LOAN_PAYMENTS', 'expense', 'sign_default', 'low', 1);
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-4000-8000-000000009001',
                                              '00000000-0000-0000-0000-00000000d001', 350, 1::smallint);
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-4000-8000-000000009002',
                                              '00000000-0000-0000-0000-00000000d001', 350, 1::smallint);

-- ---- User A: card payments — one tracked pair, one cash leg with no partner (unresolved) ---------------
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category,
                                 auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-4000-8000-000000009101', '00000000-0000-0000-0000-00000000a001', 'i1-a-pay', 300, '2026-09-10', 'Card payment', 'LOAN_PAYMENTS', 'credit_card_payment', 'category_detailed', 'high', 1),
  ('00000000-0000-4000-8000-000000009102', '00000000-0000-0000-0000-00000000a002', 'i1-a-card', -300, '2026-09-11', 'Payment received', 'LOAN_PAYMENTS', 'credit_card_payment', 'category_detailed', 'high', 1),
  ('00000000-0000-4000-8000-000000009103', '00000000-0000-0000-0000-00000000a001', 'i1-a-pay-lone', 80, '2026-09-15', 'Card payment (other card)', 'LOAN_PAYMENTS', 'credit_card_payment', 'category_detailed', 'high', 1);

-- ---- User A: an account EXCLUDED from cash flow — sentinel rows that must never be returned -----------
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
select ('00000000-0000-4000-8000-0000000095' || lpad(g::text, 2, '0'))::uuid, '00000000-0000-0000-0000-00000000a003', 'i1-a-excluded-' || g,
       777777.77, date '2026-09-05' + g, 'EXCLUDED SENTINEL', 'expense', 'sign_default', 'low', 1
from generate_series(1, 3) g;
insert into public.transaction_splits (transaction_id, budget_category_id, amount, note)
values ('00000000-0000-4000-8000-000000009501', '00000000-0000-0000-0000-00000000ca01', 777777.77, 'EXCLUDED SENTINEL SPLIT');

-- ---- User B: sentinel rows that must never appear for user A -------------------------------------------
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, budget_category_id,
                                 auto_role, role_source, role_confidence, classifier_version)
select ('00000000-0000-4000-8000-0000000096' || lpad(g::text, 2, '0'))::uuid, '00000000-0000-0000-0000-00000000b001', 'i1-b-' || g,
       999999.99, date '2026-09-01' + g, 'OTHER USER SENTINEL', '00000000-0000-0000-0000-00000000cb01', 'expense', 'sign_default', 'low', 1
from generate_series(1, 5) g;
insert into public.transaction_splits (transaction_id, budget_category_id, amount, note)
values ('00000000-0000-4000-8000-000000009601', '00000000-0000-0000-0000-00000000cb01', 999999.99, 'OTHER USER SENTINEL SPLIT');

-- A quiescent, evaluated starting point for both users with rows.
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');

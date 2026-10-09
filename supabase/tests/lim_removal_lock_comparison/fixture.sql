-- Fixture of one lock-comparison case (run.sh). psql variable: scenario = S1 | S2 | S3 | S4 | S5.
--
-- User aa. Item 1 is REMOVED; item 3 "Kept Bank" survives (checking C).
-- Item 1's accounts, in the order its cascade reaches them (the order they are inserted here):
--   R   checking, with a payment linked to a manual loan (1000 -> 900), so a rolled-back and retried removal
--       must restore the balance exactly once;
--   X   card: lc-x −60, a tier 1 pair with lc-k +60 on C;
--   XB  a second card (S3 only).
-- The row the lock-free writer holds (writer.sql):
--   S1  the TRANSACTION lc-held (an unpaired card-side leg, −75) on X. NO decision row exists anywhere.
--   S2  lc-held on X. The user confirmed lc-k / lc-x: a decision row that references X.
--   S3  lc-held on XB. The same decision row references X, which the cascade reaches BEFORE XB.
--   S4  the ACCOUNT row of card X itself (the writer updates it). NO decision row exists anywhere.
--   S5  the ACCOUNT row of card X, held only by the foreign-key lock of an INSERT that references it.
\set ON_ERROR_STOP 1
select :'scenario' in ('S2', 'S3') as with_decision, :'scenario' = 'S3' as second_card \gset

drop table if exists public.th_lc_outcome, public.th_lc_waits, public.th_lc_seed;
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1001', '00000000-0000-0000-0000-000000000001', 'lc-r', 'Removed Checking', 'depository');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1002', '00000000-0000-0000-0000-000000000001', 'lc-x-card', 'Card X', 'credit');
\if :second_card
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1003', '00000000-0000-0000-0000-000000000001', 'lc-xb', 'Card XB', 'credit');
\endif
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1004', '00000000-0000-0000-0000-000000000003', 'lc-c', 'Kept Checking', 'depository');

insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000c10f1', '00000000-0000-0000-0000-0000000000aa', 'L1', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000c10e1', '00000000-0000-0000-0000-0000000c1001', 'lc-loanpay', 100, '2026-09-10', 'Loan payment', 'expense', 'sign_default', 'low', 1);
select th.assert(public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000c10e1',
                 '00000000-0000-0000-0000-0000000c10f1', 100, 1::smallint) = 'linked', 'fixture: a payment on the removed item is linked to a manual loan');

insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1004', 'lc-k', 60, '2026-09-03', 'Leg lc-k', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000c1002', 'lc-x', -60, '2026-09-04', 'Leg lc-x', false, 'credit_card_payment');
\if :second_card
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1003', 'lc-held', -75, '2026-09-20', 'Leg lc-held', false, 'credit_card_payment');
\else
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1002', 'lc-held', -75, '2026-09-20', 'Leg lc-held', false, 'credit_card_payment');
\endif
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
\if :with_decision
select th.assert(public.link_card_payment('00000000-0000-0000-0000-0000000000aa',
                   (select id from public.transactions where plaid_transaction_id = 'lc-k'),
                   (select id from public.transactions where plaid_transaction_id = 'lc-x'), 0,
                   (select input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'))->>'matching' = 'fresh',
  'fixture: the user confirms the pair (a decision row that references card X)');
\endif
select th.assert((select count(*) from public.card_payment_decisions) = case when :'scenario' in ('S1', 'S4', 'S5') then 0 else 1 end, 'fixture: the decision rows the scenario names');

select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'fixture: the user is fresh before the overlap');
reset role;

-- What each session did, the waits a third session saw, and the state before the overlap.
create table public.th_lc_outcome (who text primary key, outcome text not null, sqlstate text, detail text);
create table public.th_lc_waits (waiter text not null, blocker text not null, wait_event text not null, primary key (waiter, blocker, wait_event));
create table public.th_lc_seed as
  select (select input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa') as iv,
         (select evaluated_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa') as ev,
         (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
          where a.item_id = '00000000-0000-0000-0000-000000000001') as item_txns,
         (select count(*) from public.accounts where item_id = '00000000-0000-0000-0000-000000000001') as item_accounts,
         (select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000c10f1') as loan,
         (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) from public.card_payment_decisions d) as decisions,
         (select coalesce(jsonb_agg(to_jsonb(s) order by s.transaction_id), '[]'::jsonb) from public.card_payment_leg_states s) as leg_states,
         (select to_jsonb(r) from public.plaid_item_removals r where r.item_id = '00000000-0000-0000-0000-000000000001') as removal,
         (select amount from public.transactions where plaid_transaction_id = 'lc-held') as held_amount;
grant select, insert on public.th_lc_outcome to service_role;
grant select on public.th_lc_seed, public.th_lc_waits to service_role;

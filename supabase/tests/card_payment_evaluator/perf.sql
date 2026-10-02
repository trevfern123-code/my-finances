-- Evaluator timing on representative larger histories (throwaway containers only; run as supabase_admin
-- after the migrations). Mostly non-card transactions, with pending → posted lineage on a share of all
-- rows (as sync produces it), a few conflicting replacement groups, carry-overs and decisions.
--
--   psql -v n=20000 -f perf.sql      (n = total transactions for the user; default below)
--
-- Prints the elapsed evaluation time for :n rows. Deterministic data (no random()).
\set ON_ERROR_STOP 1
\if :{?n}
\else
  \set n 20000
\endif
set client_min_messages = warning;
truncate auth.users cascade;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'perf@example.test');
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'perf-item', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow)
select ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000001',
       'perf-acct-' || g, 'Account ' || g,
       case when g in (4, 5, 6) then 'credit' else 'depository' end, g = 6
from generate_series(1, 8) g;

-- :n rows. Every 50th row is a card-payment leg (2%); the rest are ordinary spending/income. Every 3rd
-- row is a posted row whose pending row (every 3rd + 1) it replaces; every 997th pending id is claimed
-- twice (a conflicting replacement group).
insert into public.transactions (account_id, plaid_transaction_id, pending_transaction_id, pending, date, amount, user_role_override)
select ('00000000-0000-0000-0000-0000000001' || lpad((case when g % 50 = 0 then (case when (g / 50) % 2 = 0 then 1 else 4 + (g / 50) % 3 end)
                                                       else 1 + g % 3 end)::text, 2, '0'))::uuid,
       'perf-' || g,
       case when g % 3 = 0 then 'perf-' || (g + 1) when g % 997 = 0 then 'perf-' || (g - 996) end,
       g % 3 = 1,
       date '2024-01-01' + (g % 900),
       case when g % 50 = 0 then (case when (g / 50) % 2 = 0 then 1 else -1 end) * (100 + (g % 7) * 25)
            else 10 + (g % 400) end,
       case when g % 50 = 0 then 'credit_card_payment' when g % 5 = 0 then 'income' else 'expense' end
from generate_series(1, :n) g;

insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id,
                                           pending_amount, pending_date, needs_review, expires_at)
select '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000101', 'perf-gone-' || g, gen_random_uuid(),
       100, date '2025-01-01', false, timestamptz '2026-12-31'
from generate_series(1, 50) g;

-- Decisions on card legs: destination confirmations and pairs (some referencing lineage ids).
insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
select '00000000-0000-0000-0000-0000000000aa', 'destination_unlinked', t.account_id, t.plaid_transaction_id, (t.amount * 100)::bigint
from public.transactions t join public.accounts a on a.id = t.account_id
where t.user_role_override = 'credit_card_payment' and a.type = 'depository' and t.amount > 0
order by t.plaid_transaction_id limit 40;
insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
select '00000000-0000-0000-0000-0000000000aa', 'destination_unlinked', '00000000-0000-0000-0000-000000000101', 'perf-gone-' || g, 10000
from generate_series(1, 20) g;

select count(*) as transactions, count(*) filter (where user_role_override = 'credit_card_payment') as card_legs
from public.transactions;

\timing on
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
\timing off
select count(*) as leg_states from public.card_payment_leg_states;

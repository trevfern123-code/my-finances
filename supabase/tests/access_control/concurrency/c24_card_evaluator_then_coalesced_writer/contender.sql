-- A lock-free writer starting while the evaluator holds L2: three input writes in one transaction. The
-- first bump waits on L2; after the evaluator publishes, it bumps (the row is fresh again, so nothing
-- may be skipped), and the later writes may then be coalesced into it.
select th.wait_for_application('c24-evaluator-holding-l2');
select set_config('application_name', 'c24-writer', false);
begin;
set local role service_role;
update public.transactions set amount = 98 where plaid_transaction_id = 'c24-pay';
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1c01', 'c24-extra', 55, '2026-09-05', 'credit_card_payment');
update public.transactions set amount = -97 where plaid_transaction_id = 'c24-card';
commit;

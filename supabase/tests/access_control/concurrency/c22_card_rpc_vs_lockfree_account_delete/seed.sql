-- The documented lock-free-writer cycle, for the decision RPCs (design §3.7 16c; the migration header's
-- step 2). The RPC takes no row lock on transactions, but its decision INSERT's foreign-key check takes
-- KEY SHARE on the referenced account row. A lock-free writer (manual SQL, an old backend) deleting that
-- account holds the row and, once its cascade finishes, needs L2 for its trigger bump — which the RPC
-- holds. A test-only trigger pauses the writer's cascade until the RPC is OBSERVED blocked on the account
-- row, so the cycle is established, not timed. PostgreSQL must abort exactly one side, which rolls back
-- completely; afterwards the state is consistent and never falsely fresh.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000022c01', '00000000-0000-0000-0000-000000000001', 'c22-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-000000022c02', '00000000-0000-0000-0000-000000000001', 'c22-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-000000022c03', '00000000-0000-0000-0000-000000000001', 'c22-y', 'Card Y', 'credit');
-- p is 14 and 19 days from its two exact candidates, so nothing pairs automatically.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-000000022c01', 'c22-p', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000022c02', 'c22-x', -100, '2026-09-15', 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000022c03', 'c22-y', -100, '2026-09-20', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
reset role;
-- The version both sessions' users saw, and each session's outcome.
create table public.th_c22_state as
  select evaluated_version as v from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa';
create table public.th_c22_outcome (who text primary key, outcome text not null);
grant select on public.th_c22_state to service_role;
grant select, insert on public.th_c22_outcome to service_role;
create function public.th_c22_pause() returns trigger language plpgsql as $$
declare
  v_rpc integer;
begin
  if old.plaid_transaction_id = 'c22-x' and current_setting('application_name') = 'c22-writer' then
    perform set_config('application_name', 'c22-writer-holding', false);
    v_rpc := th.wait_for_application('c22-rpc');
    perform th.wait_until_blocked_by(v_rpc, pg_backend_pid());
  end if;
  return old;
end $$;
create trigger th_c22_pause before delete on public.transactions for each row execute function public.th_c22_pause();

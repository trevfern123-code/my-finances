-- The RPC shape: per-user lock (L1); write A (its bump takes L2); then — only once it has OBSERVED the
-- lock-free writer holding row B and blocked on L2 — write B, closing the cycle; then evaluate. A
-- deadlock rolls back everything inside the block, the bump included. Runs as the session user for the
-- barriers and switches to service_role for the RPC's statements.
begin;
do $$
declare
  v_writer integer;
begin
  perform set_config('role', 'service_role', true);
  perform pg_advisory_xact_lock(hashtext('00000000-0000-0000-0000-0000000000aa'));
  update public.transactions set amount = 101 where plaid_transaction_id = 'c15-a';
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c15-rpc-holding-l2', false);
  v_writer := th.wait_for_application('c15-writer');
  perform th.wait_until_blocked_by(v_writer, pg_backend_pid());
  perform set_config('role', 'service_role', true);
  update public.transactions set amount = 201 where plaid_transaction_id = 'c15-b';
  perform public.try_evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
  insert into public.th_c15_outcome values ('holder', 'committed');
exception when deadlock_detected then
  insert into public.th_c15_outcome values ('holder', 'deadlock');
end $$;
commit;

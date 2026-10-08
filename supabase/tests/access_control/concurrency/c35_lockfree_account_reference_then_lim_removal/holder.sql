-- The lock-free writer. It takes the lock its insert's foreign-key check takes, waits until the removal is
-- observed blocked on that row, probes L2 (free only if the waiting removal has not taken it), then inserts.
begin;
do $$
declare
  v_contender integer;
begin
  perform set_config('role', 'service_role', true);
  perform 1 from public.accounts where id = '00000000-0000-0000-0000-000000035c02' for key share;
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c35-holder', false);
  v_contender := th.wait_for_application('c35-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
  perform set_config('role', 'service_role', true);
  begin
    perform 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa' for update nowait;
    insert into public.th_c35_outcome values ('probe', 'l2_free');
  exception when lock_not_available then
    insert into public.th_c35_outcome values ('probe', 'l2_held_by_waiting_removal');
  end;
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
  values ('00000000-0000-0000-0000-000000035c02', 'c35-new', 12.34, '2026-09-05', 'Purchase', 'expense', 'sign_default', 'low', 1);
  insert into public.th_c35_outcome values ('holder', 'inserted');
end $$;
commit;

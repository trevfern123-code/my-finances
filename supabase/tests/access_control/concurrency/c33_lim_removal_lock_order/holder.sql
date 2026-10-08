-- Holds ONLY L1 (no input write, so no L2), waits until the removal is observed blocked by it, then probes L2.
begin;
do $$
declare
  v_contender integer;
begin
  perform pg_advisory_xact_lock(hashtext('00000000-0000-0000-0000-0000000000aa'));
  perform set_config('application_name', 'c33-holder', false);
  v_contender := th.wait_for_application('c33-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
  begin
    perform 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa' for update nowait;
    insert into public.th_c33_outcome values ('holder', 'l2_free');
  exception when lock_not_available then
    insert into public.th_c33_outcome values ('holder', 'l2_held_by_waiting_removal');
  end;
end $$;
commit;

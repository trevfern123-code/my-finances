-- The first request commits while the second waits for the user's advisory lock.
begin;
do $$
declare
  v_contender integer;
  v jsonb;
begin
  perform set_config('role', 'service_role', true);
  select public.apply_card_payment_recovery_action(rrh.aa(), rrh.op(1), s.input, s.review, rrh.pair_kw()) into v from public.th_c01_seen s;
  insert into public.th_c01_outcome values ('holder', v->>'status');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c01-holder', false);
  v_contender := th.wait_for_application('c01-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

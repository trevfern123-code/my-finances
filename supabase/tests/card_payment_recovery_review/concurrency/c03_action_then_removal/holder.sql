-- The user pairs k with w; the transaction stays open.
begin;
do $$
declare
  v_contender integer;
  v jsonb;
begin
  perform set_config('role', 'service_role', true);
  select public.apply_card_payment_recovery_action(rrh.aa(), rrh.op(1), s.input, s.review, rrh.pair_kw()) into v from public.th_c03_seen s;
  insert into public.th_c03_outcome values ('holder', v->>'status');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c03-holder', false);
  v_contender := th.wait_for_application('c03-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

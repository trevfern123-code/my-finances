-- The ORIGINAL request. Its client gave up waiting (a timeout) — the transaction itself is still open: the
-- decision and its receipt are written, and not committed. It commits only after the other session has looked
-- the operation up AND is waiting to send the same operation again.
begin;
do $$
declare
  v_contender integer;
  v jsonb;
begin
  perform set_config('role', 'service_role', true);
  select public.apply_card_payment_recovery_action(rrh.aa(), rrh.op(1), s.input, s.review, rrh.pair_kw()) into v from public.th_c08_seen s;
  insert into public.th_c08_outcome values ('original request', v->>'status');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c08-holder', false);
  v_contender := th.wait_for_application('c08-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

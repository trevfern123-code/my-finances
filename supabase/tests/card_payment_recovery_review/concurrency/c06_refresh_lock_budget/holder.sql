-- Something else holds the user's advisory lock (L1) for longer than the refresh's lock budget.
begin;
do $$
declare
  v_contender integer;
begin
  perform pg_advisory_xact_lock(hashtext(rrh.aa()::text));
  insert into public.th_c06_outcome values ('holder', 'locked');
  perform set_config('application_name', 'c06-holder', false);
  v_contender := th.wait_for_application('c06-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
  perform pg_sleep(12);
end $$;
commit;

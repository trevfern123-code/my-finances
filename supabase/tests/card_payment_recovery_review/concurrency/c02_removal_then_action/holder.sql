-- The removal of the Second Bank runs and holds its locks.
begin;
do $$
declare
  v_contender integer;
  v jsonb;
begin
  perform set_config('role', 'service_role', true);
  v := public.remove_plaid_item_local(rrh.aa(), '00000000-0000-0000-0000-000000000004');
  insert into public.th_c02_outcome values ('holder', case when (v->>'replayed')::boolean then 'replayed' else 'removed' end);
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c02-holder', false);
  v_contender := th.wait_for_application('c02-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

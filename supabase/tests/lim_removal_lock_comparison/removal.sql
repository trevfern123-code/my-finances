-- The removal: remove_plaid_item_local, as the backend calls it, started once the lock-free writer holds its
-- row. psql variable: dt = this session's deadlock_timeout. Whatever it raises is recorded with its SQLSTATE
-- (and PostgreSQL's own detail for a deadlock: process and lock names only).
\set ON_ERROR_STOP 1
set deadlock_timeout = :'dt';
set session authorization postgres;
select th.wait_for_application('lc-writer-holding');
select set_config('application_name', 'lc-removal', false);
begin;
set local role service_role;
do $$
declare
  v jsonb;
  v_detail text;
begin
  begin
    v := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
    insert into public.th_lc_outcome values ('removal', case when (v->>'replayed')::boolean then 'replayed' else 'removed' end, null, null);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into public.th_lc_outcome values ('removal', 'error', sqlstate, v_detail);
  end;
end $$;
commit;

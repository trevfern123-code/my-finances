-- The removal of the lock-extent probe: remove_plaid_item_local, as the backend calls it, in a transaction that
-- is kept open after the function has returned until the probing session has looked (extent_probe.sql).
\set ON_ERROR_STOP 1
set session authorization postgres;
select th.wait_for_application('lx-probe');
begin;
set local role service_role;
select th.assert((public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')->>'replayed')::boolean = false,
  'the removal runs');
set local role none;
select set_config('application_name', 'lx-removed', false);
select th.wait_for_application('lx-probed');
commit;

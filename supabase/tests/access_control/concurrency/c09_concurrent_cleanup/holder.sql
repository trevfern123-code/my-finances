-- Two removal requests for the same item (a double submit, or a retry while the first is running).
set role service_role;
begin;
select th.assert((public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')->>'replayed')::boolean = false,
  'the first cleanup does the work');
select pg_sleep(3);
commit;

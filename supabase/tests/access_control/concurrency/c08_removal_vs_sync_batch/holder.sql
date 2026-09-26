-- Cleanup runs and holds its transaction open.
set role service_role;
begin;
select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
select pg_sleep(3);
commit;

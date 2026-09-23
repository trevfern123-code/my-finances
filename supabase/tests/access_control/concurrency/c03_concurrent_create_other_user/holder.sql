-- Creates for aa — taking aa's per-user lock AND the sweep lock — and holds both open.
begin;
set local role service_role;
select public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select pg_sleep(3);
commit;

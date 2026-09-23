-- Creates for aa — taking aa's per-user lock AND the sweep lock — and holds both open.
begin;
set local role service_role;
select th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select pg_sleep(3);
commit;

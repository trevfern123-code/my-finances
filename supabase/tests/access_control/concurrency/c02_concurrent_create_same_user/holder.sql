-- Creates aa's fifth attempt and holds its transaction (and so the per-user lock) open.
begin;
set local role service_role;
select th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select pg_sleep(3);
commit;

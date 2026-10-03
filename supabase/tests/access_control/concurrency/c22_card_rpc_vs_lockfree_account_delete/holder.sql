-- The lock-free writer: deletes card account X (cascading to its transaction c22-x). It holds the account
-- row from the delete on; its own version bump comes only after the (paused) cascade.
select set_config('application_name', 'c22-writer', false);
begin;
do $$
begin
  delete from public.accounts where id = '00000000-0000-0000-0000-000000022c02';
  insert into public.th_c22_outcome values ('holder', 'committed');
exception when deadlock_detected then
  insert into public.th_c22_outcome values ('holder', 'deadlock');
end $$;
commit;

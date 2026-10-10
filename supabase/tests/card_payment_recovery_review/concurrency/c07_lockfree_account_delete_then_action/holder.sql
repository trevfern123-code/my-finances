-- The account of w is deleted directly (no advisory lock): its row lock, then the version bump.
begin;
do $$
declare
  v_contender integer;
begin
  perform set_config('role', 'service_role', true);
  delete from public.accounts where id = '00000000-0000-0000-0000-00000001f0e1';
  insert into public.th_c07_outcome values ('holder', 'deleted');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c07-holder', false);
  v_contender := th.wait_for_application('c07-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

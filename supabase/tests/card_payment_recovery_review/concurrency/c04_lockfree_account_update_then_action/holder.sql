-- The account-settings update of card W: its row lock, then the version bump (L2). No advisory lock.
begin;
do $$
declare
  v_contender integer;
begin
  perform set_config('role', 'service_role', true);
  update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-00000001f0e1';
  insert into public.th_c04_outcome values ('holder', 'updated');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c04-holder', false);
  v_contender := th.wait_for_application('c04-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

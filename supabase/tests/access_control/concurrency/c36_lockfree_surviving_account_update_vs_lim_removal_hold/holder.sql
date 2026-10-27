-- The lock-free writer. It takes the row lock its UPDATE takes on the KEPT card's account, and keeps it until it
-- has SEEN the removal finish (bounded: if the removal had to wait for this row, this times out and the test
-- fails). Then it runs its UPDATE, whose trigger bumps the user's version.
begin;
do $$
declare
  v_deadline timestamptz := clock_timestamp() + interval '60 seconds';
  v_status text;
begin
  perform set_config('role', 'service_role', true);
  perform 1 from public.accounts where id = '00000000-0000-0000-0000-000000036c03' for no key update;
  if not found then raise exception 'fixture: the kept card account row was not locked'; end if;
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c36-holder', false);
  perform set_config('role', 'service_role', true);
  loop
    -- READ COMMITTED: every statement of this block sees what has committed since.
    select r.status into v_status from public.plaid_item_removals r where r.item_id = '00000000-0000-0000-0000-000000000001';
    exit when v_status = 'cleaned';
    if clock_timestamp() > v_deadline then
      raise exception 'COORDINATION TIMEOUT: the removal did not complete while a lock-free writer held the kept card account row (status %)', v_status;
    end if;
    perform pg_sleep(0.02);
  end loop;
  insert into public.th_c36_outcome values ('holder-saw', 'removal_completed_while_the_row_was_held');
  update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-000000036c03';
  insert into public.th_c36_outcome values ('holder', 'updated');
end $$;
commit;

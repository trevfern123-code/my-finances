-- The edit must wait for the lock, then find the row gone and raise transaction_not_found (never
-- write to a dead row, never silently succeed).
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
begin
  begin
    perform public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000cd1', '00000000-0000-0000-0000-000000000cc1');
    raise exception 'ASSERTION FAILED: the edit of a row the posting deleted should have raised transaction_not_found';
  exception when others then
    if sqlerrm not like 'transaction_not_found:%' then raise; end if;
  end;
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'the edit waited on the posting lock');
end
$$;

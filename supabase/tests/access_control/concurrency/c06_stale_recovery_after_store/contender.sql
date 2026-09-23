-- A recovery call arriving at the same moment waits, then sees the committed completion: it must
-- report completed, never overwrite it with exchange_unknown.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v_result text;
begin
  select outcome into v_result from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c006', '00000000-0000-0000-0000-0000000000aa', 'sid-a');
  perform th.assert(v_result = 'completed', format('recovery sees the stored item (got %s)', v_result));
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'contender actually waited on the holder''s row lock');
end
$$;

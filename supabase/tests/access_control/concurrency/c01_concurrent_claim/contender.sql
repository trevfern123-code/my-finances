-- A duplicate/concurrent completion call started while the holder's claim is uncommitted: it blocks
-- on the row lock and then — once the holder commits — finds the attempt already completing. Two
-- completion calls can never both be allowed to exchange.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v_result text;
begin
  select outcome into v_result from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a');
  perform th.assert(v_result = 'in_progress', format('contender is told another call is completing (got %s)', v_result));
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'contender actually waited on the holder''s row lock');
end
$$;

-- Meanwhile the slow original exchange finally returns and tries to store its item: it waits on the
-- row lock, then finds the attempt no longer exchanging — so it stores NOTHING (and the backend then
-- compensates at Plaid). An attempt can never end up both exchange_unknown and holding an item.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v_stored boolean;
begin
  v_stored := public.store_plaid_link_item('00000000-0000-0000-0000-00000000c005', '00000000-0000-0000-0000-0000000000aa', 'sid-a',
    '00000000-0000-0000-0000-0000000c0c05', '00000000-0000-0000-0000-00000000c5c5', 'harness-item-c05',
    'Y2lwaGVy', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1::smallint);
  perform th.assert(not v_stored, 'the late store is refused');
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'contender actually waited on the holder''s row lock');
end
$$;

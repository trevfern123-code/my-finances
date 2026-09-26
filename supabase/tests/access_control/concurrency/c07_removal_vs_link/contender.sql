-- Cleanup waits for the link to commit, then must restore it: the restored set is the linked set at
-- cleanup time, read under the same lock.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v jsonb;
begin
  v := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'cleanup waited on the holder''s lock');
  perform th.assert((v->'loan_adjustments'->0->>'restored')::numeric = 100, format('cleanup restored the late link (got %s)', v));
end
$$;

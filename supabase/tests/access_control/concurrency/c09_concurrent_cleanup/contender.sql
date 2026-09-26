set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v jsonb;
begin
  v := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'the second cleanup waited');
  perform th.assert((v->>'replayed')::boolean, 'the second cleanup replays the recorded result');
  perform th.assert((v->'loan_adjustments'->0->>'restored')::numeric = 100, 'with the same adjustments');
end
$$;

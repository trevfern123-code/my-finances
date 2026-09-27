set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  n integer;
begin
  n := public.backfill_category_mapping('00000000-0000-0000-0000-0000000000aa', 'FOOD_AND_DRINK', '00000000-0000-0000-0000-000000000cc2');
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'the backfill waited on the posting lock');
  perform th.assert(n = 1, format('exactly the posted row was filled (got %s)', n));
end
$$;

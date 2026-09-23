-- Started while the holder's transaction is still open: blocks on the row lock, then — once the
-- holder commits — finds the attempt already spent. Two concurrent exchanges can never both win.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v_result text;
begin
  v_result := public.consume_plaid_link_attempt('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a');
  perform th.assert(v_result = 'invalid', format('contender finds the attempt already consumed (got %s)', v_result));
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'contender actually waited on the holder''s row lock');
end
$$;

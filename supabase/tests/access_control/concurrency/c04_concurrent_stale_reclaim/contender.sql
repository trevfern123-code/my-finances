-- A second recovering call at the same moment: it waits on the row lock, then finds a FRESH claim
-- (the holder's) and must not take it over — two recoveries can never both proceed to exchange.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
  v_result text;
begin
  select outcome into v_result from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-0000000000aa', 'sid-a');
  perform th.assert(v_result = 'in_progress', format('contender sees the holder''s fresh claim (got %s)', v_result));
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'contender actually waited on the holder''s row lock');
end
$$;

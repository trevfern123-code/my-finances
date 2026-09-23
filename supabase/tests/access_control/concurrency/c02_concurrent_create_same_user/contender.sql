-- A simultaneous create for the SAME user, started while the holder is still open: it must wait
-- for the holder to commit, then see its row — so it trims one old attempt instead of making six.
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
begin
  perform public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'contender waited on the holder''s per-user lock');
end
$$;

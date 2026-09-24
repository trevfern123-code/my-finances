-- A simultaneous create for a DIFFERENT user is not serialized behind aa, and its sweep neither
-- waits for nor contends with the holder's: it skips (the holder's sweep already did the work).
set role service_role;
do $$
declare
  t0 timestamptz := clock_timestamp();
begin
  perform th.new_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b');
  perform th.assert(public.purge_expired_plaid_link_attempts(100) = 0, 'a sweep while another is in progress skips at once');
  perform th.assert(clock_timestamp() - t0 < interval '1 second', 'contender for another user did not wait');
end
$$;

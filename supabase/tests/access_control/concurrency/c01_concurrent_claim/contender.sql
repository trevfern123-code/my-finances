-- A duplicate/concurrent completion call started while the holder's claim is uncommitted: it blocks
-- on the row lock and then — once the holder commits — finds the attempt already completing. Two
-- completion calls can never both be allowed to exchange.
-- It starts only once the holder has announced its uncommitted claim. The holder, in turn, commits only
-- after observing THIS session blocked on it, so the overlap is established rather than assumed from
-- elapsed time.
select th.wait_for_application('c01-holder-claimed');
select set_config('application_name', 'c01-contender', false);
set role service_role;
do $$
declare
  v_result text;
begin
  select outcome into v_result from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a');
  perform th.assert(v_result = 'in_progress', format('contender is told another call is completing (got %s)', v_result));
end
$$;

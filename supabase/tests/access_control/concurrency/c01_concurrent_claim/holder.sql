-- The first completion call claims the attempt and holds its transaction open until it has OBSERVED the
-- duplicate call blocked on the claimed row's lock (bounded coordination; no sleep). Only then does it
-- commit. If the duplicate never blocks on this session, the wait raises COORDINATION TIMEOUT with a
-- snapshot of every session, this transaction aborts, and the test fails.
begin;
set local role service_role;
select th.assert((select outcome from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a')) = 'claimed',
  'holder claims the attempt');
reset role;
select set_config('application_name', 'c01-holder-claimed', false);
select th.wait_until_blocked_by(th.wait_for_application('c01-contender'), pg_backend_pid());
commit;

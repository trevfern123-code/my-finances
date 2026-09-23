-- The first completion call claims the attempt and holds its transaction open, so a duplicate
-- completion call arriving meanwhile must wait on the claimed row's lock.
begin;
set local role service_role;
select th.assert((select outcome from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a')) = 'claimed',
  'holder claims the attempt');
select pg_sleep(3);
commit;

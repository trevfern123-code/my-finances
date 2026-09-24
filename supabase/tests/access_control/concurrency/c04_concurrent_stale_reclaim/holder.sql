-- The first recovering call re-claims the stale claim and holds its transaction open.
begin;
set local role service_role;
select th.assert((select outcome from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-0000000000aa', 'sid-a')) = 'claimed',
  'holder re-claims the stale claim');
select pg_sleep(3);
commit;

-- A recovery call records the stale exchange as exchange_unknown and holds its transaction open.
begin;
set local role service_role;
select th.assert((select outcome from public.claim_plaid_link_attempt('00000000-0000-0000-0000-00000000c005', '00000000-0000-0000-0000-0000000000aa', 'sid-a')) = 'exchange_unknown',
  'recovery records the stale exchange as exchange_unknown');
select pg_sleep(3);
commit;

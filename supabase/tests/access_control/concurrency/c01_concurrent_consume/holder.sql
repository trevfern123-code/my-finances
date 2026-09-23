-- Consumes the attempt and holds its transaction open, so the contender's consume must wait on the
-- deleted row's lock.
begin;
set local role service_role;
select th.assert(public.consume_plaid_link_attempt('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'consumed',
  'holder consumes the attempt');
select pg_sleep(3);
commit;

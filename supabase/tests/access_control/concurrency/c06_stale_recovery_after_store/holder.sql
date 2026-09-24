-- The slow original exchange stores its item first and holds the transaction open.
begin;
set local role service_role;
select th.assert(public.store_plaid_link_item('00000000-0000-0000-0000-00000000c006', '00000000-0000-0000-0000-0000000000aa', 'sid-a',
    '00000000-0000-0000-0000-0000000c0c06', '00000000-0000-0000-0000-00000000c6c6', 'harness-item-c06',
    'Y2lwaGVy', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1::smallint), 'the original exchange stores its item');
select pg_sleep(3);
commit;

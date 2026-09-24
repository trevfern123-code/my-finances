set role service_role;
select pg_sleep(1.5);
select th.expect_error($q$
  select public.confirm_transfer_pair('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000ab01',
    '00000000-0000-0000-0000-00000000ab02', 'transfer_like_unconfirmed', 3, 1::smallint)
$q$, '%best current candidate is no longer row_b%');

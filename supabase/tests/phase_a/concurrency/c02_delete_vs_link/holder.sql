set role service_role;
begin;
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000f5',
  '00000000-0000-0000-0000-0000000000d8', 10, 1::smallint);
select pg_sleep(4);
commit;

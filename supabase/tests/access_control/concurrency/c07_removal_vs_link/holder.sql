-- A sync already running when removal began auto-links T1 (it takes the per-user lock and holds it).
set role service_role;
begin;
select th.assert(public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1',
  '00000000-0000-0000-0000-0000000007b1', 100, 1::smallint) = 'linked', 'holder links T1 (L1 1000 -> 900)');
select pg_sleep(3);
commit;

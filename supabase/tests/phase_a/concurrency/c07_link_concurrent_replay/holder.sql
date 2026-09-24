-- The first caller links T and holds its transaction (and the per-user advisory lock) open.
-- (`::text` and the assertion after COMMIT keep this runnable against the pre-repair function too,
-- which returns void, so FOLLOWUP_MIGRATIONS="" shows the defect's end state.)
set role service_role;
begin;
create temporary table holder_outcome as
  select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007e1',
    '00000000-0000-0000-0000-0000000007d1', 100, 1::smallint)::text as outcome;
select pg_sleep(4);
commit;
select th.assert((select outcome from holder_outcome) = 'linked', 'holder links T to L');

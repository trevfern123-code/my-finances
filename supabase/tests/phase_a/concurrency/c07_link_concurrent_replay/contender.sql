-- The second caller, working from the same stale "unlinked" candidate list, waits on the lock and
-- then must see T already linked: an exact replay, with no second decrement.
-- (Committed before asserting, as in holder.sql.)
set role service_role;
select pg_sleep(1.5);
create temporary table started as select clock_timestamp() as at;
create temporary table contender_outcome as
  select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007e1',
    '00000000-0000-0000-0000-0000000007d1', 100, 1::smallint)::text as outcome, clock_timestamp() as at;
select th.assert((select c.at - s.at > interval '1 second' from contender_outcome c, started s), 'contender actually waited for the holder');
select th.assert(outcome = 'already_linked', format('contender sees an exact replay (got %s)', outcome)) from contender_outcome;

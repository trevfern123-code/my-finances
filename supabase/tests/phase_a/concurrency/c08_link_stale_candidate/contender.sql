-- The second caller's candidate is stale: once the lock is free, T already belongs to L1. Nothing may
-- move the link or decrement L2.
-- (Committed before asserting, as in holder.sql.)
set role service_role;
select pg_sleep(1.5);
create temporary table started as select clock_timestamp() as at;
create temporary table contender_outcome as
  select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000008e1',
    '00000000-0000-0000-0000-0000000008d2', 100, 1::smallint)::text as outcome, clock_timestamp() as at;
select th.assert((select c.at - s.at > interval '1 second' from contender_outcome c, started s), 'contender actually waited for the holder');
select th.assert(outcome = 'linked_to_other_loan', format('contender sees the stale candidate (got %s)', outcome)) from contender_outcome;

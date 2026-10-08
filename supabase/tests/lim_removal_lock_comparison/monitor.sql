-- A third session that only watches: which of the two sessions waited for the other, and on what kind of
-- lock (pg_blocking_pids, sampled every 20 ms until both sessions have recorded their outcome). It is the
-- record of the waits, not what establishes the overlap (writer.sql does that).
--   * A wait that is part of a cycle lasts until PostgreSQL's deadlock check (a second or more): always seen.
--   * The removal's wait for the writer's row, when no cycle forms, ends within a few milliseconds and can
--     fall between two samples. writer.sql therefore records that wait itself, at its barrier.
\set ON_ERROR_STOP 1
select set_config('application_name', 'lc-monitor', false);
do $$
declare
  v_deadline timestamptz := clock_timestamp() + interval '120 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    insert into public.th_lc_waits (waiter, blocker, wait_event)
    select case when w.application_name = 'lc-removal' then 'removal' else 'writer' end,
           case when b.application_name = 'lc-removal' then 'removal' else 'writer' end,
           coalesce(w.wait_event_type || '/' || w.wait_event, 'unknown')
    from pg_stat_activity w
    cross join lateral unnest(pg_blocking_pids(w.pid)) as bp(pid)
    join pg_stat_activity b on b.pid = bp.pid
    where w.application_name in ('lc-removal', 'lc-writer', 'lc-writer-holding')
      and b.application_name in ('lc-removal', 'lc-writer', 'lc-writer-holding')
    on conflict do nothing;
    exit when (select count(*) from public.th_lc_outcome) = 2;
    if clock_timestamp() > v_deadline then
      raise exception 'the two sessions did not both finish within 120 s; sessions:%', E'\n  ' || th.session_snapshot();
    end if;
    perform pg_sleep(0.02);
  end loop;
end $$;

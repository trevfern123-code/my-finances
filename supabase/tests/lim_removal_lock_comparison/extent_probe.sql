-- The probing session of the lock-extent probe (run.sh). psql variable: body = the timestamp of the migration
-- that installed the body under test.
--
-- While the removal's transaction is open and its function has returned (extent_removal.sql), this session
-- asks for four rows FOR UPDATE NOWAIT — the lock a deletion of the row takes, which conflicts with every row
-- lock, the KEY SHARE of a foreign-key check included — and records for each whether it was free:
--   user row          the user's auth.users row;
--   earlier removal   the ledger row of the user's EARLIER, cleaned removal (it has no generation row);
--   this removal      the ledger row of the removal that is running: locked under every body (a control);
--   another user      the auth.users row of a user who is not involved: free under every body (a control).
-- It prints them as one EXTENT line, which run.sh compares with what is documented for each body. NOWAIT, so
-- nothing here can wait for, or deadlock with, the removal.
\set ON_ERROR_STOP 1
select :'body' = '20261008120000' as records_provenance \gset
select th.assert(:'body' in ('20260926120000', '20261006120000', '20261008120000'), 'the body under test is one this file knows');
select set_config('application_name', 'lx-probe', false);
select th.wait_for_application('lx-removed');

create function pg_temp.probe(p_what text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into public.th_lx_probe values (p_what, 'free');
  exception when lock_not_available then
    insert into public.th_lx_probe values (p_what, 'locked');
  end;
end $$;
select pg_temp.probe('user row', $q$ select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000aa' for update nowait $q$);
select pg_temp.probe('earlier removal', $q$ select 1 from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000003' for update nowait $q$);
select pg_temp.probe('this removal', $q$ select 1 from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000001' for update nowait $q$);
select pg_temp.probe('another user', $q$ select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000bb' for update nowait $q$);

-- Let the removal commit, and wait until its session is gone.
select set_config('application_name', 'lx-probed', false);
do $$
declare
  v_deadline timestamptz := clock_timestamp() + interval '30 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when not exists (select 1 from pg_stat_activity a where a.application_name = 'lx-removed');
    if clock_timestamp() > v_deadline then
      raise exception 'the removal did not finish within 30 s; sessions:%', E'\n  ' || th.session_snapshot();
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

select th.assert((select count(*) from public.th_lx_probe) = 4, 'the four rows were probed');
select th.assert((select outcome from public.th_lx_probe where what = 'this removal') = 'locked'
                 and (select outcome from public.th_lx_probe where what = 'another user') = 'free',
  'the probe is live: it finds the lock that is certainly held, and none where certainly none is');
select th.assert(not exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000001')
                 and (select status = 'cleaned' from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000001')
                 and not exists (select 1 from public.card_payment_decisions),
  'the removal then committed: the item is gone, the operation is cleaned, and it wrote no decision');
\if :records_provenance
-- The two generation rows are what took the two locks: the marker of the earlier removal, first in the user's
-- order, and this removal's own. No decision was written, so there is no source row.
select th.assert((select string_agg(g.ordinal || ':' || r.plaid_item_id || ':' || case when g.sources_recorded then 'recorded' else 'marker' end, ', ' order by g.ordinal)
                  from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
                  where g.user_id = '00000000-0000-0000-0000-0000000000aa') = '1:harness-item-a3:marker, 2:harness-item-a:recorded'
                 and (select count(*) from public.card_payment_removal_generations) = 2
                 and (select count(*) from public.card_payment_removal_sources) = 0,
  'the removal marked the earlier removal and recorded its own generation after it; no source row');
\else
select th.assert(to_regclass('public.card_payment_removal_generations') is null and to_regclass('public.card_payment_removal_sources') is null,
  'this body is measured without the provenance tables: the migration that creates them is not applied yet');
\endif

\pset tuples_only on
\pset format unaligned
select 'EXTENT user_row=' || (select outcome from public.th_lx_probe where what = 'user row')
       || ' earlier_removal=' || (select outcome from public.th_lx_probe where what = 'earlier removal')
       || ' this_removal=' || (select outcome from public.th_lx_probe where what = 'this removal')
       || ' another_user=' || (select outcome from public.th_lx_probe where what = 'another user');

-- Session-growth check for the per-user coalescing marker. run.sh runs it once per mode with
-- psql -v mode=final|baseline, each time in ONE long-lived session (as a pooled connection would be).
-- Synthetic users only; disposable database only.
--
-- It bumps 20,000 distinct users, each in its own committed transaction, and measures:
--   * the backend's GUC memory context (GUCMemoryContext) and all its memory contexts, after 100, 1,000,
--     5,000 and 20,000 distinct users;
--   * whether a marker's VALUE survives its transaction (it must not: is_local);
--   * whether the setting NAME (placeholder) survives (it does, for the backend's lifetime);
--   * whether bumping the same users again grows anything;
--   * whether RESET ALL / DISCARD ALL release the placeholders.
-- The baseline body sets no marker, so its run is the control for every other per-session cache.
set client_min_messages = warning;
select bench.use(:'mode') \g /dev/null
insert into auth.users (id, email)
select ('00000000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid, 'growth-' || g || '@example.test' from generate_series(1, 20000) g
on conflict (id) do nothing;
insert into public.card_payment_eval_versions (user_id)
select ('00000000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid from generate_series(1, 20000) g on conflict (user_id) do nothing;
create or replace procedure bench.bump_users(p_from integer, p_to integer) language plpgsql as $b$
begin
  for g in p_from .. p_to loop
    perform public.card_payment_bump(('00000000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid);
    commit;
  end loop;
end $b$;
create temporary table growth (step text, distinct_users integer, guc_bytes bigint, all_bytes bigint, ms double precision, bumps integer);
create function pg_temp.mem(p_step text, p_users integer, p_ms double precision, p_bumps integer) returns void language sql as $$
  insert into pg_temp.growth
  select p_step, p_users, coalesce(sum(total_bytes) filter (where name = 'GUCMemoryContext'), 0), sum(total_bytes), p_ms, p_bumps
  from pg_backend_memory_contexts $$;
-- The marker for growth user n: its quoted value, or <no such setting> when no placeholder exists.
create function pg_temp.marker(p_user integer) returns text language sql as $$
  select coalesce(quote_literal(current_setting('card_payment.bumped_'
                    || replace('00000000-0000-0000-0001-' || lpad(to_hex(p_user), 12, '0'), '-', ''), true)), '<no such setting>') $$;
select pg_temp.mem('start', 0, null, 0);

select extract(epoch from clock_timestamp()) as t0 \gset
call bench.bump_users(1, 100);
select pg_temp.mem('distinct users', 100, (extract(epoch from clock_timestamp()) - :t0) * 1000, 100);
select extract(epoch from clock_timestamp()) as t0 \gset
call bench.bump_users(101, 1000);
select pg_temp.mem('distinct users', 1000, (extract(epoch from clock_timestamp()) - :t0) * 1000, 900);
select extract(epoch from clock_timestamp()) as t0 \gset
call bench.bump_users(1001, 5000);
select pg_temp.mem('distinct users', 5000, (extract(epoch from clock_timestamp()) - :t0) * 1000, 4000);
select extract(epoch from clock_timestamp()) as t0 \gset
call bench.bump_users(5001, 20000);
select pg_temp.mem('distinct users', 20000, (extract(epoch from clock_timestamp()) - :t0) * 1000, 15000);
-- The same 20,000 users again: no new names.
select extract(epoch from clock_timestamp()) as t0 \gset
call bench.bump_users(1, 20000);
select pg_temp.mem('same users again', 20000, (extract(epoch from clock_timestamp()) - :t0) * 1000, 20000);
select pg_temp.marker(1) as marker_user_1_after_commit, pg_temp.marker(20001) as marker_never_bumped_user \gset
reset all;
select pg_temp.mem('after RESET ALL', 20000, null, 0);
select pg_temp.marker(1) as marker_user_1_after_reset_all \gset

\echo
\echo '--- session growth, mode' :mode
select step, distinct_users, guc_bytes,
       guc_bytes - (select guc_bytes from pg_temp.growth where step = 'start') as guc_growth_bytes,
       round((guc_bytes - (select guc_bytes from pg_temp.growth where step = 'start'))::numeric / nullif(distinct_users, 0), 1) as guc_bytes_per_user,
       all_bytes, all_bytes - (select all_bytes from pg_temp.growth where step = 'start') as all_growth_bytes,
       round((ms * 1000 / nullif(bumps, 0))::numeric, 1) as us_per_committed_bump
from pg_temp.growth order by distinct_users, step desc;
\echo 'user 1 marker after its transaction committed:' :marker_user_1_after_commit
\echo 'never-bumped user (no placeholder):' :marker_never_bumped_user
\echo 'user 1 marker after RESET ALL:' :marker_user_1_after_reset_all
discard all;
select 'after DISCARD ALL: GUCMemoryContext ' || coalesce(sum(total_bytes) filter (where name = 'GUCMemoryContext'), 0)
       || ' bytes; all memory contexts ' || sum(total_bytes) || ' bytes; user 1 marker '
       || coalesce(quote_literal(current_setting('card_payment.bumped_00000000000000000001000000000001', true)), '<no such setting>') as after_discard_all
from pg_backend_memory_contexts;

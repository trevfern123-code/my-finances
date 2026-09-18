# The migration gets its locks FIRST (and holds them, as any real run does, until it commits).
# Writers arriving during that window must wait — none can write between the gate's clean check and
# the constraints being installed — and once it commits, an invalid write is rejected by the new
# constraints while a valid one succeeds.
set -euo pipefail
. "$HERE/gate/lib.sh"

# Same statements the explicit model runs, plus a hold before COMMIT so the window is observable.
{ echo 'begin;'; cat "$MIGRATION"; printf '\nselect pg_sleep(4);\ncommit;\n'; } \
  | psql_db >"$LOGS/g04.migration.log" 2>&1 &
migration=$!

for _ in $(seq 1 100); do
  held="$(psql_db -At -c "select count(distinct relation) from pg_locks where mode = 'AccessExclusiveLock' and granted
                          and relation in ('public.manual_loans'::regclass, 'public.manual_loan_payments'::regclass,
                                           'public.transactions'::regclass)" </dev/null 2>/dev/null || echo 0)"
  [ "$held" -ge 3 ] && break
  sleep 0.1
done
[ "$held" -ge 3 ] || fail "migration never held its three locks"
echo "migration holds AccessExclusiveLock on all three tables and has not committed"

psql_db >"$LOGS/g04.invalid.log" 2>&1 <<'SQL' &
select clock_timestamp() as started \gset
select th.expect_error(
  $q$insert into public.manual_loans (user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000000aa', 'late violator', -9)$q$,
  '%manual_loans_current_balance_check%');
select th.assert(clock_timestamp() - :'started'::timestamptz > interval '1 second', 'invalid writer did not wait for the migration');
SQL
invalid=$!

psql_db >"$LOGS/g04.valid.log" 2>&1 <<'SQL' &
select clock_timestamp() as started \gset
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-000000000ee1', '00000000-0000-0000-0000-0000000000aa', 'late valid loan', 25);
select th.assert(clock_timestamp() - :'started'::timestamptz > interval '1 second', 'valid writer did not wait for the migration');
SQL
valid=$!

wait "$migration" || { cat "$LOGS/g04.migration.log"; fail "migration failed"; }
wait "$invalid" || { cat "$LOGS/g04.invalid.log"; fail "invalid writer was not blocked-then-rejected"; }
wait "$valid" || { cat "$LOGS/g04.valid.log"; fail "valid writer was not blocked-then-accepted"; }

migration_is_applied || fail "migration not applied"
psql_db -At -c "select count(*) from public.manual_loans where name = 'late violator'" </dev/null | grep -qx 0 || fail "violating row was written"
psql_db -At -c "select count(*) from public.manual_loans where id = '00000000-0000-0000-0000-000000000ee1'" </dev/null | grep -qx 1 || fail "valid row missing"
echo "both writers waited for the commit; the invalid one was then rejected by the new constraint, the valid one written"

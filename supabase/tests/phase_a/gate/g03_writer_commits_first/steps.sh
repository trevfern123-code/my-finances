# A concurrent writer that gets in FIRST: it inserts a violating row and is still in its transaction
# when the migration starts. The migration's LOCK must wait for it, and the gate must then see the
# committed row and refuse — the row cannot slip in between "checked clean" and "constraints on".
set -euo pipefail
. "$HERE/gate/lib.sh"

schema_before="$(schema_fingerprint)"

psql_db >"$LOGS/g03.writer.log" 2>&1 <<'SQL' &
begin;
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-000000000dd0', '00000000-0000-0000-0000-0000000000aa', 'racing violator', -7);
select pg_sleep(3);
commit;
SQL
writer=$!

# Deterministic ordering: do not start the migration until the writer verifiably holds its lock.
for _ in $(seq 1 100); do
  held="$(psql_db -At -c "select count(*) from pg_locks where relation = 'public.manual_loans'::regclass
                          and mode = 'RowExclusiveLock' and granted and pid <> pg_backend_pid()" </dev/null)"
  [ "$held" -ge 1 ] && break
  sleep 0.1
done
[ "$held" -ge 1 ] || fail "writer never took its lock"
echo "writer holds RowExclusiveLock on manual_loans with an uncommitted violating row"

start=$(date +%s%N)
if out="$(apply_migration "$MIGRATION" explicit 2>&1)"; then
  wait "$writer"
  fail "migration applied although a violating row was committed before its check"
fi
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
wait "$writer" || { cat "$LOGS/g03.writer.log"; fail "writer failed"; }

echo "$out" | grep -E "ERROR|manual_loans_current_balance_check" | head -3
echo "$out" | grep -q "manual_loans_current_balance_check: 1 row(s)" || fail "gate did not report the racing row"
[ "$elapsed_ms" -ge 1000 ] || fail "migration did not wait for the writer (${elapsed_ms} ms)"
[ "$(schema_fingerprint)" = "$schema_before" ] || fail "schema changed after the refused migration"
migration_is_applied && fail "migration partially applied"
psql_db -At -c "select count(*) from public.manual_loans where id = '00000000-0000-0000-0000-000000000dd0'" </dev/null | grep -qx 1 \
  || fail "the writer's row is missing"
echo "migration waited ${elapsed_ms} ms for the writer, then saw its row and rolled back; schema unchanged"

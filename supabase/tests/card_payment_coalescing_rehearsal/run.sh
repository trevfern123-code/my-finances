#!/usr/bin/env bash
# Upgrade / rollback / re-apply rehearsal for 20261002120000_card_payment_bump_coalescing.sql. Nothing here
# touches any real database: one throwaway container of Supabase's PostgreSQL 17 image. Not run in CI.
#
#   supabase/tests/card_payment_coalescing_rehearsal/run.sh
#
#   1. Build the supported baseline: every migration before 20261002120000, each in one transaction, as
#      postgres. Then build matching state on it (baseline.sql): a fresh user, a stale user, a
#      never-evaluated user, and a saved decision.
#   2. Upgrade. The migration file is applied exactly as the harness applies every migration. Meanwhile one
#      transaction that bumped under the OLD body stays open, and writes again under the NEW body after the
#      upgrade commits (straddle_upgrade.sql).
#   3. upgraded.sql:
#      * no row of any card-payment table, or of transactions/accounts, changed;
#      * freshness is exactly as before;
#      * the straddling transaction left its user stale and complete;
#      * coalescing is active; evaluation and a decision RPC work.
#   4. Roll back with supabase/rollback/20261002120000_card_payment_bump_coalescing_rollback.sql. Meanwhile
#      a transaction that bumped under the NEW body writes again under the OLD body
#      (straddle_rollback.sql).
#   5. rolled_back.sql:
#      * the bodies are the 20260930120000 ones, byte for byte (checksums);
#      * no data changed by the rollback;
#      * per-row bumps are back; the straddler is stale and complete.
#   6. Re-apply the migration file (its guard accepts the restored bodies). reapplied.sql: coalescing again,
#      data unchanged.
#
# Requires: docker, bash, GNU timeout (coreutils).
#   PG_IMAGE=<image>   default public.ecr.aws/supabase/postgres:17.6.1.155
#   KEEP=1             leave the container running afterwards
#   PSQL_TIMEOUT=s     default 300
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required to bound database waits"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-coalescing-rehearsal-$$"
MIGRATION="$ROOT/supabase/migrations/20261002120000_card_payment_bump_coalescing.sql"
ROLLBACK="$ROOT/supabase/rollback/20261002120000_card_payment_bump_coalescing_rollback.sql"
LOGS="$(mktemp -d)"
cleanup() { if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi; rm -rf "$LOGS"; }
trap cleanup EXIT
PSQL_TIMEOUT="${PSQL_TIMEOUT:-300}"
bounded() { timeout "$PSQL_TIMEOUT" "$@"; local rc=$?; [ "$rc" -eq 124 ] && echo "TIMEOUT: exceeded ${PSQL_TIMEOUT}s" >&2; return "$rc"; }
psql_db() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
psql_admin() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; }
step() { # $1 = label, then a command; prints PASS/FAIL and the transcript on failure
  local label="$1"; shift
  if "$@" >"$LOGS/step.log" 2>&1; then echo "PASS  $label"; else echo "FAIL  $label"; sed 's/^/      | /' "$LOGS/step.log"; exit 1; fi
}

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + 180))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not start"; docker logs --tail 40 "$CONTAINER"; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1; done
sleep 3

apply_baseline() {
  local f
  for f in "$ROOT"/supabase/migrations/*.sql; do
    [ "$f" = "$MIGRATION" ] && continue
    bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" || { echo "migration $(basename "$f") failed"; return 1; }
  done
}
# A migration file: one transaction per file (psql -1), as the harnesses and `supabase db push` apply them.
apply_file() { bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"; }
# The rollback script: its own explicit transaction, run WITHOUT -1, exactly as its header instructs.
apply_script() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"; }
helpers() {
  psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" && psql_admin < "$ROOT/supabase/tests/access_control/helpers.sql" \
    && psql_admin < "$ROOT/supabase/tests/access_control/seed.sql"
}
# Runs a straddling session in the background around a transition ($2 = the file to apply in between).
straddle() { # $1 = session script, $2 = file to apply, $3 = signal name, $4 = applier (apply_file or apply_script)
  psql_db < "$HERE/$1" >"$LOGS/straddle.log" 2>&1 &
  local pid=$!
  psql_db -c "select th.wait_for_application('rehearsal-straddler-open')" >/dev/null || { kill "$pid"; cat "$LOGS/straddle.log"; return 1; }
  "$4" "$2" || { kill "$pid"; return 1; }
  psql_db -c "insert into rehearsal.signal values ('$3')" || { kill "$pid"; return 1; }
  wait "$pid" || { cat "$LOGS/straddle.log"; return 1; }
}

step "baseline: every migration before 20261002120000" apply_baseline
step "helpers and seed" helpers
step "baseline: matching state built and snapshotted" psql_db -f - < "$HERE/baseline.sql"
step "upgrade: migration applied while a transaction straddles it" straddle straddle_upgrade.sql "$MIGRATION" migrated apply_file
step "upgraded: data unchanged, freshness preserved, coalescing active" psql_db -f - < "$HERE/upgraded.sql"
step "rollback: rollback script applied while a transaction straddles it" straddle straddle_rollback.sql "$ROLLBACK" rolled_back apply_script
step "rolled back: baseline bodies restored exactly, data unchanged, per-row bumps" psql_db -f - < "$HERE/rolled_back.sql"
step "re-apply: migration file applied again" apply_file "$MIGRATION"
step "re-applied: coalescing again, data unchanged" psql_db -f - < "$HERE/reapplied.sql"
# Evidence that every phase ran to its end: six snapshots and both transition signals.
evidence() {
  [ "$(psql_db -At -c "select (select count(distinct label) from rehearsal.snap) || '/' || (select string_agg(s, ',' order by s) from rehearsal.signal)")" = "6/migrated,rolled_back" ]
}
step "evidence: all six snapshots taken, both transitions signalled" evidence
echo
echo "rehearsal passed"

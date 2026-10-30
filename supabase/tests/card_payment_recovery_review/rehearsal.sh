#!/usr/bin/env bash
# Upgrade / rollback / re-apply rehearsal of 20261009120000_card_payment_recovery_review.sql
# (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §10). One throwaway container; every step is a file of rehearsal/ and
# must exit cleanly (an assertion that fails raises).
#
#   s0  the full history is applied to an EMPTY database; the rollback runs with no setting (no obligation
#       exists), leaves no fence, and the database is the 20261008120000 database again
#   s1  under those previous bodies: a removal, then an unrelated transaction — the UNGUARDED pair is published
#       fresh (the exposure); a second user has an ordinary automatic pair
#   s2  the migration is applied to that database: obligations are seeded from what is retained, NO user is
#       readable, refresh work exists for every user; the worker's two calls publish the guarded range
#   s3  the rollback WITHOUT the operator's setting is refused, and changes nothing
#   s4  the rollback WITH the setting: previous bodies, every table and row kept, the affected owner unreadable
#       whatever the previous evaluator publishes, the other user unaffected
#   s5  while rolled back: a removal runs under the previous body (decisions and provenance, no obligation)
#   s6  the migration is applied again: the fence is gone, the removal of s5 is seeded, nothing is duplicated,
#       nobody is readable until evaluated, and then the guard holds
#   s7  applying it a second time on top of itself is refused by its guard
#
# Requires docker, bash, GNU timeout.   PG_IMAGE, LOGDIR, KEEP, STARTUP_TIMEOUT, PSQL_TIMEOUT: as run.sh.
#   ROLLBACK_FILE=<file>   rehearse another rollback script (mutations.sh passes altered ones, which must FAIL here).
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres@sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b}"
CONTAINER="recovery-review-rehearsal-$$"
LOGS="${LOGDIR:-$(mktemp -d)}"
mkdir -p "$LOGS"
MIGRATION="$ROOT/supabase/migrations/20261009120000_card_payment_recovery_review.sql"
ROLLBACK="${ROLLBACK_FILE:-$ROOT/supabase/rollback/20261009120000_card_payment_recovery_review_rollback.sql}"

trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$CONTAINER" >/dev/null 2>&1' EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-600}"
psql_as() { local role="$1"; shift; timeout "$PSQL_TIMEOUT" docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$role" -d postgres "$@"; }

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + STARTUP_TIMEOUT))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not start"; docker logs --tail 40 "$CONTAINER" 2>&1; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3

FAILED=0
step() {  # step <name> <description> <command...>   — the command reads no stdin unless it redirects it itself
  local name="$1" what="$2"; shift 2
  if "$@" >"$LOGS/$name.log" 2>&1; then
    echo "PASS  $name  $what"
  else
    echo "FAIL  $name  $what"
    grep -E 'ERROR|ASSERTION FAILED|TIMEOUT' "$LOGS/$name.log" | head -8 | sed 's/^/      | /'
    FAILED=$((FAILED + 1))
  fi
}
apply_file() { psql_as postgres -1 < "$1"; }
apply_file_with_setting() { { echo "set card_payment.recovery_review_rollback = 'fence_affected_owners';"; cat "$1"; } | psql_as postgres -1; }
# A file that MUST be refused, with a message containing the pattern.
refused() {
  local file="$1" pattern="$2" out
  out="$(psql_as postgres -1 < "$file" 2>&1)" && { echo "it was applied, but must be refused"; return 1; }
  echo "$out" | grep -q -- "$pattern" || { echo "refused, but not with: $pattern"; echo "$out" | tail -5; return 1; }
  echo "refused as expected: $(echo "$out" | grep -m1 ERROR)"
}
sql() { psql_as postgres < "$HERE/rehearsal/$1"; }

apply_history() {
  local f
  for f in "$ROOT"/supabase/migrations/*.sql; do
    psql_as postgres -1 < "$f" || { echo "FAILED to apply $(basename "$f")"; return 1; }
  done
}
load_helpers() {
  psql_as supabase_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" &&
  psql_as supabase_admin < "$ROOT/supabase/tests/access_control/helpers.sql" &&
  psql_as supabase_admin < "$HERE/helpers.sql" &&
  psql_as supabase_admin < "$ROOT/supabase/tests/access_control/seed.sql"
}

step s0a "the full migration history applies to an empty database" apply_history
step s0b "helpers and the two seed users" load_helpers
step s0c "rollback with no review obligation: no setting needed" apply_file "$ROLLBACK"
step s0d "after it: the previous bodies, no fence, every table kept" sql s0_rolled_back_empty.sql
step s1 "previous bodies: a removal, then an unrelated transaction pairs automatically" sql s1_history_under_previous_bodies.sql
step s2a "the migration applies to a database with history" apply_file "$MIGRATION"
step s2b "seeded, nobody readable, refresh work for everyone; then the guarded range" sql s2_upgraded.sql
step s3a "rollback WITHOUT the operator's setting is refused" refused "$ROLLBACK" "review obligations exist"
step s3b "and it changed nothing" sql s3_refusal_changed_nothing.sql
step s4a "rollback WITH the operator's setting" apply_file_with_setting "$ROLLBACK"
step s4b "previous bodies, rows kept, the affected owner unreadable, the other user unaffected" sql s4_rolled_back_fenced.sql
step s5 "while rolled back: a removal under the previous body" sql s5_removal_while_rolled_back.sql
step s6a "the migration applies again" apply_file "$MIGRATION"
step s6b "fence gone, the interval's removal seeded, nothing duplicated, the guard holds" sql s6_reapplied.sql
step s7 "applying it again on top of itself is refused by its guard" refused "$MIGRATION" "refusing to replace it"

echo
if [ "$FAILED" -gt 0 ]; then echo "$FAILED step(s) failed   (transcripts: $LOGS)"; exit 1; fi
echo "all rehearsal steps passed   (transcripts: $LOGS)"

#!/usr/bin/env bash
# Validates the DRAFT read-only audit supabase/preflight/phase_b_card_payment_matching_audit.sql against
# synthetic rows (seed.sql) in a THROWAWAY container of Supabase's PostgreSQL 17 image. Nothing here
# touches any real database. The seed dates are relative to current_date, so expected.out is stable.
#
#   supabase/tests/card_payment_audit/run.sh            compare with expected.out
#   UPDATE=1 supabase/tests/card_payment_audit/run.sh   rewrite expected.out (review the diff!)
#
# Requires: docker, bash.  PG_IMAGE=<image> overrides the image.
#   STARTUP_TIMEOUT=s  fail if the database does not accept connections within s seconds (default 180)
#   PSQL_TIMEOUT=s     fail any single psql run that exceeds s seconds (default 600)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-audit-$$"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1' EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-600}"
# Runs a command under PSQL_TIMEOUT and reports a timeout.
bounded() {
  timeout "$PSQL_TIMEOUT" "$@"
  local rc=$?
  [ "$rc" -eq 124 ] && echo "TIMEOUT: exceeded ${PSQL_TIMEOUT}s (PSQL_TIMEOUT)" >&2
  return "$rc"
}
# Waits for the database, bounded; exits with the container's recent logs if it stops or times out.
wait_for_database() {
  local deadline=$((SECONDS + STARTUP_TIMEOUT))
  until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
      echo "FAILED: the database container stopped during startup. Last log lines:"; docker logs --tail 40 "$CONTAINER" 2>&1; exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "FAILED: the database did not accept connections within ${STARTUP_TIMEOUT}s. Last log lines:"; docker logs --tail 40 "$CONTAINER" 2>&1; exit 1
    fi
    sleep 1
  done
}

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
wait_for_database
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3

for f in "$ROOT"/supabase/migrations/*.sql; do
  bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >/dev/null 2>&1 \
    || { echo "FAILED to apply migration $(basename "$f")"; exit 1; }
done
bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$HERE/seed.sql" >/dev/null 2>&1 \
  || { echo "FAILED to seed"; exit 1; }

# The audit runs in a read-only session: any write in it would fail the run.
ACTUAL="$(bounded docker exec -i "$CONTAINER" psql -X -q -A -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "set default_transaction_read_only = on" -f - < "$ROOT/supabase/preflight/phase_b_card_payment_matching_audit.sql")" \
  || { echo "FAILED: the audit did not run"; exit 1; }

# Named regression rows (design §9), checked before the full comparison so a failure says which case.
check() { printf '%s
' "$ACTUAL" | grep -qxF "$2" || { echo "FAIL  $1: expected row missing: $2"; exit 1; }; }
check "R1 NULL account type is the cash side"   "sandbox_institution_id|cash_side|payment|projected|predicted|confirmed_tracked_pair_5d|4|1|1|2210.00|-2210.00|0.00|0.00|0.00|0.00"
check "R7 excluded card closer: confirmed difference, zero exposure"   "sandbox_institution_id|cash_side|payment|current|stored|confirmed_untracked_partner_excluded_5d|1|1|0|100.00|-100.00|0.00|-100.00|-100.00|0.00"
check "R6 payment to an excluded card is not exposure"   "sandbox_institution_id|cash_side|payment|projected|predicted|confirmed_untracked_partner_excluded_5d|1|1|0|500.00|-500.00|-500.00|-500.00|0.00|0.00"
if [ "${UPDATE:-0}" = 1 ]; then printf '%s\n' "$ACTUAL" > "$HERE/expected.out"; echo "expected.out rewritten"; exit 0; fi
if diff --strip-trailing-cr <(printf '%s\n' "$ACTUAL") "$HERE/expected.out"; then echo "PASS  card-payment audit buckets"; else echo "FAIL  (diff above)"; exit 1; fi

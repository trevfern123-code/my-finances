#!/usr/bin/env bash
# Oracle equivalence for the card-payment SQL evaluator (Phase B slice 2a; design §3.8): the SQL
# evaluate_card_payments must produce EXACTLY what the TypeScript reference evaluator
# (backend/src/services/cardPaymentMatching.ts) produces, on the Stage 2 generated histories
# (backend/src/testUtils/cardPaymentHistories.ts, seeds 1000–1299, two users each).
#
# Nothing here touches any real database: a throwaway container of Supabase's PostgreSQL 17 image gets
# the repository's migration history, then each generated history is loaded (as supabase_admin),
# evaluated and read back as service_role, and compared with the oracle.
#
#   supabase/tests/card_payment_evaluator/run.sh
#
# Requires: docker, bash, node, and backend dependencies installed (for tsc).
#   PG_IMAGE=<image>   default public.ecr.aws/supabase/postgres:17.6.1.155
#   KEEP=1             leave the container and the scratch directory
#   STARTUP_TIMEOUT=s  fail if the database does not accept connections within s seconds (default 180)
#   PSQL_TIMEOUT=s     fail any single psql run that exceeds s seconds (default 600)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-evaluator-$$"
WORK="$(mktemp -d)"
cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$WORK"; else echo "kept: $CONTAINER $WORK"; fi
}
trap cleanup EXIT
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

# 1. Compile the generator and the reference evaluator (test-only code; not part of the backend build).
(cd "$ROOT/backend" && npx tsc --outDir "$WORK/compiled" --rootDir src --module commonjs --target es2022 \
  --strict --skipLibCheck src/testUtils/cardPaymentHistories.ts) || { echo "FAILED to compile the generator"; exit 1; }
node "$HERE/export.cjs" "$WORK/compiled" "$WORK" || { echo "FAILED to export fixtures"; exit 1; }

# 2. A throwaway database with the repository's migration history.
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
wait_for_database
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
for f in "$ROOT"/supabase/migrations/*.sql; do
  bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >"$WORK/migrate.log" 2>&1 \
    || { echo "FAILED to apply migration $(basename "$f")"; tail -20 "$WORK/migrate.log"; exit 1; }
done
echo "migration history applied"

# 3. Load, evaluate and read every generated history; 4. compare with the oracle.
bounded docker exec -i "$CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$WORK/seed.sql" >"$WORK/actual.txt" 2>"$WORK/psql.err" \
  || { echo "FAILED while evaluating:"; tail -20 "$WORK/psql.err"; exit 1; }
node "$HERE/compare.cjs" "$WORK/expected.json" "$WORK/actual.txt"

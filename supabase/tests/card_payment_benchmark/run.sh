#!/usr/bin/env bash
# Phase B packet 2b-2a performance measurements — synthetic data in a THROWAWAY database only. Nothing
# here touches any real database. Not a pass/fail test and not run in CI: it prints timings to report
# (PHASE_B_MATCHING_ENGINE_HANDOFF.md §10). See bench.cjs for what is measured and how.
#
#   supabase/tests/card_payment_benchmark/run.sh [samples] [warmups]     (defaults 6 and 1)
#
# Requires: docker, bash, GNU timeout (coreutils), node.
#   PG_IMAGE=<image>   default public.ecr.aws/supabase/postgres:17.6.1.155
#   KEEP=1             leave the container running afterwards
#   STARTUP_TIMEOUT=s  default 180;  PSQL_TIMEOUT=s  default 3600 (the whole benchmark is one psql run)
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required to bound database waits"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-benchmark-$$"
WORK="$(mktemp -d)"
cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$WORK"; else echo "kept: $CONTAINER $WORK"; fi
}
trap cleanup EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-3600}"
bounded() {
  timeout "$PSQL_TIMEOUT" "$@"
  local rc=$?
  [ "$rc" -eq 124 ] && echo "TIMEOUT: exceeded ${PSQL_TIMEOUT}s (PSQL_TIMEOUT)" >&2
  return "$rc"
}
wait_for_database() {
  local deadline=$((SECONDS + STARTUP_TIMEOUT))
  until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
      echo "FAILED: the database container stopped during startup. Last log lines:"; docker logs --tail 40 "$CONTAINER" 2>&1; exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "FAILED: the database did not accept connections within ${STARTUP_TIMEOUT}s"; docker logs --tail 40 "$CONTAINER" 2>&1; exit 1
    fi
    sleep 1
  done
}

node "$HERE/bench.cjs" "${1:-6}" "${2:-1}" >"$WORK/bench.sql" || { echo "FAILED to generate the benchmark script"; exit 1; }
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
echo "environment: image $IMAGE; server $(docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc 'show server_version'); docker $(docker info --format '{{.ServerVersion}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes memory, {{.OperatingSystem}}')"
echo "settings: $(docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select string_agg(name || '=' || setting, ' ') from pg_settings where name in ('shared_buffers','synchronous_commit','fsync','work_mem')")"
echo "samples per configuration: ${1:-6} measured after ${2:-1} warm-up"
bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -v bench_disposable=1 -U supabase_admin -d postgres < "$WORK/bench.sql" 2>"$WORK/psql.err" \
  || { echo "FAILED while benchmarking:"; tail -20 "$WORK/psql.err"; exit 1; }

#!/usr/bin/env bash
# Bump-coalescing PERFORMANCE comparison and session-growth check (20261002120000). Synthetic data in a
# THROWAWAY database only; nothing here touches any real database. Not a pass/fail test and not run in CI.
#
# The container gets every migration BEFORE 20261002120000 (the supported baseline). Then:
#   * perf.sql (from perf.cjs) applies the real 20261002120000 file itself and times baseline vs final (see
#     perf.cjs);
#   * growth.sql measures, on one long-lived session, what the transaction-local per-user marker leaves
#     behind as more distinct users are bumped (final vs baseline);
#   * a fresh session is measured for comparison.
#
#   supabase/tests/card_payment_benchmark/coalescing/run.sh [samples] [warmups]     (defaults 6 and 1)
#   BENCH_CASES=<section,...>   limit the timing run to those sections (see perf.cjs)
#   GROWTH=0                    skip the session-growth check
#
# Requires: docker, bash, GNU timeout (coreutils), node.
#   PG_IMAGE=<image>   default public.ecr.aws/supabase/postgres:17.6.1.155
#   KEEP=1             leave the container running afterwards
#   STARTUP_TIMEOUT=s  default 180;  PSQL_TIMEOUT=s  default 5400 (each psql run)
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required to bound database waits"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-coalescing-bench-$$"
WORK="$(mktemp -d)"
cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$WORK"; else echo "kept: $CONTAINER $WORK"; fi
}
trap cleanup EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-5400}"
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

node "$HERE/perf.cjs" "${1:-6}" "${2:-1}" >"$WORK/perf.sql" || { echo "FAILED to generate the benchmark script"; exit 1; }
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
wait_for_database
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
for f in "$ROOT"/supabase/migrations/*.sql; do
  [ "$(basename "$f")" = 20261002120000_card_payment_bump_coalescing.sql ] && continue  # perf.sql applies it
  bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >"$WORK/migrate.log" 2>&1 \
    || { echo "FAILED to apply migration $(basename "$f")"; tail -20 "$WORK/migrate.log"; exit 1; }
done
echo "environment: image $IMAGE; server $(docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc 'show server_version'); docker $(docker info --format '{{.ServerVersion}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes memory, {{.OperatingSystem}}')"
echo "settings: $(docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select string_agg(name || '=' || setting, ' ') from pg_settings where name in ('shared_buffers','synchronous_commit','fsync','work_mem')")"
echo "samples per configuration: ${1:-6} measured after ${2:-1} warm-up${BENCH_CASES:+; sections: $BENCH_CASES}"
bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -v bench_disposable=1 -U supabase_admin -d postgres < "$WORK/perf.sql" 2>"$WORK/psql.err" \
  || { echo "FAILED during the timing run:"; tail -20 "$WORK/psql.err"; exit 1; }

if [ "${GROWTH:-1}" = 1 ]; then
  echo
  echo "=== session growth: one long-lived session per mode, then a fresh session"
  for mode in final baseline; do
    bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -v mode="$mode" -U supabase_admin -d postgres < "$HERE/growth.sql" 2>"$WORK/growth.err" \
      || { echo "FAILED during the growth check ($mode):"; tail -20 "$WORK/growth.err"; exit 1; }
  done
  bounded docker exec -i "$CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$HERE/fresh_session.sql" 2>"$WORK/growth.err" \
    || { echo "FAILED measuring a fresh session:"; tail -20 "$WORK/growth.err"; exit 1; }
fi

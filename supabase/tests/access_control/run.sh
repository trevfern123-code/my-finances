#!/usr/bin/env bash
# Access-control harness for the Wave 1 remediation migrations. Nothing here touches any real
# database: every run uses a throwaway container of Supabase's own PostgreSQL 17 image (the real
# anon/authenticated/service_role roles, auth schema, auth.uid() and platform default privileges).
#
#   supabase/tests/access_control/run.sh           run every test
#   supabase/tests/access_control/run.sh a01       run only tests whose name starts with a prefix
#
# It applies the repository's ACTUAL migration history, in filename order, each file in one
# transaction as the non-superuser `postgres` role (as `supabase db push` connects), seeds two users
# with placeholder (non-secret) Plaid rows, then runs every sql/*.sql test — each must exit cleanly;
# assertions raise on failure — and every concurrency/<name>/ test (seed.sql, then holder.sql in the
# background, contender.sql one second later, then verify.sql). Queries run under `set role authenticated` + `request.jwt.claims`,
# which is exactly how PostgREST executes a request made with the anon key and a user's JWT.
#
# Requires: docker, bash.
#   PG_IMAGE=<image>   override the image (default public.ecr.aws/supabase/postgres:17.6.1.155)
#   EXCLUDE=<file>     skip one migration by basename — e.g. the one under test, to watch its tests
#                      fail against the schema it was written to fix
#   KEEP=1             leave the container running afterwards
#   VERBOSE=1          print every test's transcript, not just failing ones
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="access-control-harness-$$"
LOGS="$(mktemp -d)"

cleanup_container() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi
}
trap cleanup_container EXIT

psql_db() {
  docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
# supabase_admin owns auth.users.
psql_admin() {
  docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"
}

FILTERS=("$@")
wanted() {
  local name="$1" f
  [ "${#FILTERS[@]}" -eq 0 ] && return 0
  for f in "${FILTERS[@]}"; do
    case "$name" in "$f"*) return 0 ;; esac
  done
  return 1
}

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || exit 1
until docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do sleep 1; done
# Supabase's image finishes its own role/extension setup shortly after it first accepts connections.
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
echo "server: $(psql_db -At -c 'show server_version' </dev/null)"

for f in "$ROOT"/supabase/migrations/*.sql; do  # glob order is sorted, and safe with spaces in paths
  if [ -n "${EXCLUDE:-}" ] && [ "$(basename "$f")" = "$EXCLUDE" ]; then echo "skipping $EXCLUDE (EXCLUDE)"; continue; fi
  if ! docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >>"$LOGS/history.log" 2>&1; then
    echo "FAILED to apply migration $(basename "$f"):"; tail -20 "$LOGS/history.log"; exit 1
  fi
done
echo "repository migration history applied (as postgres, one transaction per file)"

psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" >"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
psql_admin < "$HERE/helpers.sql" >>"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }

PASSED=0
FAILED=0
FAILED_NAMES=()
for file in "$HERE"/sql/*.sql; do
  name="$(basename "$file" .sql)"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  # Fresh data per test: a test may commit writes (e.g. consuming a link attempt).
  if psql_admin < "$HERE/seed.sql" >"$log" 2>&1 && psql_db < "$file" >>"$log" 2>&1; then
    echo "PASS  $name"
    if [ "${VERBOSE:-0}" = 1 ]; then sed 's/^/      | /' "$log"; fi
    PASSED=$((PASSED + 1))
  else
    echo "FAIL  $name"
    sed 's/^/      | /' "$log"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
done

for dir in "$HERE"/concurrency/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  status=0
  psql_admin < "$HERE/seed.sql" >"$log" 2>&1 && psql_db < "$dir/seed.sql" >>"$log" 2>&1 || status=1
  if [ "$status" -eq 0 ]; then
    psql_db < "$dir/holder.sql" >"$LOGS/$name.holder.log" 2>&1 &
    holder_pid=$!
    sleep 1  # let the holder take its row lock first
    psql_db < "$dir/contender.sql" >"$LOGS/$name.contender.log" 2>&1 || status=1
    wait "$holder_pid" || status=1
    { echo "--- holder"; cat "$LOGS/$name.holder.log"; echo "--- contender"; cat "$LOGS/$name.contender.log"; } >>"$log"
    if [ "$status" -eq 0 ]; then psql_db < "$dir/verify.sql" >>"$log" 2>&1 || status=1; fi
  fi
  if [ "$status" -eq 0 ]; then
    echo "PASS  $name"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL  $name"
    sed 's/^/      | /' "$log"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
done

echo
echo "$PASSED passed, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi

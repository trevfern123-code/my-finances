#!/usr/bin/env bash
# Adversarial PostgreSQL harness for supabase/migrations/20260912120000_transaction_semantic_roles.sql.
#
# Starts a throwaway PostgreSQL container, and for EVERY test resets the schema and applies
# scaffold.sql + the real migration + seed.sql from scratch, so tests cannot leak state into each
# other. Nothing here touches any real database.
#
#   supabase/tests/phase_a/run.sh               run everything
#   supabase/tests/phase_a/run.sh c03 t04       run only tests whose name starts with a prefix
#
# Test kinds:
#   sql/<name>.sql           single session; must exit cleanly (assertions raise on failure)
#   concurrency/<name>/      two sessions: holder.sql runs in the background while contender.sql
#                            runs, then verify.sql; OR a custom steps.sh when the test needs
#                            orchestration between sessions (e.g. running the real TypeScript
#                            classifier between reads).
#
# Requires: docker, bash, node. Tests that call the real classifier build the backend first
# (npm --prefix backend run build) unless SKIP_BUILD=1.
#
# Environment:
#   MIGRATION=<path>   migration to test (default: the Phase A migration). Point it at an older
#                      revision, e.g. `git show <sha>:<path> > /tmp/old.sql`, to watch the
#                      regression tests fail against the code they were written to catch.
#   PG_IMAGE=<image>   default postgres:15
#   KEEP=1             leave the container running afterwards
#   VERBOSE=1          print every test's transcript, not just failing ones
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="${MIGRATION:-$ROOT/supabase/migrations/20260912120000_transaction_semantic_roles.sql}"
IMAGE="${PG_IMAGE:-postgres:15}"
CONTAINER="phase-a-harness-$$"
LOGS="$(mktemp -d)"
export HERE ROOT CONTAINER LOGS

cleanup_container() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi
}
trap cleanup_container EXIT

# psql against the harness database. SQL comes from stdin (or -c); ON_ERROR_STOP makes any failed
# statement — including a failed th.assert/th.expect_error — a non-zero exit.
psql_db() {
  docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
export -f psql_db

reset_db() {
  psql_db -c "drop schema if exists public cascade; drop schema if exists th cascade; create schema public;" </dev/null >"$LOGS/reset.log" 2>&1 \
    && psql_db < "$HERE/scaffold.sql" >"$LOGS/scaffold.log" 2>&1 \
    && psql_db < "$MIGRATION" >"$LOGS/migration.log" 2>&1 \
    && psql_db < "$HERE/seed.sql" >"$LOGS/seed.log" 2>&1
}

wanted() {
  local name="$1"
  [ "${#FILTERS[@]}" -eq 0 ] && return 0
  local f
  for f in "${FILTERS[@]}"; do
    case "$name" in "$f"*) return 0 ;; esac
  done
  return 1
}

FILTERS=("$@")

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "building backend (for the real classifier)..."
  npm --prefix "$ROOT/backend" run build >"$LOGS/build.log" 2>&1 || { cat "$LOGS/build.log"; exit 1; }
fi

echo "starting $IMAGE as $CONTAINER..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || exit 1
# The image's entrypoint runs a temporary server during initialization and then restarts it, so wait
# for initialization to finish before trusting pg_isready.
until docker logs "$CONTAINER" 2>&1 | grep -q "PostgreSQL init process complete"; do sleep 1; done
until docker exec "$CONTAINER" pg_isready -U postgres -q; do sleep 1; done
echo "server: $(psql_db -At -c 'show server_version' </dev/null)"

if ! reset_db; then
  echo "FAILED to apply scaffold/migration/seed:"
  cat "$LOGS"/reset.log "$LOGS"/scaffold.log "$LOGS"/migration.log "$LOGS"/seed.log 2>/dev/null
  exit 1
fi
echo "migration applies cleanly: $MIGRATION"

PASSED=0
FAILED=0
FAILED_NAMES=()

report() {
  local name="$1" status="$2" log="$3"
  if [ "$status" -eq 0 ]; then
    echo "PASS  $name"
    if [ "${VERBOSE:-0}" = 1 ]; then sed 's/^/      | /' "$log"; fi
    PASSED=$((PASSED + 1))
  else
    echo "FAIL  $name"
    sed 's/^/      | /' "$log"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
}

for file in "$HERE"/sql/*.sql; do
  name="$(basename "$file" .sql)"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  if reset_db; then
    psql_db < "$file" >"$log" 2>&1
    report "$name" $? "$log"
  else
    cp "$LOGS/migration.log" "$log"
    report "$name" 1 "$log"
  fi
done

for dir in "$HERE"/concurrency/*/; do
  name="$(basename "$dir")"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  : >"$log"
  if ! reset_db; then
    cp "$LOGS/migration.log" "$log"
    report "$name" 1 "$log"
    continue
  fi
  status=0
  if [ -f "$dir/seed.sql" ]; then
    psql_db < "$dir/seed.sql" >>"$log" 2>&1 || status=1
  fi
  if [ "$status" -eq 0 ]; then
    if [ -f "$dir/steps.sh" ]; then
      TEST_DIR="$dir" bash "$dir/steps.sh" >>"$log" 2>&1 || status=1
    else
      psql_db < "$dir/holder.sql" >"$LOGS/$name.holder.log" 2>&1 &
      holder_pid=$!
      psql_db < "$dir/contender.sql" >"$LOGS/$name.contender.log" 2>&1 || status=1
      wait "$holder_pid" || status=1
      { echo "--- holder"; cat "$LOGS/$name.holder.log"; echo "--- contender"; cat "$LOGS/$name.contender.log"; } >>"$log"
      if [ "$status" -eq 0 ]; then
        echo "--- verify" >>"$log"
        psql_db < "$dir/verify.sql" >>"$log" 2>&1 || status=1
      fi
    fi
  fi
  report "$name" "$status" "$log"
done

echo
echo "$PASSED passed, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi

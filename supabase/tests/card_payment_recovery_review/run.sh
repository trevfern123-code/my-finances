#!/usr/bin/env bash
# Packet 2-A harness: guarded manual recovery after an institution removal
# (20261009120000_card_payment_recovery_review.sql; PHASE_B_I3A_R_PACKET_2A_REVIEW.md).
#
#   supabase/tests/card_payment_recovery_review/run.sh           every sql/ and concurrency/ test
#   supabase/tests/card_payment_recovery_review/run.sh r01 c02   only tests whose name starts with a prefix
#
# Nothing here touches a real database. Every run starts ONE throwaway container of Supabase's PostgreSQL image,
# applies the repository's migration history in filename order (each file in one transaction, as the
# non-superuser `postgres` role), loads the assertion helpers and this harness's fixture helpers, and then:
#   * sql/<name>.sql          seeded fresh (access_control/seed.sql), run as postgres; an assertion that fails raises;
#   * concurrency/<name>/     seed.sql, then holder.sql in the background, contender.sql one second later, verify.sql.
# It removes its own container on exit and nothing else.
#
# Requires: docker, bash, GNU timeout (coreutils).
#   PG_IMAGE=<image>     the database image. Default: the digest the CI workflow pins for the Supabase suites.
#   MIGRATIONS=<dir>     apply the *.sql of this directory instead of supabase/migrations (the mutation controls
#                        pass a copy in which the newest migration is altered).
#   EXCLUDE=<file>...    skip migrations by basename (separated by spaces or commas).
#   LOGDIR=<dir>         keep every transcript there (default: a temporary directory).
#   REFERENCE=0          do not compare with the TypeScript reference evaluator (the runner says so). By default,
#                        after every passing sql test the rows and the published states are exported, and at the
#                        end backend/src/services/cardPaymentMatching.ts is compiled and must agree with all of them.
#   KEEP=1               leave the container running afterwards.
#   VERBOSE=1            print every test's transcript, not only failing ones.
#   STARTUP_TIMEOUT=s    fail if the database does not accept connections within s seconds (default 180).
#   PSQL_TIMEOUT=s       fail any single psql run that exceeds s seconds (default 600); the transcript says TIMEOUT.
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required to bound database waits"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres@sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b}"
MIGRATIONS_DIR="${MIGRATIONS:-$ROOT/supabase/migrations}"
CONTAINER="recovery-review-harness-$$"
LOGS="${LOGDIR:-$(mktemp -d)}"
mkdir -p "$LOGS"

cleanup_container() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi
}
trap cleanup_container EXIT

STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-600}"
bounded() {
  timeout "$PSQL_TIMEOUT" "$@"
  local rc=$?
  [ "$rc" -eq 124 ] && echo "TIMEOUT: exceeded ${PSQL_TIMEOUT}s (PSQL_TIMEOUT)" >&2
  return "$rc"
}
psql_db() {
  bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
psql_admin() {
  bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"
}
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

FILTERS=("$@")
wanted() {
  local name="$1" f
  [ "${#FILTERS[@]}" -eq 0 ] && return 0
  for f in "${FILTERS[@]}"; do
    case "$name" in "$f"*) return 0 ;; esac
  done
  return 1
}

echo "image: $IMAGE   container: $CONTAINER   migrations: $MIGRATIONS_DIR"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
wait_for_database
# Supabase's image finishes its own role/extension setup shortly after it first accepts connections.
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
echo "server: $(psql_db -At -c 'show server_version' </dev/null)"

EXCLUDED="${EXCLUDE:-}"
EXCLUDED="${EXCLUDED//,/ }"
excluded() {
  local name="$1" e
  for e in $EXCLUDED; do [ "$name" = "$e" ] && return 0; done
  return 1
}
for f in "$MIGRATIONS_DIR"/*.sql; do
  if excluded "$(basename "$f")"; then echo "skipping $(basename "$f") (EXCLUDE)"; continue; fi
  if ! bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >>"$LOGS/history.log" 2>&1; then
    echo "FAILED to apply migration $(basename "$f"):"; tail -20 "$LOGS/history.log"; exit 1
  fi
done
echo "migration history applied (as postgres, one transaction per file)"

psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" >"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
psql_admin < "$ROOT/supabase/tests/access_control/helpers.sql" >>"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
psql_admin < "$HERE/helpers.sql" >>"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
SEED="$ROOT/supabase/tests/access_control/seed.sql"

PASSED=0
FAILED=0
FAILED_NAMES=()
for file in "$HERE"/sql/*.sql; do
  [ -f "$file" ] || continue
  name="$(basename "$file" .sql)"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  if psql_admin < "$SEED" >"$log" 2>&1 && psql_db < "$file" >>"$log" 2>&1; then
    echo "PASS  $name"
    if [ "${REFERENCE:-1}" != 0 ]; then
      psql_db -v test="$name" < "$HERE/reference/export.sql" >>"$LOGS/reference.txt" 2>>"$LOGS/reference.err" \
        || { echo "FAIL  $name (the reference export failed)"; tail -3 "$LOGS/reference.err" | sed 's/^/      | /'; FAILED=$((FAILED + 1)); FAILED_NAMES+=("$name:reference-export"); }
    fi
    if [ "${VERBOSE:-0}" = 1 ]; then sed 's/^/      | /' "$log"; fi
    PASSED=$((PASSED + 1))
  else
    echo "FAIL  $name"
    grep -E 'ERROR|ASSERTION FAILED|TIMEOUT|CONTEXT' "$log" | head -12 | sed 's/^/      | /'
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
  psql_admin < "$SEED" >"$log" 2>&1 && psql_db < "$dir/seed.sql" >>"$log" 2>&1 || status=1
  if [ "$status" -eq 0 ]; then
    psql_db < "$dir/holder.sql" >"$LOGS/$name.holder.log" 2>&1 &
    holder_pid=$!
    sleep 1  # let the holder take its locks first
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
    grep -E 'ERROR|ASSERTION FAILED|TIMEOUT|CONTEXT' "$log" | head -12 | sed 's/^/      | /'
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
done

# The SQL evaluator against the TypeScript reference evaluator, on every state the sql tests left behind.
if [ "${REFERENCE:-1}" = 0 ]; then
  echo "NOT RUN  reference comparison (REFERENCE=0)"
elif [ ! -s "$LOGS/reference.txt" ]; then
  echo "NOT RUN  reference comparison (no sql test passed, so nothing was exported)"
else
  WORK="$(mktemp -d)"
  if (cd "$ROOT/backend" && npx tsc --outDir "$WORK/compiled" --rootDir src --module commonjs --target es2022 \
        --strict --skipLibCheck src/services/cardPaymentMatching.ts) >"$LOGS/reference-compile.log" 2>&1 \
     && node "$HERE/reference/compare.cjs" "$WORK/compiled" "$LOGS/reference.txt" 1 >"$LOGS/reference-compare.log" 2>&1; then
    echo "PASS  reference  $(tail -1 "$LOGS/reference-compare.log")"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL  reference"
    { cat "$LOGS/reference-compile.log"; cat "$LOGS/reference-compare.log" 2>/dev/null; } | tail -25 | sed 's/^/      | /'
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("reference")
  fi
  rm -rf "$WORK"
fi

echo
echo "$PASSED passed, $FAILED failed   (transcripts: $LOGS)"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi
if [ "$PASSED" -eq 0 ]; then
  echo "FAILED: no test matched"; exit 1
fi

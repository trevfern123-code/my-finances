#!/usr/bin/env bash
# Adversarial PostgreSQL harness for supabase/migrations/20260912120000_transaction_semantic_roles.sql
# and the later `*_manual_loan_*` migrations that repair its functions (FOLLOWUP_MIGRATIONS below).
# Nothing here touches any real database: every run uses a throwaway container.
#
#   supabase/tests/phase_a/run.sh               run everything (scaffold mode)
#   supabase/tests/phase_a/run.sh c03 t04 g0    run only tests whose name starts with a prefix
#   PHASE_A_BASE=history supabase/tests/phase_a/run.sh
#
# Modes (PHASE_A_BASE):
#   scaffold (default)  Image postgres:17 (production's major version, per supabase/config.toml).
#                       Before EVERY test, rebuilds public from scaffold.sql — a hand-written subset
#                       of the base schema carrying the real project's default privileges — plus
#                       seed.sql, and applies the migration unless the test needs the pre-migration
#                       state. Runs every test kind, including the gate/ concurrency tests.
#   history             Image public.ecr.aws/supabase/postgres:17.6.1.155 (Supabase's own PostgreSQL
#                       17, with the real anon/authenticated/service_role roles, auth schema and
#                       platform default privileges). Applies the repository's ACTUAL migration
#                       history, each file in one transaction as the non-superuser `postgres` role
#                       (the role `supabase db push` connects as; its pipeline transport is the
#                       `pipeline` model below and supabase/tests/replay). It then checks the gate
#                       once against that authentic schema — refused dirty data under every
#                       transaction model, schema and data unchanged — then applies the candidate.
#                       Finally it runs every sql/ and concurrency/ test, resetting DATA (not schema)
#                       between them. The gate/ tests each need a fresh pre-migration database and
#                       are therefore run in scaffold mode only.
#
# Test kinds:
#   sql/<name>.sql           single session; must exit cleanly (assertions raise on failure)
#   concurrency/<name>/      two sessions: holder.sql in the background, contender.sql, then
#                            verify.sql; OR a custom steps.sh
#   gate/<name>/steps.sh     start from a PRE-migration database and apply the migration themselves
#
# Requires: docker, bash, node. Tests that call the real classifier build the backend first
# (npm --prefix backend run build) unless SKIP_BUILD=1.
#
# Environment:
#   MIGRATION=<path>   migration to test (default: the Phase A migration). Point it at an older
#                      revision, e.g. `git show <sha>:<path> > /tmp/old.sql`, to watch the
#                      regression tests fail against the code they were written to catch.
#   PHASE_A_BASE=...   scaffold (default) or history, as above
#   FOLLOWUP_MIGRATIONS=<basenames>  migrations applied after the candidate (default: every later
#                      `*_manual_loan_*` file). "" tests the candidate alone, e.g. to watch t07/c07/c08
#                      fail without 20260924120000.
#   PG_IMAGE=<image>   override the mode's image
#   KEEP=1             leave the container running afterwards
#   VERBOSE=1          print every test's transcript, not just failing ones
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="${MIGRATION:-$ROOT/supabase/migrations/20260912120000_transaction_semantic_roles.sql}"
BASE="${PHASE_A_BASE:-scaffold}"
case "$BASE" in
  scaffold) IMAGE="${PG_IMAGE:-postgres:17}" ;;
  history)  IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}" ;;
  *) echo "PHASE_A_BASE must be scaffold or history"; exit 2 ;;
esac
CONTAINER="phase-a-harness-$$"
LOGS="$(mktemp -d)"
PHASE_A_BASENAME=20260912120000_transaction_semantic_roles.sql
# Later migrations that repair the candidate's manual-loan functions (applied after it in scaffold
# mode too). Set FOLLOWUP_MIGRATIONS="" to run the tests against the candidate alone.
if [ -z "${FOLLOWUP_MIGRATIONS+set}" ]; then
  FOLLOWUP_MIGRATIONS="$(cd "$ROOT/supabase/migrations" && ls | grep '_manual_loan_' | awk -v a="$PHASE_A_BASENAME" '$0 > a' | tr '\n' ' ')"
fi
export HERE ROOT CONTAINER LOGS MIGRATION BASE PHASE_A_BASENAME FOLLOWUP_MIGRATIONS

cleanup_container() {
  if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi
}
trap cleanup_container EXIT

# psql as `postgres` — the role migrations and tests run as in both modes. SQL comes from stdin (or
# -c); ON_ERROR_STOP makes any failed statement — including a failed th.assert/th.expect_error — a
# non-zero exit.
psql_db() {
  docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
# psql as the superuser (history mode: supabase_admin owns auth.users and the platform objects).
psql_admin() {
  if [ "$BASE" = history ]; then
    docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"
  else
    psql_db "$@"
  fi
}
# Applies a migration file under one of four transaction models:
#   pipeline    what the Supabase CLI (`db push` / `db reset`) actually does: every statement as its
#               own extended-protocol message in ONE pipeline with a single Sync — an implicit
#               transaction that is NOT a "transaction block" (supabase/tests/replay/pipeline-replay.cjs)
#   explicit    BEGIN ... COMMIT around the whole file (psql --single-transaction)
#   implicit    the whole file sent as ONE simple-protocol query, which PostgreSQL runs as a single
#               implicit transaction — the model of a runner that submits a file in one request
#   autocommit  statement by statement, each committed on its own (a runner with no transaction)
node_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
apply_migration() {
  local file="$1" model="${2:-explicit}"
  case "$model" in
    pipeline)
      node "$(node_path "$ROOT/supabase/tests/replay/pipeline-replay.cjs")" --host 127.0.0.1 --port "$PG_PORT" \
        --user postgres --password harness --db postgres --file "$(node_path "$file")" ;;
    explicit) docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file" ;;
    implicit)
      if [ "$(wc -c < "$file")" -gt 130000 ]; then
        echo "apply_migration: $file is too large to pass as one argument; the implicit model needs another transport"
        return 2
      fi
      docker cp "$file" "$CONTAINER:/tmp/phase_a_migration.sql" >/dev/null \
        && docker exec "$CONTAINER" sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$(cat /tmp/phase_a_migration.sql)"' ;;
    autocommit) docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file" ;;
    *) echo "unknown model $model"; return 2 ;;
  esac
}
export -f psql_db psql_admin node_path apply_migration

# --- scaffold mode: rebuild the whole public schema per test ------------------------------------
reset_scaffold() { # $1 = with_migration | pre_migration
  psql_db -c "drop schema if exists public cascade; drop schema if exists th cascade; drop schema if exists supabase_migrations cascade; create schema public;" </dev/null >"$LOGS/reset.log" 2>&1 \
    && psql_db < "$HERE/scaffold.sql" >"$LOGS/scaffold.log" 2>&1 \
    && psql_db < "$HERE/helpers.sql" >"$LOGS/helpers.log" 2>&1 \
    && psql_db < "$HERE/seed.sql" >"$LOGS/seed.log" 2>&1 \
    && if [ "$1" = with_migration ]; then apply_followups_after "$MIGRATION"; fi
}
# The candidate, then the later migrations that repair its manual-loan functions (their names contain
# "_manual_loan_"; the other later migrations need tables the scaffold does not have). History mode
# applies every later migration instead — see below.
apply_followups_after() {
  apply_migration "$1" explicit >"$LOGS/migration.log" 2>&1 || return 1
  local f
  for f in $FOLLOWUP_MIGRATIONS; do
    apply_migration "$ROOT/supabase/migrations/$f" explicit >>"$LOGS/migration.log" 2>&1 || return 1
  done
}

# --- history mode: real migration history once, then reset data only -----------------------------
HISTORY_TRUNCATE="do \$\$ declare r record; begin
  execute 'truncate auth.users cascade';
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('truncate public.%I cascade', r.tablename);
  end loop;
end \$\$;"

reset_history_data() {
  psql_admin -c "$HISTORY_TRUNCATE" </dev/null >"$LOGS/reset.log" 2>&1 \
    && psql_admin < "$HERE/history_seed.sql" >"$LOGS/seed.log" 2>&1
}

reset_for_test() { # $1 = with_migration | pre_migration
  if [ "$BASE" = history ]; then reset_history_data; else reset_scaffold "$1"; fi
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

echo "mode: $BASE   image: $IMAGE   container: $CONTAINER"
# The port is published (loopback only) for the pipeline model's client.
docker run -d --name "$CONTAINER" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || exit 1
PG_PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
export PG_PORT
if [ "$BASE" = scaffold ]; then
  # The official image runs a temporary server during initialization and then restarts it.
  until docker logs "$CONTAINER" 2>&1 | grep -q "PostgreSQL init process complete"; do sleep 1; done
  until docker exec "$CONTAINER" pg_isready -U postgres -q; do sleep 1; done
else
  until docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do sleep 1; done
  # Supabase's image finishes its own role/extension setup shortly after it first accepts connections.
  for _ in $(seq 1 60); do
    [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
    sleep 1
  done
  sleep 3
fi
echo "server: $(psql_db -At -c 'show server_version' </dev/null)"

PASSED=0
FAILED=0
SKIPPED=0
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

if [ "$BASE" = scaffold ]; then
  if ! reset_scaffold with_migration; then
    echo "FAILED to apply scaffold/migration/seed:"
    cat "$LOGS"/reset.log "$LOGS"/scaffold.log "$LOGS"/helpers.log "$LOGS"/seed.log "$LOGS"/migration.log 2>/dev/null
    exit 1
  fi
  echo "migration applies cleanly (explicit transaction): $MIGRATION"
else
  # 1. The repository's real migration history BEFORE the candidate, in version order. (Later files
  #    are applied after the candidate below — applying them first would let the candidate's
  #    CREATE OR REPLACEs overwrite their repairs.)
  for f in "$ROOT"/supabase/migrations/*.sql; do  # glob order is sorted, and safe with spaces in paths
    [ "$(basename "$f")" \< "$PHASE_A_BASENAME" ] || continue
    if ! apply_migration "$f" explicit >>"$LOGS/history.log" 2>&1; then
      echo "FAILED to apply history migration $(basename "$f"):"; tail -20 "$LOGS/history.log"; exit 1
    fi
  done
  echo "repository migration history before the candidate applied (as postgres, one transaction per file)"
  psql_admin < "$HERE/helpers.sql" >"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
  psql_admin < "$HERE/history_seed.sql" >"$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log"; exit 1; }

  # 2. The dirty-data gate against the authentic schema, then the candidate itself.
  log="$LOGS/h00.log"
  ( . "$HERE/gate/lib.sh"
    set -e
    psql_db < "$HERE/gate/dirty_seed.sql" >/dev/null
    schema_before="$(schema_fingerprint)"; data_before="$(data_fingerprint)"
    for model in pipeline explicit implicit autocommit; do
      if apply_migration "$MIGRATION" "$model" >"$LOGS/h00.$model.log" 2>&1; then fail "applied over dirty data ($model)"; fi
      grep -E "Phase A migration aborted|LOCK TABLE can only be used" "$LOGS/h00.$model.log" | head -1
      [ "$(schema_fingerprint)" = "$schema_before" ] || fail "schema changed ($model)"
      [ "$(data_fingerprint)" = "$data_before" ] || fail "data changed ($model)"
      echo "refused, schema and data unchanged ($model)"
    done
    for c in "${ALL_NINE_CONSTRAINTS[@]}"; do grep -q "$c: 1 row(s)" "$LOGS/h00.explicit.log" || fail "gate did not report $c"; done
  ) >"$log" 2>&1
  report "h00_history_dirty_gate" $? "$log"

  # 3. Clean data, then the candidate — kept separate from h00 so that running an OLDER migration
  #    (which has no gate, and so "succeeds" over the dirty rows) still reaches the tests below.
  log="$LOGS/h01.log"
  ( . "$HERE/gate/lib.sh"
    set -e
    psql_db -q -c "delete from public.manual_loan_payments where id::text like '%00d_' or id::text like '%00e_';
                   delete from public.transactions where id::text like '%00d_' or id::text like '%00e_';
                   delete from public.manual_loans where id::text like '%00d_' or id::text like '%00e_';" </dev/null
    if migration_is_applied; then
      echo "candidate was already applied (it did not refuse the dirty data — see h00)"
    else
      apply_migration "$MIGRATION" pipeline >"$LOGS/h01.apply.log" 2>&1 || { cat "$LOGS/h01.apply.log"; fail "clean apply failed"; }
      echo "clean data: candidate applied as the Supabase CLI applies it (one pipeline)"
    fi
    migration_is_applied || fail "candidate not applied"
  ) >"$log" 2>&1
  status=$?
  report "h01_history_clean_apply" $status "$log"
  if [ "$status" -ne 0 ]; then echo; echo "cannot continue without the candidate applied"; exit 1; fi

  # 4. Every later migration, in version order, exactly as the Supabase CLI applies them.
  for f in "$ROOT"/supabase/migrations/*.sql; do
    [ "$(basename "$f")" \> "$PHASE_A_BASENAME" ] || continue
    if ! apply_migration "$f" pipeline >>"$LOGS/history.log" 2>&1; then
      echo "FAILED to apply later migration $(basename "$f"):"; tail -20 "$LOGS/history.log"; exit 1
    fi
  done
  echo "later migrations applied (one CLI pipeline per file)"
fi

for file in "$HERE"/sql/*.sql; do
  name="$(basename "$file" .sql)"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  if reset_for_test with_migration; then
    psql_db < "$file" >"$log" 2>&1
    report "$name" $? "$log"
  else
    cat "$LOGS"/reset.log "$LOGS"/migration.log "$LOGS"/seed.log >"$log" 2>/dev/null
    report "$name" 1 "$log"
  fi
done

for dir in "$HERE"/concurrency/*/; do
  name="$(basename "$dir")"
  wanted "$name" || continue
  log="$LOGS/$name.log"
  : >"$log"
  if ! reset_for_test with_migration; then
    cat "$LOGS"/reset.log "$LOGS"/migration.log "$LOGS"/seed.log >"$log" 2>/dev/null
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
      # Verified even when a session failed, so a regression also shows its end state (e.g. a
      # double decrement), not only the first failed assertion.
      echo "--- verify" >>"$log"
      psql_db < "$dir/verify.sql" >>"$log" 2>&1 || status=1
    fi
  fi
  report "$name" "$status" "$log"
done

for dir in "$HERE"/gate/*/; do
  name="$(basename "$dir")"
  wanted "$name" || continue
  if [ "$BASE" = history ]; then
    echo "SKIP  $name (needs a fresh pre-migration database; see h00 for the history-mode gate check)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  log="$LOGS/$name.log"
  if ! reset_for_test pre_migration; then
    cat "$LOGS"/reset.log "$LOGS"/seed.log >"$log" 2>/dev/null
    report "$name" 1 "$log"
    continue
  fi
  TEST_DIR="$dir" bash "$dir/steps.sh" >"$log" 2>&1
  report "$name" $? "$log"
done

echo
echo "$PASSED passed, $FAILED failed, $SKIPPED skipped"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi

#!/usr/bin/env bash
# Can the tracked migration history be REBUILT through the supported Supabase workflow?
# (Post-audit blocker 3.) Nothing here touches any real database: every check uses a throwaway
# container of Supabase's own PostgreSQL 17 image, and the real CLI only ever runs in a scratch
# working directory that is NOT linked to any project, with an explicit --db-url for `db push`.
#
#   supabase/tests/replay/run.sh                      emulator tier only (no CLI needed)
#   SUPABASE_CLI="npx -y supabase@2.117.0" supabase/tests/replay/run.sh     both tiers
#   SUPABASE_CLI=supabase supabase/tests/replay/run.sh                      (CI: supabase/setup-cli)
#
# Tier 1 — pipeline emulator (pipeline-replay.cjs; applies files exactly as the CLI's ExecBatch does):
#   R1  a clean database replays every migration, one pipeline per file, with no error or WARNING
#   R2  replaying again applies nothing (versions are already recorded)
#   R3  control: the ORIGINAL Phase A file (ORIGINAL_REV, default 367e1a0) fails exactly as the real
#       CLI did during the rollout — proving the emulator reproduces the CLI's transaction model
#   R4  the schema produced by the HISTORICAL path (original Phase A, each file under `psql -1`, as
#       production was built) is identical to the one produced by the CLI-style replay of the
#       corrected files (pg_dump --schema-only, migration ledger excluded)
#   R5  a database in production's state (historical path + ledger rows for every version, stored
#       statements from the ORIGINAL files) replays nothing: no historical migration re-runs and
#       the ledger is byte-for-byte unchanged
# Tier 2 — the real, pinned Supabase CLI (only when SUPABASE_CLI is set):
#   C0  control: the real CLI rejects the ORIGINAL Phase A file (the rollout failure, reproduced)
#   C1  `supabase db push --db-url` on a clean database applies every migration
#   C2  a second `db push` finds nothing to apply
#   C3  `db push` against production's state (as R5) applies nothing and leaves the ledger unchanged
#   C4  the schema after C1 is identical to R4's historical schema
#   C5  `supabase db reset` on a clean local environment (scratch project, db only) rebuilds from
#       the migrations
#
# Requires: docker, bash, node, git.
#   ORIGINAL_REV=<rev>  revision holding the Phase A file as production applied it (default 367e1a0)
#   PG_IMAGE=<image>    default public.ecr.aws/supabase/postgres:17.6.1.155 (production's version)
#   KEEP=1              leave containers running
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
PG_VERSION_TAG="${IMAGE##*:}"
ORIGINAL_REV="${ORIGINAL_REV:-367e1a0}"
PHASE_A=20260912120000_transaction_semantic_roles.sql
WORK="$(mktemp -d)"
PREFIX="replay-harness-$$"
CONTAINERS=()

cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1; done
    if [ -n "${SUPABASE_CLI:-}" ] && [ -d "$WORK/cli-reset" ]; then
      (cd "$WORK/cli-reset" && $SUPABASE_CLI stop --no-backup --workdir . >/dev/null 2>&1)
    fi
  fi
}
trap cleanup EXIT

node_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

# The migrations directory as production applied it: the current files, but the Phase A file taken
# from ORIGINAL_REV (before the CLI-replay correction).
ORIGINAL_DIR="$WORK/original-migrations"
mkdir -p "$ORIGINAL_DIR"
cp "$ROOT"/supabase/migrations/*.sql "$ORIGINAL_DIR/"
git -C "$ROOT" show "$ORIGINAL_REV:supabase/migrations/$PHASE_A" > "$ORIGINAL_DIR/$PHASE_A" || { echo "cannot read $PHASE_A at $ORIGINAL_REV"; exit 2; }
if cmp -s "$ORIGINAL_DIR/$PHASE_A" "$ROOT/supabase/migrations/$PHASE_A"; then
  echo "note: $PHASE_A is unchanged since $ORIGINAL_REV (the original-file checks are then trivial)"
fi

start_db() { # $1 = name suffix; prints the container name and sets PORT_<suffix>
  local name="$PREFIX-$1"
  docker run -d --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || exit 1
  CONTAINERS+=("$name")
  until docker exec "$name" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do sleep 1; done
  for _ in $(seq 1 60); do
    [ "$(docker logs "$name" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
    sleep 1
  done
  sleep 3
}
port_of() { docker port "$PREFIX-$1" 5432/tcp | head -1 | sed 's/.*://'; }
emulate() { # $1 = db suffix, $2 = migrations dir
  node "$(node_path "$HERE/pipeline-replay.cjs")" --host 127.0.0.1 --port "$(port_of "$1")" \
    --user postgres --password harness --db postgres --dir "$(node_path "$2")"
}
# Production's build path: each file in its own explicit transaction as `postgres`.
apply_historically() { # $1 = db suffix, $2 = migrations dir
  local f
  for f in "$2"/*.sql; do
    docker exec -i "$PREFIX-$1" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >>"$WORK/$1.history.log" 2>&1 \
      || { echo "historical apply failed at $(basename "$f")"; tail -5 "$WORK/$1.history.log"; return 1; }
  done
}
# Production's ledger after the manual rollout: a row per version, statements from the ORIGINAL files.
record_ledger() { # $1 = db suffix
  local f v n
  docker exec -i "$PREFIX-$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL' >/dev/null
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;
SQL
  for f in "$ORIGINAL_DIR"/*.sql; do
    v="$(basename "$f" | cut -d_ -f1)"; n="$(basename "$f" .sql | cut -d_ -f2-)"
    docker cp "$f" "$PREFIX-$1:/tmp/ledger.sql" >/dev/null
    docker exec "$PREFIX-$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "insert into supabase_migrations.schema_migrations (version, name, statements)
          values ('$v', '$n', array[pg_read_file('/tmp/ledger.sql')])" >/dev/null 2>&1 \
    || docker exec "$PREFIX-$1" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
      -c "insert into supabase_migrations.schema_migrations (version, name, statements)
          values ('$v', '$n', array[pg_read_file('/tmp/ledger.sql')])" >/dev/null || return 1
  done
}
ledger_digest() { docker exec "$PREFIX-$1" psql -X -At -U postgres -d postgres -c "select md5(string_agg(version || ':' || coalesce(name, '') || ':' || coalesce(array_to_string(statements, '§'), ''), '|' order by version)) || ' / ' || count(*) from supabase_migrations.schema_migrations"; }
schema_dump() { # $1 = container name
  local out="$WORK/$(basename "$1").schema.sql"
  docker exec "$1" pg_dump -U supabase_admin -d postgres --schema-only --exclude-schema=supabase_migrations \
    | grep -vE '^-- Dumped (from|by)|^\\(un)?restrict ' > "$out"
  # An empty or partial dump must never compare "equal": require the objects these migrations create.
  grep -q 'CREATE FUNCTION public.link_transaction_to_manual_loan' "$out" && grep -q 'CREATE TABLE public.plaid_link_attempts' "$out" \
    || { echo "schema dump of $1 is incomplete" >&2; : > "$out.invalid"; }
  echo "$out"
}

PASSED=0
FAILED=0
FAILED_NAMES=()
check() { # $1 = name, $2 = log; runs the rest as the check
  local name="$1" log="$2"; shift 2
  if "$@" >"$log" 2>&1; then echo "PASS  $name"; PASSED=$((PASSED + 1)); [ "${VERBOSE:-0}" = 1 ] && sed 's/^/      | /' "$log"
  else echo "FAIL  $name"; sed 's/^/      | /' "$log"; FAILED=$((FAILED + 1)); FAILED_NAMES+=("$name"); fi
}

echo "image: $IMAGE   original Phase A: $ORIGINAL_REV   cli: ${SUPABASE_CLI:-<not set: emulator tier only>}"
start_db emu; start_db ctl; start_db hist; start_db prod

r1() { emulate emu "$ROOT/supabase/migrations"; }
r2() { out="$(emulate emu "$ROOT/supabase/migrations")" || return 1; echo "$out"; echo "$out" | tail -1 | grep -qx "0 applied"; }
r3() {
  out="$(emulate ctl "$ORIGINAL_DIR")" && { echo "$out"; echo "the original Phase A file replayed — control failed"; return 1; }
  echo "$out"
  echo "$out" | grep -q "FAIL   $PHASE_A: ERROR 25P01: LOCK TABLE can only be used in transaction blocks (at statement 2" \
    || { echo "unexpected failure mode"; return 1; }
  [ "$(docker exec "$PREFIX-ctl" psql -X -At -U postgres -d postgres -c "select to_regclass('public.manual_loan_deletions') is null and not exists (select 1 from supabase_migrations.schema_migrations where version = '20260912120000')")" = t ] \
    || { echo "the failed file left something behind"; return 1; }
  echo "original file refused exactly as the CLI refused it; nothing from it remained"
}
r4() {
  apply_historically hist "$ORIGINAL_DIR" || return 1
  a="$(schema_dump "$PREFIX-hist")"; b="$(schema_dump "$PREFIX-emu")"
  [ ! -e "$a.invalid" ] && [ ! -e "$b.invalid" ] || return 1
  echo "historical: $(wc -l < "$a") lines   CLI-style replay: $(wc -l < "$b") lines"
  diff -u "$a" "$b" && echo "schemas identical"
}
r5() {
  apply_historically prod "$ORIGINAL_DIR" || return 1
  record_ledger prod || return 1
  before_ledger="$(ledger_digest prod)"; before_schema="$(md5sum < "$(schema_dump "$PREFIX-prod")")"
  out="$(emulate prod "$ROOT/supabase/migrations")" || { echo "$out"; return 1; }
  echo "$out"
  echo "$out" | tail -1 | grep -qx "0 applied" || { echo "something was re-applied"; return 1; }
  [ "$(ledger_digest prod)" = "$before_ledger" ] || { echo "ledger changed"; return 1; }
  [ "$(md5sum < "$(schema_dump "$PREFIX-prod")")" = "$before_schema" ] || { echo "schema changed"; return 1; }
  echo "production-state ledger ($before_ledger) and schema unchanged; nothing re-ran"
}
check R1_clean_replay "$WORK/r1.log" r1
check R2_replay_is_idempotent "$WORK/r2.log" r2
check R3_original_phase_a_fails_like_the_cli "$WORK/r3.log" r3
check R4_historical_schema_equals_cli_replay "$WORK/r4.log" r4
check R5_production_ledger_replays_nothing "$WORK/r5.log" r5

if [ -n "${SUPABASE_CLI:-}" ]; then
  # A scratch project: only config.toml (with its own project_id) and the migrations — never the
  # repository's supabase/.temp, which links this checkout to the production project.
  scratch() { # $1 = dir
    mkdir -p "$1/supabase/.temp"
    sed 's/^project_id = .*/project_id = "replay-harness"/' "$ROOT/supabase/config.toml" > "$1/supabase/config.toml"
    cp -r "$ROOT/supabase/migrations" "$1/supabase/migrations"
    echo "$PG_VERSION_TAG" > "$1/supabase/.temp/postgres-version"
  }
  scratch "$WORK/cli"
  cli() { (cd "$WORK/cli" && $SUPABASE_CLI "$@" --workdir .); }
  # Throwaway local containers have no TLS; only ever these loopback URLs are used here.
  url() { echo "postgresql://postgres:harness@127.0.0.1:$(port_of "$1")/postgres?sslmode=disable"; }
  start_db cli; start_db cliprod
  c1() { cli db push --db-url "$(url cli)" --yes && [ "$(docker exec "$PREFIX-cli" psql -X -At -U postgres -d postgres -c 'select count(*) from supabase_migrations.schema_migrations')" = "$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')" ]; }
  c2() { out="$(cli db push --db-url "$(url cli)" --yes 2>&1)"; echo "$out"; echo "$out" | grep -qi "up to date"; }
  c3() {
    apply_historically cliprod "$ORIGINAL_DIR" || return 1
    record_ledger cliprod || return 1
    before="$(ledger_digest cliprod)"
    out="$(cli db push --db-url "$(url cliprod)" --yes 2>&1)"; echo "$out"
    echo "$out" | grep -qi "up to date" || return 1
    [ "$(ledger_digest cliprod)" = "$before" ] && echo "ledger unchanged ($before)"
  }
  c4() { a="$WORK/$PREFIX-hist.schema.sql"; b="$(schema_dump "$PREFIX-cli")"; [ -s "$a" ] && [ ! -e "$a.invalid" ] && [ ! -e "$b.invalid" ] || return 1; diff -u "$a" "$b" && echo "schemas identical ($(wc -l < "$b") lines)"; }
  c5() {
    scratch "$WORK/cli-reset"
    (cd "$WORK/cli-reset" && $SUPABASE_CLI db start --workdir . && $SUPABASE_CLI db reset --workdir . --yes) || return 1
    db="$(docker ps --format '{{.Names}}' | grep -x 'supabase_db_replay-harness' || true)"
    [ -n "$db" ] || { echo "local db container not found"; return 1; }
    n="$(docker exec "$db" psql -X -At -U postgres -d postgres -c 'select count(*) from supabase_migrations.schema_migrations')"
    echo "db reset recorded $n migrations"
    [ "$n" = "$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')" ] || return 1
    [ "$(docker exec "$db" psql -X -At -U postgres -d postgres -c "select to_regclass('public.manual_loan_deletions') is not null and to_regclass('public.plaid_link_attempts') is not null")" = t ]
  }
  c0() {
    mkdir -p "$WORK/cli-original" && scratch "$WORK/cli-original" && cp "$ORIGINAL_DIR/$PHASE_A" "$WORK/cli-original/supabase/migrations/$PHASE_A"
    start_db cliorig
    out="$(cd "$WORK/cli-original" && $SUPABASE_CLI db push --db-url "$(url cliorig)" --yes --workdir . 2>&1)" \
      && { echo "$out"; echo "the original Phase A file was pushed — control failed"; return 1; }
    echo "$out" | grep -E "ERROR|LOCK TABLE" | head -3
    echo "$out" | grep -q "LOCK TABLE can only be used in transaction blocks"
  }
  check C0_cli_rejects_original_phase_a "$WORK/c0.log" c0
  check C1_cli_db_push_clean "$WORK/c1.log" c1
  check C2_cli_db_push_again_up_to_date "$WORK/c2.log" c2
  check C3_cli_db_push_production_state_noop "$WORK/c3.log" c3
  check C4_cli_schema_equals_historical "$WORK/c4.log" c4
  check C5_cli_db_reset_clean_local "$WORK/c5.log" c5
fi

echo
echo "$PASSED passed, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then printf '  failed: %s\n' "${FAILED_NAMES[@]}"; exit 1; fi

#!/usr/bin/env bash
# Phase B integration slice I1 — the read path against a REAL local Data API.
#
# What mocks cannot show, this does: the backend's own service-role client talking to PostgREST behind
# Kong, on a PostgreSQL holding this repository's migrations. It checks the coherent financial read
# (get_financial_read_snapshot), the frozen single-request reads and their exact-count completeness
# proof, the server row cap, ownership filtering, ordering, and three scheduled interference cases.
#
#   SUPABASE_CLI="npx -y supabase@2.117.0" supabase/tests/read_path_integration/run.sh
#
# DISPOSABLE AND LOCAL ONLY. It starts a throwaway local stack (PostgreSQL + PostgREST + Kong) from a
# scratch copy of supabase/config.toml and supabase/migrations — never from this checkout's
# supabase/.temp, which links it to the production project — on its own ports and project id, seeds
# synthetic rows, and removes the stack and its volumes when it exits. It contacts no hosted database,
# no provider, and uses no credential from anywhere: the keys are the local stack's own.
#
# Requires: docker, bash, node, the pinned Supabase CLI, and backend dependencies installed.
#   KEEP=1     leave the stack running afterwards
#   LOG_DIR    where to write the logs (default: a temporary directory)
#
# Not a CI step, and not a substitute for the database harnesses: it is the bounded read-integration
# check of the I1 corrections.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CLI="${SUPABASE_CLI:-npx -y supabase@2.117.0}"
PROJECT="i1-read-path"
PG_VERSION_TAG="17.6.1.155"
API_PORT=55321
DB_PORT=55322
WORK="$(mktemp -d)"
LOGS="${LOG_DIR:-$WORK/logs}"
mkdir -p "$LOGS"

cli() { (cd "$WORK/project" && $CLI "$@" --workdir .); }

cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    cli stop --no-backup >"$LOGS/stop.log" 2>&1
  else
    echo "KEEP=1: the stack is still running (project $PROJECT). Stop it with: (cd $WORK/project && $CLI stop --no-backup --workdir .)"
  fi
}
trap cleanup EXIT

# ---- 1. A scratch project: config (own id and ports) and the migrations, nothing else ---------------
mkdir -p "$WORK/project/supabase/.temp"
sed -e "s/^project_id = .*/project_id = \"$PROJECT\"/" \
    -e 's/^\(\s*port = \)543\([0-9][0-9]\)$/\1553\2/' \
    -e 's/^\(\s*shadow_port = \)543\([0-9][0-9]\)$/\1553\2/' \
    -e 's/^\(\s*inspector_port = \)8083$/\18183/' \
    "$ROOT/supabase/config.toml" > "$WORK/project/supabase/config.toml"
cp -r "$ROOT/supabase/migrations" "$WORK/project/supabase/migrations"
echo "$PG_VERSION_TAG" > "$WORK/project/supabase/.temp/postgres-version"
grep -q "^project_id = \"$PROJECT\"" "$WORK/project/supabase/config.toml" || { echo "FAILED: scratch config has no project id"; exit 1; }
grep -q "^port = $API_PORT" "$WORK/project/supabase/config.toml" || { echo "FAILED: scratch config did not move the API port"; exit 1; }
echo "max_rows in the scratch config: $(grep -E '^max_rows' "$WORK/project/supabase/config.toml")"

# ---- 2. Start only what the Data API needs: PostgreSQL, PostgREST, Kong ------------------------------
echo "starting the local stack (project $PROJECT; API :$API_PORT, db :$DB_PORT) with: $CLI"
cli start -x gotrue,realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor \
  >"$LOGS/start.log" 2>&1 || { echo "FAILED: supabase start"; tail -40 "$LOGS/start.log"; exit 1; }

# Connection details of THIS local stack. The keys are never printed or written to a log.
STATUS="$(cli status -o env 2>"$LOGS/status.err")" || { echo "FAILED: supabase status"; cat "$LOGS/status.err"; exit 1; }
value_of() { printf '%s\n' "$1" | sed -n "s/^$2=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" | head -1; }
API_URL="$(value_of "$STATUS" API_URL)"
case "$API_URL" in http://127.0.0.1:$API_PORT|http://localhost:$API_PORT) ;; *) echo "FAILED: unexpected API URL '$API_URL' (expected the local port $API_PORT)"; exit 1 ;; esac

DB_CONTAINER="supabase_db_$PROJECT"
REST_CONTAINER="supabase_rest_$PROJECT"
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || { echo "FAILED: database container $DB_CONTAINER not found"; exit 1; }
docker inspect "$REST_CONTAINER" >/dev/null 2>&1 || { echo "FAILED: PostgREST container $REST_CONTAINER not found"; exit 1; }

# `supabase status` lists no keys when the auth service is not started, so the two keys are derived
# from the local stack's own JWT secret (keys.cjs).
KEYS="$(node "$HERE/keys.cjs" "$REST_CONTAINER")" || { echo "FAILED: could not derive the local stack's keys"; exit 1; }
SERVICE_ROLE_KEY="$(value_of "$KEYS" SERVICE_ROLE_KEY)"
ANON_KEY="$(value_of "$KEYS" ANON_KEY)"
[ -n "$SERVICE_ROLE_KEY" ] && [ -n "$ANON_KEY" ] || { echo "FAILED: the local stack's keys are empty"; exit 1; }

{
  echo "cli: $($CLI --version 2>/dev/null | head -1)"
  echo "api url: $API_URL   db port: $DB_PORT   project: $PROJECT"
  for c in $(docker ps --format '{{.Names}}' | grep "_$PROJECT\$" | sort); do
    echo "container $c: image $(docker inspect -f '{{.Config.Image}}' "$c")   id $(docker inspect -f '{{.Image}}' "$c")"
  done
  echo "PostgREST row cap: $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$REST_CONTAINER" | grep '^PGRST_DB_MAX_ROWS=')"
  echo "migrations applied: $(docker exec "$DB_CONTAINER" psql -X -At -U supabase_admin -d postgres -c 'select count(*) from supabase_migrations.schema_migrations')  (files: $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' '))"
  echo "latest migration: $(docker exec "$DB_CONTAINER" psql -X -At -U supabase_admin -d postgres -c 'select max(version) from supabase_migrations.schema_migrations')"
} | tee "$LOGS/environment.log"

# ---- 3. Seed synthetic rows ---------------------------------------------------------------------------
docker exec -i "$DB_CONTAINER" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < "$HERE/seed.sql" >"$LOGS/seed.log" 2>&1 \
  || { echo "FAILED: seed"; tail -30 "$LOGS/seed.log"; exit 1; }

# ---- 4. Build the backend and run the check through its real client -----------------------------------
(cd "$ROOT/backend" && npm run build) >"$LOGS/backend_build.log" 2>&1 || { echo "FAILED: backend build"; tail -20 "$LOGS/backend_build.log"; exit 1; }

FRONTEND_URL=http://localhost:5173 PLAID_CLIENT_ID=test-client-id PLAID_SECRET=test-secret \
SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" I1_ANON_KEY="$ANON_KEY" \
I1_DB_CONTAINER="$DB_CONTAINER" I1_ROOT="$ROOT" I1_HERE="$HERE" \
  node "$HERE/check.cjs" 2>&1 | tee "$LOGS/check.log"
RESULT="${PIPESTATUS[0]}"

echo "logs: $LOGS"
exit "$RESULT"

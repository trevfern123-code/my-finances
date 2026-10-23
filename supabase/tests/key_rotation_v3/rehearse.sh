#!/usr/bin/env bash
# Staging rehearsal of the RAILWAY_PROD_V2 → RENDER_PROD_V3 rotation against a REAL local Supabase stack
# (Postgres + PostgREST + Kong + GoTrue), using this checkout's migrations and its compiled backend.
# See PLAID_KEY_ROTATION_V2_TO_V3.md §4.1 step 3 and §8.
#
# LOCAL AND SYNTHETIC ONLY. A scratch Supabase project with its own id and ports (573xx), a scratch COPY
# of config.toml and the migrations, fake tokens, and throwaway encryption keys generated for this run.
# No hosted database, no Plaid call (the rotation CLI has no Plaid client; an unreachable HTTPS proxy is
# set anyway), no real credential. The local stack's keys and the throwaway keys stay in the scratch
# directory (mode 600) and are never printed; script output is the CLI's own allow-listed log lines.
#
#   REHEARSAL_SCRATCH=<empty scratch dir> bash supabase/tests/key_rotation_v3/rehearse.sh
#   optional: SUPABASE_CLI=<path to the pinned 2.117.0 CLI>   REHEARSAL_KEEP=1 (leave the stack up)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CLI="${SUPABASE_CLI:-/c/Projects/local-tools/supabase/2.117.0/bin/supabase.exe}"
SCR="${REHEARSAL_SCRATCH:?set REHEARSAL_SCRATCH to an empty scratch directory}"
PROJECT=keyrot-v3
API_PORT=57321
DB_PORT=57322
DB_CONTAINER="supabase_db_$PROJECT"
HOST="127.0.0.1:$API_PORT"
EVIDENCE="$SCR/evidence.log"
PASS=0
FAIL=0

say() { echo "$*" | tee -a "$EVIDENCE"; }
ok() { PASS=$((PASS + 1)); say "PASS  $*"; }
bad() { FAIL=$((FAIL + 1)); say "FAIL  $*"; }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
cli() { (cd "$SCR/project" && "$CLI" "$@" --workdir .); }
sql() { docker exec -i "$DB_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; }
pid_on_port() { netstat -ano 2>/dev/null | grep -E "[:.]$1 +.*LISTENING" | awk '{print $NF}' | sort -u | head -1; }
value_of() { sed -n "s/^$2=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$1" | head -1; }

down() {
  if [ "${REHEARSAL_KEEP:-0}" = 1 ]; then say "REHEARSAL_KEEP=1: stack $PROJECT left running"; return; fi
  [ -d "$SCR/project" ] && cli stop --no-backup >/dev/null 2>&1
  rm -rf "$SCR/project" "$SCR/secrets.env" "$SCR/keys.env" "$SCR/dist" "$SCR/cwd" "$SCR/start.log"
  say "down: remaining containers of project $PROJECT: $(docker ps -a --format '{{.Names}}' | grep -c "_$PROJECT\$")"
}

# ---- Stack -------------------------------------------------------------------------------------------
mkdir -p "$SCR"
[ -e "$SCR/project" ] && { echo "FAILED: $SCR/project exists — previous run not cleaned up"; exit 1; }
: > "$EVIDENCE"
for p in $API_PORT $DB_PORT 57323 57324 57327 57329; do
  [ -z "$(pid_on_port "$p")" ] || { echo "FAILED: port $p is in use; nothing was started"; exit 1; }
done
docker ps -a --format '{{.Names}}' | grep -q "_$PROJECT\$" && { echo "FAILED: containers of project $PROJECT already exist"; exit 1; }
trap down EXIT

mkdir -p "$SCR/project/supabase/.temp" "$SCR/cwd"
sed -e "s/^project_id = .*/project_id = \"$PROJECT\"/" \
    -e 's/^\(\s*port = \)543\([0-9][0-9]\)$/\1573\2/' \
    -e 's/^\(\s*shadow_port = \)543\([0-9][0-9]\)$/\1573\2/' \
    -e 's/^\(\s*inspector_port = \)8083$/\18383/' \
    "$ROOT/supabase/config.toml" > "$SCR/project/supabase/config.toml"
cp -r "$ROOT/supabase/migrations" "$SCR/project/supabase/migrations"
echo "17.6.1.155" > "$SCR/project/supabase/.temp/postgres-version"
grep -q "^port = $API_PORT" "$SCR/project/supabase/config.toml" || { echo "FAILED: the scratch config did not move the API port"; exit 1; }
say "rehearsal $(date -u +%Y-%m-%dT%H:%M:%SZ) — checkout $(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- backend supabase || echo '+uncommitted') — $("$CLI" --version 2>/dev/null | head -1)"
cli start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >"$SCR/start.log" 2>&1 \
  || { echo "FAILED: supabase start"; grep -iv "key\|secret\|jwt" "$SCR/start.log" | tail -20; exit 1; }
cli status -o env >"$SCR/secrets.env" 2>/dev/null || { echo "FAILED: supabase status"; exit 1; }
chmod 600 "$SCR/secrets.env"
API_URL="$(value_of "$SCR/secrets.env" API_URL)"
SRK="$(value_of "$SCR/secrets.env" SERVICE_ROLE_KEY)"
[ "$API_URL" = "http://$HOST" ] || { echo "FAILED: unexpected local API URL"; exit 1; }
[ -n "$SRK" ] || { echo "FAILED: the local stack listed no service key"; exit 1; }
MIGRATIONS="$(sql -c 'select count(*) from supabase_migrations.schema_migrations')"
check "all $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ') checkout migrations applied to the scratch database ($MIGRATIONS)" \
  [ "$MIGRATIONS" = "$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')" ]
for c in $(docker ps --format '{{.Names}}' | grep "_$PROJECT\$" | sort); do say "container $c: $(docker inspect -f '{{.Config.Image}}' "$c")"; done

# ---- Build + throwaway keys -------------------------------------------------------------------------
(cd "$ROOT/backend" && npx tsc -p tsconfig.build.json --outDir "$SCR/dist") || { echo "FAILED: backend build"; exit 1; }
K2="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
K3="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
printf 'K2=%s\nK3=%s\n' "$K2" "$K3" > "$SCR/keys.env"; chmod 600 "$SCR/keys.env"
NODE_PATH_W="$(cygpath -w "$ROOT/node_modules")"
DIST="$SCR/dist"

# run <label> <keyring: mixed|v3only|v2only> <args…>: the compiled rotation CLI, from an EMPTY cwd (no .env)
run() {
  local label="$1" ring="$2"; shift 2
  local keys
  case "$ring" in
    mixed) keys="PLAID_TOKEN_KEY_RAILWAY_PROD_V2=$K2 PLAID_TOKEN_KEY_RENDER_PROD_V3=$K3 PLAID_TOKEN_CURRENT_KEY_ID=RENDER_PROD_V3" ;;
    v3only) keys="PLAID_TOKEN_KEY_RENDER_PROD_V3=$K3 PLAID_TOKEN_CURRENT_KEY_ID=RENDER_PROD_V3" ;;
    v2only) keys="PLAID_TOKEN_KEY_RAILWAY_PROD_V2=$K2 PLAID_TOKEN_CURRENT_KEY_ID=RAILWAY_PROD_V2" ;;
  esac
  [ -e "$SCR/cwd/.env" ] && { echo "FAILED: a .env exists in the scratch cwd"; exit 1; }
  # shellcheck disable=SC2086
  (cd "$SCR/cwd" && env NODE_PATH="$NODE_PATH_W" FRONTEND_URL=http://localhost:5173 SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SRK" \
    PLAID_CLIENT_ID=rehearsal-not-a-client PLAID_SECRET=rehearsal-not-a-secret PLAID_ENV=sandbox \
    HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost $keys \
    node "$(cygpath -w "$DIST/scripts/rotatePlaidTokenKeyV2ToV3.js")" "$@") > "$SCR/run_$label.log" 2>&1
  local code=$?
  echo "$code" > "$SCR/run_$label.code"
  say "run $label: exit $code; outcomes: $(sed -n 's/.*"outcome":"\([^"]*\)".*/\1/p' "$SCR/run_$label.log" | sort | uniq -c | awk '{printf "%s×%s ", $1, $2}')"
  return 0
}
code_of() { cat "$SCR/run_$1.code"; }
has() { grep -q "\"outcome\":\"$2\"" "$SCR/run_$1.log"; }
count_of() { grep -c "\"outcome\":\"$2\"" "$SCR/run_$1.log"; }
COMMON=(--expected-plaintext-copies 3 --expected-plaid-env sandbox --expected-supabase-host "$HOST" --constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED)
rot() { local label="$1" ring="$2" total="$3" remaining="$4"; shift 4; run "$label" "$ring" --mode rotate --expected-total "$total" --expected-remaining-v2 "$remaining" "${COMMON[@]}" "$@"; }
ret() { local label="$1" ring="$2" total="$3"; shift 3; run "$label" "$ring" --mode verify-retirement --expected-total "$total" "${COMMON[@]}" "$@"; }
APPLY=(--apply --confirm ROTATE_PLAID_KEY_V2_TO_V3)

# Fingerprints of the table, computed in the database (digests only, never printed values).
non_enc_digest() { sql -c "select md5(string_agg(md5(row(id, user_id, plaid_item_id, access_token, institution_id, institution_name, transactions_cursor, status, created_at, updated_at)::text), ',' order by id)) from public.plaid_items"; }
full_digest() { sql -c "select md5(string_agg(md5(p::text), ',' order by id)) from public.plaid_items p"; }
xmins() { sql -c "select string_agg(xmin::text, ',' order by id) from public.plaid_items"; }
keyids() { sql -c "select string_agg(coalesce(access_token_key_id, '-'), ',' order by id) from public.plaid_items"; }
links() { sql -c "select count(*) from public.plaid_link_attempts"; }

# ---- Seed (production shape) ------------------------------------------------------------------------------
REHEARSAL_V2_KEY="$K2" node "$HERE/seed.cjs" "$(cygpath -w "$DIST")" initial | sql >/dev/null || { echo "FAILED: seed"; exit 1; }
say "seeded: $(sql -c "select count(*) || ' items, ' || count(*) filter (where access_token is not null) || ' with plaintext, statuses ' || string_agg(status, '/' order by id) from public.plaid_items"); $(links) link attempts"
say "integrity before: $(sql -F' ' < "$HERE/integrity.sql" | tr '\n' ' ')"
NONENC0="$(non_enc_digest)"; FULL0="$(full_digest)"

# ---- Preflight refusals on a real PostgREST -----------------------------------------------------------------
run wrong_host mixed --mode rotate --expected-total 4 --expected-remaining-v2 4 --expected-plaintext-copies 3 --expected-plaid-env sandbox \
  --expected-supabase-host smoke-check.invalid --constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED
check "wrong Supabase host refused (exit 1, failed:unexpected_supabase_host, no inventory read)" \
  eval '[ "$(code_of wrong_host)" = 1 ] && has wrong_host failed:unexpected_supabase_host && ! grep -q "\"stage\":\"inventory\"" "$SCR/run_wrong_host.log"'
rot wrong_total mixed 5 4
check "wrong --expected-total refused against the real exact count" eval '[ "$(code_of wrong_total)" = 1 ] && has wrong_total failed:unexpected_total_count'
rot v2_current v2only 4 4
check "V2-current key ring refused (failed:v3_key_missing, failed:v3_not_current)" eval 'has v2_current failed:v3_key_missing && has v2_current failed:v3_not_current'

# ---- Dry run ------------------------------------------------------------------------------------------------------
rot dry mixed 4 4
check "dry run: exit 0, 4 × dry_run_verified, final_check passed, dry_run_complete" \
  eval '[ "$(code_of dry)" = 0 ] && [ "$(count_of dry dry_run_verified)" = 4 ] && has dry passed && has dry dry_run_complete'
check "dry run wrote nothing (full-table digest unchanged)" [ "$(full_digest)" = "$FULL0" ]

# ---- Apply ----------------------------------------------------------------------------------------------------------
rot apply mixed 4 4 "${APPLY[@]}"
check "apply: exit 0, 4 × rotated, rotation_complete" eval '[ "$(code_of apply)" = 0 ] && [ "$(count_of apply rotated)" = 4 ] && has apply rotation_complete'
check "every row now on RENDER_PROD_V3" [ "$(keyids)" = "RENDER_PROD_V3,RENDER_PROD_V3,RENDER_PROD_V3,RENDER_PROD_V3" ]
check "no column other than the five encrypted ones changed (plaintext, status, cursor, user, timestamps)" [ "$(non_enc_digest)" = "$NONENC0" ]
check "encrypted-only row still has no plaintext; 3 plaintext copies remain" \
  [ "$(sql -c "select count(*) filter (where access_token is not null) || '/' || bool_and(access_token is null) filter (where id = '0d000000-0000-4000-8000-00000000000d') from public.plaid_items")" = "3/true" ]
check "4 distinct nonces" [ "$(sql -c 'select count(distinct access_token_nonce) from public.plaid_items')" = 4 ]

XMIN1="$(xmins)"
rot rerun mixed 4 0 "${APPLY[@]}"
check "idempotent rerun: exit 0, 4 × already_v3_verified" eval '[ "$(code_of rerun)" = 0 ] && [ "$(count_of rerun already_v3_verified)" = 4 ]'
check "idempotent rerun wrote nothing (row versions unchanged)" [ "$(xmins)" = "$XMIN1" ]

# ---- Resume from an interrupted state (A, B on V3; C, D back on V2) ------------------------------------------------
REHEARSAL_V2_KEY="$K2" node "$HERE/seed.cjs" "$(cygpath -w "$DIST")" revert-cd-to-v2 | sql >/dev/null
rot resume_stale mixed 4 4 "${APPLY[@]}"
check "resume with a stale --expected-remaining-v2 4 refused" eval '[ "$(code_of resume_stale)" = 1 ] && has resume_stale failed:unexpected_remaining_v2_count'
rot resume mixed 4 2 "${APPLY[@]}"
check "resume: A, B already_v3_verified; C, D rotated; rotation_complete" \
  eval '[ "$(code_of resume)" = 0 ] && [ "$(count_of resume already_v3_verified)" = 2 ] && [ "$(count_of resume rotated)" = 2 ] && has resume rotation_complete'
check "after resume: plaintext/status/cursor still unchanged" [ "$(non_enc_digest)" = "$NONENC0" ]

# ---- Retirement gate + Hosted Link cleanup (runbook §4.3, the exact SQL files) --------------------------------------
ret gate_links_remaining v3only 4
check "verify-retirement refused at preflight while V2 link tokens exist" \
  eval '[ "$(code_of gate_links_remaining)" = 1 ] && grep -q "\"stage\":\"preflight\",\"outcome\":\"failed:v2_link_tokens_remaining\"" "$SCR/run_gate_links_remaining.log"'
check "step 1 count: 2 V2 link tokens, 1 purgeable, 1 not yet" [ "$(sql -F' ' < "$HERE/link_token_count.sql")" = "2 1 1" ]
cleanup() { sed "s/<purgeable from step 1>/$1/" "$HERE/link_token_cleanup.sql" | sql >"$SCR/cleanup_$1.log" 2>&1; }
LINKS0="$(links)"
check "cleanup refused while a V2 token is newer than the threshold (nothing deleted)" eval '! cleanup 1 && grep -q "newer than the purge threshold" "$SCR/cleanup_1.log" && [ "$(links)" = "$LINKS0" ]'
# Time passes: the live attempt ages past expiry + 1 hour.
sql -c "update public.plaid_link_attempts set created_at = now() - interval '130 minutes', expires_at = now() - interval '100 minutes' where id = '1d000000-0000-4000-8000-0000000000a4'" >/dev/null
check "recount: 2 purgeable, 0 not yet" [ "$(sql -F' ' < "$HERE/link_token_count.sql")" = "2 2 0" ]
check "cleanup with a wrong expected count (1) rolled back (nothing deleted)" eval '! cleanup 1 && grep -q "deleted 2 rows, expected 1" "$SCR/cleanup_1.log" && [ "$(links)" = "$LINKS0" ]'
check "cleanup with an out-of-bounds count (0) refused" eval '! cleanup 0 && [ "$(links)" = "$LINKS0" ]'
check "cleanup with the exact count (2) deleted exactly the two V2 rows" eval 'cleanup 2 && [ "$(links)" = "$((LINKS0 - 2))" ]'
check "the tokenless history attempt was kept" [ "$(sql -c "select count(*) from public.plaid_link_attempts where id = '1b000000-0000-4000-8000-0000000000a2'")" = 1 ]
check "step 3 recount: 0 V2 link tokens" [ "$(sql -F' ' < "$HERE/link_token_count.sql")" = "0 0 0" ]

XMIN2="$(xmins)"
ret gate v3only 4
check "verify-retirement with ONLY the V3 key configured: v2_retirement_gate_passed" \
  eval '[ "$(code_of gate)" = 0 ] && [ "$(count_of gate v3_only_verified)" = 4 ] && has gate v2_retirement_gate_passed'
check "verify-retirement wrote nothing (row versions unchanged)" [ "$(xmins)" = "$XMIN2" ]

# ---- Missed writer: a backend still on V2 creates an item after the rotation ------------------------------------------
REHEARSAL_V2_KEY="$K2" node "$HERE/seed.cjs" "$(cygpath -w "$DIST")" missed-writer-item | sql >/dev/null
ret gate_missed_writer v3only 5
check "verify-retirement refuses a V2 item written after the rotation" eval '[ "$(code_of gate_missed_writer)" = 1 ] && has gate_missed_writer failed:v2_rows_remaining'
rot rotate_missed_writer mixed 5 1
check "the same CLI rotates it once re-attested (dry run: 4 already V3, 1 dry_run_verified)" \
  eval '[ "$(count_of rotate_missed_writer already_v3_verified)" = 4 ] && [ "$(count_of rotate_missed_writer dry_run_verified)" = 1 ]'

say "integrity after: $(sql -F' ' < "$HERE/integrity.sql" | tr '\n' ' ')"
say "secret check: throwaway keys / local service key / fixture tokens in any CLI output: $(cat "$SCR"/run_*.log | grep -cF -e "$K2" -e "$K3" -e "$SRK" -e access-sandbox-rehearsal -e link-sandbox-rehearsal)"
check "no key, service key or fixture token appears in any CLI output" [ "$(cat "$SCR"/run_*.log | grep -cF -e "$K2" -e "$K3" -e "$SRK" -e access-sandbox-rehearsal -e link-sandbox-rehearsal)" = 0 ]

say "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]

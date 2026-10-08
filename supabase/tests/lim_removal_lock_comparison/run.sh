#!/usr/bin/env bash
# Lock comparison for 20261006120000_lim_removal_card_payment_matching.sql: institution removal against a
# LOCK-FREE writer that holds a row of the item being removed (design §3.7; the independent review's packet
# C1). The same two-session overlap, on identical synthetic fixtures, under the PREVIOUS body of
# remove_plaid_item_local (20260926120000) and under the CANDIDATE body. Not run in CI. Nothing here touches
# any real database: one throwaway container of Supabase's PostgreSQL image.
#
#   supabase/tests/lim_removal_lock_comparison/run.sh
#
# The overlap. The writer takes the row lock a direct UPDATE takes (L3) and stops before the trigger bump
# that needs the user's version row (L2). The removal then runs until it waits for that row. Only then does
# the writer run its UPDATE. Whether that closes a cycle depends on whether the removal already holds L2:
#   * PREVIOUS body: it takes L2 only inside "delete from plaid_items", in the item's own delete trigger.
#     PostgreSQL runs a cascade's DELETE of the child rows at once, but queues the child rows' own triggers
#     (the next level of the cascade among them) behind the parent row's remaining triggers. So the order is:
#     the item's ACCOUNT rows are deleted (locked) -> the item's trigger takes L2 -> the transactions, and
#     then the decisions, of each account are deleted. Whether a decision row exists changes nothing.
#   * CANDIDATE body: it takes L2 in its first evaluation, before it deletes anything — but it first locks
#     the item's ACCOUNT rows (in id order, FOR UPDATE: the lock their delete takes), so that those rows come
#     before L2 as they did under the previous body. Transactions still come after L2, as they always did.
#
# Cases (fixture.sql; the held row is a TRANSACTION of the item in S1-S3 and an ACCOUNT of the item in S4, S5):
#   S1 no decision row; S2 a decision row on the held row's own account; S3 a decision row on an account the
#   cascade reaches BEFORE the held row's account; S4 the account row itself, updated by the writer (the
#   account-settings update); S5 the account row, held only by the foreign-key lock of an INSERT that
#   references it. No decision row in S4 and S5.
# Each runs under both bodies with default deadlock detection, and S1 under the candidate once more with
# detection left to the writer only.
#
# For every case verify.sql asserts: the only error is a detected deadlock (40P01); the side that lost rolled
# back completely; a removal that lost is retryable, and the manual loan is restored exactly once; the final
# matching state is fresh or unreadable. This script then compares what happened with EXPECT below — what
# is documented for each body — and fails on any difference.
#
# Requires what access_control/run.sh requires: docker, bash, GNU timeout.
#   PG_IMAGE=<image>   override the image (default public.ecr.aws/supabase/postgres:17.6.1.155)
#   KEEP=1             leave the container running afterwards
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
AC="$ROOT/supabase/tests/access_control"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="lim-lock-comparison-$$"
LOGS="$(mktemp -d)"
TARGET=20261006120000_lim_removal_card_payment_matching.sql
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$CONTAINER" >/dev/null 2>&1' EXIT

psql_db() { timeout 300 docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
# supabase_admin owns auth.users, and may set a session's deadlock_timeout.
psql_admin() { timeout 300 docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; }
apply() {
  if ! timeout 300 docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1" >>"$LOGS/history.log" 2>&1; then
    echo "FAILED to apply migration $(basename "$1"):"; tail -20 "$LOGS/history.log"; exit 1
  fi
}

# body|scenario|removal's deadlock_timeout|writer's deadlock_timeout  ->  deadlock|victim|final
# A TRANSACTION row of the item: the same detected deadlock under both bodies. An ACCOUNT row of the item
# (updated, or only referenced): a plain wait under both bodies — the candidate adds no deadlock.
EXPECT=(
  "previous|S1|1s|1s|yes|removal|stale-unreadable"
  "previous|S2|1s|1s|yes|removal|stale-unreadable"
  "previous|S3|1s|1s|yes|removal|stale-unreadable"
  "previous|S4|1s|1s|no|none|stale-unreadable"
  "previous|S5|1s|1s|no|none|stale-unreadable"
  "candidate|S1|1s|1s|yes|removal|fresh"
  "candidate|S2|1s|1s|yes|removal|fresh"
  "candidate|S3|1s|1s|yes|removal|fresh"
  "candidate|S4|1s|1s|no|none|fresh"
  "candidate|S5|1s|1s|no|none|fresh"
  "candidate|S1|60s|1s|yes|writer|fresh"
)

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + 180))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not accept connections"; docker logs --tail 40 "$CONTAINER" 2>&1; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
echo "server: $(psql_db -At -c 'show server_version' </dev/null)"

# The repository's migration history up to, but not including, the candidate: the PREVIOUS body.
for f in "$ROOT"/supabase/migrations/*.sql; do
  [ "$(basename "$f")" = "$TARGET" ] && break
  apply "$f"
done
psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" >"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
psql_admin < "$AC/helpers.sql" >>"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }

body_md5() { psql_db -At -c "select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure" </dev/null; }

overall=0
SUMMARY=()
run_case() {
  local body="$1" scenario="$2" dt_removal="$3" dt_writer="$4" want_deadlock="$5" want_victim="$6" want_final="$7"
  local name="$body-$scenario-$dt_removal-$dt_writer" log="$LOGS/$1-$2-$3-$4.log" status=0
  echo
  echo "CASE  body=$body  scenario=$scenario  deadlock_timeout: removal=$dt_removal writer=$dt_writer"
  psql_admin < "$AC/seed.sql" >"$log" 2>&1 && psql_db -v scenario="$scenario" < "$HERE/fixture.sql" >>"$log" 2>&1 || status=1
  if [ "$status" -eq 0 ]; then
    psql_db < "$HERE/monitor.sql" >"$log.monitor" 2>&1 &
    local monitor_pid=$!
    psql_admin -v dt="$dt_writer" -v scenario="$scenario" < "$HERE/writer.sql" >"$log.writer" 2>&1 &
    local writer_pid=$!
    psql_admin -v dt="$dt_removal" < "$HERE/removal.sql" >"$log.removal" 2>&1 || status=1
    wait "$writer_pid" || status=1
    wait "$monitor_pid" || status=1
    { echo "--- writer"; cat "$log.writer"; echo "--- removal"; cat "$log.removal"; echo "--- monitor"; cat "$log.monitor"; } >>"$log"
  fi
  if [ "$status" -eq 0 ]; then psql_db -v body="$body" -v scenario="$scenario" < "$HERE/verify.sql" >"$log.verify" 2>&1 || status=1; cat "$log.verify" >>"$log"; fi
  if [ "$status" -ne 0 ]; then
    echo "  FAILED (an assertion, or a session that did not finish):"; sed 's/^/      | /' "$log" | grep -vE '^\s*\|\s*$' | tail -25
    overall=1; SUMMARY+=("$body|$scenario|$dt_removal/$dt_writer|FAILED|-|-|-"); return
  fi
  local result; result="$(grep '^RESULT ' "$log.verify")"
  grep -E '^(WAIT|DETAIL) ' "$log.verify" | sed 's/^/  /'
  echo "  $result"
  local got_deadlock got_victim got_final verdict=as-documented
  got_deadlock="$(sed -n 's/.* deadlock=\([a-z]*\).*/\1/p' <<<"$result")"
  got_victim="$(sed -n 's/.* victim=\([a-z]*\).*/\1/p' <<<"$result")"
  got_final="$(sed -n 's/.* final=\([a-z-]*\).*/\1/p' <<<"$result")"
  if [ "$got_deadlock" != "$want_deadlock" ] || [ "$got_victim" != "$want_victim" ] || [ "$got_final" != "$want_final" ]; then
    verdict="DIFFERS (documented: deadlock=$want_deadlock victim=$want_victim final=$want_final)"; overall=1
  fi
  echo "  -> $verdict"
  SUMMARY+=("$body|$scenario|$dt_removal/$dt_writer|$got_deadlock|$got_victim|$got_final|$verdict")
}

echo "remove_plaid_item_local body: $(body_md5) (previous: 20260926120000)"
for e in "${EXPECT[@]}"; do
  IFS='|' read -r body scenario dtr dtw d v f <<<"$e"
  [ "$body" = previous ] && run_case "$body" "$scenario" "$dtr" "$dtw" "$d" "$v" "$f"
done

# The candidate migration (and anything after it), on the same database.
past=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  [ "$(basename "$f")" = "$TARGET" ] && past=1
  [ "$past" -eq 1 ] && apply "$f"
done
echo
echo "remove_plaid_item_local body: $(body_md5) (candidate: $TARGET)"
for e in "${EXPECT[@]}"; do
  IFS='|' read -r body scenario dtr dtw d v f <<<"$e"
  [ "$body" = candidate ] && run_case "$body" "$scenario" "$dtr" "$dtw" "$d" "$v" "$f"
done

echo
printf '%-10s %-9s %-18s %-9s %-8s %-17s %s\n' BODY SCENARIO "TIMEOUT rem/wr" DEADLOCK VICTIM FINAL VERDICT
for s in "${SUMMARY[@]}"; do
  IFS='|' read -r a b c d e f g <<<"$s"
  printf '%-10s %-9s %-18s %-9s %-8s %-17s %s\n' "$a" "$b" "$c" "$d" "$e" "$f" "$g"
done
echo
if [ "$overall" -eq 0 ]; then echo "all ${#SUMMARY[@]} cases as documented"; else echo "FAILED: at least one case failed or differs from what is documented"; fi
exit "$overall"

#!/usr/bin/env bash
# Lock comparison for institution removal: remove_plaid_item_local against a LOCK-FREE writer that holds a row
# of the item being removed (design §3.7; the independent review's packet C1). The same two-session overlap,
# on identical synthetic fixtures, under each BODY the function has had. A body is named by the migration that
# installs it (BODIES below):
#   20260926120000   the first body: it deletes, and takes the user's version row only inside the delete;
#   20261006120000   it evaluates, preserves what is known, deletes, and evaluates again;
#   20261008120000   the same, and it records the provenance of everything it preserves.
# Each is installed by applying its own file on top of its predecessors, and is measured BEFORE the next body's
# file is applied: no body is measured under another's name, and the first two are measured without the
# provenance tables. The checksum printed for each is computed from the installed function. Not run in CI.
# Nothing here touches any real database: one throwaway container of Supabase's PostgreSQL image.
#
#   supabase/tests/lim_removal_lock_comparison/run.sh
#
# The overlap. The writer takes the row lock a direct UPDATE takes (L3) and stops before the trigger bump
# that needs the user's version row (L2). The removal then runs until it waits for that row. Only then does
# the writer run its UPDATE. Whether that closes a cycle depends on whether the removal already holds L2:
#   * 20260926120000: it takes L2 only inside "delete from plaid_items", in the item's own delete trigger.
#     PostgreSQL runs a cascade's DELETE of the child rows at once, but queues the child rows' own triggers
#     (the next level of the cascade among them) behind the parent row's remaining triggers. So the order is:
#     the item's ACCOUNT rows are deleted (locked) -> the item's trigger takes L2 -> the transactions, and
#     then the decisions, of each account are deleted. Whether a decision row exists changes nothing.
#   * 20261006120000: it takes L2 in its first evaluation, before it deletes anything — but it first locks
#     the item's ACCOUNT rows (in id order, FOR UPDATE: the lock their delete takes), so that those rows come
#     before L2 as they did under the first body. Transactions still come after L2, as they always did.
#   * 20261008120000: the locks of 20261006120000, in the same order (its header, LOCKS: no new lock class and
#     no new order). What it adds is written where the decisions were written — after the account rows and
#     after L2 — and takes only the KEY SHARE locks of foreign-key checks: on rows this transaction wrote or
#     already holds FOR UPDATE, on the user's auth.users row, and on the ledger rows of the user's earlier
#     cleaned removals that get a marker. No writer below holds one of those rows, so every case is expected
#     to read as under 20261006120000. (Those rows are what the EXTENT probe below is about.)
#
# Cases (fixture.sql; the held row is a TRANSACTION of the item in S1-S3 and an ACCOUNT of the item in S4, S5):
#   S1 no decision row; S2 a decision row on the held row's own account; S3 a decision row on an account the
#   cascade reaches BEFORE the held row's account; S4 the account row itself, updated by the writer (the
#   account-settings update); S5 the account row, held only by the foreign-key lock of an INSERT that
#   references it. No decision row in S4 and S5.
# Each runs under every body with default deadlock detection, and S1 under the two later bodies once more with
# detection left to the writer only.
#
# For every case verify.sql asserts: the only error is a detected deadlock (40P01); the side that lost rolled
# back completely; a removal that lost is retryable, and the manual loan is restored exactly once; the final
# matching state is fresh or unreadable; and, under 20261008120000, that a removal that lost left no generation
# and no source row, and that the one that completed has exactly its own. This script then compares what
# happened with EXPECT below — what is documented for each body — and fails on any difference.
#
# The EXTENT probe, once per body (extent_fixture.sql, extent_removal.sql, extent_probe.sql). The cases above
# say nothing about rows that no writer there holds, and those are the rows 20261008120000's new inserts
# reference. So, for a user with NO card-payment leg (the removal writes no decision and no state) who has an
# earlier, cleaned removal without a generation row, a second session asks — while the removal's transaction is
# open and its function has returned — whether the user's auth.users row and that earlier removal's ledger row
# can be locked FOR UPDATE NOWAIT. Compared with EXTENT below.
#
# Requires what access_control/run.sh requires: docker, bash, GNU timeout.
#   PG_IMAGE=<image>   override the image (default public.ecr.aws/supabase/postgres:17.6.1.155)
#   KEEP=1             leave the container running afterwards
#   LOG_DIR=<dir>      keep the per-case session logs there (default: a new temporary directory)
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
AC="$ROOT/supabase/tests/access_control"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="lim-lock-comparison-$$"
if [ -n "${LOG_DIR:-}" ]; then mkdir -p "$LOG_DIR" || exit 1; LOGS="$(cd "$LOG_DIR" && pwd)"; else LOGS="$(mktemp -d)"; fi
# The migrations that install a body of remove_plaid_item_local, in the order of the history. A body's label
# is its file's timestamp. A migration that replaces the function again must be added here, with its cases.
BODIES=(
  20260926120000_linked_institution_management.sql
  20261006120000_lim_removal_card_payment_matching.sql
  20261008120000_card_payment_removal_provenance.sql
)
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
# A TRANSACTION row of the item: the same detected deadlock under every body. An ACCOUNT row of the item
# (updated, or only referenced): a plain wait under every body — neither later body adds a deadlock.
EXPECT=(
  "20260926120000|S1|1s|1s|yes|removal|stale-unreadable"
  "20260926120000|S2|1s|1s|yes|removal|stale-unreadable"
  "20260926120000|S3|1s|1s|yes|removal|stale-unreadable"
  "20260926120000|S4|1s|1s|no|none|stale-unreadable"
  "20260926120000|S5|1s|1s|no|none|stale-unreadable"
  "20261006120000|S1|1s|1s|yes|removal|fresh"
  "20261006120000|S2|1s|1s|yes|removal|fresh"
  "20261006120000|S3|1s|1s|yes|removal|fresh"
  "20261006120000|S4|1s|1s|no|none|fresh"
  "20261006120000|S5|1s|1s|no|none|fresh"
  "20261006120000|S1|60s|1s|yes|writer|fresh"
  "20261008120000|S1|1s|1s|yes|removal|fresh"
  "20261008120000|S2|1s|1s|yes|removal|fresh"
  "20261008120000|S3|1s|1s|yes|removal|fresh"
  "20261008120000|S4|1s|1s|no|none|fresh"
  "20261008120000|S5|1s|1s|no|none|fresh"
  "20261008120000|S1|60s|1s|yes|writer|fresh"
)

# body  ->  the user's auth.users row | the ledger row of the user's earlier cleaned removal (no generation row)
#   * The user's row. 20260926120000 leaves it alone: it updates the user's card_payment_eval_versions row once
#     (the bump of the delete), and an update that changes no key re-checks no foreign key. 20261006120000
#     takes KEY SHARE on it on EVERY removal, although it inserts nothing here that references the user: its
#     evaluation updates that version row, the bump of the delete updates it AGAIN, and PostgreSQL re-checks
#     the foreign key of a row that the same transaction has already written, whether or not the key changed.
#     20261008120000 takes the same lock for the same reason, and once more for its generation row. So on
#     this row it changes nothing against 20261006120000; the difference is against 20260926120000.
#   * The earlier removal's ledger row. Only 20261008120000 touches it: the marker it writes references it.
EXTENT=(
  "20260926120000|free|free"
  "20261006120000|locked|free"
  "20261008120000|locked|locked"
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

body_md5() { psql_db -At -c "select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure" </dev/null; }

# The repository's migration history, applied in order and in pieces. apply_before <file> applies what has not
# been applied yet up to, but not including, <file>; with no argument, everything that is left.
MIGRATIONS=("$ROOT"/supabase/migrations/*.sql)
next=0
apply_before() {
  while [ "$next" -lt "${#MIGRATIONS[@]}" ]; do
    [ "$(basename "${MIGRATIONS[$next]}")" = "${1:-}" ] && return 0
    apply "${MIGRATIONS[$next]}"
    next=$((next + 1))
  done
  [ -z "${1:-}" ] || { echo "FAILED: $1 is not in supabase/migrations"; exit 1; }
}

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
  grep -E '^(WAIT|DETAIL|PROVENANCE) ' "$log.verify" | sed 's/^/  /'
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

EXTENT_SUMMARY=()
run_extent() {
  local body="$1" want_user="$2" want_earlier="$3" log="$LOGS/$1-extent.log" status=0
  echo
  echo "EXTENT  body=$body  a user with no card-payment leg and an earlier cleaned removal"
  psql_admin < "$AC/seed.sql" >"$log" 2>&1 && psql_db < "$HERE/extent_fixture.sql" >>"$log" 2>&1 || status=1
  if [ "$status" -eq 0 ]; then
    psql_admin -v body="$body" < "$HERE/extent_probe.sql" >"$log.probe" 2>&1 &
    local probe_pid=$!
    psql_admin < "$HERE/extent_removal.sql" >"$log.removal" 2>&1 || status=1
    wait "$probe_pid" || status=1
    { echo "--- removal"; cat "$log.removal"; echo "--- probe"; cat "$log.probe"; } >>"$log"
  fi
  if [ "$status" -ne 0 ]; then
    echo "  FAILED (an assertion, or a session that did not finish):"; sed 's/^/      | /' "$log" | grep -vE '^\s*\|\s*$' | tail -25
    overall=1; EXTENT_SUMMARY+=("$body|FAILED|-|-"); return
  fi
  local result got_user got_earlier verdict=as-documented
  result="$(grep '^EXTENT ' "$log.probe")"
  echo "  $result"
  got_user="$(sed -n 's/.* user_row=\([a-z]*\).*/\1/p' <<<"$result")"
  got_earlier="$(sed -n 's/.* earlier_removal=\([a-z]*\).*/\1/p' <<<"$result")"
  if [ "$got_user" != "$want_user" ] || [ "$got_earlier" != "$want_earlier" ]; then
    verdict="DIFFERS (documented: user_row=$want_user earlier_removal=$want_earlier)"; overall=1
  fi
  echo "  -> $verdict"
  EXTENT_SUMMARY+=("$body|$got_user|$got_earlier|$verdict")
}

# One body after the other: its own file on top of everything before it, then the migrations that follow it up
# to the next body's file (after the last body: the rest of the history). None of those may replace the body.
SEEN=()
for i in "${!BODIES[@]}"; do
  file="${BODIES[$i]}"
  label="${file%%_*}"
  apply_before "$file"
  apply "${MIGRATIONS[$next]}"
  next=$((next + 1))
  md5="$(body_md5)"
  apply_before "${BODIES[$((i + 1))]:-}"
  if [ "$i" -eq 0 ]; then
    psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" >"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
    psql_admin < "$AC/helpers.sql" >>"$LOGS/helpers.log" 2>&1 || { cat "$LOGS/helpers.log"; exit 1; }
  fi
  if [ -z "$md5" ] || [ "$(body_md5)" != "$md5" ]; then
    echo "FAILED: a migration after $file replaces remove_plaid_item_local before the next body in BODIES; add it to BODIES"; exit 1
  fi
  for seen in ${SEEN[@]+"${SEEN[@]}"}; do
    [ "$seen" = "$md5" ] && { echo "FAILED: $file did not install a new body of remove_plaid_item_local ($md5)"; exit 1; }
  done
  SEEN+=("$md5")
  echo
  echo "remove_plaid_item_local body: $md5 ($file)"
  for e in "${EXPECT[@]}"; do
    IFS='|' read -r body scenario dtr dtw d v f <<<"$e"
    [ "$body" = "$label" ] && run_case "$body" "$scenario" "$dtr" "$dtw" "$d" "$v" "$f"
  done
  for e in "${EXTENT[@]}"; do
    IFS='|' read -r body user earlier <<<"$e"
    [ "$body" = "$label" ] && run_extent "$body" "$user" "$earlier"
  done
done

echo
printf '%-15s %-9s %-15s %-9s %-8s %-17s %s\n' BODY SCENARIO "TIMEOUT rem/wr" DEADLOCK VICTIM FINAL VERDICT
for s in "${SUMMARY[@]}"; do
  IFS='|' read -r a b c d e f g <<<"$s"
  printf '%-15s %-9s %-15s %-9s %-8s %-17s %s\n' "$a" "$b" "$c" "$d" "$e" "$f" "$g"
done
echo
printf '%-15s %-12s %-23s %s\n' BODY "USER'S ROW" "EARLIER REMOVAL'S ROW" VERDICT
for s in "${EXTENT_SUMMARY[@]}"; do
  IFS='|' read -r a b c d <<<"$s"
  printf '%-15s %-12s %-23s %s\n' "$a" "$b" "$c" "$d"
done
echo
if [ "${#SUMMARY[@]}" -ne "${#EXPECT[@]}" ] || [ "${#EXTENT_SUMMARY[@]}" -ne "${#EXTENT[@]}" ]; then
  echo "FAILED: ${#SUMMARY[@]} cases and ${#EXTENT_SUMMARY[@]} extent probes ran; ${#EXPECT[@]} and ${#EXTENT[@]} are documented (a body that is not in BODIES?)"; overall=1
fi
if [ "$overall" -eq 0 ]; then
  echo "all ${#SUMMARY[@]} cases and ${#EXTENT_SUMMARY[@]} extent probes as documented"
else
  echo "FAILED: at least one case or probe failed or differs from what is documented"
fi
exit "$overall"

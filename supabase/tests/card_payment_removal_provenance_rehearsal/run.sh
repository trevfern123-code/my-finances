#!/usr/bin/env bash
# Upgrade / use / rollback / use / re-apply / use rehearsal, on a POPULATED database, for
#   20261008120000_card_payment_removal_provenance.sql   (institution removal records the source of what it preserves)
# and its rollback script, on top of 20261006120000 (Revision 5), whose own rehearsal is
# supabase/tests/lim_removal_matching_rehearsal. Nothing here touches any real database: one throwaway
# container of Supabase's PostgreSQL 17 image, holding the rehearsed database and its twin. Not run in CI.
#
#   supabase/tests/card_payment_removal_provenance_rehearsal/run.sh
#
# The fixture (r0_baseline.sql has the cases): a user with a kept institution and SIX card institutions,
# removed one after the other — two by Revision 5 before the migration, two by the new body, one by Revision 5
# while the migration is rolled back, one by the new body applied again — and a second user with one removal.
# Every step asserts exact identities: which decision, which removal, which removed account and transaction.
#
#   R0  Baseline: every migration up to and including 20261006120000, each in one transaction, as postgres;
#       populated; two institutions already removed by Revision 5. Their rows — two holds and a record —
#       have no provenance. One of those holds is on a pair that R2 protects again.
#       THE TWIN: the baseline database is then copied, whole, into a second database of the same container
#       (CREATE DATABASE … TEMPLATE). The twin never gets 20261008120000: it stays on Revision 5.
#   R1  20261008120000 BEFORE 20261006120000 is refused by its guard. That state is built BY ORDERING, on the
#       rehearsed database itself: the migration is offered while the history stops at 20261006110000, before
#       20261006120000 is applied and before anything is populated. Applied on Revision 5 it succeeds: no row
#       of any existing table changed (a digest of every row of every table of schema public and of
#       auth.users); the two new tables exist, empty; of every definition that existed, one changed — the
#       removal function, in its body alone; the body is the one the migration's postcondition names. Applied
#       a second time it is refused: the body is no longer Revision 5's.
#   R2  The same three removals (r2_removals.sql) on the twin and on the upgraded database: two of the first
#       user, one of the second. The first removal under the new body writes two markers — one for each
#       Revision 5 removal, in the order they were cleaned — and then its generation, third in the user's
#       order; the second writes its generation, the fourth, and no marker. One row per source where
#       Revision 5 merges (eleven rows for one institution where the twin has eight); one provenance row per
#       decision; two holds that differ only in their source, written in the byte order of its Plaid id. THE
#       DIFFERENTIAL: for both users, what the reader gives is what it gives in the twin, after normalising a
#       leg's decisionId and the decisions list (r2_upgraded.sql says exactly how and why), and nothing else.
#   R3  While the new body is installed the rollback scripts of 20261006120000 and of 20261006110000 are each
#       refused, with their exact messages — the second also when acknowledged. Nothing changed.
#   R4  The rollback script: Revision 5's body, byte for byte; no row of any table changed, both provenance
#       tables included; every other definition as the migration left it; its NOTICE gives the number of live
#       system rows that keep their provenance. Run a second time it is refused.
#   R5  A removal in the rolled-back interval (Revision 5's body): no generation and no provenance row. THE
#       HAZARD: its removed candidate has the pair and the date of two live holds that R2 attributed to
#       another removal's transaction, and it writes no hold of its own — shown by row id, and by the
#       counterfactual (without R2's holds it writes both; rolled back).
#   R6  The migration file's SQL run again: no row changed, every definition exactly as after the first
#       application. Before the next removal THE RULE of the migration's header excludes every attributed
#       system row of the user by its second clause (a cleaned removal without a generation row). The next
#       removal under the new body gives the interval's removal a MARKER, after both generations of R2 and
#       before its own; the rule then excludes exactly the rows of those two generations, row by row, and none
#       written after the marker — also where both kinds hold the same pair.
#   R7  The full rollback chain from the re-applied state, in order: 20261008120000's script, 20261006120000's,
#       20261006110000's (acknowledged in the same session, as lim_removal_matching_rehearsal shows). Each
#       succeeds; no row changed; both provenance tables survive with every row and every definition. Then,
#       observed and not approved: the evaluator before 20261006110000 reads two identical live holds on one
#       pair as conflicting_decisions where one hold reads not_cash_side, and its undo must be repeated per hold.
#
# Requires: docker, bash, GNU timeout (coreutils).
#   PG_IMAGE=<image>   default public.ecr.aws/supabase/postgres:17.6.1.155
#   KEEP=1             leave the container running afterwards
#   PSQL_TIMEOUT=s     default 300
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required to bound database waits"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-removal-provenance-rehearsal-$$"
TWIN="rehearsal_twin"
MIGRATION="$ROOT/supabase/migrations/20261008120000_card_payment_removal_provenance.sql"
ROLLBACK="$ROOT/supabase/rollback/20261008120000_card_payment_removal_provenance_rollback.sql"
PREDECESSOR="$ROOT/supabase/migrations/20261006120000_lim_removal_card_payment_matching.sql"
PREDECESSOR_ROLLBACK="$ROOT/supabase/rollback/20261006120000_lim_removal_card_payment_matching_rollback.sql"
SCHEMA_ROLLBACK="$ROOT/supabase/rollback/20261006110000_card_payment_pair_counterpart_removed_rollback.sql"
LOGS="$(mktemp -d)"
cleanup() { if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi; rm -rf "$LOGS"; }
trap cleanup EXIT
PSQL_TIMEOUT="${PSQL_TIMEOUT:-300}"
bounded() { timeout "$PSQL_TIMEOUT" "$@"; local rc=$?; [ "$rc" -eq 124 ] && echo "TIMEOUT: exceeded ${PSQL_TIMEOUT}s" >&2; return "$rc"; }
psql_db() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
psql_twin() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$TWIN" "$@"; }
psql_admin() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; }
step() { # $1 = label, then a command; prints PASS/FAIL, what the step reported, and the transcript on failure
  local label="$1"; shift
  if "$@" >"$LOGS/step.log" 2>&1; then echo "PASS  $label"; sed -n 's/^REPORT  /      | /p' "$LOGS/step.log"
  else echo "FAIL  $label"; sed 's/^/      | /' "$LOGS/step.log"; exit 1; fi
}

# The three bodies of remove_plaid_item_local this rehearsal passes through, each by the checksum that the
# file which installs it verifies in its own postcondition. None is written here.
checksum_before() { # $1 = file, $2 = a message; the last checksum literal the file has before it raises that message
  local line
  line="$(grep -n -F -- "$2" "$1" | head -n 1 | cut -d: -f1)"
  [ -n "$line" ] && head -n "$line" "$1" | grep -oE '[0-9a-f]{32}' | tail -n 1
}
NEW_BODY="$(checksum_before "$MIGRATION" "remove_plaid_item_local is not the definition this migration installs")"
REVISION5_BODY="$(checksum_before "$PREDECESSOR" "remove_plaid_item_local is not the definition this migration installs")"
ORIGINAL_BODY="$(checksum_before "$PREDECESSOR_ROLLBACK" "rollback did not restore the 20260926120000 definition exactly")"
for sum in "$NEW_BODY" "$REVISION5_BODY" "$ORIGINAL_BODY"; do
  [[ "$sum" =~ ^[0-9a-f]{32}$ ]] || { echo "FAILED: could not read a body checksum from the migration and rollback files"; exit 1; }
done
# The files agree with each other about them: what the migration replaces and what its rollback restores is
# the body 20261006120000 installs, and what its rollback replaces is the body the migration installs.
[ "$(checksum_before "$MIGRATION" "remove_plaid_item_local is not the 20261006120000 definition; refusing to replace it")" = "$REVISION5_BODY" ] \
  && [ "$(checksum_before "$ROLLBACK" "remove_plaid_item_local is not the 20261008120000 definition; refusing to roll back")" = "$NEW_BODY" ] \
  && [ "$(checksum_before "$ROLLBACK" "rollback did not restore the 20261006120000 definition exactly")" = "$REVISION5_BODY" ] \
  && [ "$NEW_BODY" != "$REVISION5_BODY" ] && [ "$REVISION5_BODY" != "$ORIGINAL_BODY" ] && [ "$NEW_BODY" != "$ORIGINAL_BODY" ] \
  || { echo "FAILED: the migration, its rollback script and 20261006120000 do not name the same bodies"; exit 1; }

echo "image: $IMAGE   container: $CONTAINER"
echo "remove_plaid_item_local: 20260926120000 $ORIGINAL_BODY   20261006120000 (Revision 5) $REVISION5_BODY   20261008120000 $NEW_BODY"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + 180))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not start"; docker logs --tail 40 "$CONTAINER"; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1; done
sleep 3

# Every migration that sorts before 20261006120000.
apply_history() {
  local f
  for f in "$ROOT"/supabase/migrations/*.sql; do
    [ "$f" = "$PREDECESSOR" ] && return 0
    bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" || { echo "migration $(basename "$f") failed"; return 1; }
  done
  echo "20261006120000 is not among the migrations"; return 1
}
# A migration file: one transaction per file (psql -1), as the harnesses and `supabase db push` apply them.
apply_file() { bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"; }
# A rollback script: its own explicit transaction, run WITHOUT -1, exactly as its header instructs.
apply_script() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"; }
# The 20261006110000 rollback with its acknowledgement, exactly as its header instructs: the setting is issued
# by psql -c in the SAME session, before the file (-f -, the script on stdin) runs its own BEGIN.
apply_script_acknowledged() {
  bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "set i3a.rollback_with_live_holds = 'acknowledged'" -f - < "$1"
}
helpers() {
  psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" && psql_admin < "$ROOT/supabase/tests/access_control/helpers.sql" \
    && psql_admin < "$ROOT/supabase/tests/access_control/seed.sql" && psql_db < "$HERE/helpers.sql"
}
# One of this directory's files, on the rehearsed database or on its twin, with the three checksums and any
# further psql variables ($2…).
sql() { local file="$1"; shift; psql_db -v new_body="$NEW_BODY" -v revision5_body="$REVISION5_BODY" -v original_body="$ORIGINAL_BODY" "$@" -f - < "$HERE/$file"; }
twin_sql() { psql_twin -v new_body="$NEW_BODY" -v revision5_body="$REVISION5_BODY" -v original_body="$ORIGINAL_BODY" -f - < "$HERE/$1"; }
# A file that must be REFUSED by its own guard: the run must fail, and its one error must be exactly the given
# message. (That nothing changed is asserted by the step that follows.)
refused() { # $1 = applier, $2 = file, $3 = the exact message
  if "$1" "$2" >"$LOGS/refused.log" 2>&1; then echo "it was applied, but its guard should have refused it"; return 1; fi
  [ "$(sed -n 's/^.*ERROR:  //p' "$LOGS/refused.log" | tr -d '\r')" = "$3" ] || { echo "refused, but not with exactly: $3"; cat "$LOGS/refused.log"; return 1; }
  echo "REPORT  ERROR:  $3"
}
# A file that must be APPLIED and must have said exactly the given line at the given level.
applied_saying() { # $1 = applier, $2 = file, $3 = NOTICE or WARNING, $4 = the exact text
  "$1" "$2" >"$LOGS/applied.log" 2>&1 || { echo "it did not apply:"; cat "$LOGS/applied.log"; return 1; }
  sed -n "s/^.*$3:  //p" "$LOGS/applied.log" | tr -d '\r' | grep -qxF -- "$4" || { echo "applied, but without saying exactly ($3): $4"; cat "$LOGS/applied.log"; return 1; }
  echo "REPORT  $3:  $4"
}
# The migration applied AGAIN, over the tables its rollback kept: it must apply, and every NOTICE it raises
# must be one of its own repeatable statements finding its object there — the two tables and their three indexes.
reapplied() {
  apply_file "$MIGRATION" >"$LOGS/applied.log" 2>&1 || { echo "it did not apply:"; cat "$LOGS/applied.log"; return 1; }
  local want got
  want="$(printf 'relation "%s" already exists, skipping\n' card_payment_removal_generations card_payment_removal_generations_user_idx \
            card_payment_removal_sources card_payment_removal_sources_source_idx card_payment_removal_sources_user_idx | LC_ALL=C sort)"
  got="$(sed -n 's/^.*NOTICE:  //p' "$LOGS/applied.log" | tr -d '\r' | LC_ALL=C sort)"
  [ "$got" = "$want" ] || { echo "applied, but its notices are not the five expected:"; cat "$LOGS/applied.log"; return 1; }
  printf '%s\n' "$got" | sed 's/^/REPORT  NOTICE:  /'
}
# The twin: the rehearsed database, copied whole. CREATE DATABASE … TEMPLATE refuses a template that any other
# session is connected to, and Supabase's image keeps two background workers on `postgres` (pg_net, pg_cron).
# They are terminated in the session that makes the copy, right before it; the postmaster restarts both, and
# a worker that restarts first only makes the attempt fail, so it is repeated.
copy_into_twin() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if psql_admin >"$LOGS/twin.log" 2>&1 <<SQL
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid();
create database $TWIN owner postgres template postgres;
SQL
    then twin_sql r0_twin.sql; return; fi
    sleep 2
  done
  cat "$LOGS/twin.log"; return 1
}
# What the twin kept of its readings, copied into the rehearsed database (COPY's text format, unchanged).
copy_twin_readings() {
  psql_twin -c "copy (select moment, usr, listed, doc from rehearsal.readings order by moment, usr) to stdout" </dev/null >"$LOGS/twin_readings.copy" || return 1
  [ "$(wc -l <"$LOGS/twin_readings.copy")" -eq 4 ] || { echo "the twin kept $(wc -l <"$LOGS/twin_readings.copy") readings, not four"; return 1; }
  psql_db -c "copy rehearsal.twin_readings from stdin" <"$LOGS/twin_readings.copy"
}

step "R0  baseline: every migration before 20261006120000" apply_history
step "R0  helpers and seed" helpers
step "R1  (by ordering) 20261008120000 before 20261006120000: refused by its guard" refused apply_file "$MIGRATION" "remove_plaid_item_local is not the 20261006120000 definition; refusing to replace it"
step "R1  (by ordering) and it left nothing: the 20260926120000 body, no provenance table, no trigger function" sql r1_before_revision5.sql
step "R0  baseline: 20261006120000 (Revision 5) applied" apply_file "$PREDECESSOR"
step "R0  baseline populated under Revision 5: a kept institution and six card institutions, two of them already removed — two holds and a record without provenance; a second user" sql r0_baseline.sql
step "R0  the twin: the baseline database copied into a second database, row for row and definition for definition; it stays on Revision 5" copy_into_twin
step "R1  upgrade: 20261008120000 applied on Revision 5" apply_file "$MIGRATION"
step "R1  upgraded: no row changed; both new tables exist, empty; of every existing definition only the removal function changed, in its body; the body is the one the postcondition names" sql r1_upgraded.sql
step "R1  upgrade again: refused by the guard — the body is no longer Revision 5's" refused apply_file "$MIGRATION" "remove_plaid_item_local is not the 20261006120000 definition; refusing to replace it"
step "R2  the twin (Revision 5): the three removals; every published reading as derived by hand" twin_sql r2_removals.sql
step "R2  the twin (Revision 5) wrote eight rows for the first institution — it merged two removed candidates with one date, and into a live hold and a live record of the earlier removals — and one for the second" twin_sql r2_twin.sql
step "R2  new body: the same three removals; every published reading as derived by hand — the same expectations" sql r2_removals.sql
step "R2  the twin's readings copied into the rehearsed database" copy_twin_readings
step "R2  new body: two markers and then the generation, third in the user's order, and the second removal's, fourth; eleven rows for the first institution, one per source, each with exactly one provenance row and exact identities; DIFFERENTIAL — both users read exactly what they read under Revision 5" sql r2_upgraded.sql
step "R3  rollback of 20261006120000 while the new body is installed: refused by its guard" refused apply_script "$PREDECESSOR_ROLLBACK" "remove_plaid_item_local is not the 20261006120000 definition; refusing to roll back"
step "R3  rollback of 20261006110000 while the new body is installed: refused by its guard" refused apply_script "$SCHEMA_ROLLBACK" "remove_plaid_item_local is not the 20260926120000 definition: roll back 20261006120000 first"
step "R3  rollback of 20261006110000, acknowledged: refused all the same" refused apply_script_acknowledged "$SCHEMA_ROLLBACK" "remove_plaid_item_local is not the 20260926120000 definition: roll back 20261006120000 first"
step "R3  the three refusals changed nothing: no row, no definition, the new body" sql r3_refused.sql
step "R4  rollback: 20261008120000 rolled back; its NOTICE counts thirteen live system rows that keep their provenance" applied_saying apply_script "$ROLLBACK" NOTICE "remove_plaid_item_local is the 20261006120000 definition again. 13 live system row(s) keep their provenance. Removals made until 20261008120000 is applied again record none, and may merge into those rows; they are marked when it is applied again."
step "R4  rolled back: Revision 5's body, byte for byte; no row changed — both provenance tables and every row in them kept; every other definition kept; every reading unchanged" sql r4_rolled_back.sql
step "R4  rollback again: refused by the guard" refused apply_script "$ROLLBACK" "remove_plaid_item_local is not the 20261008120000 definition; refusing to roll back"
step "R5  a removal while rolled back (Revision 5): no generation, no provenance row; THE HAZARD — its candidate has the pair and date of two live attributed holds of R2, and it writes no hold of its own (by row id; the counterfactual writes both)" sql r5_interval.sql
step "R6  re-apply: the migration file's SQL run again; its only notices are its repeatable statements finding their objects" reapplied
step "R6  re-applied: the new body; no row changed; every definition exactly as after the first application; before the next removal THE RULE excludes every attributed system row of the user (a cleaned removal without a generation row)" sql r6_reapplied.sql
step "R6  the next removal under the new body: a MARKER for the interval's removal, ordinal 5, after R2's generations (3, 4) and before its own (6); THE RULE, row by row, excludes exactly the rows of generations 3 and 4 and none written after the marker" sql r6_next_removal.sql
step "R7  chain 1/3: rollback of 20261008120000 from the re-applied state; its NOTICE counts fourteen live system rows" applied_saying apply_script "$ROLLBACK" NOTICE "remove_plaid_item_local is the 20261006120000 definition again. 14 live system row(s) keep their provenance. Removals made until 20261008120000 is applied again record none, and may merge into those rows; they are marked when it is applied again."
step "R7  chain 1/3: Revision 5's body; no row changed; the provenance tables whole" sql r7_rolled_back.sql -v label=r7_a -v body="$REVISION5_BODY" -v same_as=r6
step "R7  chain 2/3: rollback of 20261006120000 — accepted now" apply_script "$PREDECESSOR_ROLLBACK"
step "R7  chain 2/3: the 20260926120000 body; no row changed; the provenance tables whole" sql r7_rolled_back.sql -v label=r7_b -v body="$ORIGINAL_BODY" -v same_as=r7_a
step "R7  chain 3/3: rollback of 20261006110000, acknowledged in the same session; it warns about ten live holds and one live preserved pair" applied_saying apply_script_acknowledged "$SCHEMA_ROLLBACK" WARNING "rolling back 20261006110000 over 10 live ambiguity hold(s) and 1 live pair_counterpart_removed decision(s): the previous evaluator and RPCs do not know these kinds (this file's header says what they do with them) until the migration is applied again"
step "R7  the whole chain changed no row; both provenance tables survive it with every row and every definition. OBSERVED under the previous evaluator: two identical live holds on one pair read conflicting_decisions, one hold reads not_cash_side, and an undo must be repeated per hold" sql r7_previous_evaluator.sql
# Evidence that every phase ran to its end: all the snapshots exist.
evidence() {
  [ "$(psql_db -At -c "select count(distinct label) from rehearsal.snap" </dev/null)" = "16" ] \
    && [ "$(psql_twin -At -c "select count(distinct label) from rehearsal.snap" </dev/null)" = "2" ]
}
step "evidence: all sixteen snapshots taken, and the twin's two" evidence
echo
echo "rehearsal passed"

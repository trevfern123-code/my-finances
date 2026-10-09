#!/usr/bin/env bash
# Upgrade / rollback / re-apply rehearsal, on a POPULATED database, for the two I3A migrations:
#   20261006110000_card_payment_pair_counterpart_removed.sql  (the decision kinds, the evaluator, three RPCs)
#   20261006120000_lim_removal_card_payment_matching.sql      (institution removal)
# 20261008120000_card_payment_removal_provenance.sql builds on the second and is never applied here: this
# rehearsal ends before it (its own is supabase/tests/card_payment_removal_provenance_rehearsal).
# Nothing here touches any real database: one throwaway container of Supabase's PostgreSQL 17 image. Not run
# in CI.
#
#   supabase/tests/lim_removal_matching_rehearsal/run.sh
#
#   1. Build the supported baseline: every migration before 20261006110000, each in one transaction, as
#      postgres. Then populate it (baseline.sql): a user with three card institutions and payments to each
#      from a kept checking account, a USER-confirmed pair with a competing card leg, an "unlinked" decision,
#      for each institution an unresolved payment that its card and the kept card both fit (a tie), a
#      manual-loan link, a second user; everything evaluated; all three removals taken to plaid_removed.
#      For revision 5 (Option B): the payment that is matched automatically to the SECOND institution has a
#      kept card leg that was already there and fits less well, and a bystander payment is tied between that
#      kept leg and a leg on a second kept card.
#   2. baseline.sql also removes the FIRST institution with the previous function: the payment to it
#      loses its destination, its tie is resolved to the kept card by the deletion, and the user is left
#      stale. (What these migrations change.)
#   3. Upgrade 20261006110000. upgraded_schema.sql: no row changed; re-evaluating the same rows with the new
#      evaluator gives exactly the previous states; applying it again is refused by its guard.
#   4. Upgrade 20261006120000. upgraded.sql: no row changed; the SECOND institution's removal preserves the
#      automatic destination (system record) and the user-confirmed pair (the user's decision), writes a
#      system ambiguity hold for its tie (which stays unresolved), and commits fresh; applying it again is
#      refused; rolling back 20261006110000 underneath it is refused. Revision 5: the automatically matched
#      payment also gets a hold against the kept card leg that was already there, reads its removed
#      destination (a figure) and is not switched; the bystander stays tied.
#   5. Roll back 20261006120000. rolled_back.sql: the previous body, byte for byte; no row changed; what
#      step 4 wrote is still there and still honoured — every reading unchanged; the THIRD institution's
#      removal behaves as in step 2; running the rollback again is refused.
#   6. Roll back 20261006110000. While live ambiguity holds exist it is REFUSED unless the operator has
#      acknowledged it in the same session (set i3a.rollback_with_live_holds = 'acknowledged'): refused with
#      no value and with another value; with the acknowledgement, set by psql -c before the file's own BEGIN,
#      it proceeds and raises a WARNING with the counts. One acknowledgement serves one run, and that is
#      shown first: in ONE session the acknowledged rollback is applied, 20261006110000 is applied again, and
#      the rollback is run once more — refused, because the first run cleared the setting. That leaves the
#      database as it was, and the acknowledged rollback the rehearsal continues from is run after it.
#      rolled_back_schema.sql: the previous evaluator and
#      RPC bodies, byte for byte; NO ROW CHANGED — the preserved user decision and the holds stay, with their
#      columns. Then what that rollback's header warns about: the previous evaluator still holds the
#      preserved leg but reads it unresolved, and reads a hold as an inactive decision that claims both of
#      its legs — so the payment with a known removed destination reads unresolved (a range), and the
#      bystander payment, on no held pair, is published as automatically matched: a figure the evidence
#      does not support. The previous RPCs do not supersede the one and do not refuse to undo the other.
#      Running the rollback again is refused.
#   7. Re-apply both files (their guards accept the restored bodies; the DDL is repeatable). reapplied.sql:
#      the new bodies again, no row changed, the preserved decision and the holds understood again, the
#      known destination a figure again and the bystander tied again; and what a hold undone during the
#      rolled-back interval would leave behind (the payment switched to the kept card leg, for good).
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
CONTAINER="lim-removal-matching-rehearsal-$$"
SCHEMA_MIGRATION="$ROOT/supabase/migrations/20261006110000_card_payment_pair_counterpart_removed.sql"
SCHEMA_ROLLBACK="$ROOT/supabase/rollback/20261006110000_card_payment_pair_counterpart_removed_rollback.sql"
MIGRATION="$ROOT/supabase/migrations/20261006120000_lim_removal_card_payment_matching.sql"
ROLLBACK="$ROOT/supabase/rollback/20261006120000_lim_removal_card_payment_matching_rollback.sql"
LATER_MIGRATION="$ROOT/supabase/migrations/20261008120000_card_payment_removal_provenance.sql"
LOGS="$(mktemp -d)"
cleanup() { if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1; fi; rm -rf "$LOGS"; }
trap cleanup EXIT
PSQL_TIMEOUT="${PSQL_TIMEOUT:-300}"
bounded() { timeout "$PSQL_TIMEOUT" "$@"; local rc=$?; [ "$rc" -eq 124 ] && echo "TIMEOUT: exceeded ${PSQL_TIMEOUT}s" >&2; return "$rc"; }
psql_db() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
psql_admin() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; }
step() { # $1 = label, then a command; prints PASS/FAIL and the transcript on failure
  local label="$1"; shift
  if "$@" >"$LOGS/step.log" 2>&1; then echo "PASS  $label"; else echo "FAIL  $label"; sed 's/^/      | /' "$LOGS/step.log"; exit 1; fi
}

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + 180))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not start"; docker logs --tail 40 "$CONTAINER"; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1; done
sleep 3

apply_baseline() {
  local f
  for f in "$ROOT"/supabase/migrations/*.sql; do
    [ "$f" = "$MIGRATION" ] && continue
    [ "$f" = "$SCHEMA_MIGRATION" ] && continue
    [ "$f" = "$LATER_MIGRATION" ] && continue
    bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" || { echo "migration $(basename "$f") failed"; return 1; }
  done
}
# A migration file: one transaction per file (psql -1), as the harnesses and `supabase db push` apply them.
apply_file() { bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"; }
# The rollback script: its own explicit transaction, run WITHOUT -1, exactly as its header instructs.
apply_script() { bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"; }
helpers() {
  psql_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" && psql_admin < "$ROOT/supabase/tests/access_control/helpers.sql" \
    && psql_admin < "$ROOT/supabase/tests/access_control/seed.sql"
}
# A file that must be REFUSED by its own guard: the run must fail, with the expected message, and change nothing.
refused() { # $1 = applier, $2 = file, $3 = expected message fragment
  if "$1" "$2" >"$LOGS/refused.log" 2>&1; then echo "it was applied, but its guard should have refused it"; return 1; fi
  grep -q "$3" "$LOGS/refused.log" || { echo "refused, but not by the guard:"; cat "$LOGS/refused.log"; return 1; }
}
# The 20261006110000 rollback while live ambiguity holds exist, exactly as its header instructs: the setting
# is issued by psql -c in the SAME session, before the file (-f -, the script on stdin) runs its own BEGIN.
# $1 = the value to set, $2 = file.
apply_script_with_setting() {
  bounded docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "set i3a.rollback_with_live_holds = '$1'" -f - < "$2"
}
apply_script_not_acknowledged() { apply_script_with_setting "yes" "$1"; }
# It must be APPLIED, and must have said what it ran over: every fragment given is in its output.
acknowledged() { # $1 = file, then the expected fragments of its WARNING
  local file="$1" fragment; shift
  apply_script_with_setting "acknowledged" "$file" >"$LOGS/acknowledged.log" 2>&1 || { echo "it was acknowledged, but did not apply:"; cat "$LOGS/acknowledged.log"; return 1; }
  for fragment in "$@"; do
    grep -q "$fragment" "$LOGS/acknowledged.log" || { echo "applied, but without the expected warning ($fragment):"; cat "$LOGS/acknowledged.log"; return 1; }
  done
}
# One acknowledgement serves one run. ONE session, in this order: the setting; the rollback script (applied —
# its WARNING is in the output); 20261006110000 again, in one transaction; the rollback script once more, with
# nothing set in between. The first run cleared the setting when it committed, so the second must be refused by
# the hold guard, and the session ends there: 20261006110000 is applied, as before this step.
# $1 = the rollback script, $2 = the migration, $3 = the WARNING of the first run, $4 = the refusal of the second.
acknowledged_once() {
  { printf "set i3a.rollback_with_live_holds = 'acknowledged';\n"; cat "$1"; printf '\nbegin;\n'; cat "$2"; printf '\ncommit;\n'; cat "$1"; } >"$LOGS/once.sql"
  if apply_script "$LOGS/once.sql" >"$LOGS/once.log" 2>&1; then echo "the second run was applied, but the first should have consumed the acknowledgement"; return 1; fi
  [ "$(grep -c "$3" "$LOGS/once.log")" = 1 ] || { echo "the first, acknowledged run did not apply exactly once:"; cat "$LOGS/once.log"; return 1; }
  grep -q "$4" "$LOGS/once.log" || { echo "the second run failed, but not by the acknowledgement guard:"; cat "$LOGS/once.log"; return 1; }
}

step "baseline: every migration before 20261006110000" apply_baseline
step "helpers and seed" helpers
step "baseline: populated, evaluated; the previous function loses a destination, resolves a tie by deleting a candidate, and leaves the user stale" psql_db -f - < "$HERE/baseline.sql"
step "removal migration before the schema migration: refused by its guard" refused apply_file "$MIGRATION" "apply 20261006110000 first"
step "schema upgrade: 20261006110000 applied" apply_file "$SCHEMA_MIGRATION"
step "schema upgraded: no row changed; the new evaluator gives exactly the previous states" psql_db -f - < "$HERE/upgraded_schema.sql"
step "schema upgrade again: refused by the guard" refused apply_file "$SCHEMA_MIGRATION" "not the 20261002120000 definition"
step "upgrade: 20261006120000 applied" apply_file "$MIGRATION"
step "upgraded: no row changed; a removal now preserves the destination and the user's pair, holds a tie instead of resolving it, and commits fresh" psql_db -f - < "$HERE/upgraded.sql"
step "upgrade again: refused by the guard" refused apply_file "$MIGRATION" "not the 20260926120000 definition"
step "schema rollback underneath the removal function: refused by the guard" refused apply_script "$SCHEMA_ROLLBACK" "roll back 20261006120000 first"
step "rollback: 20261006120000 rolled back" apply_script "$ROLLBACK"
step "rolled back: previous body restored exactly; no row changed; what was preserved or held is still honoured" psql_db -f - < "$HERE/rolled_back.sql"
step "rollback again: refused by the guard" refused apply_script "$ROLLBACK" "not the 20261006120000 definition"
step "schema rollback with live ambiguity holds, not acknowledged: refused by the guard, which says how many and how to acknowledge" refused apply_script "$SCHEMA_ROLLBACK" "refusing to roll back 20261006110000: 2 live ambiguity hold(s) exist.*set i3a.rollback_with_live_holds = 'acknowledged';"
grep -h "refusing to roll back" "$LOGS/refused.log" | sed 's/^/      | /'
step "schema rollback with live ambiguity holds, another value set: refused by the guard" refused apply_script_not_acknowledged "$SCHEMA_ROLLBACK" "refusing to roll back 20261006110000: 2 live ambiguity hold(s) exist"
step "schema rollback, acknowledged once, then 20261006110000 applied again and the rollback run again in the SAME session: the second run is refused — the first consumed the acknowledgement" acknowledged_once "$SCHEMA_ROLLBACK" "$SCHEMA_MIGRATION" "rolling back 20261006110000 over 2 live ambiguity hold(s) and 1 live pair_counterpart_removed decision(s)" "refusing to roll back 20261006110000: 2 live ambiguity hold(s) exist"
step "schema rollback: 20261006110000 rolled back — acknowledged in the same session before the file's BEGIN; it warns about 2 live holds and 1 live preserved pair" acknowledged "$SCHEMA_ROLLBACK" "WARNING" "rolling back 20261006110000 over 2 live ambiguity hold(s) and 1 live pair_counterpart_removed decision(s)"
grep -h "WARNING" "$LOGS/acknowledged.log" | sed 's/^/      | /'
step "schema rolled back: previous bodies exactly; no row changed; the preserved decision and the holds are kept, their legs held and read as unresolved; a known destination became a range and a bystander got a figure the evidence does not support" psql_db -f - < "$HERE/rolled_back_schema.sql"
step "schema rollback again: refused by the guard" refused apply_script "$SCHEMA_ROLLBACK" "not the 20261006110000 definitions"
step "re-apply: 20261006110000 applied again (its DDL is repeatable)" apply_file "$SCHEMA_MIGRATION"
step "re-apply: 20261006120000 applied again" apply_file "$MIGRATION"
step "re-applied: the new bodies again; no row changed; the preserved decision and the holds are understood again; the known destination is a figure again and the bystander is tied again" psql_db -f - < "$HERE/reapplied.sql"
# Evidence that every phase ran to its end: all the snapshots exist.
evidence() {
  [ "$(psql_db -At -c "select count(distinct label) from rehearsal.snap")" = "15" ]
}
step "evidence: all fifteen snapshots taken" evidence
echo
echo "rehearsal passed"

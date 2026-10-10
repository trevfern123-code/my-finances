#!/usr/bin/env bash
# Negative controls of the packet 2-A database code (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §11).
#
#   supabase/tests/card_payment_recovery_review/mutations.sh            every mutant
#   supabase/tests/card_payment_recovery_review/mutations.sh m05 m21    only mutants whose id starts with a prefix
#
# One throwaway database with the UNMUTATED migration history. Then:
#   1. BASELINE   every test a mutant names is run unmutated and must pass (otherwise the controls prove nothing);
#   2. MUTANTS    each one (mutants.cjs) is applied — an altered function body, or DDL —, its tests are run, and it
#                 is restored. It is
#                     DETECTED            when the test fails on the NAMED assertion,
#                     FAILED DIFFERENTLY  when the test fails, but not on that assertion (shown; not a detection),
#                     SURVIVED            when the test passes,
#                     NOT APPLIED         when the mutant itself could not be installed (a setup failure);
#   3. RESTORED   the baseline tests are run once more and must pass: every mutant was undone;
#   4. ROLLBACK   two mutants of the rollback script are rehearsed (rehearsal.sh): one that does not refuse while
#                 review obligations exist, one that does not install the fence. The rehearsal must fail at the
#                 named step.
# Exit status 0 only when every mutant was DETECTED.
#
# Requires docker, bash, node, GNU timeout.   PG_IMAGE, LOGDIR, STARTUP_TIMEOUT, PSQL_TIMEOUT: as run.sh.
#   SKIP_ROLLBACK_MUTANTS=1   leave step 4 out (the runner says so).
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAILED: node is required"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres@sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b}"
CONTAINER="recovery-review-mutations-$$"
LOGS="${LOGDIR:-$(mktemp -d)}"
WORK="$(mktemp -d)"
mkdir -p "$LOGS"
MIGRATION="$ROOT/supabase/migrations/20261009120000_card_payment_recovery_review.sql"
ROLLBACK="$ROOT/supabase/rollback/20261009120000_card_payment_recovery_review_rollback.sql"
SEED="$ROOT/supabase/tests/access_control/seed.sql"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-600}"
psql_as() { local role="$1"; shift; timeout "$PSQL_TIMEOUT" docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$role" -d postgres "$@"; }

FILTERS=("$@")
wanted() {
  local name="$1" f
  [ "${#FILTERS[@]}" -eq 0 ] && return 0
  for f in "${FILTERS[@]}"; do case "$name" in "$f"*) return 0 ;; esac; done
  return 1
}

node "$HERE/mutants.cjs" "$MIGRATION" "$WORK/mutants" || { echo "FAILED: the mutants could not be built (an anchor is gone?)"; exit 1; }

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + STARTUP_TIMEOUT))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not start"; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql_as postgres -1 < "$f" >>"$LOGS/history.log" 2>&1 || { echo "FAILED to apply $(basename "$f")"; tail -5 "$LOGS/history.log"; exit 1; }
done
{ psql_as supabase_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" && psql_as supabase_admin < "$ROOT/supabase/tests/access_control/helpers.sql" \
  && psql_as supabase_admin < "$HERE/helpers.sql"; } >"$LOGS/helpers.log" 2>&1 || { echo "FAILED to load the helpers"; cat "$LOGS/helpers.log"; exit 1; }
echo "unmutated history applied"

# run_test <prefix> <log>  — seeds, runs sql/<prefix>*.sql; status 0 when it passes
run_test() {
  local file
  file="$(ls "$HERE"/sql/"$1"*.sql 2>/dev/null | head -1)"
  [ -n "$file" ] || { echo "no test file for $1" >"$2"; return 2; }
  # A test that a mutant stopped midway may have left its own test-only functions and triggers in `public`
  # (th_r…): remove them, so that the next test starts from the same schema as the first.
  psql_as postgres >"$2" 2>&1 <<'SQL' || return 3
do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'th\_r0%' loop
    execute 'drop function ' || f.sig || ' cascade';
  end loop;
end $$;
SQL
  psql_as supabase_admin < "$SEED" >>"$2" 2>&1 && psql_as postgres < "$file" >>"$2" 2>&1
}

TESTS="$(cut -f2 "$WORK/mutants/plan.tsv" | tr ' ' '\n' | sort -u)"
echo
echo "1. BASELINE (unmutated)"
for t in $TESTS; do
  if run_test "$t" "$LOGS/baseline-$t.log"; then echo "PASS  $t (unmutated)"; else
    echo "FAIL  $t (unmutated) — the controls cannot be run"; grep -E 'ERROR|ASSERTION' "$LOGS/baseline-$t.log" | head -5; exit 1
  fi
done

echo
echo "2. MUTANTS"
DETECTED=0; SURVIVED=0; DIFFERENT=0; NOT_APPLIED=0; RAN=0
SUMMARY="$LOGS/summary.tsv"; : >"$SUMMARY"
while IFS=$'\t' read -r id tests expected description; do
  [ -n "$id" ] || continue
  wanted "$id" || continue
  RAN=$((RAN + 1))
  if ! psql_as postgres -1 < "$WORK/mutants/$id.apply.sql" >"$LOGS/$id.apply.log" 2>&1; then
    echo "NOT APPLIED         $id — $description"; tail -3 "$LOGS/$id.apply.log" | sed 's/^/      | /'
    NOT_APPLIED=$((NOT_APPLIED + 1)); printf '%s\tnot_applied\t%s\t%s\n' "$id" "$tests" "$description" >>"$SUMMARY"
    psql_as postgres -1 < "$WORK/mutants/$id.restore.sql" >"$LOGS/$id.restore.log" 2>&1
    continue
  fi
  result=survived; seen=""
  for t in $tests; do
    if run_test "$t" "$LOGS/$id-$t.log"; then continue; fi
    seen="$(grep -m1 -E 'ERROR' "$LOGS/$id-$t.log" | cut -c1-200)"
    if grep -E 'ERROR' "$LOGS/$id-$t.log" | grep -qE -- "$expected"; then result=detected; break; fi
    result=different
  done
  if ! psql_as postgres -1 < "$WORK/mutants/$id.restore.sql" >"$LOGS/$id.restore.log" 2>&1; then
    echo "FAILED: mutant $id could not be undone; stopping"; tail -5 "$LOGS/$id.restore.log"; exit 1
  fi
  case "$result" in
    detected)  echo "DETECTED            $id — $description"; echo "                    by: $(grep -E 'ERROR' "$LOGS/$id-"*.log | grep -m1 -E -- "$expected" | sed 's/^[^:]*:ERROR: *//' | cut -c1-170)"; DETECTED=$((DETECTED + 1)) ;;
    different) echo "FAILED DIFFERENTLY  $id — $description"; echo "                    expected: $expected"; echo "                    got:      $seen"; DIFFERENT=$((DIFFERENT + 1)) ;;
    survived)  echo "SURVIVED            $id — $description"; echo "                    expected: $expected"; SURVIVED=$((SURVIVED + 1)) ;;
  esac
  printf '%s\t%s\t%s\t%s\n' "$id" "$result" "$tests" "$description" >>"$SUMMARY"
done <"$WORK/mutants/plan.tsv"

echo
echo "3. RESTORED (unmutated again)"
RESTORE_FAILED=0
for t in $TESTS; do
  if run_test "$t" "$LOGS/restored-$t.log"; then echo "PASS  $t (after every mutant was undone)"; else
    echo "FAIL  $t (after the mutants) — a mutant was not undone"; grep -E 'ERROR|ASSERTION' "$LOGS/restored-$t.log" | head -3; RESTORE_FAILED=1
  fi
done
docker rm -f "$CONTAINER" >/dev/null 2>&1

echo
ROLLBACK_DETECTED=0; ROLLBACK_RAN=0
if [ "${SKIP_ROLLBACK_MUTANTS:-0}" = 1 ] || [ "${#FILTERS[@]}" -gt 0 ]; then
  echo "4. ROLLBACK mutants: NOT RUN (SKIP_ROLLBACK_MUTANTS=1, or a filter was given)"
else
  echo "4. ROLLBACK mutants (rehearsal.sh with an altered rollback script)"
  node - "$ROLLBACK" "$WORK" <<'NODE' || { echo "FAILED: the rollback mutants could not be built"; exit 1; }
const fs = require('node:fs');
const [rollbackPath, work] = process.argv.slice(2);
const text = fs.readFileSync(rollbackPath, 'utf8').replace(/\r\n/g, '\n');
function once(s, a, b, id) {
  const i = s.indexOf(a);
  if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`${id}: anchor not found exactly once`);
  return s.slice(0, i) + b + s.slice(i + a.length);
}
fs.writeFileSync(`${work}/r1_no_refusal.sql`, once(text,
  "     and current_setting('card_payment.recovery_review_rollback', true) is distinct from 'fence_affected_owners' then",
  '     and false then', 'r1'));
fs.writeFileSync(`${work}/r2_no_fence.sql`, once(text,
  `    create trigger card_payment_recovery_downgrade_fence
      before insert or update on public.card_payment_eval_versions
      for each row execute function public.card_payment_recovery_downgrade_fence();`,
  '    null;', 'r2'));
NODE
  rollback_mutant() {  # <id> <file> <step that must fail> <description>
    ROLLBACK_RAN=$((ROLLBACK_RAN + 1))
    ROLLBACK_FILE="$2" LOGDIR="$LOGS/$1" PG_IMAGE="$IMAGE" bash "$HERE/rehearsal.sh" >"$LOGS/$1.out" 2>&1
    if grep -q "^FAIL  $3 " "$LOGS/$1.out" && ! grep -E '^FAIL  s(0|1|2)' "$LOGS/$1.out" >/dev/null; then
      echo "DETECTED            $1 — $4"; echo "                    by: rehearsal step $3: $(grep -A1 "^FAIL  $3 " "$LOGS/$1.out" | tail -1 | sed 's/^ *| *//' | cut -c1-150)"
      ROLLBACK_DETECTED=$((ROLLBACK_DETECTED + 1)); printf '%s\tdetected\trehearsal %s\t%s\n' "$1" "$3" "$4" >>"$SUMMARY"
    else
      echo "SURVIVED            $1 — $4 (the rehearsal did not fail at $3)"; grep -E '^(PASS|FAIL)' "$LOGS/$1.out" | sed 's/^/      | /'
      printf '%s\tsurvived\trehearsal %s\t%s\n' "$1" "$3" "$4" >>"$SUMMARY"
    fi
  }
  rollback_mutant r1_rollback_does_not_refuse "$WORK/r1_no_refusal.sql" s3a "the rollback proceeds without the operator's setting while review obligations exist"
  rollback_mutant r2_rollback_installs_no_fence "$WORK/r2_no_fence.sql" s4a "the rollback, with the setting, restores the previous evaluator and installs no fence"
fi

echo
echo "database mutants: $RAN run — $DETECTED detected, $DIFFERENT failed differently, $SURVIVED survived, $NOT_APPLIED not applied"
echo "rollback mutants: $ROLLBACK_RAN run — $ROLLBACK_DETECTED detected"
echo "transcripts: $LOGS   (summary.tsv)"
[ "$RESTORE_FAILED" -eq 0 ] || exit 1
[ "$RAN" -gt 0 ] || { echo "FAILED: no mutant matched"; exit 1; }
[ "$DETECTED" -eq "$RAN" ] && [ "$ROLLBACK_DETECTED" -eq "$ROLLBACK_RAN" ] || exit 1

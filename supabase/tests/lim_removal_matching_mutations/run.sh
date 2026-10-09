#!/usr/bin/env bash
# Negative controls (mutation check) for institution removal — remove_plaid_item_local as it is INSTALLED at
# the end of the migration history, the body of 20261008120000_card_payment_removal_provenance.sql (the removal
# that records the provenance of what it preserves) — and for the evaluator of the decision kinds it writes
# (20261006110000). Would the tests notice a deletion
# without preservation, a user-confirmed pair dropped or downgraded to the system record, a waiting,
# amount-changed or ambiguous confirmation released, the mirror case dropped, a superseded confirmation
# resurrected, a competitor allowed to auto-match, a missing version bump, a stale state published as fresh, a
# best-effort first evaluation, a final evaluation made strict again, the account locks omitted or too weak,
# a wrong lock order, an ambiguity hold omitted, publishing an effect, given user strength, failing to block
# the surviving competitor, never expiring, blocking beyond its scope or blocking the user; an excluded account
# left out of the ambiguity capture, an excluded candidate ignored, a frozen invalidity masked by an amount
# change, bypassed or read only while the surviving row is a card leg, the protection of an automatic match
# omitted, moot beside a record, or lost when the payment or its competitor posts; a dismissed or far-away leg
# counted as a candidate, a payment that the "no included card" rule decides left out; and, of the provenance:
# a record or a hold merged again with one another removal wrote, two identical removed transactions collapsed
# into one row, a removal with no generation, with its generation's failure swallowed or under a generation that
# was already there, a source of another user, a row without its source, a source read after the delete, a
# failed preservation that still removes, a second execution, the source of the wrong decision, the wrong leg,
# the wrong account or with the wrong amount, a user's decision recorded as a system dependency, a missing or
# misplaced marker, a NULL pending flag that blocks a removal ...? Not run in CI (each mutant needs its own
# throwaway database). Nothing here touches any real database.
#
#   supabase/tests/lim_removal_matching_mutations/run.sh [mutant ...]     (default: every mutant)
#
# Several runs can go on at once, each with its own mutants: a run keeps everything it writes in a temporary
# directory of its own, and each database container is named after the process that started it.
#
# WHICH BODY IS MUTATED. Each mutant is a bare CREATE OR REPLACE, applied last: built from another text than
# the installed one it would silently put another body in place of the function under test. mutants.cjs
# therefore refuses to generate unless the md5 of each text it mutates is the checksum that 20261008120000's
# postcondition requires of the installed function (read from that file, for the removal and the evaluator),
# and every mutant file first compares the INSTALLED function's md5 with that value and raises otherwise: such a
# mutant "did not apply" and is an ERROR row here, never a detection. A mutant replaces one function and
# nothing else: no table, trigger, grant or row. The two guard triggers of the provenance tables are trigger
# functions of their own and are not mutated here: what each of their predicates refuses is a27's part.
#
# CHECKSUM PINS IN THE TESTS. A test that pins the installed function by its checksum (a27, in its catalog
# section) fails under EVERY mutant of that function for that reason alone, and stops there: it would count as
# a detection of each of them and show nothing of what the rest of the test finds. So in the mirror — the
# disposable copy, never the repository — the pinned checksum is replaced by the checksum of the body the mutant
# installs. The pin then holds, and the test runs on. This script prints which files it does that in. The
# baseline row runs them as they are: there the pin is the real one, and must hold.
#
# For each mutant from mutants.cjs:
#   * copy supabase/migrations and supabase/tests into a temporary mirror;
#   * add the mutant as the LAST migration (it re-creates remove_plaid_item_local or evaluate_card_payments,
#     deliberately wrong), and re-bind the tests' checksum pins to it;
#   * run the mirror's access-control harness on the tests that guard the removal:
#     a18, a19, a20, a21, a22, a23, a24, a25, a26, a27, c26, c27, c33, c34, c35, c36 and c37;
#   * record, for every test, PASS or the first failing assertion;
#   * compare the outcome with the manifest's expectation.
# A mutant passes the check when the expected test fails with the expected assertion — EVERY expected test,
# when the manifest names several ("a && b") — or, when marked SURVIVES, when every one of those tests still
# passes. An expectation "test| requirement" asks for more than the first failure: that test must print exactly
# that requirement of its contract as violated. The first row, "unmutated", is the baseline: the installed
# function re-created unchanged, on which every test must pass.
# Exit status 1 if any expectation is not met, a mutant did not apply, or the migrations or the tests changed
# while the run was reading them.
#
# Requires what access_control/run.sh requires (docker, bash, GNU timeout) plus node.
set -uo pipefail
# The harness run for each mutant (access_control/run.sh) inherits this environment. EXCLUDE would test the
# controls against another history than the one they were derived from; KEEP would leave one container per mutant.
if [ -n "${EXCLUDE:-}" ]; then echo "FAILED: EXCLUDE is set; the controls mutate the function the FULL migration history installs"; exit 1; fi
unset KEEP
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
node "$HERE/mutants.cjs" "$WORK/mutants" >"$WORK/generation.log" 2>&1 || { echo "FAILED to generate the mutants:"; cat "$WORK/generation.log"; exit 1; }
cat "$WORK/generation.log"
TESTS=(a18 a19 a20 a21 a22 a23 a24 a25 a26 a27 c26 c27 c33 c34 c35 c36 c37)
# The accounting below ("every test ran") counts on each of these naming exactly one test.
for t in "${TESTS[@]}"; do
  n="$(ls -d "$ROOT/supabase/tests/access_control/sql/$t"*.sql "$ROOT/supabase/tests/access_control/concurrency/$t"*/ 2>/dev/null | wc -l)"
  [ "$n" -eq 1 ] || { echo "FAILED: $n tests are named $t*; exactly one is expected"; exit 1; }
done
# A name that is not a mutant's would otherwise run nothing and report nothing.
for wanted in "$@"; do
  cut -f1 "$WORK/mutants/manifest.tsv" | grep -qx "$wanted" || { echo "FAILED: no mutant is named $wanted"; exit 1; }
done
# What every mirror is copied from, as one checksum: a run means something only if it did not change underneath.
inputs() {
  (cd "$ROOT/supabase" && find migrations tests/access_control tests/phase_a -type f | LC_ALL=C sort | tr '\n' '\0' | xargs -0 md5sum | md5sum | cut -d' ' -f1)
}
inputs_before="$(inputs)"
echo "inputs (migrations, access-control tests, helpers): $inputs_before"
# The tests that pin a mutated function by its checksum (the manifest's fourth column: what a mutant replaces).
PINNED_IN=(sql concurrency)
while IFS= read -r pin; do
  while IFS= read -r f; do
    echo "checksum pin $pin: re-bound to each mutant in its mirror of access_control/$f"
  done < <(cd "$ROOT/supabase/tests/access_control" && grep -rlF "$pin" "${PINNED_IN[@]}")
done < <(cut -f4 "$WORK/mutants/manifest.tsv" | sort -u)
# The transcript of one failed test in a harness log: from its FAIL line to the next test's result.
transcript() {
  awk -v t="$2" '$0 ~ "^FAIL  "t {on=1; next} on && /^(PASS|FAIL)  / {exit} on' "$1"
}

overall=0
detected=0
survived=0
unexpected=0
errors=0
printf '%-40s %-10s %s\n' MUTANT RESULT DETAIL
while IFS=$'\t' read -r name expect what replaces installs; do
  if [ "$#" -gt 0 ] && ! printf '%s\n' "$@" | grep -qx "$name"; then continue; fi
  mirror="$WORK/mirror-$name"
  mkdir -p "$mirror/supabase"
  cp -r "$ROOT/supabase/migrations" "$ROOT/supabase/tests" "$mirror/supabase/"
  cp "$WORK/mutants/$name.sql" "$mirror/supabase/migrations/29991231235959_mutant_$name.sql"
  if [ "$installs" != "$replaces" ]; then
    while IFS= read -r f; do
      sed -i "s/$replaces/$installs/g" "$mirror/supabase/tests/access_control/$f"
    done < <(cd "$mirror/supabase/tests/access_control" && grep -rlF "$replaces" "${PINNED_IN[@]}")
  fi
  log="$WORK/$name.log"
  bash "$mirror/supabase/tests/access_control/run.sh" "${TESTS[@]}" >"$log" 2>&1
  if grep -q "FAILED to apply migration" "$log"; then
    printf '%-40s %-10s %s\n' "$name" ERROR "the mutant did not apply"; sed 's/^/    | /' "$log" | tail -15; overall=1; errors=$((errors + 1)); rm -rf "$mirror"; continue
  fi
  # Per test: pass, or FAIL with its first assertion (or error) message.
  detail=""
  failures=()
  ran=0
  while read -r status test; do
    ran=$((ran + 1))
    short="${test%%_*}"
    if [ "$status" = PASS ]; then detail="$detail $short:pass"; continue; fi
    msg="$(transcript "$log" "$test" | awk '/ASSERTION FAILED|ERROR:/ {sub(/.*(ASSERTION FAILED: |ERROR:  )/, ""); print; exit}')"
    detail="$detail $short:FAIL"
    failures+=("$short: $msg")
  done < <(grep -E '^(PASS|FAIL)  ' "$log" | awk '{print $1, $2}')
  ok=0
  named=()
  if [ "$ran" -ne "${#TESTS[@]}" ]; then
    : # the harness did not run every test: never counted as an expected outcome
  else
    case "$expect" in
      SURVIVES*)
        [ "${#failures[@]}" -eq 0 ] && ok=1 ;;
      *)
        # Every expectation of the list must be met.
        ok=1
        while IFS= read -r one; do
          [ -z "$one" ] && continue
          found=0
          if [[ "$one" =~ ^([a-z][0-9]+)\|\ (.*)$ ]]; then
            # A requirement that the test must print as violated.
            case " ${named[*]:-} " in *" ${BASH_REMATCH[1]} "*) ;; *) named+=("${BASH_REMATCH[1]}") ;; esac
            transcript "$log" "${BASH_REMATCH[1]}" | grep -qF "CONTRACT VIOLATED | ${BASH_REMATCH[2]}" && found=1
          else
            want_test="${one%%:*}"
            want_msg="${one#*: }"
            for f in "${failures[@]:-}"; do
              case "$f" in "$want_test: $want_msg"*) found=1 ;; esac
            done
          fi
          [ "$found" -eq 1 ] || ok=0
        done < <(printf '%s\n' "$expect" | sed 's/ && /\n/g') ;;
    esac
  fi
  if [ "$ok" -ne 1 ]; then
    result=UNEXPECTED; unexpected=$((unexpected + 1)); overall=1
  else
    result=ok
    case "$expect" in
      SURVIVES*) survived=$((survived + 1)) ;;
      *) detected=$((detected + 1)) ;;
    esac
  fi
  printf '%-40s %-10s %s\n' "$name" "$result" "$what"
  while IFS= read -r one; do printf '%-40s %-10s %s\n' "" "" "expected: $one"; done < <(printf '%s\n' "$expect" | sed 's/ && /\n/g')
  printf '%-40s %-10s %s\n' "" "" "tests:$detail"
  for f in "${failures[@]:-}"; do [ -n "$f" ] && printf '%-40s %-10s %s\n' "" "" "first failure in ${f:0:230}"; done
  # Where requirements were expected of a test: the ones it printed as violated (it prints them when it fails).
  for t in "${named[@]:-}"; do
    [ -n "$t" ] || continue
    while IFS= read -r line; do
      printf '%-40s %-10s %s\n' "" "" "$t violates: ${line:0:200}"
    done < <(transcript "$log" "$t" | sed -n 's/^.*CONTRACT VIOLATED | //p')
  done
  if [ "$result" = UNEXPECTED ]; then sed 's/^/    | /' "$log" | grep -E "PASS|FAIL|ASSERTION|ERROR" | head -20; fi
  rm -rf "$mirror"
done < "$WORK/mutants/manifest.tsv"
# What follows the rows is commentary, marked as the results files mark theirs (a leading "#"): a reader that
# collects a mutant's rows up to the next mutant must not take it for the last mutant's.
echo "# $detected detected as expected, $survived survive as defined, $unexpected unexpected, $errors did not apply"
inputs_after="$(inputs)"
if [ "$inputs_after" != "$inputs_before" ]; then
  echo "# FAILED: the migrations or the tests changed during the run ($inputs_before at the start, $inputs_after at the end): the rows above were not all run on the same files"
  overall=1
fi
exit "$overall"

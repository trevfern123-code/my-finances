#!/usr/bin/env bash
# Negative controls (mutation check) for the two I3A migrations — institution removal
# (20261006120000) and the decision kind it writes (20261006110000). Would the tests notice a deletion
# without preservation, a user-confirmed pair dropped or downgraded to the system record, a waiting,
# amount-changed or ambiguous confirmation released, the mirror case dropped, a superseded confirmation
# resurrected, a competitor allowed to auto-match, a missing version bump, a stale state published as fresh, a
# best-effort first evaluation, a final evaluation made strict again, the account locks omitted or too weak,
# a wrong lock order, an ambiguity hold omitted, publishing an effect, given user strength, failing to block
# the surviving competitor, never expiring, blocking beyond its scope or blocking the user; an excluded account
# left out of the ambiguity capture, an excluded candidate ignored, a frozen invalidity masked by an amount
# change, bypassed or read only while the surviving row is a card leg, the protection of an automatic match
# omitted, moot beside a record, or lost when the payment or its competitor posts; a dismissed or far-away leg
# counted as a candidate, a payment that the "no included card" rule decides left out ...? Not run in CI
# (each mutant needs its own throwaway database). Nothing here touches any real database.
#
#   supabase/tests/lim_removal_matching_mutations/run.sh [mutant ...]     (default: every mutant)
#
# For each mutant from mutants.cjs:
#   * copy supabase/migrations and supabase/tests into a temporary mirror;
#   * add the mutant as the LAST migration (it re-creates remove_plaid_item_local or evaluate_card_payments,
#     deliberately wrong);
#   * run the mirror's access-control harness on the tests that guard the removal:
#     a18, a19, a20, a21, a22, a23, a24, a25, c26, c27, c33, c34, c35 and c36;
#   * record, for every test, PASS or the first failing assertion;
#   * compare the outcome with the manifest's expectation.
# A mutant passes the check when the expected test fails with the expected assertion — EVERY expected test,
# when the manifest names several ("a && b") — or, when marked SURVIVES, when every one of those tests still
# passes. Exit status 1 if any expectation is not met.
#
# Requires what access_control/run.sh requires (docker, bash, GNU timeout) plus node.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
node "$HERE/mutants.cjs" "$WORK/mutants" >/dev/null || { echo "FAILED to generate the mutants"; exit 1; }
TESTS=(a18 a19 a20 a21 a22 a23 a24 a25 c26 c27 c33 c34 c35 c36)

overall=0
printf '%-40s %-10s %s\n' MUTANT RESULT DETAIL
while IFS=$'\t' read -r name expect what; do
  if [ "$#" -gt 0 ] && ! printf '%s\n' "$@" | grep -qx "$name"; then continue; fi
  mirror="$WORK/mirror-$name"
  mkdir -p "$mirror/supabase"
  cp -r "$ROOT/supabase/migrations" "$ROOT/supabase/tests" "$mirror/supabase/"
  cp "$WORK/mutants/$name.sql" "$mirror/supabase/migrations/29991231235959_mutant_$name.sql"
  log="$WORK/$name.log"
  bash "$mirror/supabase/tests/access_control/run.sh" "${TESTS[@]}" >"$log" 2>&1
  if grep -q "FAILED to apply migration" "$log"; then
    printf '%-40s %-10s %s\n' "$name" ERROR "the mutant did not apply"; sed 's/^/    | /' "$log" | tail -15; overall=1; rm -rf "$mirror"; continue
  fi
  # Per test: pass, or FAIL with its first assertion (or error) message.
  detail=""
  failures=()
  ran=0
  while read -r status test; do
    ran=$((ran + 1))
    short="${test%%_*}"
    if [ "$status" = PASS ]; then detail="$detail $short:pass"; continue; fi
    msg="$(awk -v t="$test" '$0 ~ "^FAIL  "t {on=1; next} on && /^(PASS|FAIL)  / {exit} on && /ASSERTION FAILED|ERROR:/ {sub(/.*(ASSERTION FAILED: |ERROR:  )/, ""); print; exit}' "$log")"
    detail="$detail $short:FAIL"
    failures+=("$short: $msg")
  done < <(grep -E '^(PASS|FAIL)  ' "$log" | awk '{print $1, $2}')
  ok=0
  if [ "$ran" -ne "${#TESTS[@]}" ]; then
    : # the harness did not run every test: never counted as an expected outcome
  else
    case "$expect" in
      SURVIVES*)
        [ "${#failures[@]}" -eq 0 ] && ok=1 ;;
      *)
        # Every expectation of the list must be among the failures.
        ok=1
        while IFS= read -r one; do
          [ -z "$one" ] && continue
          want_test="${one%%:*}"
          want_msg="${one#*: }"
          found=0
          for f in "${failures[@]:-}"; do
            case "$f" in "$want_test: $want_msg"*) found=1 ;; esac
          done
          [ "$found" -eq 1 ] || ok=0
        done < <(printf '%s\n' "$expect" | sed 's/ && /\n/g') ;;
    esac
  fi
  if [ "$ok" -eq 1 ]; then result=ok; else result=UNEXPECTED; overall=1; fi
  printf '%-40s %-10s %s\n' "$name" "$result" "$what"
  while IFS= read -r one; do printf '%-40s %-10s %s\n' "" "" "expected: $one"; done < <(printf '%s\n' "$expect" | sed 's/ && /\n/g')
  printf '%-40s %-10s %s\n' "" "" "tests:$detail"
  for f in "${failures[@]:-}"; do [ -n "$f" ] && printf '%-40s %-10s %s\n' "" "" "first failure in ${f:0:230}"; done
  if [ "$result" != ok ]; then sed 's/^/    | /' "$log" | grep -E "PASS|FAIL|ASSERTION|ERROR" | head -20; fi
  rm -rf "$mirror"
done < "$WORK/mutants/manifest.tsv"
exit "$overall"

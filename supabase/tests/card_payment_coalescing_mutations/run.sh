#!/usr/bin/env bash
# Mutation check for the bump-coalescing safeguards (20261002120000) and the revised a09 contract. Not run
# in CI (each mutant needs its own throwaway database). Nothing here touches any real database.
#
#   supabase/tests/card_payment_coalescing_mutations/run.sh [mutant ...]     (default: every mutant)
#
# For each mutant from mutants.cjs:
#   * copy supabase/migrations and supabase/tests into a temporary mirror;
#   * add the mutant as the LAST migration;
#   * run the mirror's access-control harness on the tests that guard coalescing:
#     a09, a14, a15, c23, c24 and c25;
#   * record, for every test, PASS or the first failing assertion;
#   * compare the outcome with the manifest's expectation.
# A mutant passes the check when it is detected where expected, or, when marked SURVIVES, when a14 (the
# contract) still passes. Exit status 1 if any expectation is not met.
#
# Requires what access_control/run.sh requires (docker, bash, GNU timeout) plus node.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
node "$HERE/mutants.cjs" "$WORK/mutants" >/dev/null || { echo "FAILED to generate the mutants"; exit 1; }
TESTS=(a09 a14 a15 c23 c24 c25)

overall=0
printf '%-30s %-8s %s\n' MUTANT RESULT DETAIL
while IFS=$'\t' read -r name expect what; do
  if [ "$#" -gt 0 ] && ! printf '%s\n' "$@" | grep -qx "$name"; then continue; fi
  mirror="$WORK/mirror-$name"
  mkdir -p "$mirror/supabase"
  cp -r "$ROOT/supabase/migrations" "$ROOT/supabase/tests" "$mirror/supabase/"
  cp "$WORK/mutants/$name.sql" "$mirror/supabase/migrations/29991231235959_mutant_$name.sql"
  log="$WORK/$name.log"
  bash "$mirror/supabase/tests/access_control/run.sh" "${TESTS[@]}" >"$log" 2>&1
  if grep -q "FAILED to apply migration" "$log"; then
    printf '%-30s %-8s %s\n' "$name" ERROR "the mutant did not apply"; sed 's/^/    | /' "$log" | tail -15; overall=1; continue
  fi
  # Per test: PASS, or FAIL with its first assertion message.
  detail=""
  a14_failed=0
  first_failure=""
  while read -r status test; do
    if [ "$status" = PASS ]; then detail="$detail $test:pass"; continue; fi
    msg="$(awk -v t="$test" '$0 ~ "^FAIL  "t {on=1; next} on && /^(PASS|FAIL)  / {exit} on && /ASSERTION FAILED|ERROR:/ {sub(/.*(ASSERTION FAILED: |ERROR:  )/, ""); print; exit}' "$log")"
    short="${test%%_*}"
    detail="$detail $short:FAIL"
    [ -z "$first_failure" ] && first_failure="$short: $msg"
    [ "$short" = a14 ] && a14_failed=1 && a14_msg="a14: $msg"
    [ "$short" = a09 ] && a09_msg="a09: $msg"
    [ "$short" = a15 ] && a15_msg="a15: $msg"
  done < <(grep -E '^(PASS|FAIL)  ' "$log" | awk '{print $1, $2}')
  ok=0
  case "$expect" in
    SURVIVES*)
      [ "$a14_failed" -eq 0 ] && ok=1
      second="${expect#*; }"
      if [ "$second" != "$expect" ] && ! grep -qF "${second#*: }" "$log"; then ok=0; fi ;;
    *)
      grep -qF "ASSERTION FAILED: ${expect#*: }" "$log" && ok=1 ;;
  esac
  if [ "$ok" -eq 1 ]; then result=ok; else result=UNEXPECTED; overall=1; fi
  printf '%-30s %-8s %s\n' "$name" "$result" "expected: $expect"
  printf '%-30s %-8s %s\n' "" "" "tests:$detail"
  for m in "${a09_msg:-}" "${a14_msg:-}" "${a15_msg:-}"; do [ -n "$m" ] && printf '%-30s %-8s %s\n' "" "" "first failure in $m"; done
  unset a09_msg a14_msg a15_msg
  if [ "$result" != ok ]; then sed 's/^/    | /' "$log" | grep -E "PASS|FAIL|ASSERTION|ERROR" | head -20; fi
  rm -rf "$mirror"
done < "$WORK/mutants/manifest.tsv"
exit "$overall"

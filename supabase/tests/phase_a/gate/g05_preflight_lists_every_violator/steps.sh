# The committed standalone preflight file (what an operator runs against production) must list every
# seeded violator — all nine, each under the right constraint — and none of the valid rows.
set -euo pipefail
. "$HERE/gate/lib.sh"

psql_db < "$HERE/gate/dirty_seed.sql" >/dev/null
out="$(psql_db -At -F '|' < "$ROOT/supabase/preflight/20260912120000_phase_a_numeric_preflight.sql")"
echo "$out"

expect() { # id suffix -> constraint it must be reported under
  echo "$out" | grep "0000000000$1|" | grep -q "$2" || fail "violator ...$1 not reported under $2"
}
expect d1 manual_loans_current_balance_check
expect d2 manual_loans_origination_principal_amount_check
expect d3 manual_loans_interest_rate_percentage_check
expect d4 manual_loans_minimum_payment_amount_check
expect d5 manual_loans_term_months_check
expect d6 transactions_amount_finite_check
expect d7 transactions_principal_portion_check
expect d8 manual_loan_payments_principal_portion_check
expect d9 manual_loan_payments_interest_portion_check
[ "$(echo "$out" | grep -c .)" -eq 9 ] || fail "expected exactly 9 rows, got $(echo "$out" | grep -c .)"
# Only each row's own id (first column) counts: payment rows legitimately reference a valid loan.
echo "$out" | cut -d'|' -f1 | grep -q "0000000000e" && fail "a valid row was reported"
echo "all nine violators reported under the right constraint; no valid row reported"

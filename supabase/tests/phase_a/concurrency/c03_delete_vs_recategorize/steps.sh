# Round 11 item 1, orchestrated like the application's deleteManualLoan retry loop: read linked rows
# -> classify with the real classifier -> call the RPC; on "changed since they were classified",
# re-read, re-classify and retry. A concurrent sync re-categorizes the linked row between the first
# read and the first RPC call. Invoked by run.sh with psql_db, HERE, LOGS and TEST_DIR in scope.
set -euo pipefail

read_linked() {
  psql_db -At -c "select coalesce(json_agg(json_build_object(
      'id', t.id, 'amount', t.amount, 'category', t.category,
      'personal_finance_category_detailed', t.personal_finance_category_detailed,
      'personal_finance_category_confidence', t.personal_finance_category_confidence) order by t.id), '[]'::json)
    from public.transactions t where t.manual_loan_id = '00000000-0000-0000-0000-0000000000d5'" </dev/null
}

classify() {
  node "$HERE/classify_linked.cjs"
}

echo "--- deletion reads the linked rows"
rows_before="$(read_linked)"
echo "$rows_before"
payload_before="$(printf '%s' "$rows_before" | classify)"
echo "classified (real classifier): $payload_before"

echo "--- concurrent sync re-categorizes the linked row as LOAN_PAYMENTS and holds the lock"
psql_db < "$TEST_DIR/sync_holder.sql" >"$LOGS/c03.holder.log" 2>&1 &
holder=$!

echo "--- deletion RPC with the stale payload: must wait, then reject"
psql_db -v payload="$payload_before" < "$TEST_DIR/stale_attempt.sql"
wait "$holder"
cat "$LOGS/c03.holder.log"

echo "--- retry: re-read and re-classify"
rows_after="$(read_linked)"
echo "$rows_after"
payload_after="$(printf '%s' "$rows_after" | classify)"
echo "classified (real classifier): $payload_after"
psql_db -v payload="$payload_after" < "$TEST_DIR/retry.sql"
echo "--- converged"

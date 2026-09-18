# Dirty pre-migration data: the migration must refuse, name every violated constraint with its row
# count, and leave the schema AND the data exactly as they were — under every transaction model a
# runner could use. Starts from a pre-migration database (run.sh does not apply the migration here).
set -euo pipefail
. "$HERE/gate/lib.sh"

psql_db < "$HERE/gate/dirty_seed.sql" >/dev/null
schema_before="$(schema_fingerprint)"
data_before="$(data_fingerprint)"

for model in explicit implicit; do
  echo "--- $model transaction model"
  if out="$(apply_migration "$MIGRATION" "$model" 2>&1)"; then
    fail "migration succeeded over dirty data ($model)"
  fi
  echo "$out" | grep -E "ERROR|DETAIL|HINT|manual_loan|transactions_" | head -14
  echo "$out" | grep -q "Phase A migration aborted before making any change" || fail "gate message missing ($model)"
  for c in "${ALL_NINE_CONSTRAINTS[@]}"; do
    echo "$out" | grep -q "$c: 1 row(s)" || fail "gate did not report $c ($model)"
  done
  [ "$(schema_fingerprint)" = "$schema_before" ] || fail "schema changed after the refused migration ($model)"
  [ "$(data_fingerprint)" = "$data_before" ] || fail "data changed after the refused migration ($model)"
  migration_is_applied && fail "migration partially applied ($model)"
  echo "refused, schema and data unchanged ($model)"
done

echo "--- per-statement autocommit (a runner with no transaction)"
if out="$(apply_migration "$MIGRATION" autocommit 2>&1)"; then
  fail "migration ran outside a transaction"
fi
echo "$out" | grep ERROR | head -2
echo "$out" | grep -q "LOCK TABLE can only be used in transaction blocks" || fail "did not stop at the transaction assertion"
[ "$(schema_fingerprint)" = "$schema_before" ] || fail "schema changed (autocommit)"
[ "$(data_fingerprint)" = "$data_before" ] || fail "data changed (autocommit)"
echo "refused at its first statement, nothing applied (autocommit)"

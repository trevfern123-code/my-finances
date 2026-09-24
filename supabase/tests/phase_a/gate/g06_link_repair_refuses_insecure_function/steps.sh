# Post-audit blocker 1: 20260924120000 drops and recreates link_transaction_to_manual_loan. It must
# refuse to run unless the deployed function is already in its secure state (it would otherwise carry
# an insecure grant over, or silently drop it), and a refusal must leave the old function and the
# ledger exactly as they were. From the secure state it applies and changes only the return type.
set -euo pipefail
. "$HERE/gate/lib.sh"

REPAIR="$ROOT/supabase/migrations/20260924120000_manual_loan_link_idempotency.sql"
FN='public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)'
fn_state() {
  psql_db -At <<SQL
select p.prorettype::regtype, has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'), p.prosecdef, p.proconfig
from pg_proc p where p.oid = '$FN'::regprocedure;
SQL
}
repair_recorded() {
  psql_db -At <<'SQL'
select count(*) from supabase_migrations.schema_migrations where version = '20260924120000';
SQL
}

out="$(apply_migration "$MIGRATION" pipeline 2>&1)" || { echo "$out" | tail -20; fail "Phase A failed"; }

psql_db -q -c "grant execute on function $FN to authenticated" </dev/null
before="$(fn_state)"
if out="$(apply_migration "$REPAIR" pipeline 2>&1)"; then fail "repair applied over an authenticated-executable function"; fi
echo "$out" | grep -q "is not in its expected secure state before the repair" || { echo "$out" | tail -20; fail "refused for the wrong reason"; }
[ "$(fn_state)" = "$before" ] || fail "a refused repair changed the function: $(fn_state)"
[ "$(repair_recorded)" = 0 ] || fail "a refused repair was recorded as applied"
echo "refused over an insecure grant; function ($before) and ledger unchanged"

psql_db -q -c "revoke execute on function $FN from authenticated" </dev/null
out="$(apply_migration "$REPAIR" pipeline 2>&1)" || { echo "$out" | tail -20; fail "repair failed from the secure state"; }
after="$(fn_state)"
[ "$after" = 'text|f|t|f|{"search_path=\"\""}' ] || fail "unexpected state after the repair: $after"
[ "$(repair_recorded)" = 1 ] || fail "the repair was not recorded"
echo "applied from the secure state ($after): returns text, SECURITY INVOKER, search_path pinned, service_role-only"

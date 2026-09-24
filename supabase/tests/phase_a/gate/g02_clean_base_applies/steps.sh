# Clean pre-migration data (including legitimate zeros and negative income): the migration applies
# in one implicit transaction — the whole file as a single query — and leaves the constraints
# installed, NOT VALID, and enforced.
set -euo pipefail
. "$HERE/gate/lib.sh"

psql_db < "$HERE/gate/dirty_seed.sql" >/dev/null
# Keep only the valid rows (ids ...00e*): exactly the state an operator reaches after correcting.
psql_db -q -c "
  delete from public.manual_loan_payments where id::text like '%00d_';
  delete from public.transactions where id::text like '%00d_';
  delete from public.manual_loans where id::text like '%00d_';" </dev/null
data_before="$(data_fingerprint)"

out="$(apply_migration "$MIGRATION" pipeline 2>&1)" || { echo "$out" | tail -20; fail "clean migration failed"; }
migration_is_applied || fail "migration not applied"
[ "$(data_fingerprint)" = "$data_before" ] || fail "migration modified existing financial data"

psql_db -At -c "select count(*) from pg_constraint where connamespace = 'public'::regnamespace and not convalidated
                and conname in ($(printf "'%s'," "${ALL_NINE_CONSTRAINTS[@]}" | sed 's/,$//'))" </dev/null | grep -qx 9 \
  || fail "the nine constraints are not all present and NOT VALID"
echo "applied; nine constraints present and NOT VALID; existing data untouched"

# The locks were released at commit: ordinary writes proceed, invalid ones are rejected.
psql_db -q -c "update public.manual_loans set notes = 'after migration' where id = '00000000-0000-0000-0000-0000000000e1'" </dev/null \
  || fail "valid write blocked after commit"
if psql_db -q -c "insert into public.manual_loans (user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000000aa', 'x', -1)" </dev/null 2>/dev/null; then
  fail "invalid write accepted after migration"
fi
echo "locks released; valid writes succeed, invalid writes rejected"

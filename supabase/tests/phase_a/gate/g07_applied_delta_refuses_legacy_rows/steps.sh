# Post-audit re-review: 20260924130000 must refuse to run while any linked transaction or manual
# loan payment exists (their applied deltas are unknown). A refusal rolls the whole file back —
# schema, function bodies, data and the migration ledger are exactly as before — and it applies
# once no such row remains, with both guards validated.
set -euo pipefail
. "$HERE/gate/lib.sh"

IDEMPOTENCY="$ROOT/supabase/migrations/20260924120000_manual_loan_link_idempotency.sql"
DELTA="$ROOT/supabase/migrations/20260924130000_manual_loan_applied_balance_delta.sql"
bodies() {
  psql_db -At <<'SQL'
select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text))
from pg_proc p where p.pronamespace = 'public'::regnamespace;
SQL
}
recorded() {
  psql_db -At <<'SQL'
select count(*) from supabase_migrations.schema_migrations where version = '20260924130000';
SQL
}
state() { echo "$(schema_fingerprint) $(bodies) $(data_fingerprint) $(recorded)"; }
expect_refusal() { # $1 = links, $2 = payments
  local before out phrase
  phrase="applied-delta migration refused: $1 linked transaction(s) and $2 manual loan payment(s) predate applied-delta tracking"
  before="$(state)"
  if out="$(apply_migration "$DELTA" pipeline 2>&1)"; then fail "applied with $1 link(s) and $2 payment(s) present"; fi
  echo "$out" | grep -qF "$phrase" || { echo "$out" | tail -20; fail "refused for the wrong reason"; }
  [ "$(state)" = "$before" ] || fail "a refused migration changed the schema, a function, the data or the ledger"
  [ "$(recorded)" = 0 ] || fail "a refused migration was recorded"
  echo "refused ($1 link(s), $2 payment(s)); schema, function bodies, data and ledger unchanged"
}

out="$(apply_migration "$MIGRATION" pipeline 2>&1)" || { echo "$out" | tail -20; fail "Phase A failed"; }
out="$(apply_migration "$IDEMPOTENCY" pipeline 2>&1)" || { echo "$out" | tail -20; fail "20260924120000 failed"; }

# A payment linked by the old backend (direct write, balance already decremented by it).
psql_db -q <<'SQL'
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000000aa', 'Legacy loan', 0);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, manual_loan_id, principal_portion,
  auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000000a1', 'legacy-link', 100, '2026-09-01', 'Loan payment',
  '00000000-0000-0000-0000-0000000007a1', 100, 'debt_payment', 'manual_loan_link', 'high', 1);
SQL
# The operator preflight (supabase/preflight) sees exactly what the gate will refuse.
PREFLIGHT="$ROOT/supabase/preflight/20260924130000_applied_delta_preflight.sql"
pre="$(sed '/^-- POSTFLIGHT/,$d' "$PREFLIGHT" | psql_db -At -v ON_ERROR_STOP=1)" || fail "preflight SQL failed"
[ "$(echo "$pre" | head -1 | cut -d'|' -f3-6)" = "1|0|0|0" ] || fail "preflight did not report the legacy link: $pre"
echo "$pre" | grep -q '^00000000-0000-0000-0000-0000000007a1|Legacy loan|0|' || fail "preflight detail missing the loan: $pre"
expect_refusal 1 0

# Only a manual payment.
psql_db -q <<'SQL'
update public.transactions set manual_loan_id = null, principal_portion = null,
  auto_role = 'expense', role_source = 'sign_default', role_confidence = 'low'
  where id = '00000000-0000-0000-0000-0000000007b1';
insert into public.manual_loan_payments (user_id, loan_id, date, principal_portion, interest_portion)
values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007a1', '2026-09-02', 40, 0);
SQL
expect_refusal 0 1

# Loans alone (and a stale principal left on an unlinked row) are not legacy links: it applies.
psql_db -q -c "delete from public.manual_loan_payments" </dev/null
psql_db -q -c "update public.transactions set principal_portion = 100 where id = '00000000-0000-0000-0000-0000000007b1'" </dev/null
out="$(apply_migration "$DELTA" pipeline 2>&1)" || { echo "$out" | tail -20; fail "refused a base with no links or payments"; }
[ "$(recorded)" = 1 ] || fail "applied but not recorded"
guards="$(psql_db -At <<'SQL'
select (select count(*) from pg_constraint where convalidated and conname in
          ('transactions_loan_balance_applied_check', 'transactions_loan_balance_applied_required_check',
           'manual_loan_payments_balance_applied_check'))
       || ':' || (select attnotnull from pg_attribute
                  where attrelid = 'public.manual_loan_payments'::regclass and attname = 'balance_applied');
SQL
)"
[ "$guards" = "3:true" ] || fail "guards missing or not validated after apply: $guards"
echo "applied once no link or payment remained; both guards present and validated"

post="$(sed -n '/^-- POSTFLIGHT/,$p' "$PREFLIGHT" | psql_db -At -v ON_ERROR_STOP=1)" || fail "postflight SQL failed"
[ "$post" = "20260924120000,20260924130000|text|3|t|0|0|0" ] || fail "unexpected postflight: $post"
echo "operator preflight/postflight SQL runs and reports: $post"

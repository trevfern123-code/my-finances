-- The posting holds the per-user advisory lock for 3 s after deleting the pending row.
set role service_role;
begin;
select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'c10-q', 'account_id', '00000000-0000-0000-0000-000000000ca1', 'amount', 52.10,
    'iso_currency_code', 'USD', 'date', '2026-09-12', 'name', 'Posted', 'merchant_name', null, 'category', 'FOOD_AND_DRINK',
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false,
    'needs_review', true, 'budget_category_id', null, 'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low',
    'classifier_version', 1, 'pending_transaction_id', 'c10-p')),
  '[]', array['c10-p']);
select pg_sleep(3);
commit;

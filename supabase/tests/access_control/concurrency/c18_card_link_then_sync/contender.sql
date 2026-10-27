-- The sync batch, waiting on the per-user lock.
select th.wait_for_application('c18-holder');
select set_config('application_name', 'c18-contender', false);
begin;
set local role service_role;
do $$
begin
  perform public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
    jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'c18-synced', 'account_id', '00000000-0000-0000-0000-000000018c01', 'amount', 12.34,
      'iso_currency_code', 'USD', 'date', '2026-09-10', 'name', 'Synced', 'merchant_name', null, 'category', 'FOOD_AND_DRINK',
      'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false,
      'needs_review', false, 'budget_category_id', null, 'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low',
      'classifier_version', 1, 'pending_transaction_id', null)),
    '[]', '{}');
  insert into public.th_c18_outcome values ('contender', 'synced');
end $$;
commit;

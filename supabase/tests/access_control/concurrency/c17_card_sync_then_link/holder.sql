-- The sync batch writes a new row (bumping the version) and holds the per-user lock.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  v_result := public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
    jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'c17-synced', 'account_id', '00000000-0000-0000-0000-000000017c01', 'amount', 12.34,
      'iso_currency_code', 'USD', 'date', '2026-09-10', 'name', 'Synced', 'merchant_name', null, 'category', 'FOOD_AND_DRINK',
      'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false,
      'needs_review', false, 'budget_category_id', null, 'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low',
      'classifier_version', 1, 'pending_transaction_id', null)),
    '[]', '{}');
  insert into public.th_c17_outcome values ('holder', 'synced');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c17-holder', false);
  v_contender := th.wait_for_application('c17-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

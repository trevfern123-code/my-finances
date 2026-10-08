-- The sync batch that posts the pending cash leg completes and holds its locks.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  perform public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
    jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'c31-posted', 'account_id', '00000000-0000-0000-0000-000000031c01', 'amount', 120,
      'iso_currency_code', 'USD', 'date', '2026-09-18', 'name', 'Posted', 'merchant_name', null, 'category', null,
      'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false,
      'needs_review', false, 'budget_category_id', null, 'auto_role', 'credit_card_payment', 'role_source', 'category_detailed', 'role_confidence', 'high',
      'classifier_version', 1, 'pending_transaction_id', 'c31-pend')),
    '[]'::jsonb, array['c31-pend']);
  insert into public.th_c31_outcome values ('holder', 'synced');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c31-holder', false);
  v_contender := th.wait_for_application('c31-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;

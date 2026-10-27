-- The sync batch that posts the pending cash leg (removes it, inserts its posted replacement).
select th.wait_for_application('c30-holder');
select set_config('application_name', 'c30-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  perform public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
    jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'c30-posted', 'account_id', '00000000-0000-0000-0000-000000030c01', 'amount', 120,
      'iso_currency_code', 'USD', 'date', '2026-09-18', 'name', 'Posted', 'merchant_name', null, 'category', null,
      'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false,
      'needs_review', false, 'budget_category_id', null, 'auto_role', 'credit_card_payment', 'role_source', 'category_detailed', 'role_confidence', 'high',
      'classifier_version', 1, 'pending_transaction_id', 'c30-pend')),
    '[]'::jsonb, array['c30-pend']);
  insert into public.th_c30_outcome values ('contender', 'synced');
end $$;
commit;

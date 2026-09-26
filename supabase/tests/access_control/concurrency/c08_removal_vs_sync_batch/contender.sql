-- A sync that read the item before removal began now writes its batch into the item's account. It
-- waits for the cleanup, then finds the account gone and writes nothing (the batch is all-or-nothing).
set role service_role;
do $$
declare t0 timestamptz := clock_timestamp();
begin
  perform th.expect_error($q$
    select public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa',
      jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'c08-late', 'account_id', '00000000-0000-0000-0000-0000000008a1',
        'amount', 5, 'iso_currency_code', 'USD', 'date', '2026-09-10', 'name', 'late', 'merchant_name', null, 'category', null,
        'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null,
        'pending', false, 'needs_review', true, 'budget_category_id', null,
        'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low', 'classifier_version', 1)), '[]')
  $q$, '%not owned by this user%');
  perform th.assert(clock_timestamp() - t0 > interval '1 second', 'the batch waited on the cleanup''s lock');
end
$$;

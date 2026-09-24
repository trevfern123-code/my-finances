set role service_role;
select pg_sleep(1.5);
select th.expect_error($q$
  select public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa', '[]', '[
    {"id":"00000000-0000-0000-0000-0000000000f3","account_id":"00000000-0000-0000-0000-0000000000a1","amount":20,
     "iso_currency_code":"USD","date":"2026-09-10","name":"Payment","merchant_name":"Lender","category":null,
     "personal_finance_category_detailed":null,"personal_finance_category_confidence":null,"plaid_category":null,"pending":false,
     "auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_account_id":"00000000-0000-0000-0000-0000000000a1","exp_amount":100,"exp_date":"2026-09-10","exp_name":"Payment",
     "exp_merchant_name":"Lender","exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null,
     "exp_manual_loan_id":null,"exp_auto_role":"expense","exp_principal_portion":null}]')
$q$, '%no longer match the state they were classified against%');

set role service_role;
begin;
select public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa', '[
  {"plaid_transaction_id":"ph-c","account_id":"00000000-0000-0000-0000-0000000000a2","amount":100,"iso_currency_code":"USD",
   "date":"2026-09-10","name":"C-phantom","merchant_name":null,"category":null,"personal_finance_category_detailed":null,
   "personal_finance_category_confidence":null,"plaid_category":null,"pending":false,"needs_review":true,"budget_category_id":null,
   "auto_role":"expense","role_source":"transfer_like_unconfirmed","role_confidence":"low","classifier_version":1}]', '[]');
select pg_sleep(4);
commit;

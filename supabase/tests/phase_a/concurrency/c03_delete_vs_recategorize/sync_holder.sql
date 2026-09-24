-- The concurrent sync: Plaid re-categorizes T as LOAN_PAYMENTS. Sent exactly as
-- applyTransactionChanges would for a loan-linked row (role fields null = unchanged, exp_* = the
-- row as it read it). Holds the per-user advisory lock for 4 seconds before committing.
set role service_role;
begin;
select public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa', '[]', '[
  {"id":"00000000-0000-0000-0000-0000000000f1","account_id":"00000000-0000-0000-0000-0000000000a1","amount":75,
   "iso_currency_code":"USD","date":"2026-09-10","name":"Lender Payment","merchant_name":null,
   "category":"LOAN_PAYMENTS","personal_finance_category_detailed":null,"personal_finance_category_confidence":null,
   "plaid_category":null,"pending":false,
   "auto_role":null,"role_source":null,"role_confidence":null,"classifier_version":null,
   "exp_account_id":"00000000-0000-0000-0000-0000000000a1","exp_amount":75,"exp_date":"2026-09-10",
   "exp_name":"Lender Payment","exp_merchant_name":null,"exp_category":"GENERAL_MERCHANDISE",
   "exp_pfc_detailed":null,"exp_pfc_confidence":null,
   "exp_manual_loan_id":"00000000-0000-0000-0000-0000000000d5","exp_auto_role":"debt_payment","exp_principal_portion":50}]');
select pg_sleep(4);
commit;

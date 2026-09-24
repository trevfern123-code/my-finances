-- Round 11 item 1. Transaction T is linked to loan L and currently categorized as an ordinary
-- purchase. Deletion reads T, then a sync re-categorizes it as LOAN_PAYMENTS before the deletion's
-- RPC takes the lock. T's id stays in the linked set throughout, so only the classifier-input
-- compare-and-swap can notice.
set role service_role;

insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000aa', 'Recategorized Loan', 1000);

insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, merchant_name, category,
  personal_finance_category_detailed, personal_finance_category_confidence,
  auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'recat-t', 75, '2026-09-10',
  'Lender Payment', null, 'GENERAL_MERCHANDISE', null, null, 'expense', 'sign_default', 'low', 1);

select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000f1',
  '00000000-0000-0000-0000-0000000000d5', 50, 1::smallint);

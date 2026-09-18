-- Round 11 item 4. G is linked to user aa's loan through account a1 -> plaid item 1 (owned by aa).
-- Concurrently, item 1 is re-parented to user bb. The deletion must wait for that change and then
-- re-check ownership against the committed row — not act on the pre-change snapshot.
set role service_role;

insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000aa', 'Ownership Loan', 1000);

insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category,
  personal_finance_category_detailed, personal_finance_category_confidence,
  auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'own-g', 30, '2026-09-10',
  'G', null, null, null, 'expense', 'sign_default', 'low', 1);

select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000f2',
  '00000000-0000-0000-0000-0000000000d6', 10, 1::smallint);

-- Two callers picked the same unlinked transaction T (e.g. a loan-create backfill and a sync
-- auto-link) and both try to link it to loan L with the same principal.
set role service_role;
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000000aa', 'Replay Loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000007e1', '00000000-0000-0000-0000-0000000000a1', 'replay-t', 100, '2026-09-10', 'Loan payment', 'expense', 'sign_default', 'low', 1);

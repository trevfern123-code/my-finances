-- Round 7/8 regression. A and B look like a reciprocal transfer; while confirm_transfer_pair(A, B)
-- waits for the lock, a sync inserts C — a strictly closer counterpart for A.
set role service_role;
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
  role_source, auto_role, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-00000000ab01', '00000000-0000-0000-0000-0000000000a1', 'ph-a', -100, '2026-09-10', 'A-out', 'transfer_like_unconfirmed', 'income', 'low', 1),
  ('00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-0000000000a2', 'ph-b', 100, '2026-09-11', 'B-in', 'transfer_like_unconfirmed', 'expense', 'low', 1);

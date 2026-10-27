-- 16c: the documented cycle outside the evaluator. A multi-statement RPC (per-user lock, then input
-- writes, then evaluation) holds L2 from its first write's bump; a lock-free writer holds row B and waits
-- on L2 for its own bump; the RPC then writes row B. PostgreSQL detects the deadlock and aborts one
-- side, which rolls back completely (bump included). Whatever the outcome, fresh states must equal a
-- re-evaluation of the committed data: never falsely fresh.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-00000000c151', '00000000-0000-0000-0000-000000000001', 'c15-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-00000000c152', '00000000-0000-0000-0000-000000000001', 'c15-x', 'Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000c151', 'c15-a', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000c151', 'c15-b', 200, '2026-09-03', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000c152', 'c15-card', -100, '2026-09-02', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
reset role;
create table public.th_c15_outcome (who text primary key, outcome text not null);
grant select, insert on public.th_c15_outcome to service_role;

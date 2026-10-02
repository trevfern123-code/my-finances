-- Bump coalescing (20261002120000): the race that starts from an ALREADY-STALE committed row. One user, a
-- matched pair, evaluated, then changed in a committed transaction, so the row is stale before the race
-- begins. A writer's first bump in a new transaction must still take L2 even though the row is already stale.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c2501', '00000000-0000-0000-0000-000000000001', 'c25-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000c2502', '00000000-0000-0000-0000-000000000001', 'c25-x', 'Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000c2501', 'c25-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000c2502', 'c25-card', -100, '2026-09-02', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
update public.transactions set amount = 99 where plaid_transaction_id = 'c25-pay';
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'seed: stale before the race');

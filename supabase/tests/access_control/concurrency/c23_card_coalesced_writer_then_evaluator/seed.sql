-- Bump coalescing (20261002120000): one user, a matched pair, evaluated (fresh) before the race.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1c01', '00000000-0000-0000-0000-000000000001', 'c23-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000c1c02', '00000000-0000-0000-0000-000000000001', 'c23-x', 'Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1c01', 'c23-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000c1c02', 'c23-card', -100, '2026-09-02', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'seed: fresh');

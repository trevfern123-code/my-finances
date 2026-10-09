-- Two removals of ONE user, running concurrently, whose removed candidates look alike (20261008120000; the
-- contract, 1 to 3). Each removal writes its own hold for its own source: the second removal's hold on a pair is
-- written although the first removal's hold on that pair, with the same date, is live — and each hold's
-- provenance row names the removal, the removed account and the removed transaction it depends on.
-- 20261006120000 wrote ONE hold there (it skipped a pair and date that already had a live hold), and that hold
-- then stood for two removed transactions without naming either.
-- The second removal queues on the per-user advisory lock (L1), the first lock it takes, and starts when the
-- first has committed: the two generations are numbered in commit order.
--   q    C  +60 09-03   the payment
--   yq   Y  −60 09-05   a kept card that fits, 2 days away
--   x1q  X1 −60 09-04   the card of item 1, 1 day away   \  a tie: the payment has no automatic match
--   x2q  X2 −60 09-04   the card of item 4, 1 day away   /
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a4', 'placeholder-token-a4', 'Bank B');
-- C and Y stay (item 3). X1 is on the item removed first (item 1), X2 on the item removed second (item 4): the
-- same type, subtype and mask.
insert into public.accounts (id, item_id, plaid_account_id, name, type, subtype, mask) values
  ('00000000-0000-0000-0000-000000037c01', '00000000-0000-0000-0000-000000000003', 'c37-c', 'Checking', 'depository', 'checking', '9001'),
  ('00000000-0000-0000-0000-000000037c03', '00000000-0000-0000-0000-000000000003', 'c37-y', 'Kept Card Y', 'credit', 'credit card', '9002'),
  ('00000000-0000-0000-0000-000000037c02', '00000000-0000-0000-0000-000000000001', 'c37-x1', 'Card X1', 'credit', 'credit card', '1111'),
  ('00000000-0000-0000-0000-000000037c04', '00000000-0000-0000-0000-000000000004', 'c37-x2', 'Card X2', 'credit', 'credit card', '1111');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-000000037c01', 'c37-q', 60, '2026-09-03', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000037c03', 'c37-yq', -60, '2026-09-05', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000037c02', 'c37-x1q', -60, '2026-09-04', false, 'credit_card_payment'),
  ('00000000-0000-0000-0000-000000037c04', 'c37-x2q', -60, '2026-09-04', false, 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'the removal of item 1 begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000004', public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000004'))->>'outcome' = 'started', 'the removal of item 4 begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000004', 'removed', null);
select th.assert((select count(*) = 2 and bool_and(status = 'plaid_removed') from public.plaid_item_removals), 'fixture: both removals are confirmed at Plaid, and neither has run');
reset role;
-- What the payment reads before either removal: state/reason/effect/partner/range/decision/its tier-1-shaped
-- candidates. And each session's outcome.
create table public.th_c37_state as
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') || '/' || coalesce(l->>'partnerTransactionId', '-')
         || '/' || (l->>'lowCents') || '..' || (l->>'highCents') || '/' || coalesce(l->>'decisionId', '-') || '/'
         || (select coalesce(string_agg(t.plaid_transaction_id, ',' order by t.plaid_transaction_id collate "C"), '')
             from jsonb_array_elements(l->'candidates') c join public.transactions t on t.id = (c->>'transactionId')::uuid
             where c->>'kind' = 'tier1_competitor') as q
  from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
  where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c37-q');
select th.assert((select q from public.th_c37_state) = 'unresolved/ambiguous/null/-/-6000..0/-/c37-x1q,c37-x2q,c37-yq',
  'fixture: the payment is unresolved — the two cards that will be removed tie, and the kept card fits less well');
create table public.th_c37_outcome (who text primary key, outcome text not null);
grant select on public.th_c37_state to service_role;
grant select, insert on public.th_c37_outcome to service_role;

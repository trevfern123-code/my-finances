-- Rehearsal step 1: matching state on the supported baseline (every migration before 20261002120000).
--   aa  fresh, with a saved user decision (a link) and an automatic pair;
--   bb  stale (an input changed after its evaluation);
--   cc  never evaluated (version row, NULL evaluated_version);
--   ss  the straddling sessions' user (excluded from the data snapshots, since those sessions write).
create schema rehearsal;
create table rehearsal.signal (s text primary key);
create table rehearsal.touch1 (x integer);
create table rehearsal.touch2 (x integer);
create table rehearsal.snap (label text, tbl text, digest text, n bigint, primary key (label, tbl));
grant usage on schema rehearsal to service_role;
grant select, insert on all tables in schema rehearsal to service_role;
-- Digest of every card-payment table and the matching inputs, excluding the straddler's user (ss).
create function rehearsal.take(p_label text) returns void language plpgsql as $$
declare
  ss constant uuid := '00000000-0000-0000-0000-0000000000ee';
begin
  insert into rehearsal.snap
  select p_label, 'card_payment_eval_versions', md5(coalesce(string_agg(t::text, '|' order by t::text), '')), count(*)
  from public.card_payment_eval_versions t where t.user_id <> ss
  union all
  select p_label, 'card_payment_decisions', md5(coalesce(string_agg(t::text, '|' order by t::text), '')), count(*)
  from public.card_payment_decisions t where t.user_id <> ss
  union all
  select p_label, 'card_payment_leg_states', md5(coalesce(string_agg(t::text, '|' order by t::text), '')), count(*)
  from public.card_payment_leg_states t where t.user_id <> ss
  union all
  select p_label, 'card_payment_auto_pairs', md5(coalesce(string_agg(t::text, '|' order by t::text), '')), count(*)
  from public.card_payment_auto_pairs t where t.user_id <> ss
  union all
  select p_label, 'card_payment_decision_states', md5(coalesce(string_agg(t::text, '|' order by t::text), '')), count(*)
  from public.card_payment_decision_states t where t.user_id <> ss
  union all
  select p_label, 'transactions', md5(coalesce(string_agg(t::text, '|' order by t::text), '')), count(*)
  from public.transactions t join public.accounts a on a.id = t.account_id join public.plaid_items i on i.id = a.item_id where i.user_id <> ss
  union all
  select p_label, 'accounts', md5(coalesce(string_agg(a::text, '|' order by a::text), '')), count(*)
  from public.accounts a join public.plaid_items i on i.id = a.item_id where i.user_id <> ss;
end $$;
create function rehearsal.same(p_a text, p_b text) returns boolean language sql as $$
  select count(*) = 7 and bool_and(a.digest = b.digest and a.n = b.n)
  from rehearsal.snap a join rehearsal.snap b on b.tbl = a.tbl and b.label = p_b where a.label = p_a $$;
create function rehearsal.body_md5(p_fn regprocedure) returns text language sql as $$
  select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = p_fn $$;
create function rehearsal.iv(p uuid) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p $$;
create function rehearsal.fresh(p uuid) returns boolean language sql as $$
  select coalesce((public.get_card_payment_states(p)->>'fresh')::boolean, false) $$;
create function rehearsal.cents(p uuid, p_plaid text) returns bigint language sql as $$
  select (l->>'amountCents')::bigint from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
grant execute on all functions in schema rehearsal to service_role;

select th.assert(rehearsal.body_md5('public.card_payment_bump(uuid)') = '9b67a29937db09a4661f0f906cf80563'
                 and rehearsal.body_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = 'c43128295a457d62b83448083eb6f7d2',
  'baseline: card_payment_bump and evaluate_card_payments are the 20260930120000 bodies');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000cc', 'never@example.test'), ('00000000-0000-0000-0000-0000000000ee', 'straddler@example.test');
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000ee', 'rh-item-ss', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000fa001', '00000000-0000-0000-0000-000000000001', 'rh-ac', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000fa002', '00000000-0000-0000-0000-000000000001', 'rh-ak', 'Card', 'credit'),
  ('00000000-0000-0000-0000-0000000fb001', '00000000-0000-0000-0000-000000000002', 'rh-bc', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000fb002', '00000000-0000-0000-0000-000000000002', 'rh-bk', 'Card', 'credit'),
  ('00000000-0000-0000-0000-0000000fe001', '00000000-0000-0000-0000-0000000000e1', 'rh-ec', 'Checking', 'depository');

set role service_role;
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000fa001', 'rh-aa-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fa002', 'rh-aa-card', -100, '2026-09-02', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fa001', 'rh-aa-lpay', 55.55, '2026-03-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fa002', 'rh-aa-lcard', -55.55, '2026-05-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-pay', 44, '2026-03-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fb002', 'rh-bb-card', -44, '2026-05-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fe001', 'rh-ss-1', 10, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fe001', 'rh-ss-2', 20, '2026-09-02', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000fe001', 'rh-ss-3', 30, '2026-09-03', 'credit_card_payment');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((public.link_card_payment('00000000-0000-0000-0000-0000000000aa',
                   (select id from public.transactions where plaid_transaction_id = 'rh-aa-lpay'),
                   (select id from public.transactions where plaid_transaction_id = 'rh-aa-lcard'), 0,
                   rehearsal.iv('00000000-0000-0000-0000-0000000000aa'))->>'status') = 'saved', 'baseline: a decision is saved');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000ee');
update public.transactions set amount = 45 where plaid_transaction_id = 'rh-bb-pay';
select public.card_payment_bump('00000000-0000-0000-0000-0000000000cc');
-- The previous body: one statement of three rows advances its owner three times.
create temporary table probe as select rehearsal.iv('00000000-0000-0000-0000-0000000000bb') as v;
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-x1', 1, '2026-01-01'), ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-x2', 2, '2026-01-02'),
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-x3', 3, '2026-01-03');
select th.assert(rehearsal.iv('00000000-0000-0000-0000-0000000000bb') - (select v from probe) = 3, 'baseline: per-row bumps (3 for 3 rows)');
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000aa') and not rehearsal.fresh('00000000-0000-0000-0000-0000000000bb')
                 and (select evaluated_version is null from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000cc')
                 and rehearsal.fresh('00000000-0000-0000-0000-0000000000ee'),
  'baseline: aa fresh, bb stale, cc never evaluated, ss fresh');
reset role;
select rehearsal.take('before_upgrade');

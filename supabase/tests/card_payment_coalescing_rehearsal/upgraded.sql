-- Rehearsal step 3: after the upgrade.
select rehearsal.take('after_upgrade');
select th.assert(rehearsal.same('before_upgrade', 'after_upgrade'),
  'upgraded: no row of any card-payment table, transactions or accounts changed (outside the straddler''s user)');
select th.assert(rehearsal.body_md5('public.card_payment_bump(uuid)') = '3fa11a0ed807dfb54aad20ba576e567c'
                 and rehearsal.body_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = 'f620515feaee49b382965cc8b73f02e2',
  'upgraded: the migration''s bodies are installed');
set role service_role;
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000aa') and not rehearsal.fresh('00000000-0000-0000-0000-0000000000bb')
                 and (select evaluated_version is null from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000cc'),
  'upgraded: freshness exactly as before (aa fresh, bb stale, cc never evaluated)');
select th.assert((select count(*) from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'decisions')) = 1,
  'upgraded: aa''s stored states, with its decision, are still readable');
select th.assert(not rehearsal.fresh('00000000-0000-0000-0000-0000000000ee'), 'upgraded: the straddler left its user stale');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000ee');
select th.assert(rehearsal.cents('00000000-0000-0000-0000-0000000000ee', 'rh-ss-1') = 1100 and rehearsal.cents('00000000-0000-0000-0000-0000000000ee', 'rh-ss-2') = 2100
                 and rehearsal.cents('00000000-0000-0000-0000-0000000000ee', 'rh-ss-3') = 3100,
  'upgraded: re-evaluation includes every straddling write');
-- Coalescing is active: one statement of three rows advances bb once.
create temporary table probe as select rehearsal.iv('00000000-0000-0000-0000-0000000000bb') as v;
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-y1', 1, '2026-01-04'), ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-y2', 2, '2026-01-05'),
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-y3', 3, '2026-01-06');
select th.assert(rehearsal.iv('00000000-0000-0000-0000-0000000000bb') - (select v from probe) = 1, 'upgraded: coalesced (1 for 3 rows)');
-- Evaluation, re-invalidation in the same transaction, and a decision RPC's compare-and-set.
begin;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'), 'upgraded: evaluation publishes');
update public.transactions set amount = 46 where plaid_transaction_id = 'rh-bb-pay';
select th.assert(not rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'), 'upgraded: a write after the evaluation re-invalidates');
commit;
update probe set v = rehearsal.iv('00000000-0000-0000-0000-0000000000bb');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');
select th.expect_error(format('select public.link_card_payment(%L, (select id from public.transactions where plaid_transaction_id = %L), (select id from public.transactions where plaid_transaction_id = %L), 0, %s)',
                              '00000000-0000-0000-0000-0000000000bb', 'rh-bb-pay', 'rh-bb-card', (select v from probe) - 1),
                       'card_payment_stale_version:%');
select th.assert((public.link_card_payment('00000000-0000-0000-0000-0000000000bb',
                   (select id from public.transactions where plaid_transaction_id = 'rh-bb-pay'),
                   (select id from public.transactions where plaid_transaction_id = 'rh-bb-card'), 200,
                   rehearsal.iv('00000000-0000-0000-0000-0000000000bb'))->>'status') = 'saved',
  'upgraded: a stale expected version is refused; the current one is accepted');
reset role;
select rehearsal.take('before_rollback');

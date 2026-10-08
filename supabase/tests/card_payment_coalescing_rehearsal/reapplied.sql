-- Rehearsal step 6: after re-applying the migration file on top of the rolled-back bodies.
select rehearsal.take('after_reapply');
select th.assert(rehearsal.same('before_reapply', 'after_reapply'), 'reapplied: no row changed');
select th.assert(rehearsal.body_md5('public.card_payment_bump(uuid)') = '3fa11a0ed807dfb54aad20ba576e567c'
                 and rehearsal.body_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = 'f620515feaee49b382965cc8b73f02e2',
  'reapplied: the migration''s bodies are installed again');
set role service_role;
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000aa') and rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'),
  'reapplied: freshness unchanged');
create temporary table probe as select rehearsal.iv('00000000-0000-0000-0000-0000000000bb') as v;
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-w1', 1, '2026-01-10'), ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-w2', 2, '2026-01-11'),
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-w3', 3, '2026-01-12');
select th.assert(rehearsal.iv('00000000-0000-0000-0000-0000000000bb') - (select v from probe) = 1, 'reapplied: coalesced again (1 for 3 rows)');
select th.assert(not rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'), 'reapplied: and stale');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'), 'reapplied: evaluation publishes');

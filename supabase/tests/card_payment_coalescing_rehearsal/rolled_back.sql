-- Rehearsal step 5: after the rollback script.
select rehearsal.take('after_rollback');
select th.assert(rehearsal.same('before_rollback', 'after_rollback'),
  'rolled back: no row of any card-payment table, transactions or accounts changed (outside the straddler''s user)');
select th.assert(rehearsal.body_md5('public.card_payment_bump(uuid)') = '9b67a29937db09a4661f0f906cf80563'
                 and rehearsal.body_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = 'c43128295a457d62b83448083eb6f7d2',
  'rolled back: the 20260930120000 bodies are restored byte for byte');
select th.assert((select count(*) from pg_proc p where p.oid in ('public.card_payment_bump(uuid)'::regprocedure,
                    'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure)
                    and not p.prosecdef and p.proconfig = array['search_path=""']
                    and has_function_privilege('service_role', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')) = 2,
  'rolled back: security, search_path and grants preserved');
set role service_role;
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000aa') and rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'),
  'rolled back: states published under the new bodies stay readable');
select th.assert(not rehearsal.fresh('00000000-0000-0000-0000-0000000000ee'), 'rolled back: the straddler left its user stale');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000ee');
select th.assert(rehearsal.cents('00000000-0000-0000-0000-0000000000ee', 'rh-ss-1') = 1200 and rehearsal.cents('00000000-0000-0000-0000-0000000000ee', 'rh-ss-2') = 2200
                 and rehearsal.cents('00000000-0000-0000-0000-0000000000ee', 'rh-ss-3') = 3200,
  'rolled back: re-evaluation includes every straddling write');
create temporary table probe as select rehearsal.iv('00000000-0000-0000-0000-0000000000bb') as v;
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-z1', 1, '2026-01-07'), ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-z2', 2, '2026-01-08'),
  ('00000000-0000-0000-0000-0000000fb001', 'rh-bb-z3', 3, '2026-01-09');
select th.assert(rehearsal.iv('00000000-0000-0000-0000-0000000000bb') - (select v from probe) = 3, 'rolled back: per-row bumps again (3 for 3 rows)');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000bb'), 'rolled back: the previous evaluator publishes');
reset role;
select rehearsal.take('before_reapply');

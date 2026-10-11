-- The migration was applied to the database of s1.
set role service_role;
select th.assert(rrh.obligations('k') = 'seeded(harness-item-a) edges=y sources=ambiguity_hold:x,removed_destination:x',
                 'seeded from what is retained: one obligation, attributed to its removal, the hold''s own edge, both sources — and no gap: ' || rrh.obligations('k'));
select th.assert(not rrh.fresh() and not rrh.fresh(rrh.bb()) and not (rrh.states() ? 'legs') and not (rrh.states(rrh.bb()) ? 'legs'),
                 'NOBODY is readable: the stored states were published by the previous evaluator');
select th.assert((public.get_financial_read_snapshot(rrh.aa(), '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01')->'cardPayments'->>'fresh')::boolean = false and not (public.get_financial_read_snapshot(rrh.aa(), '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01')->'cardPayments' ? 'legs'), 'the financial snapshot returns no card state either');
select th.assert(not exists (select 1 from public.card_payment_evaluator_contracts), 'no user carries this evaluator''s stamp yet');
select th.assert((select count(*) from public.card_payment_recovery_refresh_queue) = 2
                 and (select bool_and(q.target_version = v.input_version) from public.card_payment_recovery_refresh_queue q join public.card_payment_eval_versions v using (user_id)),
                 'refresh work is registered for both users, at their input versions');
select th.assert((public.get_card_payment_recovery_reviews(rrh.aa())->>'fresh')::boolean = false and (public.get_card_payment_recovery_reviews(rrh.aa())->>'affectedPaymentCount')::integer = 1,
                 'the review reader: one affected payment, no figure');
-- The worker's two calls, for everyone who is due.
create temporary table claimed as select c from jsonb_array_elements(public.claim_card_payment_recovery_refresh(rrh.op(1), 10)->'claims') c;
create temporary table refreshed as select (c->>'userId')::uuid as user_id, public.refresh_card_payment_recovery_owner((c->>'userId')::uuid, (c->>'leaseToken')::uuid) as answer from pg_temp.claimed;
select th.assert((select count(*) = 2 and bool_and(answer->>'status' = 'fresh') from pg_temp.refreshed), 'both users are refreshed with no sync and no action');
select th.assert(rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0' and rrh.review('k') = 'withheld=w obligations=1 gap=f',
                 'the affected owner now reads the guarded range: ' || rrh.line('k') || ' ' || rrh.review('k'));
select th.assert(rrh.line('bk', rrh.bb()) = 'tracked/auto_pair/0 partner=by decision=- range=0..0' and rrh.review('bk', rrh.bb()) = 'none', 'the other user reads exactly what it read before');
select th.assert(not exists (select 1 from public.card_payment_recovery_refresh_queue), 'the work is done');
-- One receipt and one note, to follow through the rollback.
select th.assert(rrh.outcome(rrh.act(rrh.op(2), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k')))) = 'committed_fresh', 'a deferral is recorded');
reset role;
create table public.th_rehearsal_counts as select (select format('obligations=%s sources=%s edges=%s notes=%s receipts=%s',
               (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_obligation_sources),
               (select count(*) from public.card_payment_review_memberships), (select count(*) from public.card_payment_review_annotations),
               (select count(*) from public.card_payment_recovery_actions))) as counts;
select th.assert((select counts from public.th_rehearsal_counts) = 'obligations=1 sources=2 edges=1 notes=1 receipts=1', 'the rows to follow: ' || (select counts from public.th_rehearsal_counts));

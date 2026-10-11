-- After the rollback with the operator's setting.
select th.assert((select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) = '6cb5e299b0383fab0b6517cc2e7522c8', 'the evaluator is the 20261006110000 body');
select th.assert((select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) = 'cc12b7a12c6510924781b93c658ee854', 'the removal is the 20261008120000 body');
select th.assert((select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) = '446e7a46e2774d52ef995cd55a79d5ed', 'the reader is the 20260930120000 body');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and (p.proname like '%card\_payment\_recovery%' or p.proname like 'card\_payment\_review\_%')
                               and p.proname <> 'card_payment_recovery_downgrade_fence'), 'no recovery or review function is installed');
select th.assert((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind = 'r'
                    and c.relname in ('card_payment_review_obligations', 'card_payment_review_obligation_sources', 'card_payment_review_memberships',
                                      'card_payment_review_states', 'card_payment_evaluator_contracts', 'card_payment_review_revisions',
                                      'card_payment_review_annotations', 'card_payment_recovery_actions', 'card_payment_recovery_refresh_queue')) = 9,
                 'all nine tables are kept');
select th.assert(not exists (select 1 from public.card_payment_evaluator_contracts), 'no evaluator stamp survives the evaluator that wrote it');
select th.assert(exists (select 1 from pg_trigger t where t.tgrelid = 'public.card_payment_eval_versions'::regclass and t.tgname = 'card_payment_recovery_downgrade_fence'),
                 'the downgrade fence is installed');
select th.assert((select format('obligations=%s sources=%s edges=%s notes=%s receipts=%s',
               (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_obligation_sources),
               (select count(*) from public.card_payment_review_memberships), (select count(*) from public.card_payment_review_annotations),
               (select count(*) from public.card_payment_recovery_actions))) = (select counts from public.th_rehearsal_counts), 'every obligation, source, known edge, note and receipt is kept: ' || (select format('obligations=%s sources=%s edges=%s notes=%s receipts=%s',
               (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_obligation_sources),
               (select count(*) from public.card_payment_review_memberships), (select count(*) from public.card_payment_review_annotations),
               (select count(*) from public.card_payment_recovery_actions))));
select th.assert((select evaluated_version is null from public.card_payment_eval_versions where user_id = rrh.aa()), 'the affected owner''s evaluated version was cleared');
set role service_role;
select th.assert(not coalesce((public.get_card_payment_states(rrh.aa())->>'fresh')::boolean, false) and not (public.get_card_payment_states(rrh.aa()) ? 'legs'), 'the previous reader returns nothing for the affected owner');
-- The previous evaluator runs — and would publish the unguarded pair. The fence keeps it unreadable.
select public.evaluate_card_payments(rrh.aa());
select th.assert((select s.state = 'tracked' and s.reason = 'auto_pair' and s.effect_cents = 0 from public.card_payment_leg_states s where s.transaction_id = rrh.tid('k')),
                 'the previous evaluator DID compute the unguarded pair for the affected owner (tracked, 0)');
select th.assert((select evaluated_version is null from public.card_payment_eval_versions where user_id = rrh.aa())
                 and not coalesce((public.get_card_payment_states(rrh.aa())->>'fresh')::boolean, false) and not (public.get_card_payment_states(rrh.aa()) ? 'legs')
                 and (public.get_financial_read_snapshot(rrh.aa(), '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01')->'cardPayments'->>'fresh')::boolean = false and not (public.get_financial_read_snapshot(rrh.aa(), '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01')->'cardPayments' ? 'legs'),
                 'and no reader returns it: the figures of the affected owner are explicitly unavailable, never the unguarded pair');
select th.expect_error(format('select public.link_card_payment(%L, %L, %L, 0, %s)', rrh.aa(), rrh.tid('k'), rrh.tid('w'), rrh.iv()), 'card_payment_stale_version:%');
select th.assert(public.try_evaluate_card_payments(rrh.aa()) and (select evaluated_version is null from public.card_payment_eval_versions where user_id = rrh.aa()), 'the best-effort wrapper is fenced too');
-- A user with no review obligation is not fenced: the previous evaluator serves it as before.
select public.evaluate_card_payments(rrh.bb());
select th.assert(rrh.fresh(rrh.bb()) and rrh.line('bk', rrh.bb()) = 'tracked/auto_pair/0 partner=by decision=- range=0..0', 'the other user is fresh under the previous reader: ' || rrh.line('bk', rrh.bb()));

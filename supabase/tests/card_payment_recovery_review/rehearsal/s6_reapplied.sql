-- The migration was applied again.
select th.assert((select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8' and (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'cc12b7a12c6510924781b93c658ee854' and (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> '446e7a46e2774d52ef995cd55a79d5ed', 'the three bodies are this migration''s again');
select th.assert(not exists (select 1 from pg_trigger t where t.tgrelid = 'public.card_payment_eval_versions'::regclass and t.tgname = 'card_payment_recovery_downgrade_fence'),
                 'the downgrade fence is not installed');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'card_payment_recovery_downgrade_fence'), 'the fence function is gone');
set role service_role;
select th.assert(rrh.obligations('k') = 'seeded(harness-item-a) edges=y sources=ambiguity_hold:x,removed_destination:x ; seeded(reh-item-other) edges=y sources=ambiguity_hold:w,removed_destination:w',
                 'the removal made while rolled back is seeded as its own obligation; the first is not duplicated: ' || rrh.obligations('k'));
select th.assert((select count(*) from public.card_payment_review_obligation_sources) = 4 and (select count(distinct decision_id) from public.card_payment_review_obligation_sources) = 4,
                 'four sources, one per retained decision');
select th.assert((public.get_card_payment_recovery_action(rrh.aa(), rrh.op(2))->>'found')::boolean and (select count(*) from public.card_payment_review_annotations) = 1, 'the receipt and the note of s2 are still there');
select th.assert(not rrh.fresh() and not rrh.fresh(rrh.bb()) and not exists (select 1 from public.card_payment_evaluator_contracts) and (select count(*) from public.card_payment_recovery_refresh_queue) = 2,
                 'nobody is readable — the other user was fresh under the previous evaluator a moment ago — and both have refresh work');
create temporary table claimed as select c from jsonb_array_elements(public.claim_card_payment_recovery_refresh(rrh.op(1), 10)->'claims') c;
create temporary table refreshed as select public.refresh_card_payment_recovery_owner((c->>'userId')::uuid, (c->>'leaseToken')::uuid) as answer from pg_temp.claimed;
select th.assert((select count(*) = 2 and bool_and(answer->>'status' = 'fresh') from pg_temp.refreshed), 'both are refreshed');
-- w is gone with its institution. k/y is the selected pair; both holds withhold it; the records give −370.
select th.assert(rrh.line('k') = 'untracked/removed_card/-37000 partner=- decision=destination_removed_card range=-37000..-37000' and rrh.review('k') = 'withheld=- obligations=2 gap=f',
                 'the payment reads its retained record, under two obligations: ' || rrh.line('k') || ' ' || rrh.review('k'));
-- And the guard holds for what arrives next.
select rrh.item('00000000-0000-0000-0000-000000000009', rrh.aa(), 'reh-item-third', 'Third Bank');
select rrh.account('00000000-0000-0000-0000-00000001f0f1', '00000000-0000-0000-0000-000000000009', 'reh-w2', 'credit');
select rrh.cardleg('w2', '00000000-0000-0000-0000-00000001f0f1', -370, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0' and rrh.review('k') = 'withheld=w2 obligations=2 gap=f',
                 'a new unrelated transaction is withheld: ' || rrh.line('k') || ' ' || rrh.review('k'));

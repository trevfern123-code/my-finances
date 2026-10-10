-- The refused rollback changed nothing.
select th.assert((select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8' and (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'cc12b7a12c6510924781b93c658ee854' and (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> '446e7a46e2774d52ef995cd55a79d5ed', 'the three bodies are still this migration''s');
select th.assert(to_regprocedure('public.apply_card_payment_recovery_action(uuid, uuid, bigint, bigint, jsonb)') is not null, 'the recovery functions are still installed');
select th.assert(not exists (select 1 from pg_trigger t where t.tgrelid = 'public.card_payment_eval_versions'::regclass and t.tgname = 'card_payment_recovery_downgrade_fence'),
                 'the downgrade fence is not installed');
select th.assert((select format('obligations=%s sources=%s edges=%s notes=%s receipts=%s',
               (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_obligation_sources),
               (select count(*) from public.card_payment_review_memberships), (select count(*) from public.card_payment_review_annotations),
               (select count(*) from public.card_payment_recovery_actions))) = (select counts from public.th_rehearsal_counts), 'every row is as it was');
set role service_role;
select th.assert(rrh.fresh() and rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0', 'the affected owner is still fresh and guarded: ' || rrh.line('k'));

-- After the rollback of a database with no review obligation: exactly the previous bodies, and no fence.
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
select th.assert(not exists (select 1 from pg_trigger t where t.tgrelid = 'public.card_payment_eval_versions'::regclass and t.tgname = 'card_payment_recovery_downgrade_fence'),
                 'the downgrade fence is not installed');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'card_payment_recovery_downgrade_fence'),
                 'the fence function is not left behind either');
select th.assert(not exists (select 1 from pg_trigger t where not t.tgisinternal and t.tgname in ('card_payment_recovery_enqueue', 'card_payment_review_obligations_changed',
                 'card_payment_review_memberships_changed', 'card_payment_review_obligation_sources_changed', 'card_payment_review_annotations_changed')), 'none of the migration''s triggers is left');

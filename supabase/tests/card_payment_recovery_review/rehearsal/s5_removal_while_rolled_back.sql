-- While rolled back: a removal under the PREVIOUS body. It preserves decisions and provenance and captures no
-- obligation (that body does not know them). The affected owner stays fenced.
set role service_role;
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000008');
select th.assert(rrh.retained('k') = 'D(k) D(k) H(y/k@2026-09-11) H(y/k@2026-09-11)', 'the removal wrote its own record and hold (its match w, removed, was dated the 11th too): ' || rrh.retained('k'));
select th.assert((select count(*) from public.card_payment_removal_sources) = 4 and (select count(*) from public.card_payment_removal_generations where sources_recorded) = 2, 'with provenance: four rows, two recorded generations');
reset role;
select th.assert((select format('obligations=%s sources=%s edges=%s notes=%s receipts=%s',
               (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_obligation_sources),
               (select count(*) from public.card_payment_review_memberships), (select count(*) from public.card_payment_review_annotations),
               (select count(*) from public.card_payment_recovery_actions))) = (select counts from public.th_rehearsal_counts), 'and no obligation: ' || (select format('obligations=%s sources=%s edges=%s notes=%s receipts=%s',
               (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_obligation_sources),
               (select count(*) from public.card_payment_review_memberships), (select count(*) from public.card_payment_review_annotations),
               (select count(*) from public.card_payment_recovery_actions))));
select th.assert((select evaluated_version is null from public.card_payment_eval_versions where user_id = rrh.aa()), 'the removal''s own evaluations did not make the affected owner readable');

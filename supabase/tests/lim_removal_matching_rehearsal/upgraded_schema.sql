-- Rehearsal step 3: right after 20261006110000 (the decision kinds, the evaluator, three RPCs) was applied to the
-- populated database. It must be behaviour-neutral: nothing writes the new kind yet.
select rehearsal.take('schema_upgraded');
select th.assert(rehearsal.same('old_removed', 'schema_upgraded'), 'schema upgrade: no row of any card-payment, transaction, account, item, removal, loan, carry-over or split table changed');
select th.assert(rehearsal.fn_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = '6cb5e299b0383fab0b6517cc2e7522c8'
                 and rehearsal.fn_md5('public.link_card_payment(uuid, uuid, uuid, bigint, bigint)') = '1ddf83f559f5179975ef52a08b7f2063'
                 and rehearsal.fn_md5('public.mark_card_payment_destination(uuid, uuid, bigint)') = 'c2c5368d749e490ed8f7e062ded261cd'
                 and rehearsal.fn_md5('public.undo_card_payment_decision(uuid, uuid, bigint)') = 'dfcba4535ba1087928185d14cc978c10'
                 and rehearsal.fn_md5('public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)') = '6f8add9a971061e1eaefc872d85ba74a',
  'schema upgrade: the evaluator, the three RPCs and the helper are the 20261006110000 bodies');
select th.assert(rehearsal.body_md5() = 'a8f567d397b9dae5b777497317985ab7', 'schema upgrade: institution removal is still the 20260926120000 body');
select th.assert(not exists (select 1 from public.card_payment_decisions
                             where counterpart_status is not null or counterpart_date is not null
                                or kind = 'pair_counterpart_removed' or kind like 'ambiguity_hold_%'),
  'schema upgrade: the new columns are empty and no decision has a new kind');

set role service_role;
-- The same evaluation as before the upgrade, with the new evaluator: every state is what it was.
select th.assert(rehearsal.fresh() and rehearsal.sre('k2') = 'tracked/auto_pair/0' and rehearsal.sre('ku2') = 'tracked/user_pair/0'
                 and rehearsal.sre('ku') = 'untracked/user_confirmed_unlinked/-2500' and rehearsal.sre('k1') = 'unresolved/no_candidate/null'
                 and rehearsal.sre('kt') = 'unresolved/ambiguous/null' and rehearsal.sre('kt1') = 'tracked/auto_pair/0',
  'schema upgrade: freshness and states are as they were');
create temporary table before_reeval as select public.get_card_payment_states(rehearsal.aa()) - 'evaluatedVersion' - 'inputVersion' - 'asOf' as s;
select public.evaluate_card_payments(rehearsal.aa(), (select evaluated_as_of from public.card_payment_eval_versions where user_id = rehearsal.aa()));
select th.assert((select s from before_reeval) = public.get_card_payment_states(rehearsal.aa()) - 'evaluatedVersion' - 'inputVersion' - 'asOf',
  'schema upgrade: re-evaluating the same rows with the new evaluator gives exactly the states the previous one gave');
reset role;
select rehearsal.take('schema_upgraded_evaluated');

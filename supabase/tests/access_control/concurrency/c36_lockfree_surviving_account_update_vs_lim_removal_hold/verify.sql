set role service_role;
select th.assert((select outcome from public.th_c36_outcome where who = 'contender') = 'removed'
                 and (select outcome from public.th_c36_outcome where who = 'holder-saw') = 'removal_completed_while_the_row_was_held'
                 and (select outcome from public.th_c36_outcome where who = 'holder') = 'updated',
  'both completed, the removal FIRST: it did not wait for the kept card account row the writer held — no wait, so no cycle');
select th.assert(not exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') and (select status from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000001') = 'cleaned', 'the institution is removed and the operation cleaned');
select th.assert((select count(*) = 1 and bool_and(d.a_account_id = '00000000-0000-0000-0000-000000036c03' and d.a_plaid_transaction_id = 'c36-yq' and d.b_plaid_transaction_id = 'c36-q'
                                                   and d.kind = 'ambiguity_hold_removed_card' and d.counterpart_date = '2026-09-04' and d.superseded_by is null)
                  from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%')
                 and (select coalesce(array_agg(a_plaid_transaction_id order by a_plaid_transaction_id), '{}') from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null) = array['c36-q'],
  'the removal wrote the record and the hold that names the kept card account, while that account row was locked by the writer');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean
                 and (select input_version = evaluated_version + 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'),
  'the writer changed an input after the final evaluation of the removal: the user is STALE (one version ahead), never falsely fresh');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'a later evaluation publishes fresh states');
select th.assert((select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') || '/' || coalesce(l->>'partnerTransactionId', '-')
                  from (select l from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                        where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c36-q')) x(l)) = 'untracked/removed_card/-6000/-',
  'the payment keeps its removed destination; it is not switched to the kept card (now excluded by the writer)');

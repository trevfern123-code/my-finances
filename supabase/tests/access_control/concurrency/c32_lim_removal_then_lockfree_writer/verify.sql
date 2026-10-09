set role service_role;
select th.assert((select outcome from public.th_c32_outcome where who = 'holder') = 'removed' and (select outcome from public.th_c32_outcome where who = 'contender') = 'updated', 'both committed');
select th.assert((select input_version = evaluated_version + 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'),
  'the writer''s bump landed after the removal''s publication: input_version is one ahead');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean and public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs' is null, 'stale: no states are readable, so −60 is not shown for a 61 payment');
select th.assert((select coalesce(array_agg(a_plaid_transaction_id order by a_plaid_transaction_id), '{}') from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null) = array['c32-q'], 'the record the removal wrote is still there');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') from (select l from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c32-q')) x(l)) = 'unresolved/no_candidate/null', 'after the next evaluation the changed payment is unresolved: its record no longer matches the amount');

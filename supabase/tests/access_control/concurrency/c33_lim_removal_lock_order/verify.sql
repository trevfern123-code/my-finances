set role service_role;
select th.assert((select outcome from public.th_c33_outcome where who = 'holder') = 'l2_free',
  'while waiting on L1, the removal held no lock on the version row (L1 strictly before L2)');
select th.assert((select outcome from public.th_c33_outcome where who = 'contender') = 'removed', 'the removal then proceeded');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean and (select evaluated_version = input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa') and (select coalesce(array_agg(a_plaid_transaction_id order by a_plaid_transaction_id), '{}') from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null) = array['c33-q'], 'and committed fresh, with the destination preserved');

set role service_role;
select th.assert((select outcome from public.th_c18_outcome where who = 'holder') = 'saved' and (select outcome from public.th_c18_outcome where who = 'contender') = 'synced', 'both committed');
select th.assert((select count(*) from public.card_payment_decisions where kind = 'pair' and superseded_by is null and a_plaid_transaction_id = 'c18-p') = 1, 'the decision survived the sync');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'stale after the sync, never falsely fresh');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'fresh: the last writer evaluated, and nothing changed after it');
select th.assert((select l->>'reason' = 'user_pair' and (l->>'partnerTransactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c18-x')
                  from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c18-p')), 'the payment is matched to the winner''s choice');

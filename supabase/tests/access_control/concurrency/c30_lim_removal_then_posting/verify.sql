set role service_role;
select th.assert((select outcome from public.th_c30_outcome where who = 'holder') = 'removed' and (select outcome from public.th_c30_outcome where who = 'contender') = 'synced', 'both committed');
select th.assert((select coalesce(array_agg(a_plaid_transaction_id order by a_plaid_transaction_id), '{}') from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null) = array['c30-pend'], 'the record was written on the pending id, the leg''s lineage key when the card was removed');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean and public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs' is null,
  'the sync changed inputs after the removal''s evaluation: stale, no states readable — never the removal''s states for the old rows');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(not exists (select 1 from public.transactions where plaid_transaction_id = 'c30-pend'), 'the pending row is gone');
select th.assert((select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') from (select l from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c30-posted')) x(l)) = 'untracked/removed_card/-12000', 'the posted replacement carries the preserved destination');

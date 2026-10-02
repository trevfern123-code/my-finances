set role service_role;
select th.assert((select outcome from public.th_c17_outcome where who = 'contender') = 'stale', 'the confirmation was refused as stale');
select th.assert((select count(*) from public.card_payment_decisions) = 0, 'nothing was written');
select th.assert(exists (select 1 from public.transactions where plaid_transaction_id = 'c17-synced'), 'the sync committed');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'the unevaluated sync leaves the user stale (sync integration is slice 2b-2)');

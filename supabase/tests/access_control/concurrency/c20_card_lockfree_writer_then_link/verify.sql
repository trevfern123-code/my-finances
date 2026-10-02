set role service_role;
select th.assert((select outcome from public.th_c20_outcome where who = 'holder') = 'committed' and (select outcome from public.th_c20_outcome where who = 'contender') = 'stale', 'the writer committed; the confirmation was refused');
select th.assert((select count(*) from public.card_payment_decisions) = 0, 'nothing was written');

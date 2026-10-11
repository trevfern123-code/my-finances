set role service_role;
select th.assert((select result from public.th_c03_outcome where who = 'holder') = 'committed_fresh' and (select result from public.th_c03_outcome where who = 'contender') = 'removed', 'both ran, the action first');
select th.assert(rrh.line('k') = 'untracked/removed_card/-37000 partner=- decision=pair_counterpart_removed range=-37000..-37000', 'the removal preserved the user''s pair on the surviving leg: ' || rrh.line('k'));
select th.assert(rrh.obligations('k') = 'captured(fixture-item-other) edges= sources=preserved_confirmation:w ; captured(harness-item-a) edges=y sources=ambiguity_hold:x,removed_destination:x',
                 'the second removal captured its own obligation; the first is untouched: ' || rrh.obligations('k'));
select th.assert((select count(*) from public.card_payment_recovery_actions where user_id = rrh.aa()) = 1
                 and (select a.outcome = 'saved' and a.decision_id is not null and not exists (select 1 from public.card_payment_decisions d where d.id = a.decision_id)
                      from public.card_payment_recovery_actions a where a.user_id = rrh.aa()),
                 'the receipt stays, a fact of what was done — also now that the pair it names went with the removed account');

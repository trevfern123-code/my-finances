set role service_role;
select th.assert((select result from public.th_c02_outcome where who = 'holder') = 'removed', 'the removal ran');
select th.assert((select result from public.th_c02_outcome where who = 'contender') = 'refused: card_payment_stale_version', 'the action that waited is refused as stale: ' || (select result from public.th_c02_outcome where who = 'contender'));
select th.assert((select count(*) from public.card_payment_recovery_actions) = 0 and not exists (select 1 from public.card_payment_decisions where kind = 'pair'), 'nothing was written');
select th.assert(rrh.fresh() and rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0', 'the removal committed fresh states; k is still guarded: ' || rrh.line('k'));

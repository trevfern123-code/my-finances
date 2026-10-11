set role service_role;
select th.assert((select result from public.th_c07_outcome where who = 'contender') in ('refused: card_payment_stale_version', 'refused: card_payment_recovery_not_reviewable', 'refused: card_payment_not_found'),
                 'the action waited on the account row and is refused — not deadlocked: ' || (select result from public.th_c07_outcome where who = 'contender'));
select th.assert((select result from public.th_c07_outcome where who = 'contender') = 'refused: card_payment_stale_version', 'by hand: the delete advanced the input version, so the refusal is "stale": ' || (select result from public.th_c07_outcome where who = 'contender'));
select th.assert((select count(*) from public.card_payment_recovery_actions) = 0 and not exists (select 1 from public.card_payment_decisions where kind = 'pair'), 'nothing was written');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k') = 'untracked/removed_card/-37000 partner=- decision=destination_removed_card range=-37000..-37000', 'with w gone, k reads its retained record again: ' || rrh.line('k'));

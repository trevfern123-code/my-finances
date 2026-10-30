set role service_role;
select th.assert((select result from public.th_c04_outcome where who = 'contender') = 'refused: card_payment_stale_version', 'the action waited for the writer and is refused as stale — not deadlocked: ' || (select result from public.th_c04_outcome where who = 'contender'));
select th.assert((select count(*) from public.card_payment_recovery_actions) = 0 and not exists (select 1 from public.card_payment_decisions where kind = 'pair'), 'nothing was written');
select th.assert((select q.target_version = rrh.iv() from public.card_payment_recovery_refresh_queue q where q.user_id = rrh.aa()), 'the writer''s change is registered for refresh');

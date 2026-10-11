set role service_role;
select th.assert((select result from public.th_c08_outcome where step = 'original request') = 'committed_fresh', 'the original request commits: ' || coalesce((select result from public.th_c08_outcome where step = 'original request'), '(nothing recorded)'));
select th.assert((select result from public.th_c08_outcome where step = 'lookup while the original is open') = 'false'
                 and (select result from public.th_c08_outcome where step = 'receipts and pairs visible while the original is open') = '0 / 0',
                 'RECEIPT TIMING: while the original transaction is open, a lookup of its operation id finds NO receipt (and no decision is visible) — although the action is being saved: '
                 || coalesce((select string_agg(step || '=' || result, '; ' order by step) from public.th_c08_outcome), '(nothing recorded)'));
select th.assert((select result from public.th_c08_outcome where step = 'same operation sent again') = 'replayed',
                 'RECEIPT TIMING: the same operation id and intent, sent again while the original was open, waits for it and is a REPLAY of it — not a second action: '
                 || coalesce((select result from public.th_c08_outcome where step = 'same operation sent again'), '(nothing recorded)'));
select th.assert((select result from public.th_c08_outcome where step = 'lookup after the original committed') = 'true', 'after the commit the same lookup finds the receipt');
select th.assert((select count(*) from public.card_payment_recovery_actions where user_id = rrh.aa()) = 1
                 and (select count(*) from public.card_payment_decisions where user_id = rrh.aa() and kind = 'pair') = 1,
                 'RECEIPT TIMING: one receipt and one pair exist — no duplicate financial effect');
select th.assert(rrh.line('k') = 'tracked/user_pair/0 partner=w decision=pair range=0..0', 'the pair stands once: ' || rrh.line('k'));
select th.assert(rrh.retained('k') = 'D(k) H(y/k@2026-09-11)' and rrh.obligations('k') = 'captured(harness-item-a) edges=y sources=ambiguity_hold:x,removed_destination:x',
                 'nothing was retired: ' || rrh.retained('k') || ' ' || rrh.obligations('k'));

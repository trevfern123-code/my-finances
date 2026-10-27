-- R7, the end of the chain: the rollback scripts of 20261008120000, of 20261006120000 and of 20261006110000 (the
-- last one acknowledged, as its header requires while live holds exist) have run, in that order. The evaluator
-- and the decision RPCs are now the ones BEFORE 20261006110000, which do not know the kinds a removal writes.
\pset format unaligned
\pset tuples_only on
select rehearsal.take('r7_c');
select rehearsal.take_catalog('r7_c');
select rehearsal.eq_list(rehearsal.diff('r6_replayed', 'r7_c'), '{}',
  'R7: the three scripts changed no row of any table — every decision, every generation, every provenance row is there');
select th.assert(rehearsal.body_md5() = :'original_body'
                 and rehearsal.fn_md5('public.evaluate_card_payments(uuid, timestamp with time zone)')
                     is distinct from (select substring(c.definition from 'body ([0-9a-f]{32})') from rehearsal.catalog c
                                       where c.label = 'r0' and c.object = 'function public.evaluate_card_payments(p_user_id uuid, p_as_of timestamp with time zone)')
                 and to_regprocedure('public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)') is null,
  'R7: institution removal is the 20260926120000 body, the evaluator is no longer the 20261006110000 one, and its helper is gone');
select rehearsal.eq_list(rehearsal.catalog_diff('r1', 'r7_c', '% public.card\_payment\_removal\_%'), '{}',
  'R7: both provenance tables survive the whole chain with every column, constraint, index, trigger, trigger function and grant');
select th.assert((select count(*) = 7 from public.card_payment_removal_generations) and (select count(*) = 15 from public.card_payment_removal_sources)
                 and not exists (select 1 from public.card_payment_removal_sources s
                                 where not exists (select 1 from public.card_payment_decisions d where d.id = s.decision_id)),
  'R7: seven generation rows and fifteen provenance rows, each still with its decision');

-- ---- What the previous evaluator publishes (an OBSERVED reading of a documented limit, not an approval) ----
-- It reads a hold as a decision that claims both of its legs. ONE hold on a pair is inactive for the reason
-- not_cash_side (the rollback script of 20261006110000, (i)); TWO holds on one pair claim each leg twice and
-- read conflicting_decisions (its case (iii); the header of 20261008120000). Since 20261008120000 writes one
-- hold per source, a pair with two identical removed candidates (D), a pair held by two removals (A: Bank 1
-- by Revision 5, Bank 3 by the new body; M: Bank 3 and Bank 5) is such a pair.
set role service_role;
select public.evaluate_card_payments(rehearsal.aa());
select public.evaluate_card_payments(rehearsal.bb());
select th.assert(rehearsal.legs() = 16 and rehearsal.legs(rehearsal.bb()) = 2, 'R7: 16 legs of aa and 2 of bb');
-- D: two identical live holds, both written by the removal of Bank 3.
select rehearsal.eq(rehearsal.reading('k-d'), 'unresolved/decision_invalidated/null partner=- range=-12000..0 decision=ambiguity_hold_removed_card(y-d/k-d@2026-09-11) detail=conflicting_decisions candidates=-',
  'R7, D, previous evaluator: the payment with TWO identical holds reads unresolved, conflicting_decisions');
select rehearsal.eq(rehearsal.reading('y-d'), 'unresolved/decision_invalidated/0 partner=- range=0..0 decision=ambiguity_hold_removed_card(y-d/k-d@2026-09-11) detail=conflicting_decisions candidates=-',
  'R7, D, previous evaluator: and so does the kept card leg');
-- A and M: two live holds on one pair, written by two removals.
select rehearsal.eq(rehearsal.reading('k-a'), 'unresolved/decision_invalidated/null partner=- range=-10000..0 decision=ambiguity_hold_removed_card(y-a/k-a@2026-09-11) detail=conflicting_decisions candidates=-',
  'R7, A, previous evaluator: two holds of two removals — one without provenance, one with — read conflicting_decisions');
select rehearsal.eq(rehearsal.reading('k-m'), 'unresolved/decision_invalidated/null partner=- range=-17000..0 decision=ambiguity_hold_removed_card(y-m/k-m@2026-09-11) detail=conflicting_decisions candidates=-',
  'R7, M, previous evaluator: two holds of two removals read conflicting_decisions');
-- E, G, S and bb: ONE hold on the pair.
select rehearsal.eq(rehearsal.reading('k-e'), 'unresolved/decision_invalidated/null partner=- range=-13000..0 decision=ambiguity_hold_removed_card(y-e/k-e@2026-09-10) detail=not_cash_side candidates=-',
  'R7, E, previous evaluator: the payment with ONE hold reads unresolved, not_cash_side — its known destination (−130) became a range');
select rehearsal.eq(rehearsal.reading('k-g'), 'unresolved/decision_invalidated/null partner=- range=-15000..0 decision=ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11) detail=not_cash_side candidates=-',
  'R7, G, previous evaluator: one hold, not_cash_side');
select rehearsal.eq(rehearsal.reading('k-s'), 'unresolved/decision_invalidated/null partner=- range=-19000..0 decision=ambiguity_hold_removed_card(y-s/k-s@2026-09-11) detail=not_cash_side candidates=-',
  'R7, S, previous evaluator: one hold, not_cash_side');
select rehearsal.eq(rehearsal.reading('b-k', rehearsal.bb()), 'unresolved/decision_invalidated/null partner=- range=-10000..0 decision=ambiguity_hold_removed_card(by-k/b-k@2026-09-11) detail=not_cash_side candidates=-',
  'R7, bb, previous evaluator: one hold, not_cash_side');
-- B and Q: records on legs that no hold claims are read as before — two live records as one.
select rehearsal.eq(rehearsal.reading('k-b'), 'untracked/removed_card/-11000 partner=- range=-11000..-11000 decision=destination_removed_card(k-b) detail=- candidates=-',
  'R7, B, previous evaluator: two live records on a leg read as one');
select rehearsal.eq(rehearsal.reading('k-q'), 'untracked/removed_card/-18000 partner=- range=-18000..-18000 decision=destination_removed_card(k-q) detail=- candidates=-',
  'R7, Q, previous evaluator: a record is read as before');
-- J: the preserved pair still holds its leg, and reads unresolved.
select rehearsal.eq(rehearsal.reading('k-j'), 'unresolved/no_candidate/null partner=- range=-16000..0 decision=pair_counterpart_removed(k-j/x3-j) detail=- candidates=-',
  'R7, J, previous evaluator: the preserved pair holds its leg, which reads unresolved');
-- The reader's decisions list: every hold inactive, for one reason or the other.
select rehearsal.eq_list(rehearsal.statuses(),
  array['pair_counterpart_removed(k-j/x3-j): active',
        'destination_removed_card(k-b): active', 'destination_removed_card(k-b): active',
        'destination_removed_card(k-e): active', 'destination_removed_card(k-q): active', 'destination_removed_card(k-s): active',
        'destination_removed_card(k-t): active',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11): inactive/conflicting_decisions', 'ambiguity_hold_removed_card(y-a/k-a@2026-09-11): inactive/conflicting_decisions',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11): inactive/conflicting_decisions', 'ambiguity_hold_removed_card(y-d/k-d@2026-09-11): inactive/conflicting_decisions',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11): inactive/conflicting_decisions', 'ambiguity_hold_removed_card(y-m/k-m@2026-09-11): inactive/conflicting_decisions',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10): inactive/not_cash_side',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11): inactive/not_cash_side',
        'ambiguity_hold_removed_card(y-s/k-s@2026-09-11): inactive/not_cash_side'],
  'R7, previous evaluator: six holds on three pairs read conflicting_decisions, three holds alone on their pairs read not_cash_side');
reset role;
select rehearsal.take('r7_evaluated');
select 'REPORT  previous evaluator, ' || p || ': ' || rehearsal.reading(p) from unnest(array['k-d', 'y-d', 'k-a', 'k-m', 'k-e', 'k-g', 'k-s', 'k-b', 'k-q', 'k-j']) p;
select 'REPORT  previous evaluator, decisions list: ' || x from unnest(rehearsal.statuses()) x where x like 'ambiguity_hold%';

-- "An undo there must be repeated per hold" (the header of 20261008120000), shown in a transaction that is
-- rolled back. The previous undo does not refuse a hold. With one of D's two holds undone, the other still
-- claims both legs, now for the reason one hold has; only the second undo releases the pair — which the
-- previous evaluator then forms automatically.
begin;
set local role service_role;
select th.assert(public.undo_card_payment_decision(rehearsal.aa(), (rehearsal.ids('ambiguity_hold_removed_card(y-d/k-d@2026-09-11)'))[1]::uuid, rehearsal.iv())->>'status' = 'undone',
  'R7, D, previous RPC: the first hold is undone');
select rehearsal.eq(rehearsal.reading('k-d'), 'unresolved/decision_invalidated/null partner=- range=-12000..0 decision=ambiguity_hold_removed_card(y-d/k-d@2026-09-11) detail=not_cash_side candidates=-',
  'R7, D, previous RPC: one undo is not enough — the payment is still held, by the other hold, and reads as one hold reads');
select th.assert(public.undo_card_payment_decision(rehearsal.aa(), (rehearsal.ids('ambiguity_hold_removed_card(y-d/k-d@2026-09-11)'))[1]::uuid, rehearsal.iv())->>'status' = 'undone',
  'R7, D, previous RPC: the second hold is undone');
select rehearsal.eq(rehearsal.reading('k-d'), 'tracked/auto_pair/0 partner=y-d range=0..0 decision=- detail=- candidates=-',
  'R7, D, previous RPC: after the second undo the pair is formed automatically — what the holds existed to withhold');
rollback;
select rehearsal.take('r7_probe');
select rehearsal.eq_list(rehearsal.diff('r7_evaluated', 'r7_probe'), '{}', 'R7: the undo demonstration was rolled back: no row changed');

-- R5. A removal in the rolled-back interval: aa removes Card Bank 4 (card X4) under Revision 5's body, with
-- the provenance tables in place and R2's rows live.
--   Q  k-q was matched automatically to x4-q: Revision 5 records the destination — with no provenance.
--   M  x4-m is a candidate of k-m, with the date (2026-09-11) of x3-m. The removal of Bank 3 left a live hold
--      on (y-m, k-m) and one on (x5-m, k-m), each with that date and each attributed to x3-m. Revision 5 merges
--      by pair and date: it writes no hold of its own. THE HAZARD: from here on those two holds also stand for
--      x4-m, and their provenance does not say so.
\pset format unaligned
\pset tuples_only on
select th.assert(rehearsal.body_md5() = :'revision5_body', 'R5: the removal function is the 20261006120000 body');
select th.assert((select t.date = d.counterpart_date and d.kind = 'ambiguity_hold_removed_card' and d.superseded_by is null
                         and d.a_plaid_transaction_id = 'y-m' and d.b_plaid_transaction_id = 'k-m'
                         and exists (select 1 from public.card_payment_removal_sources s
                                     where s.decision_id = d.id and s.source_plaid_transaction_id = 'x3-m'
                                       and s.removal_id = (rehearsal.removal('rp-card-bank-3')).id)
                  from public.transactions t, public.card_payment_decisions d
                  where t.plaid_transaction_id = 'x4-m' and t.account_id = '00000000-0000-0000-0000-0000000e0041'
                    and d.id = rehearsal.recall('R2 hold y-m/k-m')::uuid),
  'R5, M: the candidate on the card of Bank 4 has the date of the live hold on (y-m, k-m) that R2 attributed to x3-m');
select rehearsal.keep_decisions('r5_before');

-- The counterfactual, in a transaction that is rolled back: WITHOUT those two live holds, this very removal
-- writes both holds itself. So the removal below writes none only because R2's are there.
begin;
delete from public.card_payment_decisions
where id in (rehearsal.recall('R2 hold y-m/k-m')::uuid, rehearsal.recall('R2 hold x5-m/k-m')::uuid);
set local role service_role;
select rehearsal.remove(rehearsal.aa(), rehearsal.item('rp-card-bank-4'));
select rehearsal.eq_list(rehearsal.written_since('r5_before'),
  array['destination_removed_card(k-q)', 'ambiguity_hold_removed_card(y-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)'],
  'R5, counterfactual: with R2''s two holds out of the way, Revision 5 writes Q''s record and BOTH holds of M');
rollback;
select rehearsal.take('r5_probe');
select rehearsal.eq_list(rehearsal.diff('r4_evaluated', 'r5_probe'), '{}', 'R5: the counterfactual was rolled back: no row changed');

-- The removal.
set role service_role;
select rehearsal.remove(rehearsal.aa(), rehearsal.item('rp-card-bank-4'));
-- It wrote one decision, and no hold.
select rehearsal.eq_list(rehearsal.written_since('r5_before'), array['destination_removed_card(k-q)'],
  'R5: the removal wrote ONE decision, Q''s record — and no hold');
select rehearsal.eq_list(rehearsal.gone_since('r5_before'), array['ambiguity_hold_removed_card(x4-m/k-m@2026-09-11)'],
  'R5: one decision went with the removed card''s account: R2''s hold on the pair with the card of Bank 4');
-- THE MERGE, by row id: on each pair the one live hold is the row R2 wrote.
select rehearsal.eq_list(rehearsal.ids('ambiguity_hold_removed_card(y-m/k-m@2026-09-11)'), array[rehearsal.recall('R2 hold y-m/k-m')],
  'R5, M: one live hold on (y-m, k-m), and it is the row R2 wrote — no second hold for the candidate x4-m');
select rehearsal.eq_list(rehearsal.ids('ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)'), array[rehearsal.recall('R2 hold x5-m/k-m')],
  'R5, M: one live hold on (x5-m, k-m), and it is the row R2 wrote — no second hold for the candidate x4-m');
-- No generation and no source.
select rehearsal.eq_list(rehearsal.generations(),
  array['1:harness-item-a:marker(null)', '2:rp-card-bank-2:marker(null)', '3:rp-card-bank-3:recorded(ins_card3)',
        '4:rp-card-bank-6:recorded(ins_card6)'],
  'R5: the removal wrote no generation row: aa''s generations are those of R2');
select th.assert((rehearsal.removal('rp-card-bank-4')).status = 'cleaned'
                 and not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = (rehearsal.removal('rp-card-bank-4')).id)
                 and not exists (select 1 from public.card_payment_removal_sources s where s.removal_id = (rehearsal.removal('rp-card-bank-4')).id),
  'R5: the removal of Bank 4 is cleaned, and has neither a generation row nor a provenance row');
select th.assert((select count(*) = 13 from public.card_payment_removal_sources)
                 and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = rehearsal.recall('R2 hold x4-m/k-m')::uuid),
  'R5: thirteen provenance rows are left of fourteen — the one that went, went with its decision');
-- Every live row with its source. The two merged holds still name x3-m of the removal of Bank 3, and nothing
-- else; Q's record has no source.
select rehearsal.eq_list(rehearsal.deps(),
  array['pair_counterpart_removed(k-j/x3-j) <= rp-card-bank-3:rp-x3:x3-j[confirmed_counterpart]',
        'destination_removed_card(k-b) <= NO SOURCE',
        'destination_removed_card(k-b) <= rp-card-bank-3:rp-x3:x3-b[automatic_partner]',
        'destination_removed_card(k-e) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner]',
        'destination_removed_card(k-q) <= NO SOURCE',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= NO SOURCE',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= rp-card-bank-3:rp-x3:x3-a[removed_candidate]',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-d1[removed_candidate]',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-D2[removed_candidate]',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner]',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11) <= rp-card-bank-3:rp-r3:r3-g[automatic_partner]',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate]',
        'ambiguity_hold_removed_card(x5-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate]',
        'destination_removed_card(k-t) <= rp-card-bank-6:rp-x6:x6-t[automatic_partner]'],
  'R5: the merged holds still name x3-m of the removal of Bank 3 alone; the record this removal wrote has no source');
-- What is published is complete all the same.
select th.assert(rehearsal.legs() = 18, 'R5: the removal committed fresh states; 18 legs of aa are left');
select rehearsal.eq(rehearsal.reading('k-m'), 'unresolved/ambiguous/null partner=- range=-17000..0 decision=- detail=- candidates=x5-m:tier1,y-m:tier1',
  'R5, M: the payment is still unresolved, a range, with two candidates left');
select rehearsal.eq(rehearsal.reading('k-q'), 'untracked/removed_card/-18000 partner=- range=-18000..-18000 decision=destination_removed_card(k-q) detail=- candidates=-',
  'R5, Q: the payment counts as a removed-card payment — with a source or without one, the reading is the same');
select rehearsal.eq(rehearsal.reading('k-e'), 'untracked/removed_card/-13000 partner=- range=-13000..-13000 decision=destination_removed_card(k-e) detail=- candidates=-',
  'R5: a leg this removal did not concern reads as before');
reset role;
select rehearsal.take('r5');
select 'REPORT  body ' || rehearsal.body_md5() || ' (20261006120000); the removal of rp-card-bank-4: status ' || (rehearsal.removal('rp-card-bank-4')).status
       || ', generation rows ' || (select count(*) from public.card_payment_removal_generations g where g.removal_id = (rehearsal.removal('rp-card-bank-4')).id)
       || ', provenance rows ' || (select count(*) from public.card_payment_removal_sources s where s.removal_id = (rehearsal.removal('rp-card-bank-4')).id);
select 'REPORT  written: ' || array_to_string(rehearsal.written_since('r5_before'), ', ') || '; gone with the removed account: ' || array_to_string(rehearsal.gone_since('r5_before'), ', ');
select 'REPORT  merged into ' || d.id || ' ' || rehearsal.decision_key(d.id) || ' <= ' || r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || s.source_plaid_transaction_id
       || ' (the row R2 wrote: ' || (d.id::text in (rehearsal.recall('R2 hold y-m/k-m'), rehearsal.recall('R2 hold x5-m/k-m'))) || ')'
from public.card_payment_decisions d
join public.card_payment_removal_sources s on s.decision_id = d.id
join public.plaid_item_removals r on r.id = s.removal_id
where d.b_plaid_transaction_id = 'k-m' and d.superseded_by is null order by rehearsal.decision_key(d.id) collate "C";

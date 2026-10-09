-- R6. Right after the migration file's SQL was run again, on the body its rollback restored and on the two
-- tables as R5 left them. No removal has run yet.
\pset format unaligned
\pset tuples_only on
select rehearsal.take('r6');
select rehearsal.take_catalog('r6');
select rehearsal.eq_list(rehearsal.diff('r5', 'r6'), '{}', 'R6: no row of any table changed');
select th.assert(rehearsal.body_md5() = :'new_body', 'R6: remove_plaid_item_local is the body of 20261008120000 again');
select rehearsal.eq_list(rehearsal.catalog_diff('r1', 'r6'), '{}',
  'R6: every definition is exactly what the first application left: the shape of both tables, the triggers, the grants, the function');

-- THE STATE BEFORE THE NEXT REMOVAL. The removal of Bank 4 is a cleaned removal without a generation row, and
-- has no marker yet. The second clause of THE RULE therefore excludes every attributed system row of aa — of
-- generation 3 and of generation 4 alike — and none of bb, who has no such removal.
select rehearsal.eq_list(array(select r.plaid_item_id from public.plaid_item_removals r
                               where r.status = 'cleaned'
                                 and not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = r.id)),
  array['rp-card-bank-4'], 'R6, before: one cleaned removal has no generation row, the one made while rolled back');
select rehearsal.eq_list(rehearsal.generations(),
  array['1:harness-item-a:marker(null)', '2:rp-card-bank-2:marker(null)', '3:rp-card-bank-3:recorded(ins_card3)',
        '4:rp-card-bank-6:recorded(ins_card6)'],
  'R6, before: applying the migration again writes no marker; the next removal does');
select rehearsal.eq_list(rehearsal.rule(),
  array['aa G3 destination_removed_card(k-b) <= rp-card-bank-3:rp-x3:x3-b[automatic_partner] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 destination_removed_card(k-e) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= rp-card-bank-3:rp-x3:x3-a[removed_candidate] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-d1[removed_candidate] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-D2[removed_candidate] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_card(y-e/k-e@2026-09-10) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11) <= rp-card-bank-3:rp-r3:r3-g[automatic_partner] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate] -> NOT alone: a cleaned removal without a generation row',
        'aa G3 ambiguity_hold_removed_card(x5-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate] -> NOT alone: a cleaned removal without a generation row',
        'aa G4 destination_removed_card(k-t) <= rp-card-bank-6:rp-x6:x6-t[automatic_partner] -> NOT alone: a cleaned removal without a generation row',
        'bb G1 destination_removed_card(b-k) <= harness-item-b:rp-bx:bx-k[automatic_partner] -> its source alone',
        'bb G1 ambiguity_hold_removed_card(by-k/b-k@2026-09-11) <= harness-item-b:rp-bx:bx-k[automatic_partner] -> its source alone'],
  'R6, before: THE RULE excludes all ten attributed system rows of aa by its second clause (a cleaned removal without a generation row), and neither of the two of bb');
select 'REPORT  body ' || rehearsal.body_md5() || ' (20261008120000); rows: ' || coalesce(nullif(array_to_string(rehearsal.diff('r5', 'r6'), '; '), ''), 'no difference')
       || '; definitions against the first application: ' || coalesce(nullif(array_to_string(rehearsal.catalog_diff('r1', 'r6'), '; '), ''), 'no difference');
select 'REPORT  the rule, before the next removal: ' || x from unnest(rehearsal.rule()) x;

-- R6, continued. The next removal of aa under the body of 20261008120000: Card Bank 5 (card X5).
--   S  k-s was matched automatically to x5-s, and the kept card fits less well: a record and a hold.
--   M  x5-m is the last removed candidate of k-m: a hold on (y-m, k-m), next to the one R2 wrote.
\pset format unaligned
\pset tuples_only on
select rehearsal.keep_decisions('r6_before');
set role service_role;
select rehearsal.remove(rehearsal.aa(), rehearsal.item('rp-card-bank-5'));

-- The marker: the removal made while rolled back gets its place in the order of aa, after both generations of
-- R2 and before this removal's own.
select rehearsal.eq_list(rehearsal.generations(),
  array['1:harness-item-a:marker(null)', '2:rp-card-bank-2:marker(null)', '3:rp-card-bank-3:recorded(ins_card3)',
        '4:rp-card-bank-6:recorded(ins_card6)', '5:rp-card-bank-4:marker(null)', '6:rp-card-bank-5:recorded(ins_card5)'],
  'R6: the removal of Bank 4 gets a MARKER with ordinal 5 — greater than 3 and 4, the generations of R2, and smaller than 6, this removal''s own');
select th.assert((select not g.sources_recorded and g.institution_id is null
                         and g.recorded_at = (select x.recorded_at from public.card_payment_removal_generations x
                                              where x.removal_id = (rehearsal.removal('rp-card-bank-5')).id)
                  from public.card_payment_removal_generations g where g.removal_id = (rehearsal.removal('rp-card-bank-4')).id)
                 and not exists (select 1 from public.card_payment_removal_sources s where s.removal_id = (rehearsal.removal('rp-card-bank-4')).id),
  'R6: the marker has sources_recorded = false and no institution id, was written by the removal of Bank 5, and nothing is attributed to it');
select rehearsal.eq_list(rehearsal.generations(rehearsal.bb()), array['1:harness-item-b:recorded(ins_bbcard)'], 'R6: the order of bb is untouched');

-- What this removal wrote, each row with its source.
select rehearsal.eq_list(rehearsal.written_since('r6_before'),
  array['destination_removed_card(k-s)', 'ambiguity_hold_removed_card(y-s/k-s@2026-09-11)', 'ambiguity_hold_removed_card(y-m/k-m@2026-09-11)'],
  'R6: the removal wrote the record and the hold of S, and its OWN hold on (y-m, k-m)');
select rehearsal.eq_list(rehearsal.gone_since('r6_before'), array['ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)'],
  'R6: one decision went with the account of the removed card');
select th.assert(cardinality(rehearsal.ids('ambiguity_hold_removed_card(y-m/k-m@2026-09-11)')) = 2
                 and rehearsal.recall('R2 hold y-m/k-m') = any (rehearsal.ids('ambiguity_hold_removed_card(y-m/k-m@2026-09-11)')),
  'R6, M: two live holds on (y-m, k-m) with one date: the row R2 wrote, and the row of this removal');
select rehearsal.eq_list(rehearsal.deps(),
  array['pair_counterpart_removed(k-j/x3-j) <= rp-card-bank-3:rp-x3:x3-j[confirmed_counterpart]',
        'destination_removed_card(k-b) <= NO SOURCE',
        'destination_removed_card(k-b) <= rp-card-bank-3:rp-x3:x3-b[automatic_partner]',
        'destination_removed_card(k-e) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner]',
        'destination_removed_card(k-q) <= NO SOURCE',
        'destination_removed_card(k-s) <= rp-card-bank-5:rp-x5:x5-s[automatic_partner]',
        'destination_removed_card(k-t) <= rp-card-bank-6:rp-x6:x6-t[automatic_partner]',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= NO SOURCE',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= rp-card-bank-3:rp-x3:x3-a[removed_candidate]',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-d1[removed_candidate]',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-D2[removed_candidate]',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner]',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11) <= rp-card-bank-3:rp-r3:r3-g[automatic_partner]',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate]',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-5:rp-x5:x5-m[removed_candidate]',
        'ambiguity_hold_removed_card(y-s/k-s@2026-09-11) <= rp-card-bank-5:rp-x5:x5-s[automatic_partner]'],
  'R6: every row this removal wrote names its source under its own removal; the rows Revision 5 wrote — before the migration and while it was rolled back — have none');
select rehearsal.eq_list(array(select x from unnest(rehearsal.sources()) x where x like 'rp-card-bank-5|%'),
  array['rp-card-bank-5|ins_card5|rp-x5|credit/credit card/5001|row:x5-m|pending=false|of=null|2026-09-11|-17000|USD x1',
        'rp-card-bank-5|ins_card5|rp-x5|credit/credit card/5001|row:x5-s|pending=false|of=null|2026-09-11|-19000|USD x2'],
  'R6: two removed transactions on one removed account are the sources of the three rows');

-- THE RULE (the header of 20261008120000), row by row, over every live system row that has a provenance row.
-- It excludes exactly the rows of generations 3 and 4, both recorded in R2 before the marker: the removal
-- marked 5 may have merged into any of them, and did merge into the hold on (y-m, k-m). It excludes none of
-- generation 6, written after the marker: so the two holds on (y-m, k-m), alike in every column of the
-- decision, are told apart. And it excludes none of bb.
select rehearsal.eq_list(rehearsal.rule(),
  array['aa G3 destination_removed_card(k-b) <= rp-card-bank-3:rp-x3:x3-b[automatic_partner] -> NOT alone: a later marker',
        'aa G3 destination_removed_card(k-e) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner] -> NOT alone: a later marker',
        'aa G3 ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= rp-card-bank-3:rp-x3:x3-a[removed_candidate] -> NOT alone: a later marker',
        'aa G3 ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-d1[removed_candidate] -> NOT alone: a later marker',
        'aa G3 ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-D2[removed_candidate] -> NOT alone: a later marker',
        'aa G3 ambiguity_hold_removed_card(y-e/k-e@2026-09-10) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner] -> NOT alone: a later marker',
        'aa G3 ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11) <= rp-card-bank-3:rp-r3:r3-g[automatic_partner] -> NOT alone: a later marker',
        'aa G3 ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate] -> NOT alone: a later marker',
        'aa G4 destination_removed_card(k-t) <= rp-card-bank-6:rp-x6:x6-t[automatic_partner] -> NOT alone: a later marker',
        'aa G6 ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-5:rp-x5:x5-m[removed_candidate] -> its source alone',
        'aa G6 ambiguity_hold_removed_card(y-s/k-s@2026-09-11) <= rp-card-bank-5:rp-x5:x5-s[automatic_partner] -> its source alone',
        'aa G6 destination_removed_card(k-s) <= rp-card-bank-5:rp-x5:x5-s[automatic_partner] -> its source alone',
        'bb G1 destination_removed_card(b-k) <= harness-item-b:rp-bx:bx-k[automatic_partner] -> its source alone',
        'bb G1 ambiguity_hold_removed_card(by-k/b-k@2026-09-11) <= harness-item-b:rp-bx:bx-k[automatic_partner] -> its source alone'],
  'R6: THE RULE excludes exactly the nine attributed system rows of generations 3 and 4, by the marker that follows them, and none of generation 6 or of bb');
select th.assert(not exists (select 1 from public.plaid_item_removals r
                             where r.status = 'cleaned' and not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = r.id)),
  'R6: every cleaned removal now has a generation row, so the second clause of the rule excludes nothing any more');

-- What is published.
select th.assert(rehearsal.legs() = 16, 'R6: the removal committed fresh states; 16 legs of aa are left');
select rehearsal.eq(rehearsal.reading('k-m'), 'unresolved/ambiguous/null partner=- range=-17000..0 decision=- detail=- candidates=y-m:tier1',
  'R6, M: the payment is still unresolved, a range: the pair with the kept card, its last candidate, is withheld');
select rehearsal.eq(rehearsal.reading('y-m'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-m:tier1',
  'R6, M: the kept card leg is unmatched');
select rehearsal.eq(rehearsal.reading('k-s'), 'untracked/removed_card/-19000 partner=- range=-19000..-19000 decision=destination_removed_card(k-s) detail=- candidates=-',
  'R6, S: the payment counts as a removed-card payment');
select rehearsal.eq(rehearsal.reading('y-s'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-s:tier1',
  'R6, S: the kept card leg is unmatched');
select th.assert((select bool_and(x like '%: active') and count(*) = 16 from unnest(rehearsal.statuses()) x),
  'R6: the reader lists sixteen decisions for aa, all active');
reset role;
select rehearsal.take('r6_removed');

-- A repeated call for a finished removal — made by either body, marked or recorded — returns the stored
-- result and writes nothing: no decision, no generation, no marker.
set role service_role;
select th.assert((select count(*) = 7 and bool_and((public.remove_plaid_item_local(r.user_id, r.item_id)->>'replayed')::boolean)
                  from public.plaid_item_removals r),
  'R6: all seven cleaned removals replay');
reset role;
select rehearsal.take('r6_replayed');
select rehearsal.eq_list(rehearsal.diff('r6_removed', 'r6_replayed'), '{}', 'R6: and the replays changed no row');
select 'REPORT  generations aa: ' || array_to_string(rehearsal.generations(), ', ') || '; bb: ' || array_to_string(rehearsal.generations(rehearsal.bb()), ', ');
select 'REPORT  the rule: ' || x from unnest(rehearsal.rule()) x;
select 'REPORT  no provenance: ' || x from unnest(rehearsal.deps()) x where x like '% <= NO SOURCE';

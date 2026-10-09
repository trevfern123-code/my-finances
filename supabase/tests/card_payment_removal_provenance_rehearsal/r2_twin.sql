-- R2 on the twin: what the same three removals WROTE under Revision 5. It merges: one hold for a pair and a
-- date, and no row where a live one with the same key exists, whichever removal wrote that one.
\pset format unaligned
\pset tuples_only on
select th.assert(rehearsal.body_md5() = :'revision5_body' and to_regclass('public.card_payment_removal_generations') is null
                 and to_regclass('public.card_payment_removal_sources') is null,
  'twin: still the 20261006120000 body, and no provenance table');
-- aa. The removal of Bank 3 wrote eight rows: D's two removed candidates are ONE hold, and A's hold and B's
-- record are not written, because the rows the earlier removals wrote are live. The removal of Bank 6 wrote
-- one row, T's record.
select rehearsal.eq_list(rehearsal.written_since('r0'),
  array['pair_counterpart_removed(k-j/x3-j)',
        'destination_removed_card(k-e)',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11)',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10)',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11)',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x4-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)',
        'destination_removed_card(k-t)'],
  'twin, aa: Revision 5 writes the user''s pair, ONE record and six holds for Bank 3, and one record for Bank 6');
select rehearsal.eq_list(rehearsal.gone_since('r0'), array['pair(k-j/x3-j)', 'ambiguity_hold_removed_card(x3-a/k-a@2026-09-11)'],
  'twin, aa: the user''s pair and the hold on the pair with the card of Bank 3 went with the account of that card');
select rehearsal.eq_list(rehearsal.ids('ambiguity_hold_removed_card(y-a/k-a@2026-09-11)'), array[rehearsal.recall('legacy hold y-a/k-a')],
  'twin, A: one hold on the pair, the one the removal of Bank 1 wrote — the removal of Bank 3 merged into it');
select rehearsal.eq_list(rehearsal.ids('destination_removed_card(k-b)'), array[rehearsal.recall('legacy record k-b')],
  'twin, B: one record on the leg, the one the removal of Bank 2 wrote — the removal of Bank 3 merged into it');
select th.assert(cardinality(rehearsal.ids('ambiguity_hold_removed_card(y-d/k-d@2026-09-11)')) = 1,
  'twin, D: one hold on the pair for two removed candidates with one date');
select rehearsal.eq_list(rehearsal.rows(),
  array['pair_counterpart_removed(k-j/x3-j)',
        'destination_removed_card(k-b)', 'destination_removed_card(k-e)', 'destination_removed_card(k-t)',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11)',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11)',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10)',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11)',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x4-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)'],
  'twin, aa: eleven live rows in all');
-- bb.
select rehearsal.eq_list(rehearsal.written_since('r0', rehearsal.bb()), array['destination_removed_card(b-k)', 'ambiguity_hold_removed_card(by-k/b-k@2026-09-11)'],
  'twin, bb: a record and a hold');
select rehearsal.eq_list(array(select usr || ' ' || moment || ' ' || listed from rehearsal.readings),
  array['aa removal 11', 'aa as_of 11', 'bb removal 2', 'bb as_of 2'],
  'twin: the reader lists eleven decisions for aa and two for bb, at both moments');
select 'REPORT  twin (Revision 5, body ' || rehearsal.body_md5() || '): aa ' || cardinality(rehearsal.written_since('r0')) || ' rows written, '
       || cardinality(rehearsal.rows()) || ' live; bb ' || cardinality(rehearsal.rows(rehearsal.bb())) || ' written and live';

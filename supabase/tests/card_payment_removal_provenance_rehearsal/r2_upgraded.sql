-- R2 on the upgraded database: what the same three removals WROTE under the body of 20261008120000, and the
-- differential: every published reading is the one the twin (Revision 5) published.
\pset format unaligned
\pset tuples_only on
select th.assert(rehearsal.body_md5() = :'new_body', 'R2: the removals ran the body of 20261008120000');
set role service_role;

-- ---- The generations, and the markers written before the first --------------------------------------------
-- aa: the two removals Revision 5 made have no generation row. The removal of Bank 3, the first under this
-- body, gives each a MARKER — in the order they were cleaned (Bank 1, then Bank 2: asserted in R0) — and then
-- writes its own generation. The removal of Bank 6 finds nothing left to mark and writes its generation.
select rehearsal.eq_list(rehearsal.generations(),
  array['1:harness-item-a:marker(null)', '2:rp-card-bank-2:marker(null)', '3:rp-card-bank-3:recorded(ins_card3)',
        '4:rp-card-bank-6:recorded(ins_card6)'],
  'R2, aa: two markers, then the generation of each removal — third and fourth in the order of aa — with the institution id its item had');
select th.assert((select count(*) = 2 and bool_and(not g.sources_recorded and g.institution_id is null
                                                    and g.recorded_at = (select x.recorded_at from public.card_payment_removal_generations x
                                                                         where x.removal_id = (rehearsal.removal('rp-card-bank-3')).id))
                  from public.card_payment_removal_generations g
                  where g.removal_id in ((rehearsal.removal('harness-item-a')).id, (rehearsal.removal('rp-card-bank-2')).id))
                 and (select a.recorded_at < b.recorded_at from public.card_payment_removal_generations a, public.card_payment_removal_generations b
                      where a.removal_id = (rehearsal.removal('rp-card-bank-3')).id and b.removal_id = (rehearsal.removal('rp-card-bank-6')).id),
  'R2, aa: both markers have sources_recorded = false and no institution id, and were written by the removal of Bank 3 (the time of its transaction), before the removal of Bank 6 ran');
select th.assert(not exists (select 1 from public.card_payment_removal_sources s join public.card_payment_removal_generations g on g.removal_id = s.removal_id
                             where not g.sources_recorded),
  'R2: no provenance row is under a marker');
-- bb had no earlier removal: one generation, first in THAT user's order.
select rehearsal.eq_list(rehearsal.generations(rehearsal.bb()), array['1:harness-item-b:recorded(ins_bbcard)'],
  'R2, bb: one generation, first in the order of bb, and no marker');

-- ---- One row per source, and one provenance row per decision -----------------------------------------------
-- aa. The removal of Bank 3 wrote eleven rows where Revision 5 writes eight: the three more are A's second
-- hold, B's second record and D's second hold. The removal of Bank 6 wrote T's record, as Revision 5 does.
select rehearsal.eq_list(rehearsal.written_since('r0'),
  array['pair_counterpart_removed(k-j/x3-j)',
        'destination_removed_card(k-b)', 'destination_removed_card(k-e)',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11)',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11)', 'ambiguity_hold_removed_card(y-d/k-d@2026-09-11)',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10)',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11)',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x4-m/k-m@2026-09-11)', 'ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)',
        'destination_removed_card(k-t)'],
  'R2, aa: the new body writes the user''s pair, TWO records and eight holds for Bank 3, and one record for Bank 6');
select rehearsal.eq_list(rehearsal.gone_since('r0'), array['pair(k-j/x3-j)', 'ambiguity_hold_removed_card(x3-a/k-a@2026-09-11)'],
  'R2, aa: the user''s pair and the hold on the pair with the card of Bank 3 went with the account of that card, as under Revision 5');
-- Every live row of a kind a removal writes, with its source: which removal, which removed account, which
-- removed transaction, and what that transaction was to the surviving leg.
select rehearsal.eq_list(rehearsal.deps(),
  array['pair_counterpart_removed(k-j/x3-j) <= rp-card-bank-3:rp-x3:x3-j[confirmed_counterpart]',
        'destination_removed_card(k-b) <= NO SOURCE',
        'destination_removed_card(k-b) <= rp-card-bank-3:rp-x3:x3-b[automatic_partner]',
        'destination_removed_card(k-e) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner]',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= NO SOURCE',
        'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= rp-card-bank-3:rp-x3:x3-a[removed_candidate]',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-d1[removed_candidate]',
        'ambiguity_hold_removed_card(y-d/k-d@2026-09-11) <= rp-card-bank-3:rp-x3:x3-D2[removed_candidate]',
        'ambiguity_hold_removed_card(y-e/k-e@2026-09-10) <= rp-card-bank-3:rp-x3:x3-e[automatic_partner]',
        'ambiguity_hold_removed_cash_account(y-g/k-g@2026-09-11) <= rp-card-bank-3:rp-r3:r3-g[automatic_partner]',
        'ambiguity_hold_removed_card(y-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate]',
        'ambiguity_hold_removed_card(x4-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate]',
        'ambiguity_hold_removed_card(x5-m/k-m@2026-09-11) <= rp-card-bank-3:rp-x3:x3-m[removed_candidate]',
        'destination_removed_card(k-t) <= rp-card-bank-6:rp-x6:x6-t[automatic_partner]'],
  'R2, aa: every row these removals wrote names its one source, under its own removal; the two rows Revision 5 wrote have none');
select th.assert((select count(*) = 11 and bool_and(s.user_id = rehearsal.aa()
                                                     and not exists (select 1 from rehearsal.decisions_at k where k.moment = 'r0' and k.id = s.decision_id))
                  from public.card_payment_removal_sources s where s.removal_id = (rehearsal.removal('rp-card-bank-3')).id)
                 and (select count(*) = 1 from public.card_payment_removal_sources s where s.removal_id = (rehearsal.removal('rp-card-bank-6')).id)
                 and (select count(*) = 14 from public.card_payment_removal_sources),
  'R2: eleven provenance rows under the removal of Bank 3 and one under the removal of Bank 6 — one for each decision written, none for an older decision; fourteen in all');
-- A: the pair that the Revision 5 removal of Bank 1 already held. That hold is still there, and is not reused.
select th.assert(cardinality(rehearsal.ids('ambiguity_hold_removed_card(y-a/k-a@2026-09-11)')) = 2
                 and rehearsal.recall('legacy hold y-a/k-a') = any (rehearsal.ids('ambiguity_hold_removed_card(y-a/k-a@2026-09-11)'))
                 and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = rehearsal.recall('legacy hold y-a/k-a')::uuid),
  'R2, A: two live holds on one pair with one date — the one Revision 5 wrote, still without provenance, and the one the removal of Bank 3 wrote');
-- B: the leg that the Revision 5 removal of Bank 2 already recorded.
select th.assert(cardinality(rehearsal.ids('destination_removed_card(k-b)')) = 2
                 and rehearsal.recall('legacy record k-b') = any (rehearsal.ids('destination_removed_card(k-b)'))
                 and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = rehearsal.recall('legacy record k-b')::uuid),
  'R2, B: two live records on one leg — the one Revision 5 wrote, still without provenance, and the one the removal of Bank 3 wrote');
-- D: the two holds differ in nothing but their source. The removal wrote them in the order of the source's
-- Plaid id in byte order ("C" collation): x3-D2's, then x3-d1's — not the order a linguistic collation gives
-- (r0_baseline.sql says how the two ids were chosen). decided_seq, which the insert assigns row by row, keeps
-- the order of writing. (Were the two given one decided_seq, x3-d1 would be listed first here.) With two ids
-- this check has two outcomes: it tells byte order from a linguistic order and from a descending one, and
-- nothing else — an order unrelated to the ids would pass it half the time.
select rehearsal.eq((select string_agg(s.source_plaid_transaction_id, ' then ' order by d.decided_seq, s.source_plaid_transaction_id collate "C" desc)
                     from public.card_payment_decisions d join public.card_payment_removal_sources s on s.decision_id = d.id
                     where d.user_id = rehearsal.aa() and d.superseded_by is null
                       and s.removal_id = (rehearsal.removal('rp-card-bank-3')).id
                       and rehearsal.decision_key(d.id) = 'ambiguity_hold_removed_card(y-d/k-d@2026-09-11)'),
                    'x3-D2 then x3-d1',
  'R2, D: the two holds on one pair with one date were written in the byte order of their sources'' Plaid ids');
-- What is recorded of each source. x3-e justifies a record and a hold, x3-m three holds: each is described
-- once, identically on every row. x3-d1 and x3-D2 differ in nothing but their own id.
select rehearsal.eq_list(rehearsal.sources(),
  array['rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-a|pending=false|of=null|2026-09-11|-10000|USD x1',
        'rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-b|pending=false|of=null|2026-09-11|-11000|USD x1',
        'rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-d1|pending=false|of=null|2026-09-11|-12000|USD x1',
        'rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-D2|pending=false|of=null|2026-09-11|-12000|USD x1',
        'rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-e|pending=false|of=null|2026-09-10|-13000|USD x2',
        'rp-card-bank-3|ins_card3|rp-r3|depository/checking/3002|row:r3-g|pending=false|of=null|2026-09-11|15000|USD x1',
        'rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-j|pending=false|of=null|2026-09-11|-16000|USD x1',
        'rp-card-bank-3|ins_card3|rp-x3|credit/credit card/3001|row:x3-m|pending=false|of=null|2026-09-11|-17000|USD x3',
        'rp-card-bank-6|ins_card6|rp-x6|credit/credit card/6001|row:x6-t|pending=false|of=null|2026-09-11|-20000|USD x1'],
  'R2, aa: eight removed transactions on the two accounts of Bank 3 are the sources of its eleven rows, and one on the card of Bank 6 of its one');
select th.assert(not exists (select 1 from public.accounts a where a.plaid_account_id in ('rp-x3', 'rp-r3', 'rp-x6'))
                 and not exists (select 1 from public.transactions t
                                 where t.plaid_transaction_id like 'x3-%' or t.plaid_transaction_id in ('r3-g', 'x6-t')),
  'R2: the removed accounts and transactions are gone; what the provenance says of them is all that is left');
-- bb.
select rehearsal.eq_list(rehearsal.deps(rehearsal.bb()),
  array['destination_removed_card(b-k) <= harness-item-b:rp-bx:bx-k[automatic_partner]',
        'ambiguity_hold_removed_card(by-k/b-k@2026-09-11) <= harness-item-b:rp-bx:bx-k[automatic_partner]'],
  'R2, bb: a record and a hold, both from the removed partner');
select rehearsal.eq_list(rehearsal.sources(rehearsal.bb()),
  array['harness-item-b|ins_bbcard|rp-bx|credit/credit card/3001|row:bx-k|pending=false|of=null|2026-09-11|-10000|USD x2'],
  'R2, bb: one source — a card with the same type, subtype and mask as aa''s X3, under bb''s own generation');
reset role;

-- ---- The differential: the same scenario, in the twin, under Revision 5 ---------------------------------
-- NORMALISED (rehearsal.normalised), and nothing else:
--   1. a leg's decisionId -> the key of the decision it names. Ids are generated in each database; and where
--      this body leaves two records on a leg, the evaluator names the one with the lesser id, either of them.
--   2. the decisions list -> the set of distinct {key, kind, status, detail}. This body writes one row per
--      source, so a key can be listed twice here and once in the twin; a second identical row is no reading.
--   3. for what a user's last removal ITSELF published, and only there: asOf is left out. It is the time of
--      that removal's transaction, and the two databases cannot run it at the same instant. The second
--      comparison needs no such exception: both databases evaluated once more as of one fixed instant, and
--      asOf is compared too.
-- Compared as the reader gave them: fresh, inputVersion, evaluatedVersion, supersededTransactionIds, and of
-- every leg, in the reader's order, transactionId, accountId, date, amountCents, pending, side, direction,
-- accountIncluded, state, reason, detail, partnerTransactionId, candidates, effectCents, lowCents, highCents,
-- cashExcessCents, cardExcessCents and recent.
select th.assert((select count(*) = 4 from rehearsal.readings) and (select count(*) = 4 from rehearsal.twin_readings),
  'R2: both databases kept four readings — two users, two moments');
select rehearsal.eq_list(rehearsal.reading_diff('removal', u, array['asOf']), '{}',
  'R2, differential: what the last removal itself published for ' || u || ' is what Revision 5 published')
from unnest(array['aa', 'bb']) u;
select rehearsal.eq_list(rehearsal.reading_diff('as_of', u), '{}',
  'R2, differential: what an evaluation as of one instant publishes for ' || u || ' is what it publishes under Revision 5')
from unnest(array['aa', 'bb']) u;
select th.assert((select count(*) = 2 and bool_and(h.doc - 'asOf' = t.doc - 'asOf' and h.doc ? 'asOf' and t.doc ? 'asOf')
                  from rehearsal.readings h join rehearsal.twin_readings t using (moment, usr) where moment = 'removal')
                 and (select count(*) = 2 and bool_and(h.doc = t.doc and h.doc->>'asOf' = t.doc->>'asOf')
                      from rehearsal.readings h join rehearsal.twin_readings t using (moment, usr) where moment = 'as_of'),
  'R2, differential: the normalised readings of both users are equal documents at both moments');
-- The comparison is not empty, and the normalisation is not idle.
select th.assert((select bool_and((h.doc->>'fresh')::boolean and jsonb_array_length(h.doc->'legs') = case h.usr when 'aa' then 20 else 2 end)
                  from rehearsal.readings h)
                 and (select count(*) = 4 from rehearsal.readings h, jsonb_array_elements(h.doc->'legs') l
                      where h.moment = 'as_of' and h.usr = 'aa' and l->>'decisionId' is not null),
  'R2, differential: fresh readings of 20 and 2 legs; four legs of aa name a decision');
select rehearsal.eq_list(array(select h.usr || ' ' || h.moment || ': ' || h.listed || ' listed here, ' || t.listed || ' in the twin, '
                                      || jsonb_array_length(h.doc->'decisions') || ' distinct'
                               from rehearsal.readings h join rehearsal.twin_readings t using (moment, usr)),
  array['aa removal: 14 listed here, 11 in the twin, 11 distinct', 'aa as_of: 14 listed here, 11 in the twin, 11 distinct',
        'bb removal: 2 listed here, 2 in the twin, 2 distinct', 'bb as_of: 2 listed here, 2 in the twin, 2 distinct'],
  'R2, differential: the reader lists three more decisions for aa here than in the twin — the three rows Revision 5 merges — and they say nothing new');

-- What the later steps require of this moment.
select rehearsal.keep('R2 hold y-m/k-m', (rehearsal.ids('ambiguity_hold_removed_card(y-m/k-m@2026-09-11)'))[1]);
select rehearsal.keep('R2 hold x4-m/k-m', (rehearsal.ids('ambiguity_hold_removed_card(x4-m/k-m@2026-09-11)'))[1]);
select rehearsal.keep('R2 hold x5-m/k-m', (rehearsal.ids('ambiguity_hold_removed_card(x5-m/k-m@2026-09-11)'))[1]);
select rehearsal.take('r2');
select rehearsal.take_catalog('r2');
select rehearsal.eq_list(rehearsal.catalog_diff('r1', 'r2'), '{}', 'R2: using the function changed no definition');
select 'REPORT  generations aa: ' || array_to_string(rehearsal.generations(), ', ') || '; bb: ' || array_to_string(rehearsal.generations(rehearsal.bb()), ', ');
select 'REPORT  aa ' || x from unnest(rehearsal.deps()) x;
select 'REPORT  bb ' || x from unnest(rehearsal.deps(rehearsal.bb())) x;
select 'REPORT  aa the two holds on (y-d, k-d), in the order they were written (decided_seq): ' || string_agg(s.source_plaid_transaction_id, ', then ' order by d.decided_seq)
from public.card_payment_decisions d join public.card_payment_removal_sources s on s.decision_id = d.id
where d.user_id = rehearsal.aa() and rehearsal.decision_key(d.id) = 'ambiguity_hold_removed_card(y-d/k-d@2026-09-11)';
select 'REPORT  differential, ' || h.usr || ', '
       || case h.moment when 'removal' then 'as the last removal published it (asOf aside): ' else 'evaluated as of one instant (asOf included): ' end
       || case when (h.moment = 'removal' and h.doc - 'asOf' = t.doc - 'asOf') or h.doc = t.doc then 'EQUAL to the twin' else 'DIFFERENT from the twin' end
       || ' — inputVersion ' || (h.doc->>'inputVersion') || ' here, ' || (t.doc->>'inputVersion') || ' in the twin; '
       || jsonb_array_length(h.doc->'legs') || ' legs; decisions listed: ' || h.listed || ' here, ' || t.listed || ' in the twin, '
       || jsonb_array_length(h.doc->'decisions') || ' distinct in both'
from rehearsal.readings h join rehearsal.twin_readings t using (moment, usr) order by h.usr, h.moment desc;

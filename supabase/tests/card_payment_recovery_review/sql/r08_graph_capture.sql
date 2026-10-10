-- Forward capture from the eligible graph (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §3.1, §3.2; correction C1).
-- A removal knows more than the decisions it writes. A surviving payment that had an eligible candidate on the
-- removed institution is an AFFECTED PAYMENT whether or not the removal wrote a hold (H) or a record (D) for it,
-- and every removed candidate is a SOURCE of its own. Each case below is one where the removal writes NO new H
-- and NO new D; every expected value is derived by hand.
--   TIE      K +370 on the 10th; A and B, −370 each on the 11th, both on the removed institution; nothing else.
--            A tie: no automatic match (no D), no surviving competitor (no H). The removal must still keep K's
--            obligation and A and B as two sources. A later unrelated R (−370, the 11th, an included card) would
--            pair with K: withheld both ways. K: the range {−370, 0}. R: unresolved, 0.
--   MIRROR   the same with the sides exchanged: a surviving CARD leg and two removed CASH legs. The obligation is
--            the card leg's; no removed-card record is invented for it; a later cash leg is withheld from it.
--   REPEAT   K3 +260 matched to X (removed: D). The card returns as X2 and is withheld (the range). X2's
--            institution is removed as well: K3 had no automatic match and no surviving competitor, so the second
--            removal writes neither H nor D — and must still record ITS dependency on X2, beside the first D.
--   STAYS    K4's automatic match stays; a farther candidate is removed. Nothing changes for K4 today and nothing
--            is written — but K4 lost an eligible candidate: it is affected, its surviving match is a KNOWN edge
--            (so it stays automatic), and a later newcomer that would take its place is withheld.
-- User aa. Amounts are dollars; database cents are ×100. Dates are days of 2026-09.
-- User bb holds the TIE's shape on institutions that are never removed: nothing of this may reach bb.
set role service_role;

update public.plaid_items set institution_name = 'Bank A' where id = '00000000-0000-0000-0000-000000000001';
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r08-item-kept', 'Kept Bank');
select rrh.item('00000000-0000-0000-0000-000000000005', rrh.bb(), 'r08-item-bb-kept', 'BB Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000108a1', '00000000-0000-0000-0000-000000000001', 'r08-xa1', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000108a2', '00000000-0000-0000-0000-000000000001', 'r08-xa2', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000108c1', '00000000-0000-0000-0000-000000000003', 'r08-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000108e1', '00000000-0000-0000-0000-000000000002', 'r08-bx1', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000108e2', '00000000-0000-0000-0000-000000000002', 'r08-bx2', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000108f1', '00000000-0000-0000-0000-000000000005', 'r08-bc', 'depository');
create function pg_temp.c() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000108c1'::uuid $$;
create function pg_temp.removal_of(p_plaid_item text) returns uuid language sql as $$
  select id from public.plaid_item_removals where plaid_item_id = p_plaid_item $$;
-- The live removal-written decisions of user aa: how many holds, how many records.
create function pg_temp.hd() returns text language sql as $$
  select 'H=' || count(*) filter (where kind like 'ambiguity_hold_%') || ' D=' || count(*) filter (where kind = 'destination_removed_card')
  from public.card_payment_decisions where user_id = rrh.aa() and superseded_by is null $$;

-- ==== TIE ========================================================================================================
select rrh.cardleg('tie-k', pg_temp.c(), 370, '2026-09-10'),
       rrh.cardleg('tie-a', '00000000-0000-0000-0000-0000000108a1', -370, '2026-09-11'),
       rrh.cardleg('tie-b', '00000000-0000-0000-0000-0000000108a2', -370, '2026-09-11');
select rrh.cardleg('bb-k', '00000000-0000-0000-0000-0000000108f1', 370, '2026-09-10'),
       rrh.cardleg('bb-a', '00000000-0000-0000-0000-0000000108e1', -370, '2026-09-11'),
       rrh.cardleg('bb-b', '00000000-0000-0000-0000-0000000108e2', -370, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select public.evaluate_card_payments(rrh.bb());
select th.assert(rrh.line('tie-k') = 'unresolved/ambiguous/null partner=- decision=- range=-37000..0', 'TIE, before: K is a tie between A and B: ' || rrh.line('tie-k'));

select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
select th.assert(pg_temp.hd() = 'H=0 D=0' and (select count(*) from public.card_payment_removal_sources where user_id = rrh.aa()) = 0,
                 'TIE: the removal writes no hold, no record and no provenance row (a tie has no destination; nothing survives to compete): ' || pg_temp.hd());
select th.assert(rrh.obligations('tie-k') = 'captured(harness-item-a) edges= sources=graph_source:tie-a,graph_source:tie-b',
                 'TIE / GRAPH CAPTURE: K keeps its obligation and BOTH removed candidates as sources although no H or D was written; it knows no surviving edge: ' || rrh.obligations('tie-k'));
select th.assert((select count(*) = 2 and count(distinct s.id) = 2 and bool_and(s.decision_id is null and s.decision_kind is null)
                         and bool_and(s.source_removal_id = pg_temp.removal_of('harness-item-a'))
                         and bool_and(s.source_cents = -37000 and s.source_date = '2026-09-11' and s.source_relation = 'removed_candidate')
                         and string_agg(s.source_plaid_account_id, ',' order by s.source_plaid_account_id) = 'r08-xa1,r08-xa2'
                  from public.card_payment_review_obligation_sources s join public.card_payment_review_obligations o on o.id = s.obligation_id
                  where o.anchor_plaid_transaction_id = 'tie-k'),
                 'TIE: A and B are two source rows of this removal''s generation, each with its account, date and cents, and neither names a decision');
select th.assert((select o.removal_id = pg_temp.removal_of('harness-item-a') and o.anchor_side = 'cash' and o.anchor_cents = 37000 and o.origin = 'captured' and o.completeness = 'complete'
                  from public.card_payment_review_obligations o where o.anchor_plaid_transaction_id = 'tie-k'),
                 'TIE: the obligation names the removal (its generation), the cash side and K''s cents');
select th.assert((select count(*) from public.card_payment_review_obligations where user_id <> rrh.aa()) = 0
                 and (select count(*) from public.card_payment_review_obligation_sources where user_id <> rrh.aa()) = 0
                 and (select count(*) from public.card_payment_review_obligations where user_id = rrh.aa()) = 1,
                 'TIE: owner isolation — one obligation, user aa''s; nothing for bb, whose institutions were not removed');
-- No card is left: the independent "no included card" rule gives −370. K is under review all the same.
select th.assert(rrh.line('tie-k') = 'untracked/no_included_card/-37000 partner=- decision=- range=-37000..-37000' and rrh.review('tie-k') = 'withheld=- obligations=1 gap=f',
                 'TIE, after the removal: no included card, −370; an affected payment: ' || rrh.line('tie-k') || ' ' || rrh.review('tie-k'));

-- An unrelated card payment R arrives on another institution: −370 on the 11th. K/R is the reciprocal, unique
-- candidate pair. K's obligation lists no surviving edge: withheld in both directions.
select rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'r08-item-other', 'Other Bank');
select rrh.account('00000000-0000-0000-0000-0000000108d1', '00000000-0000-0000-0000-000000000008', 'r08-w', 'credit');
select rrh.cardleg('tie-r', '00000000-0000-0000-0000-0000000108d1', -370, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('tie-k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0' and rrh.review('tie-k') = 'withheld=tie-r obligations=1 gap=f',
                 'TIE / GUARD: K does not become "tracked, 0" against the unrelated R: the range {−370, 0}: ' || rrh.line('tie-k') || ' ' || rrh.review('tie-k'));
select th.assert(rrh.line('tie-r') = 'unresolved/relink_review_required/0 partner=- decision=- range=0..0' and rrh.review('tie-r') = 'withheld=tie-k obligations=1 gap=f',
                 'TIE / GUARD: R is withheld the other way: unresolved, 0: ' || rrh.line('tie-r') || ' ' || rrh.review('tie-r'));
select th.assert(rrh.auto_pair('tie-k') = '-' and pg_temp.hd() = 'H=0 D=0', 'TIE: no pair row, and still no H and no D');
select th.assert(rrh.line('bb-k', rrh.bb()) = 'unresolved/ambiguous/null partner=- decision=- range=-37000..0' and rrh.review('bb-k', rrh.bb()) = 'none',
                 'TIE: bb''s identical payment is an ordinary tie, not under review: ' || rrh.line('bb-k', rrh.bb()));

-- ==== MIRROR =====================================================================================================
-- Item 4 "Bank M" (two checking accounts) will be removed. The Kept Bank gets a card Y.
select rrh.item('00000000-0000-0000-0000-000000000004', rrh.aa(), 'r08-item-m', 'Bank M');
select rrh.account('00000000-0000-0000-0000-0000000108b1', '00000000-0000-0000-0000-000000000004', 'r08-ra1', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000108b2', '00000000-0000-0000-0000-000000000004', 'r08-ra2', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000108c2', '00000000-0000-0000-0000-000000000003', 'r08-y', 'credit');
select rrh.cardleg('mir-yc', '00000000-0000-0000-0000-0000000108c2', -410, '2026-09-10'),
       rrh.cardleg('mir-ra', '00000000-0000-0000-0000-0000000108b1', 410, '2026-09-11'),
       rrh.cardleg('mir-rb', '00000000-0000-0000-0000-0000000108b2', 410, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('mir-yc') = 'unresolved/ambiguous/0 partner=- decision=- range=0..0', 'MIRROR, before: the card leg is a tie between two cash legs: ' || rrh.line('mir-yc'));
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000004');
select th.assert(pg_temp.hd() = 'H=0 D=0', 'MIRROR: the removal writes no hold and no record: ' || pg_temp.hd());
select th.assert(rrh.obligations('mir-yc') = 'captured(r08-item-m) edges= sources=graph_source:mir-ra,graph_source:mir-rb',
                 'MIRROR / GRAPH CAPTURE: the surviving CARD leg keeps its obligation and both removed cash legs as sources: ' || rrh.obligations('mir-yc'));
select th.assert((select o.anchor_side = 'credit' and o.anchor_cents = -41000 and o.removal_id = pg_temp.removal_of('r08-item-m')
                  from public.card_payment_review_obligations o where o.anchor_plaid_transaction_id = 'mir-yc')
                 and (select bool_and(s.source_cents = 41000 and s.source_removal_id = pg_temp.removal_of('r08-item-m') and s.decision_id is null)
                      from public.card_payment_review_obligation_sources s join public.card_payment_review_obligations o on o.id = s.obligation_id
                      where o.anchor_plaid_transaction_id = 'mir-yc'),
                 'MIRROR: the card side, the card leg''s cents (−410), its own generation; the sources are cash legs (+410)');
-- A new cash leg N on the kept checking account, the card leg's own day. yc/N would pair: withheld both ways.
-- N is an included cash leg and an included card exists (Y): the range {−410, 0}. The card leg: unresolved, 0.
select rrh.cardleg('mir-n', pg_temp.c(), 410, '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('mir-n') = 'unresolved/relink_review_required/null partner=- decision=- range=-41000..0' and rrh.review('mir-n') = 'withheld=mir-yc obligations=1 gap=f',
                 'MIRROR / GUARD: the new cash leg reads the range {−410, 0}: ' || rrh.line('mir-n') || ' ' || rrh.review('mir-n'));
select th.assert(rrh.line('mir-yc') = 'unresolved/relink_review_required/0 partner=- decision=- range=0..0' and rrh.review('mir-yc') = 'withheld=mir-n obligations=1 gap=f',
                 'MIRROR / GUARD: the affected card leg is unresolved, 0: ' || rrh.line('mir-yc') || ' ' || rrh.review('mir-yc'));
select th.assert(not exists (select 1 from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.user_id = rrh.aa()),
                 'MIRROR: no removed-card record is invented for a surviving card leg');
select th.assert(rrh.line('tie-k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0' and rrh.obligations('tie-k') = 'captured(harness-item-a) edges= sources=graph_source:tie-a,graph_source:tie-b',
                 'MIRROR: the TIE is unchanged by another removal that does not concern it: ' || rrh.line('tie-k'));

-- ==== REPEAT =====================================================================================================
select rrh.item('00000000-0000-0000-0000-000000000006', rrh.aa(), 'r08-item-x', 'Bank X');
select rrh.account('00000000-0000-0000-0000-0000000108a6', '00000000-0000-0000-0000-000000000006', 'r08-x', 'credit');
select rrh.cardleg('rep-k', pg_temp.c(), 260, '2026-09-10'), rrh.cardleg('rep-x', '00000000-0000-0000-0000-0000000108a6', -260, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('rep-k') = 'tracked/auto_pair/0 partner=rep-x decision=- range=0..0', 'REPEAT, before: K3 is matched to X: ' || rrh.line('rep-k'));
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000006');
select th.assert(pg_temp.hd() = 'H=0 D=1' and rrh.retained('rep-k') = 'D(rep-k)', 'REPEAT, removal 1: one record, no hold (nothing competes): ' || pg_temp.hd());
select th.assert(rrh.obligations('rep-k') = 'captured(r08-item-x) edges= sources=removed_destination:rep-x',
                 'REPEAT, removal 1: X is ONE source — the record''s — not a second, graph-only row beside it: ' || rrh.obligations('rep-k'));
select th.assert(rrh.line('rep-k') = 'untracked/removed_card/-26000 partner=- decision=destination_removed_card range=-26000..-26000', 'REPEAT, removal 1: the record reads −260: ' || rrh.line('rep-k'));
-- The card is linked again (a new institution row, new ids) and its payment returns on its original day.
select rrh.item('00000000-0000-0000-0000-000000000007', rrh.aa(), 'r08-item-x-again', 'Bank X');
select rrh.account('00000000-0000-0000-0000-0000000108a7', '00000000-0000-0000-0000-000000000007', 'r08-x-again', 'credit');
select rrh.cardleg('rep-x2', '00000000-0000-0000-0000-0000000108a7', -260, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('rep-k') = 'unresolved/relink_review_required/null partner=- decision=- range=-26000..0' and rrh.review('rep-k') = 'withheld=rep-x2 obligations=1 gap=f',
                 'REPEAT, relinked: the return is withheld; the range {−260, 0}: ' || rrh.line('rep-k') || ' ' || rrh.review('rep-k'));
-- The second removal. K3 has no automatic match (it was withheld) and no surviving competitor: no new H, no new D.
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000007');
select th.assert(pg_temp.hd() = 'H=0 D=1' and rrh.retained('rep-k') = 'D(rep-k)'
                 and (select count(*) from public.card_payment_removal_sources s where s.user_id = rrh.aa()) = 1
                 and (select s.removal_id = pg_temp.removal_of('r08-item-x') and s.source_plaid_transaction_id = 'rep-x'
                      from public.card_payment_removal_sources s where s.user_id = rrh.aa()),
                 'REPEAT, removal 2: no second record and no hold — the ONE original record and its ONE provenance row (removal 1, X) are as they were: ' || pg_temp.hd());
select th.assert(rrh.obligations('rep-k') = 'captured(r08-item-x) edges= sources=removed_destination:rep-x ; captured(r08-item-x-again) edges= sources=graph_source:rep-x2',
                 'REPEAT / GRAPH CAPTURE: the second removal records ITS dependency on X2 as its own obligation and source, beside the first: ' || rrh.obligations('rep-k'));
select th.assert((select count(distinct o.removal_id) = 2 and count(*) = 2 from public.card_payment_review_obligations o where o.anchor_plaid_transaction_id = 'rep-k')
                 and (select s.source_removal_id = pg_temp.removal_of('r08-item-x-again') and s.decision_id is null and s.source_plaid_account_id = 'r08-x-again'
                      from public.card_payment_review_obligation_sources s where s.evidence_kind = 'graph_source' and s.source_plaid_transaction_id = 'rep-x2'),
                 'REPEAT: two generations, kept apart; the graph source names the second removal and the returned account');
select th.assert(rrh.line('rep-k') = 'untracked/removed_card/-26000 partner=- decision=destination_removed_card range=-26000..-26000' and rrh.review('rep-k') = 'withheld=- obligations=2 gap=f',
                 'REPEAT, removal 2: the original record reads −260 again; two obligations: ' || rrh.line('rep-k') || ' ' || rrh.review('rep-k'));
-- A third arrival is withheld because NEITHER obligation lists it.
select rrh.cardleg('rep-x3', '00000000-0000-0000-0000-0000000108d1', -260, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('rep-k') = 'unresolved/relink_review_required/null partner=- decision=- range=-26000..0' and rrh.review('rep-k') = 'withheld=rep-x3 obligations=2 gap=f',
                 'REPEAT: a later arrival is withheld under both obligations: ' || rrh.line('rep-k') || ' ' || rrh.review('rep-k'));

-- ==== STAYS ======================================================================================================
-- K4 +150 on the 10th is matched to Y4 (kept card, the 11th: 1 day). S (−150, the 13th: 3 days) is a farther
-- candidate on an institution that is removed. The match stays, so the removal writes nothing for K4 — but it cut
-- an eligible edge of K4: K4 is affected, S is its source, and K4/Y4 is a surviving edge it positively knows.
select rrh.item('00000000-0000-0000-0000-000000000009', rrh.aa(), 'r08-item-s', 'Bank S');
select rrh.account('00000000-0000-0000-0000-0000000108a9', '00000000-0000-0000-0000-000000000009', 'r08-s', 'credit');
select rrh.cardleg('st-k', pg_temp.c(), 150, '2026-09-10'), rrh.cardleg('st-y', '00000000-0000-0000-0000-0000000108c2', -150, '2026-09-11'),
       rrh.cardleg('st-s', '00000000-0000-0000-0000-0000000108a9', -150, '2026-09-13');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('st-k') = 'tracked/auto_pair/0 partner=st-y decision=- range=0..0', 'STAYS, before: K4 is matched to the kept card: ' || rrh.line('st-k'));
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000009');
select th.assert(pg_temp.hd() = 'H=0 D=1', 'STAYS: the removal writes no hold and no record (the automatic match stays): ' || pg_temp.hd());
select th.assert(rrh.obligations('st-k') = 'captured(r08-item-s) edges=st-y sources=graph_source:st-s',
                 'STAYS / GRAPH CAPTURE: the removed candidate is a source, and the surviving match is a known edge: ' || rrh.obligations('st-k'));
select th.assert(rrh.line('st-k') = 'tracked/auto_pair/0 partner=st-y decision=- range=0..0' and rrh.review('st-k') = 'withheld=- obligations=1 gap=f',
                 'STAYS: the known edge stays the automatic match; nothing is withheld: ' || rrh.line('st-k') || ' ' || rrh.review('st-k'));
-- A newcomer on K4's own day would now be the selected pair. The obligation does not list it: withheld, and the
-- known edge K4/Y4 is not formed in its place.
select rrh.cardleg('st-w', '00000000-0000-0000-0000-0000000108d1', -150, '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('st-k') = 'unresolved/relink_review_required/null partner=- decision=- range=-15000..0' and rrh.review('st-k') = 'withheld=st-w obligations=1 gap=f'
                 and rrh.auto_pair('st-k') = '-',
                 'STAYS / GUARD: a newcomer is withheld and nothing is selected in its place: ' || rrh.line('st-k') || ' ' || rrh.review('st-k'));

select th.assert((select count(*) from public.card_payment_review_obligations where user_id <> rrh.aa()) = 0, 'owner isolation holds to the end');

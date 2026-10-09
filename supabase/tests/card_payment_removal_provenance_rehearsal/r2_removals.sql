-- R2, the scenario. This file is run UNCHANGED on both databases: on the twin, which is still Revision 5, and
-- on the upgraded database. Everything it asserts is a PUBLISHED reading, and so must hold under both bodies.
-- What the two bodies write differently is asserted per database, in r2_twin.sql and r2_upgraded.sql.
--
-- aa removes Card Bank 3 (card X3, checking R3) and then Card Bank 6 (card X6); bb removes BB Card Bank (card BX).
\pset format unaligned
\pset tuples_only on
set role service_role;
select rehearsal.remove(rehearsal.aa(), rehearsal.item('rp-card-bank-3'));
select rehearsal.remove(rehearsal.aa(), rehearsal.item('rp-card-bank-6'));
select rehearsal.remove(rehearsal.bb(), rehearsal.item('harness-item-b'));

select th.assert(rehearsal.legs() = 20 and rehearsal.legs(rehearsal.bb()) = 2, 'R2: 20 legs of aa and 2 of bb are left');
-- A. The tie stays a tie: the automatic pair with the kept card is withheld.
select rehearsal.eq(rehearsal.reading('k-a'), 'unresolved/ambiguous/null partner=- range=-10000..0 decision=- detail=- candidates=y-a:tier1',
  'R2, A: the payment is unresolved, a range, with the kept card as its candidate');
select rehearsal.eq(rehearsal.reading('y-a'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-a:tier1',
  'R2, A: the kept card leg is unmatched');
-- B. The leg it was matched to is gone; the payment reads its removed destination again.
select rehearsal.eq(rehearsal.reading('k-b'), 'untracked/removed_card/-11000 partner=- range=-11000..-11000 decision=destination_removed_card(k-b) detail=- candidates=-',
  'R2, B: the payment counts as a removed-card payment');
-- D. Two identical removed candidates: the pair with the kept card is withheld.
select rehearsal.eq(rehearsal.reading('k-d'), 'unresolved/ambiguous/null partner=- range=-12000..0 decision=- detail=- candidates=y-d:tier1',
  'R2, D: the payment is unresolved, a range, with the kept card as its candidate');
select rehearsal.eq(rehearsal.reading('y-d'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-d:tier1',
  'R2, D: the kept card leg is unmatched');
-- E. The destination is known; the kept card does not take the payment.
select rehearsal.eq(rehearsal.reading('k-e'), 'untracked/removed_card/-13000 partner=- range=-13000..-13000 decision=destination_removed_card(k-e) detail=- candidates=-',
  'R2, E: the payment counts as a removed-card payment');
select rehearsal.eq(rehearsal.reading('y-e'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-e:tier1',
  'R2, E: the kept card leg is unmatched');
-- G. The kept card leg lost its cash leg; the kept payment is not read as its payment.
select rehearsal.eq(rehearsal.reading('y-g'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-g:tier1',
  'R2, G: the kept card leg is unresolved');
select rehearsal.eq(rehearsal.reading('k-g'), 'unresolved/ambiguous/null partner=- range=-15000..0 decision=- detail=- candidates=y-g:tier1',
  'R2, G: the kept payment reads as before the removal');
-- J. The user's pair is the user's decision on the leg that survives.
select rehearsal.eq(rehearsal.reading('k-j'), 'untracked/removed_card/-16000 partner=- range=-16000..-16000 decision=pair_counterpart_removed(k-j/x3-j) detail=- candidates=-',
  'R2, J: the payment counts as a removed-card payment, by the user''s decision');
-- M. Still a tie, between the kept card and the cards of Bank 4 and Bank 5.
select rehearsal.eq(rehearsal.reading('k-m'), 'unresolved/ambiguous/null partner=- range=-17000..0 decision=- detail=- candidates=x4-m:tier1,x5-m:tier1,y-m:tier1',
  'R2, M: the payment is unresolved, a range, with three candidates left');
select rehearsal.eq(rehearsal.reading(p), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-m:tier1',
  'R2, M: the card leg ' || p || ' is unmatched')
from unnest(array['y-m', 'x4-m', 'x5-m']) p;
-- Q, S. Not this removal's concern.
select rehearsal.eq(rehearsal.reading('k-q'), 'tracked/auto_pair/0 partner=x4-q range=0..0 decision=- detail=- candidates=-', 'R2, Q: untouched');
select rehearsal.eq(rehearsal.reading('x4-q'), 'paired/auto_pair/0 partner=k-q range=0..0 decision=- detail=- candidates=-', 'R2, Q: untouched');
select rehearsal.eq(rehearsal.reading('k-s'), 'tracked/auto_pair/0 partner=x5-s range=0..0 decision=- detail=- candidates=-', 'R2, S: untouched');
select rehearsal.eq(rehearsal.reading('x5-s'), 'paired/auto_pair/0 partner=k-s range=0..0 decision=- detail=- candidates=-', 'R2, S: untouched');
select rehearsal.eq(rehearsal.reading('y-s'), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=k-s:tier1', 'R2, S: untouched');
-- T. The removal of Bank 6: the destination is known.
select rehearsal.eq(rehearsal.reading('k-t'), 'untracked/removed_card/-20000 partner=- range=-20000..-20000 decision=destination_removed_card(k-t) detail=- candidates=-',
  'R2, T: the payment counts as a removed-card payment');
-- bb.
select rehearsal.eq(rehearsal.reading('b-k', rehearsal.bb()), 'untracked/removed_card/-10000 partner=- range=-10000..-10000 decision=destination_removed_card(b-k) detail=- candidates=-',
  'R2, bb: the payment counts as a removed-card payment');
select rehearsal.eq(rehearsal.reading('by-k', rehearsal.bb()), 'unresolved/ambiguous/0 partner=- range=0..0 decision=- detail=- candidates=b-k:tier1',
  'R2, bb: the kept card leg is unmatched');
reset role;

-- What the reader gives for both users, kept twice: as the user's last removal itself published it, and as one
-- more evaluation publishes it as of one fixed instant — the same instant in both databases.
select rehearsal.keep_readings('removal');
set role service_role;
select public.evaluate_card_payments(rehearsal.aa(), timestamp with time zone '2026-10-01 00:00:00+00');
select public.evaluate_card_payments(rehearsal.bb(), timestamp with time zone '2026-10-01 00:00:00+00');
reset role;
select rehearsal.keep_readings('as_of');

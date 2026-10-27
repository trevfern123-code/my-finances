-- R0. The baseline: every migration up to and including 20261006120000 (Revision 5), populated, with two
-- institution removals already made by Revision 5. This is the database 20261008120000 is applied to, and the
-- database the twin is a copy of.
--
-- User aa. "Kept Bank" stays (checking C, card Y). Six card institutions are removed, one after the other:
--   Card Bank 1 (card X1)                removed HERE, by Revision 5                       its rows have no provenance
--   Card Bank 2 (card X2)                removed HERE, by Revision 5, after Card Bank 1    its rows have no provenance
--   Card Bank 3 (card X3, checking R3)   removed in R2, by the body of 20261008120000
--   Card Bank 6 (card X6)                removed in R2, after Card Bank 3, by the same body
--   Card Bank 4 (card X4)                removed in R5, by Revision 5 again (20261008120000 rolled back)
--   Card Bank 5 (card X5)                removed in R6, by the body of 20261008120000, applied again
-- User bb. "BB Kept Bank" stays (checking BC, card BY). "BB Card Bank" (card BX, the same mask as aa's X3) is
-- removed in R2.
-- Every case has its own amount, so no leg of one case is a candidate in another. Dates are days of 2026-09.
--
--   case  surviving legs                  removed legs                                    what it is for
--   A     k-a +100 C 10, y-a −100 Y 11    x1-a −100 X1 11 (Bank 1)                        a pair that a Revision 5 removal holds and that R2
--                                         x3-a −100 X3 11 (Bank 3)                        protects again: one pair, one date, two removals
--   B     k-b +110 C 10                   x2-b −110 X2 11 (Bank 2)                        a destination that a Revision 5 removal recorded and
--                                         x3-b −110 X3 11 (Bank 3), imported after        that R2 records again: one leg, two removals
--                                         Bank 2 was removed
--   D     k-d +120 C 10, y-d −120 Y 12    x3-d1, x3-D2 −120 X3 11 (Bank 3)                two identical removed candidates in one removal
--   E     k-e +130 C 10, y-e −130 Y 13    x3-e −130 X3 10 (Bank 3)                        an automatic match with a kept competitor
--   G     y-g −150 Y 10, k-g +150 C 13    r3-g +150 R3 11 (Bank 3)                        the mirror: a removed CASH leg
--   J     k-j +160 C 10                   x3-j −160 X3 11 (Bank 3), CONFIRMED by the user the user's own pair
--   M     k-m +170 C 10, y-m −170 Y 11    x3-m X3 11 (Bank 3), x4-m X4 11 (Bank 4),       THE HAZARD: one pair, one date, three removals —
--                                         x5-m X5 11 (Bank 5), each −170                  recorded, then unrecorded, then recorded
--   Q     k-q +180 C 10                   x4-q −180 X4 11 (Bank 4)                        a destination recorded while rolled back
--   S     k-s +190 C 10, y-s −190 Y 13    x5-s −190 X5 11 (Bank 5)                        rows written after the marker
--   T     k-t +200 C 10                   x6-t −200 X6 11 (Bank 6)                        a second removal by the new body: a second
--                                                                                         recorded generation before the marker
--   bb    b-k +100 BC 10, by-k −100 BY 13 bx-k −100 BX 11 (BB Card Bank)                  another user's removal, in that user's own order
-- D's second removed candidate is spelled x3-D2 and is inserted before x3-d1. Byte order ("C" collation) puts
-- x3-D2 first. A linguistic collation (en-US, the default of the image this harness uses) puts x3-d1 first; so
-- does the removal's insert when its ORDER BY leaves the source out (observed on that image with this order of
-- insertion; nothing specifies it). R2 checks the order in which the removal writes the two holds.
\pset format unaligned
\pset tuples_only on
select th.assert(rehearsal.body_md5() = :'revision5_body', 'R0: remove_plaid_item_local is the 20261006120000 body (Revision 5)');
select th.assert(to_regclass('public.card_payment_removal_generations') is null and to_regclass('public.card_payment_removal_sources') is null,
  'R0: no provenance table exists');

set role service_role;
update public.plaid_items set institution_id = 'ins_card1', institution_name = 'Card Bank 1' where id = '00000000-0000-0000-0000-000000000001';
update public.plaid_items set institution_id = 'ins_bbcard', institution_name = 'BB Card Bank' where id = '00000000-0000-0000-0000-000000000002';
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_id, institution_name) values
  ('00000000-0000-0000-0000-000000000010', rehearsal.aa(), 'rp-kept-bank', 'placeholder-token-kept', 'ins_kept', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000012', rehearsal.aa(), 'rp-card-bank-2', 'placeholder-token-card2', 'ins_card2', 'Card Bank 2'),
  ('00000000-0000-0000-0000-000000000013', rehearsal.aa(), 'rp-card-bank-3', 'placeholder-token-card3', 'ins_card3', 'Card Bank 3'),
  ('00000000-0000-0000-0000-000000000014', rehearsal.aa(), 'rp-card-bank-4', 'placeholder-token-card4', 'ins_card4', 'Card Bank 4'),
  ('00000000-0000-0000-0000-000000000015', rehearsal.aa(), 'rp-card-bank-5', 'placeholder-token-card5', 'ins_card5', 'Card Bank 5'),
  ('00000000-0000-0000-0000-000000000016', rehearsal.aa(), 'rp-card-bank-6', 'placeholder-token-card6', 'ins_card6', 'Card Bank 6'),
  ('00000000-0000-0000-0000-000000000020', rehearsal.bb(), 'rp-bb-kept-bank', 'placeholder-token-bbkept', 'ins_bbkept', 'BB Kept Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type, subtype, mask) values
  ('00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-000000000010', 'rp-c', 'Kept Checking', 'depository', 'checking', '9001'),
  ('00000000-0000-0000-0000-0000000e00c2', '00000000-0000-0000-0000-000000000010', 'rp-y', 'Kept Card Y', 'credit', 'credit card', '9002'),
  ('00000000-0000-0000-0000-0000000e0011', '00000000-0000-0000-0000-000000000001', 'rp-x1', 'Card X1', 'credit', 'credit card', '1001'),
  ('00000000-0000-0000-0000-0000000e0021', '00000000-0000-0000-0000-000000000012', 'rp-x2', 'Card X2', 'credit', 'credit card', '2001'),
  ('00000000-0000-0000-0000-0000000e0031', '00000000-0000-0000-0000-000000000013', 'rp-x3', 'Card X3', 'credit', 'credit card', '3001'),
  ('00000000-0000-0000-0000-0000000e0032', '00000000-0000-0000-0000-000000000013', 'rp-r3', 'Checking R3', 'depository', 'checking', '3002'),
  ('00000000-0000-0000-0000-0000000e0041', '00000000-0000-0000-0000-000000000014', 'rp-x4', 'Card X4', 'credit', 'credit card', '4001'),
  ('00000000-0000-0000-0000-0000000e0051', '00000000-0000-0000-0000-000000000015', 'rp-x5', 'Card X5', 'credit', 'credit card', '5001'),
  ('00000000-0000-0000-0000-0000000e0061', '00000000-0000-0000-0000-000000000016', 'rp-x6', 'Card X6', 'credit', 'credit card', '6001'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-000000000020', 'rp-bc', 'BB Checking', 'depository', 'checking', '8001'),
  ('00000000-0000-0000-0000-0000000e00b2', '00000000-0000-0000-0000-000000000020', 'rp-by', 'BB Kept Card BY', 'credit', 'credit card', '8002'),
  ('00000000-0000-0000-0000-0000000e00b3', '00000000-0000-0000-0000-000000000002', 'rp-bx', 'BB Card BX', 'credit', 'credit card', '3001');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, user_role_override)
select a.id, v.plaid, v.amount, v.day, 'Payment ' || v.plaid, 'credit_card_payment'
from (values
  ('rp-c', 'k-a', 100, date '2026-09-10'), ('rp-y', 'y-a', -100, date '2026-09-11'),                                             -- A
  ('rp-x1', 'x1-a', -100, date '2026-09-11'), ('rp-x3', 'x3-a', -100, date '2026-09-11'),
  ('rp-c', 'k-b', 110, date '2026-09-10'), ('rp-x2', 'x2-b', -110, date '2026-09-11'),                                           -- B
  ('rp-c', 'k-d', 120, date '2026-09-10'), ('rp-y', 'y-d', -120, date '2026-09-12'),                                             -- D
  ('rp-x3', 'x3-D2', -120, date '2026-09-11'), ('rp-x3', 'x3-d1', -120, date '2026-09-11'),
  ('rp-c', 'k-e', 130, date '2026-09-10'), ('rp-y', 'y-e', -130, date '2026-09-13'), ('rp-x3', 'x3-e', -130, date '2026-09-10'), -- E
  ('rp-y', 'y-g', -150, date '2026-09-10'), ('rp-c', 'k-g', 150, date '2026-09-13'), ('rp-r3', 'r3-g', 150, date '2026-09-11'),  -- G
  ('rp-c', 'k-j', 160, date '2026-09-10'), ('rp-x3', 'x3-j', -160, date '2026-09-11'),                                           -- J
  ('rp-c', 'k-m', 170, date '2026-09-10'), ('rp-y', 'y-m', -170, date '2026-09-11'),                                             -- M
  ('rp-x3', 'x3-m', -170, date '2026-09-11'), ('rp-x4', 'x4-m', -170, date '2026-09-11'), ('rp-x5', 'x5-m', -170, date '2026-09-11'),
  ('rp-c', 'k-q', 180, date '2026-09-10'), ('rp-x4', 'x4-q', -180, date '2026-09-11'),                                           -- Q
  ('rp-c', 'k-s', 190, date '2026-09-10'), ('rp-y', 'y-s', -190, date '2026-09-13'), ('rp-x5', 'x5-s', -190, date '2026-09-11'), -- S
  ('rp-c', 'k-t', 200, date '2026-09-10'), ('rp-x6', 'x6-t', -200, date '2026-09-11'),                                           -- T
  ('rp-bc', 'b-k', 100, date '2026-09-10'), ('rp-by', 'by-k', -100, date '2026-09-13'), ('rp-bx', 'bx-k', -100, date '2026-09-11') -- bb
) v(account, plaid, amount, day)
join public.accounts a on a.plaid_account_id = v.account;
select public.evaluate_card_payments(rehearsal.aa());
select public.evaluate_card_payments(rehearsal.bb());
select th.assert(public.link_card_payment(rehearsal.aa(), rehearsal.tid('k-j'), rehearsal.tid('x3-j'), 0, rehearsal.iv())->>'status' = 'saved',
  'R0, J: the user confirms k-j with x3-j');

-- The fixture is what the header says.
select th.assert(rehearsal.legs() = 30 and rehearsal.legs(rehearsal.bb()) = 3, 'R0: 30 card-payment legs of aa and 3 of bb');
select rehearsal.eq(rehearsal.reading('k-a'), 'unresolved/ambiguous/null partner=- range=-10000..0 decision=- detail=- candidates=x1-a:tier1,x3-a:tier1,y-a:tier1',
  'R0, A: a three-way tie between the kept card and the cards of Bank 1 and Bank 3');
select rehearsal.eq(rehearsal.reading('k-b'), 'tracked/auto_pair/0 partner=x2-b range=0..0 decision=- detail=- candidates=-',
  'R0, B: matched automatically to the card of Bank 2');
select rehearsal.eq(rehearsal.reading('k-d'), 'unresolved/ambiguous/null partner=- range=-12000..0 decision=- detail=- candidates=x3-D2:tier1,x3-d1:tier1,y-d:tier1',
  'R0, D: the two identical payments on the card of Bank 3 tie');
select rehearsal.eq(rehearsal.reading('k-e'), 'tracked/auto_pair/0 partner=x3-e range=0..0 decision=- detail=- candidates=-',
  'R0, E: matched automatically to the card of Bank 3; the kept card fits less well');
select rehearsal.eq(rehearsal.reading('y-g'), 'paired/auto_pair/0 partner=r3-g range=0..0 decision=- detail=- candidates=-',
  'R0, G: the kept card leg is matched automatically to the cash leg of Bank 3');
select rehearsal.eq(rehearsal.reading('k-g'), 'unresolved/ambiguous/null partner=- range=-15000..0 decision=- detail=- candidates=y-g:tier1',
  'R0, G: the kept payment also fits that card leg, less well');
select rehearsal.eq(rehearsal.reading('k-j'), 'tracked/user_pair/0 partner=x3-j range=0..0 decision=pair(k-j/x3-j) detail=- candidates=-',
  'R0, J: the user''s pair is active');
select rehearsal.eq(rehearsal.reading('k-m'), 'unresolved/ambiguous/null partner=- range=-17000..0 decision=- detail=- candidates=x3-m:tier1,x4-m:tier1,x5-m:tier1,y-m:tier1',
  'R0, M: a four-way tie between the kept card and the cards of Bank 3, Bank 4 and Bank 5');
select rehearsal.eq(rehearsal.reading('k-q'), 'tracked/auto_pair/0 partner=x4-q range=0..0 decision=- detail=- candidates=-',
  'R0, Q: matched automatically to the card of Bank 4');
select rehearsal.eq(rehearsal.reading('k-s'), 'tracked/auto_pair/0 partner=x5-s range=0..0 decision=- detail=- candidates=-',
  'R0, S: matched automatically to the card of Bank 5; the kept card fits less well');
select rehearsal.eq(rehearsal.reading('k-t'), 'tracked/auto_pair/0 partner=x6-t range=0..0 decision=- detail=- candidates=-',
  'R0, T: matched automatically to the card of Bank 6');
select rehearsal.eq(rehearsal.reading('b-k', rehearsal.bb()), 'tracked/auto_pair/0 partner=bx-k range=0..0 decision=- detail=- candidates=-',
  'R0, bb: matched automatically to the card of BB Card Bank; the kept card fits less well');
select rehearsal.eq_list(rehearsal.rows(), '{}', 'R0: no removal has written anything yet');

-- ---- Two removals by Revision 5: the rows they leave have no provenance, and never get any -------------
-- Card Bank 1. The tie of A is held against both candidates that stay: the kept card and the card of Bank 3.
select rehearsal.remove(rehearsal.aa(), rehearsal.item('harness-item-a'));
select rehearsal.eq_list(rehearsal.rows(), array['ambiguity_hold_removed_card(x3-a/k-a@2026-09-11)', 'ambiguity_hold_removed_card(y-a/k-a@2026-09-11)'],
  'R0, Revision 5 removes Bank 1: a hold on each surviving candidate of k-a, with the date of the removed leg x1-a');
select rehearsal.eq(rehearsal.reading('k-a'), 'unresolved/ambiguous/null partner=- range=-10000..0 decision=- detail=- candidates=x3-a:tier1,y-a:tier1',
  'R0, A: still a tie, between the two candidates that stay');
-- Card Bank 2. The destination of B is recorded.
select rehearsal.remove(rehearsal.aa(), rehearsal.item('rp-card-bank-2'));
select rehearsal.eq_list(rehearsal.rows(), array['ambiguity_hold_removed_card(x3-a/k-a@2026-09-11)', 'ambiguity_hold_removed_card(y-a/k-a@2026-09-11)',
                                               'destination_removed_card(k-b)'],
  'R0, Revision 5 removes Bank 2: the known destination of k-b is recorded');
select rehearsal.eq(rehearsal.reading('k-b'), 'untracked/removed_card/-11000 partner=- range=-11000..-11000 decision=destination_removed_card(k-b) detail=- candidates=-',
  'R0, B: the payment counts as a removed-card payment');
select th.assert((rehearsal.removal('harness-item-a')).status = 'cleaned' and (rehearsal.removal('rp-card-bank-2')).status = 'cleaned'
                 and (rehearsal.removal('harness-item-a')).cleaned_at < (rehearsal.removal('rp-card-bank-2')).cleaned_at,
  'R0: both removals are cleaned, Bank 1''s before Bank 2''s');
-- Later, the payment of B is imported on the card of Bank 3 as well: new evidence. The payment is matched to
-- it automatically, and the record goes dormant behind that match.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, user_role_override)
values ('00000000-0000-0000-0000-0000000e0031', 'x3-b', -110, '2026-09-11', 'Payment x3-b', 'credit_card_payment');
select public.evaluate_card_payments(rehearsal.aa());
select rehearsal.eq(rehearsal.reading('k-b'), 'tracked/auto_pair/0 partner=x3-b range=0..0 decision=- detail=- candidates=-',
  'R0, B: matched automatically to the leg on the card of Bank 3; its record is still live');
select th.assert(rehearsal.legs() = 29 and cardinality(rehearsal.rows()) = 3, 'R0: 29 legs of aa are left, and three rows written by Revision 5 removals');
reset role;

-- What the later steps require of this moment.
select rehearsal.keep('revision 5 body', rehearsal.body_source());
select rehearsal.keep('legacy hold y-a/k-a', (rehearsal.ids('ambiguity_hold_removed_card(y-a/k-a@2026-09-11)'))[1]);
select rehearsal.keep('legacy record k-b', (rehearsal.ids('destination_removed_card(k-b)'))[1]);
select rehearsal.keep_decisions('r0');
select rehearsal.take('r0');
select rehearsal.take_catalog('r0');
select 'REPORT  body ' || rehearsal.body_md5() || ' (20261006120000); aa: ' || rehearsal.legs() || ' legs, linked: '
       || (select string_agg(i.institution_name, ', ' order by i.institution_name) from public.plaid_items i where i.user_id = rehearsal.aa())
       || '; removed by Revision 5: '
       || (select string_agg(r.institution_name, ', ' order by r.cleaned_at) from public.plaid_item_removals r where r.user_id = rehearsal.aa() and r.status = 'cleaned')
       || '; bb: ' || rehearsal.legs(rehearsal.bb()) || ' legs';
select 'REPORT  rows without provenance: ' || x from unnest(rehearsal.rows()) x;

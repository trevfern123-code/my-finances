-- Institution removal is not evidence — also where an EXCLUDED account is involved (Phase B I3A revision 5;
-- the independent audit's finding P1; 20261006110000 and 20261006120000).
--
-- The contract (Trevor's decision of 2026-10-06, design §4.7): a leg whose automatic match was open because a
-- candidate on the removed institution and a candidate on an institution that stays both fitted it does NOT
-- become matched merely because the first was deleted. That is a statement about the MATCHING EVIDENCE — the
-- complete tier 1 pool, in which legs on excluded accounts take part like any other — not about what a reader
-- is shown. A leg on an account that is excluded from cash flow is published as not_counted, with no candidate
-- list; a payment that the "no included card" rule decides is published as untracked. Each of them can still
-- have candidates on both sides of a removal, and each of them then needs the same system ambiguity hold as a
-- leg that reads "unresolved". And where there is no such ambiguity, nothing is written.
--
-- User aa. Item 1 "Removed Bank" (checking R, card X, EXCLUDED card XE) is REMOVED. Item 3 "Kept Bank" survives:
-- checking C, EXCLUDED checking CE, card Y (included: the "no included card" rule never applies to aa),
-- EXCLUDED card E and EXCLUDED card E2. Every case has its own amount.
--
--   case  the legs (dates in 2026-09)                                          what is exercised
--   A     k-a +200 C 10; x-a −200 X 11; e-a −200 E 11                          an included payment tied between a
--                                                                              removed card and a kept EXCLUDED card
--   B     k-b +100 C 10; r-b +100 R 10; e-b −100 E 10                          THE AUDIT'S COUNTEREXAMPLE: the owner
--                                                                              of the ambiguity is the excluded
--                                                                              card leg, which has no candidate list
--   C     kc-c +300 CE 10; x-c −300 X 11; y-c −300 Y 11                        an EXCLUDED cash leg tied between a
--                                                                              removed card and a kept one; later
--                                                                              its account is included again
--   D     k-d +400 C 10; xe-d −400 XE 11; e-d −400 E2 11                       both candidates on excluded cards,
--                                                                              one removed; an included card remains
--   E     y-e −600 Y 10; r-e +600 R 11; ke-e +600 CE 11                        the mirror: a card leg tied between a
--                                                                              removed cash leg and a kept EXCLUDED
--                                                                              cash leg; later CE is included
--   F     no genuine ambiguity, four shapes:
--         F1  k-f1 +700 C 10; e-f1 −700 E 10; r-f1 +710 R 10                   an automatic match with an excluded
--                                                                              card; the removed leg does not fit
--         F2  k-f2 +720 C 10; e-f2 −720 E 10; xe-f2 −720 XE 12                 the automatic match STAYS; a removed
--                                                                              excluded card merely fitted less well
--         F3  e2-f3 −730 E2 10; xe-f3 −730 XE 10                               two excluded card legs, no payment
--         F4  k-f4 +740 C 10; x-f4 −740 X 11; xe-f4 −740 XE 11                 a tie between two REMOVED cards
--   G     k-g +800 C 10; r-g +800 R 10; e-g −800 E 10                          shape B; later the user decides
--   I     k-i +900 C 10 PENDING; r-i +900 R 10; e-i −900 E 10                  shape B; later the payment posts
--   J     —                                                                    repeated evaluation, same evidence
-- User bb (H, N, N2). Item 2 (checking BR, EXCLUDED card BXE) is REMOVED; item 5 survives: checking BC and
-- EXCLUDED card BE. bb has NO included card at all. The first three legs have exactly the amounts and dates of
-- aa's case B; the other three have the dates of aa's case D:
--         b-k +100 BC 10; br-k +100 BR 10; be-k −100 BE 10
--         b-k2 +150 BC 10; bxe-k2 −150 BXE 11; be-k2 −150 BE 11
--   H     ownership: aa's removal does not touch bb; bb's removal holds bb's own ambiguity
--   N     shape B again: the owner of the ambiguity is the excluded card leg be-k. The payment b-k, the hold's
--         other leg, reads untracked / no_included_card before and after; later BE is included
--   N2    the OWNER of the ambiguity is a payment the "no included card" rule decides: b-k2, tied between an
--         excluded card of the removed institution and an excluded card that stays; later BE is included
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.states(p_user uuid default pg_temp.aa()) returns jsonb language sql as $$ select public.get_card_payment_states(p_user) $$;
create function pg_temp.iv(p_user uuid default pg_temp.aa()) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- A leg's state. Raises when the states are not fresh, so no check can pass on a stale read.
create function pg_temp.leg(p_plaid text, p_user uuid default pg_temp.aa()) returns jsonb language plpgsql as $$
declare
  v jsonb := pg_temp.states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  return (select l from jsonb_array_elements(v->'legs') l where (l->>'transactionId')::uuid = pg_temp.tid(p_plaid));
end $$;
-- state / reason / effect, then the partner's Plaid id ("-" when none).
create function pg_temp.srep(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') || ' partner='
         || coalesce((select t.plaid_transaction_id from public.transactions t where t.id = (l->>'partnerTransactionId')::uuid), '-')
  from pg_temp.leg(p_plaid, p_user) l $$;
-- What a leg contributes to cash flow: effect / low / high.
create function pg_temp.figures(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select coalesce(l->>'effectCents', 'null') || '/' || (l->>'lowCents') || '/' || (l->>'highCents') from pg_temp.leg(p_plaid, p_user) l $$;
-- The Plaid ids of a leg's tier-1-shaped candidates, sorted.
create function pg_temp.competitors(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select coalesce(string_agg(t.plaid_transaction_id, ',' order by t.plaid_transaction_id collate "C"), '')
  from jsonb_array_elements(pg_temp.leg(p_plaid, p_user)->'candidates') c
  join public.transactions t on t.id = (c->>'transactionId')::uuid where c->>'kind' = 'tier1_competitor' $$;
create function pg_temp.dstatus(p_decision uuid, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (d->>'status') || coalesce('/' || (d->>'detail'), '')
  from jsonb_array_elements(pg_temp.states(p_user)->'decisions') d where (d->>'decisionId')::uuid = p_decision $$;
-- The live ambiguity holds that name a Plaid id as either leg, as "kind:card-leg/cash-leg@date", sorted.
create function pg_temp.holds(p_plaid text) returns text language sql as $$
  select coalesce(string_agg(replace(d.kind, 'ambiguity_hold_', '') || ':' || d.a_plaid_transaction_id || '/' || d.b_plaid_transaction_id || '@' || d.counterpart_date, ','
                             order by d.kind, d.a_plaid_transaction_id collate "C", d.b_plaid_transaction_id collate "C", d.counterpart_date), 'none')
  from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and p_plaid in (d.a_plaid_transaction_id, d.b_plaid_transaction_id) $$;
create function pg_temp.hold_id(p_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and p_plaid in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)
  order by d.a_plaid_transaction_id collate "C", d.counterpart_date limit 1 $$;
-- Every live decision of any kind that names a Plaid id as either leg.
create function pg_temp.decisions_on(p_plaid text) returns bigint language sql as $$
  select count(*) from public.card_payment_decisions d
  where d.superseded_by is null and p_plaid in (d.a_plaid_transaction_id, d.b_plaid_transaction_id) $$;
-- The kind of the live decision a leg's state names ("none" when it names none).
create function pg_temp.holder_kind(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid and d.superseded_by is null), 'none')
  from pg_temp.leg(p_plaid, p_user) l $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending boolean default false,
                                p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, pending_transaction_id, user_role_override)
  values (p_account::uuid, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, p_pending_of, 'credit_card_payment') $$;
create function pg_temp.evaluate() returns void language sql as $$
  select public.evaluate_card_payments(pg_temp.aa()); select public.evaluate_card_payments(pg_temp.bb()); $$;
create function pg_temp.remove(p_user uuid, p_item uuid) returns void language plpgsql as $$
begin
  perform th.assert(public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item))->>'outcome' = 'started', 'removal begins');
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
  perform th.assert((public.remove_plaid_item_local(p_user, p_item)->>'replayed')::boolean = false, 'the removal runs');
end $$;
-- One write through an RPC (or a direct statement returning jsonb), run as a statement of its own and kept by
-- name: its status, or "refused: <message>" — a refusal is a recorded result, not the end of the file.
create temporary table calls (name text primary key, result text not null);
create function pg_temp.call(p_name text, p_sql text) returns void language plpgsql as $$
declare
  v jsonb;
  r text;
begin
  begin
    execute p_sql into v;
    r := coalesce(v->>'status', 'done');
  exception when others then
    r := 'refused: ' || sqlerrm;
  end;
  insert into pg_temp.calls values (p_name, r);
end $$;
create function pg_temp.called(p_name text) returns text language sql as $$ select result from pg_temp.calls where name = p_name $$;

-- ---- The contract's checks: recorded, all printed, asserted together at the end -----------------------
create temporary table contract (seq integer generated always as identity, kase text not null, requirement text not null, ok boolean not null);
create function pg_temp.req(p_case text, p_requirement text, p_ok boolean) returns void language sql as $$
  insert into pg_temp.contract (kase, requirement, ok) values (p_case, p_requirement, coalesce(p_ok, false)) $$;
create temporary table observed (seq integer generated always as identity, moment text not null, leg text not null, what text not null);
create function pg_temp.observe(p_moment text, p_legs text[], p_user uuid default pg_temp.aa()) returns void language sql as $$
  insert into pg_temp.observed (moment, leg, what)
  select p_moment, p, coalesce(pg_temp.srep(p, p_user), '(no current leg)') || '  decision=' || coalesce(pg_temp.holder_kind(p, p_user), '-') || '  holds=' || pg_temp.holds(p)
  from unnest(p_legs) with ordinality as u(p, n) order by n $$;
-- An included cash leg that is unresolved by a tier-1-shaped ambiguity: no effect, the range {−cents, 0}, no decision.
create function pg_temp.unresolved_range(p_plaid text, p_cents bigint, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select pg_temp.srep(p_plaid, p_user) = 'unresolved/ambiguous/null partner=-'
         and (l->>'lowCents')::bigint = -p_cents and (l->>'highCents')::bigint = 0 and l->>'decisionId' is null and l->>'detail' is null
  from pg_temp.leg(p_plaid, p_user) l $$;
-- A leg on an excluded account: evidence only, never counted, and here never matched.
create function pg_temp.not_counted_unmatched(p_plaid text, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select pg_temp.srep(p_plaid, p_user) = 'not_counted/excluded_account/0 partner=-' and l->>'decisionId' is null
  from pg_temp.leg(p_plaid, p_user) l $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'BB Kept Bank');
update public.plaid_items set institution_name = 'Removed Bank' where id = '00000000-0000-0000-0000-000000000001';
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-0000000023a1', '00000000-0000-0000-0000-000000000001', 'a23-r', 'Removed Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000023a2', '00000000-0000-0000-0000-000000000001', 'a23-x', 'Removed Card X', 'credit', false),
  ('00000000-0000-0000-0000-0000000023a3', '00000000-0000-0000-0000-000000000001', 'a23-xe', 'Removed Card XE (excluded)', 'credit', true),
  ('00000000-0000-0000-0000-0000000023b1', '00000000-0000-0000-0000-000000000003', 'a23-c', 'Kept Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000023b3', '00000000-0000-0000-0000-000000000003', 'a23-ce', 'Kept Checking CE (excluded)', 'depository', true),
  ('00000000-0000-0000-0000-0000000023b4', '00000000-0000-0000-0000-000000000003', 'a23-y', 'Kept Card Y', 'credit', false),
  ('00000000-0000-0000-0000-0000000023b5', '00000000-0000-0000-0000-000000000003', 'a23-e', 'Kept Card E (excluded)', 'credit', true),
  ('00000000-0000-0000-0000-0000000023b6', '00000000-0000-0000-0000-000000000003', 'a23-e2', 'Kept Card E2 (excluded)', 'credit', true),
  ('00000000-0000-0000-0000-0000000023c2', '00000000-0000-0000-0000-000000000002', 'a23-br', 'BB Removed Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000023c4', '00000000-0000-0000-0000-000000000002', 'a23-bxe', 'BB Removed Card BXE (excluded)', 'credit', true),
  ('00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-000000000005', 'a23-bc', 'BB Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000023c3', '00000000-0000-0000-0000-000000000005', 'a23-be', 'BB Card BE (excluded)', 'credit', true);
create function pg_temp.r() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023a1' $$;
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023a2' $$;
create function pg_temp.xe() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023a3' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023b1' $$;
create function pg_temp.ce() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023b3' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023b4' $$;
create function pg_temp.e() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023b5' $$;
create function pg_temp.e2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023b6' $$;
create function pg_temp.br() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023c2' $$;
create function pg_temp.bxe() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023c4' $$;
create function pg_temp.bc() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023c1' $$;
create function pg_temp.be() returns text language sql as $$ select '00000000-0000-0000-0000-0000000023c3' $$;

select pg_temp.cardleg('k-a', pg_temp.c(), 200, '2026-09-10'), pg_temp.cardleg('x-a', pg_temp.x(), -200, '2026-09-11'), pg_temp.cardleg('e-a', pg_temp.e(), -200, '2026-09-11');     -- A
select pg_temp.cardleg('k-' || s, pg_temp.c(), amt, '2026-09-10', pending), pg_temp.cardleg('r-' || s, pg_temp.r(), amt, '2026-09-10'),                                              -- B, G, I
       pg_temp.cardleg('e-' || s, pg_temp.e(), -amt, '2026-09-10')
from (values ('b', 100, false), ('g', 800, false), ('i', 900, true)) v(s, amt, pending);
select pg_temp.cardleg('kc-c', pg_temp.ce(), 300, '2026-09-10'), pg_temp.cardleg('x-c', pg_temp.x(), -300, '2026-09-11'), pg_temp.cardleg('y-c', pg_temp.y(), -300, '2026-09-11');   -- C
select pg_temp.cardleg('k-d', pg_temp.c(), 400, '2026-09-10'), pg_temp.cardleg('xe-d', pg_temp.xe(), -400, '2026-09-11'), pg_temp.cardleg('e-d', pg_temp.e2(), -400, '2026-09-11');  -- D
select pg_temp.cardleg('y-e', pg_temp.y(), -600, '2026-09-10'), pg_temp.cardleg('r-e', pg_temp.r(), 600, '2026-09-11'), pg_temp.cardleg('ke-e', pg_temp.ce(), 600, '2026-09-11');    -- E
select pg_temp.cardleg('k-f1', pg_temp.c(), 700, '2026-09-10'), pg_temp.cardleg('e-f1', pg_temp.e(), -700, '2026-09-10'), pg_temp.cardleg('r-f1', pg_temp.r(), 710, '2026-09-10');   -- F1
select pg_temp.cardleg('k-f2', pg_temp.c(), 720, '2026-09-10'), pg_temp.cardleg('e-f2', pg_temp.e(), -720, '2026-09-10'), pg_temp.cardleg('xe-f2', pg_temp.xe(), -720, '2026-09-12'); -- F2
select pg_temp.cardleg('e2-f3', pg_temp.e2(), -730, '2026-09-10'), pg_temp.cardleg('xe-f3', pg_temp.xe(), -730, '2026-09-10');                                                       -- F3
select pg_temp.cardleg('k-f4', pg_temp.c(), 740, '2026-09-10'), pg_temp.cardleg('x-f4', pg_temp.x(), -740, '2026-09-11'), pg_temp.cardleg('xe-f4', pg_temp.xe(), -740, '2026-09-11'); -- F4
select pg_temp.cardleg('b-k', pg_temp.bc(), 100, '2026-09-10'), pg_temp.cardleg('br-k', pg_temp.br(), 100, '2026-09-10'), pg_temp.cardleg('be-k', pg_temp.be(), -100, '2026-09-10');  -- bb
select pg_temp.cardleg('b-k2', pg_temp.bc(), 150, '2026-09-10'), pg_temp.cardleg('bxe-k2', pg_temp.bxe(), -150, '2026-09-11'), pg_temp.cardleg('be-k2', pg_temp.be(), -150, '2026-09-11'); -- bb, N2
select pg_temp.evaluate();

-- The fixture is what the header says.
select th.assert(pg_temp.unresolved_range('k-a', 20000) and pg_temp.competitors('k-a') = 'e-a,x-a', 'before, A: the payment is unresolved, tied between the removed card and the kept excluded card');
select th.assert((select bool_and(pg_temp.unresolved_range('k-' || s, amt) and pg_temp.competitors('k-' || s) = 'e-' || s
                                  and pg_temp.not_counted_unmatched('e-' || s) and pg_temp.leg('e-' || s)->'candidates' = '[]'::jsonb)
                  from (values ('b', 10000), ('g', 80000), ('i', 90000)) v(s, amt)),
  'before, B / G / I: the kept payment is unresolved with the excluded card leg as its one candidate; that card leg is published not_counted with NO candidate list, although two payments fit it equally');
select th.assert(pg_temp.not_counted_unmatched('kc-c') and pg_temp.leg('kc-c')->'candidates' = '[]'::jsonb
                 and pg_temp.srep('x-c') = 'unresolved/ambiguous/0 partner=-' and pg_temp.srep('y-c') = 'unresolved/ambiguous/0 partner=-',
  'before, C: the excluded cash leg is not counted and matched to nothing; the removed card''s leg and the kept card''s leg both fit it');
select th.assert(pg_temp.unresolved_range('k-d', 40000) and pg_temp.competitors('k-d') = 'e-d,xe-d', 'before, D: unresolved, tied between two excluded cards');
select th.assert(pg_temp.srep('y-e') = 'unresolved/ambiguous/0 partner=-' and pg_temp.competitors('y-e') = 'ke-e,r-e' and pg_temp.not_counted_unmatched('ke-e'),
  'before, E: the card leg is unresolved, tied between the removed cash leg and the kept excluded cash leg');
select th.assert(pg_temp.srep('k-f1') = 'untracked/partner_excluded/-70000 partner=e-f1' and pg_temp.srep('k-f2') = 'untracked/partner_excluded/-72000 partner=e-f2'
                 and pg_temp.srep('k-f4') = 'unresolved/ambiguous/null partner=-' and pg_temp.competitors('k-f4') = 'x-f4,xe-f4'
                 and pg_temp.srep('e2-f3') = 'not_counted/excluded_account/0 partner=-',
  'before, F: two automatic matches with a kept excluded card; a tie between two cards that are both removed; an excluded card leg with no payment');
select th.assert(pg_temp.srep('b-k', pg_temp.bb()) = 'untracked/no_included_card/-10000 partner=-' and pg_temp.srep('be-k', pg_temp.bb()) = 'not_counted/excluded_account/0 partner=-',
  'before, bb: no included card at all — the payment counts by that rule, and its excluded card leg is matched to nothing (two payments fit it)');
select th.assert(pg_temp.srep('b-k2', pg_temp.bb()) = 'untracked/no_included_card/-15000 partner=-' and pg_temp.leg('b-k2', pg_temp.bb())->'candidates' = '[]'::jsonb
                 and pg_temp.not_counted_unmatched('bxe-k2', pg_temp.bb()) and pg_temp.not_counted_unmatched('be-k2', pg_temp.bb()),
  'before, N2: the payment counts by the no-included-card rule and is published with NO candidate list, although an excluded card leg of the removed institution and one that stays fit it equally; neither is matched to it');
select th.assert((select count(*) from public.card_payment_decisions) = 0, 'before: no decision of any kind exists');
-- What every surviving INCLUDED payment contributes before the removal. None of them is matched to the removed
-- institution, so a removal that is not evidence must leave every one of these figures exactly as it is.
create temporary table before_removal as
  select p as leg, pg_temp.figures(p) as figures, pg_temp.srep(p) as srep
  from unnest(array['k-a', 'k-b', 'k-d', 'k-f1', 'k-f2', 'k-f4', 'k-g', 'k-i']) p;
create temporary table bb_before as
  select pg_temp.iv(pg_temp.bb()) as iv, pg_temp.figures('b-k', pg_temp.bb()) as figures, pg_temp.figures('b-k2', pg_temp.bb()) as figures_k2;

-- ---- The removal of aa's Removed Bank -------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000001');
select pg_temp.observe('right after the removal', array['k-a', 'e-a', 'k-b', 'e-b', 'kc-c', 'y-c', 'k-d', 'e-d', 'y-e', 'ke-e', 'k-f1', 'k-f2', 'k-f4', 'k-g', 'k-i']);

-- The general statement, first: the removal alone changed no surviving payment's contribution.
select pg_temp.req('INV', 'the removal alone changed the financial figures (effect, low, high) of NO surviving included payment: ' ||
                          coalesce((select string_agg(b.leg || ' ' || b.figures || ' -> ' || pg_temp.figures(b.leg), '; ' order by b.leg)
                                    from before_removal b where pg_temp.figures(b.leg) is distinct from b.figures), 'none changed'),
  (select bool_and(pg_temp.figures(b.leg) is not distinct from b.figures) from before_removal b));

-- A. An included payment whose surviving candidate is on an excluded card.
select pg_temp.req('A', 'one system hold on the two legs that are left: the excluded card''s leg and the payment, with the removed candidate''s date', pg_temp.holds('k-a') = 'removed_card:e-a/k-a@2026-09-11');
select pg_temp.req('A', 'the payment is NOT matched to the excluded card (which would read untracked / partner_excluded): still unresolved, a range',
  pg_temp.unresolved_range('k-a', 20000) and pg_temp.competitors('k-a') = 'e-a' and pg_temp.not_counted_unmatched('e-a'));

-- B. The audit's counterexample.
select pg_temp.req('B', 'the removal did not manufacture a match: the kept payment is NOT paired with the excluded card; it is unresolved with its range {−100, 0}, as before',
  pg_temp.unresolved_range('k-b', 10000) and pg_temp.competitors('k-b') = 'e-b');
select pg_temp.req('B', 'the excluded card leg is still evidence only, matched to nothing', pg_temp.not_counted_unmatched('e-b'));
select pg_temp.req('B', 'the ambiguity is recorded: one system hold on the two legs that are left, card leg first, of the removed-CASH kind, with the removed candidate''s date',
  (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_cash_account' and d.a_plaid_transaction_id = 'e-b' and d.a_cents = -10000 and d.a_account_id = pg_temp.e()::uuid
                                    and d.b_plaid_transaction_id = 'k-b' and d.b_cents = 10000 and d.b_account_id = pg_temp.c()::uuid
                                    and d.counterpart_date = '2026-09-10' and d.superseded_by is null and d.user_id = pg_temp.aa()
                                    and d.accepted_difference_cents is null and d.counterpart_status is null)
   from public.card_payment_decisions d where 'k-b' in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)));
select pg_temp.req('B', 'it is a system record that applies, publishes nothing and is no leg''s decision',
  pg_temp.dstatus(pg_temp.hold_id('k-b')) = 'active' and pg_temp.leg('k-b')->>'decisionId' is null and pg_temp.leg('e-b')->>'decisionId' is null);

-- C. The owner is an excluded CASH leg.
select pg_temp.req('C', 'the hold is written for a leg that is published not_counted: the kept card''s leg and the excluded payment', pg_temp.holds('kc-c') = 'removed_card:y-c/kc-c@2026-09-11');
select pg_temp.req('C', 'the kept card''s leg is NOT read as funded by the excluded payment: both are as before the removal',
  pg_temp.not_counted_unmatched('kc-c') and pg_temp.srep('y-c') = 'unresolved/ambiguous/0 partner=-');

-- D. Both candidates on excluded cards, the removed one too.
select pg_temp.req('D', 'held: an excluded candidate on the removed institution counts like any other', pg_temp.holds('k-d') = 'removed_card:e-d/k-d@2026-09-11');
select pg_temp.req('D', 'still unresolved, a range; not untracked / partner_excluded with the excluded card that is left',
  pg_temp.unresolved_range('k-d', 40000) and pg_temp.competitors('k-d') = 'e-d' and pg_temp.not_counted_unmatched('e-d'));

-- E. The mirror: the surviving cash candidate is on an excluded account.
select pg_temp.req('E', 'a hold of the removed-CASH kind on the card leg and the kept excluded cash leg', pg_temp.holds('y-e') = 'removed_cash_account:y-e/ke-e@2026-09-11');
select pg_temp.req('E', 'the card leg is NOT read as funded from the excluded account: unresolved, 0; the excluded cash leg matched to nothing',
  pg_temp.srep('y-e') = 'unresolved/ambiguous/0 partner=-' and pg_temp.not_counted_unmatched('ke-e'));

-- F. No genuine removed-versus-kept ambiguity: nothing is written, nothing changes.
select pg_temp.req('F', 'F1: an automatic match with an excluded card, no removed candidate: no decision of any kind, the same reading',
  pg_temp.decisions_on('k-f1') = 0 and pg_temp.decisions_on('e-f1') = 0 and pg_temp.srep('k-f1') = 'untracked/partner_excluded/-70000 partner=e-f1');
select pg_temp.req('F', 'F2: the automatic match STAYS; a removed excluded card that merely fitted less well leaves no hold and no record',
  pg_temp.decisions_on('k-f2') = 0 and pg_temp.decisions_on('e-f2') = 0 and pg_temp.srep('k-f2') = 'untracked/partner_excluded/-72000 partner=e-f2');
select pg_temp.req('F', 'F3: an excluded card leg with no payment at all gets nothing', pg_temp.decisions_on('e2-f3') = 0 and pg_temp.srep('e2-f3') = 'not_counted/excluded_account/0 partner=-');
select pg_temp.req('F', 'F4: a tie between two cards that were BOTH removed leaves nothing to hold: no decision; the payment has no candidate now, and no destination',
  pg_temp.decisions_on('k-f4') = 0 and pg_temp.srep('k-f4') = 'unresolved/no_candidate/null partner=-');
select pg_temp.req('F', 'in all: the removal wrote exactly the holds of cases A, B, C, D, E, G and I, and no destination record',
  (select count(*) = 7 and count(*) filter (where d.kind like 'ambiguity_hold_%') = 7 from public.card_payment_decisions d where d.user_id = pg_temp.aa()));

-- The cases that continue below are held too.
select pg_temp.req('G', 'held through the removal', pg_temp.unresolved_range('k-g', 80000) and pg_temp.holds('k-g') = 'removed_cash_account:e-g/k-g@2026-09-10');
select pg_temp.req('I', 'held through the removal, on the pending row''s own id', pg_temp.unresolved_range('k-i', 90000) and pg_temp.holds('k-i') = 'removed_cash_account:e-i/k-i@2026-09-10');

-- H. Ownership: the other user — the same amounts on the same days — is untouched, then gets their own.
select pg_temp.req('H', 'another user is untouched by this removal: no decision, the same version, the same reading',
  not exists (select 1 from public.card_payment_decisions d where d.user_id = pg_temp.bb())
  and pg_temp.iv(pg_temp.bb()) = (select iv from bb_before) and pg_temp.srep('b-k', pg_temp.bb()) = 'untracked/no_included_card/-10000 partner=-');
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select pg_temp.observe('after bb''s own removal', array['b-k', 'be-k', 'b-k2', 'be-k2'], pg_temp.bb());
select pg_temp.req('H', 'the other user''s removal holds their own ambiguity, on their own two accounts',
  (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_cash_account' and d.a_plaid_transaction_id = 'be-k' and d.b_plaid_transaction_id = 'b-k'
                                    and d.a_account_id = pg_temp.be()::uuid and d.b_account_id = pg_temp.bc()::uuid and d.counterpart_date = '2026-09-10')
   from public.card_payment_decisions d where d.user_id = pg_temp.bb() and 'b-k' in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)));
select pg_temp.req('H', 'no hold names an account of a user other than its own',
  not exists (select 1 from public.card_payment_decisions d
              join public.accounts a on a.id in (d.a_account_id, d.b_account_id) join public.plaid_items i on i.id = a.item_id
              where i.user_id <> d.user_id));
select pg_temp.call('foreign-hold',
  $q$ insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, counterpart_date)
      values ('00000000-0000-0000-0000-0000000000aa', 'ambiguity_hold_removed_cash_account', '00000000-0000-0000-0000-0000000023c3', 'be-k', -10000,
              '00000000-0000-0000-0000-0000000023b1', 'k-b', 10000, '2026-09-10') returning '{}'::jsonb $q$);
select pg_temp.req('H', 'and none can be written across users', pg_temp.called('foreign-hold') like 'refused: card_payment_decision_foreign_account%');

-- N. A payment the "no included card" rule decides: published untracked, never "unresolved" — and held all the same.
-- (Here it is the hold's other leg: the owner of the ambiguity is the excluded card leg, as in B.)
select pg_temp.req('N', 'the removal changed nothing a reader sees: the payment still counts by the no-included-card rule (−100), and is NOT paired with the excluded card that is left',
  pg_temp.srep('b-k', pg_temp.bb()) = 'untracked/no_included_card/-10000 partner=-' and pg_temp.figures('b-k', pg_temp.bb()) = (select figures from bb_before)
  and pg_temp.srep('be-k', pg_temp.bb()) = 'not_counted/excluded_account/0 partner=-');

-- N2. The OWNER of the ambiguity is a payment the "no included card" rule decides: both of its candidates are
-- excluded card legs, one on the removed institution. No published state shows that it had a tie.
select pg_temp.req('N2', 'a payment that is published untracked / no_included_card, with no candidate list, is held as the owner of its tie: one system hold on the two legs that are left, the kept excluded card''s leg first, of the removed-CARD kind, with the removed candidate''s date',
  (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_card' and d.a_plaid_transaction_id = 'be-k2' and d.a_cents = -15000 and d.a_account_id = pg_temp.be()::uuid
                                    and d.b_plaid_transaction_id = 'b-k2' and d.b_cents = 15000 and d.b_account_id = pg_temp.bc()::uuid
                                    and d.counterpart_date = '2026-09-11' and d.superseded_by is null and d.user_id = pg_temp.bb())
   from public.card_payment_decisions d where 'b-k2' in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)));
select pg_temp.req('N2', 'the removal changed nothing a reader sees: the payment still counts by the no-included-card rule (−150), names no decision, and is NOT paired with the excluded card that is left (which would read untracked / partner_excluded)',
  pg_temp.srep('b-k2', pg_temp.bb()) = 'untracked/no_included_card/-15000 partner=-' and pg_temp.figures('b-k2', pg_temp.bb()) = (select figures_k2 from bb_before)
  and pg_temp.leg('b-k2', pg_temp.bb())->>'decisionId' is null and pg_temp.not_counted_unmatched('be-k2', pg_temp.bb()));

-- ---- J. Later: nothing but the removals has happened → nothing changes -------------------------------
create temporary table after_removal as
  select p as leg, pg_temp.srep(p) || ' ' || pg_temp.figures(p) || ' ' || pg_temp.competitors(p) || ' ' || pg_temp.holds(p) as reading
  from unnest(array['k-a', 'e-a', 'k-b', 'e-b', 'kc-c', 'y-c', 'k-d', 'e-d', 'y-e', 'ke-e', 'k-f1', 'k-f2', 'k-f4', 'k-g', 'k-i']) p;
create temporary table decisions_after_removal as select count(*) as n, pg_temp.iv() as iv from public.card_payment_decisions;
select pg_temp.evaluate();
select pg_temp.evaluate();
select pg_temp.req('J', 'two further evaluations of unchanged evidence change no reading, write no decision and do not advance the input version',
  (select bool_and(a.reading = pg_temp.srep(a.leg) || ' ' || pg_temp.figures(a.leg) || ' ' || pg_temp.competitors(a.leg) || ' ' || pg_temp.holds(a.leg)) from after_removal a)
  and (select d.n = (select count(*) from public.card_payment_decisions) and d.iv = pg_temp.iv() from decisions_after_removal d));

-- ---- Later: genuinely changed evidence, and the user ---------------------------------------------------
-- C, E: the excluded checking account CE is included in cash flow again.
update public.accounts set exclude_from_cash_flow = false where id = pg_temp.ce()::uuid;
-- D: the excluded card E2 is included.
update public.accounts set exclude_from_cash_flow = false where id = pg_temp.e2()::uuid;
-- N: bb includes the card BE: now bb has an included card.
update public.accounts set exclude_from_cash_flow = false where id = pg_temp.be()::uuid;
-- I: the pending payment posts, same amount, same day (the posted row names the pending id; the pending row goes).
select pg_temp.cardleg('k-i-posted', pg_temp.c(), 900, '2026-09-10', false, 'k-i');
delete from public.transactions where plaid_transaction_id = 'k-i';
select pg_temp.evaluate();
select pg_temp.observe('after the accounts were included and the payment posted', array['kc-c', 'y-c', 'k-d', 'e-d', 'y-e', 'ke-e', 'k-i-posted']);
select pg_temp.observe('after bb included the card', array['b-k', 'be-k', 'b-k2', 'be-k2'], pg_temp.bb());

select pg_temp.req('C', 'when the excluded checking account is later INCLUDED, the payment is unresolved, a range {−300, 0} — it is NOT a tracked payment to the card the removal left as its only candidate',
  pg_temp.unresolved_range('kc-c', 30000) and pg_temp.competitors('kc-c') = 'y-c' and pg_temp.srep('y-c') = 'unresolved/ambiguous/0 partner=-');
select pg_temp.req('D', 'including the kept card changes neither leg''s match: the hold does not depend on what is included', pg_temp.unresolved_range('k-d', 40000) and pg_temp.srep('e-d') = 'unresolved/ambiguous/0 partner=-');
select pg_temp.req('E', 'the kept cash leg, now included, is unresolved, a range {−600, 0} — NOT a tracked payment', pg_temp.unresolved_range('ke-e', 60000) and pg_temp.srep('y-e') = 'unresolved/ambiguous/0 partner=-');
select pg_temp.req('I', 'the same payment posting with the same amount is not new evidence: the hold follows it', pg_temp.unresolved_range('k-i-posted', 90000) and pg_temp.dstatus(pg_temp.hold_id('k-i')) = 'active');
select pg_temp.req('N', 'when bb''s card is later INCLUDED the payment is unresolved, a range {−100, 0} — NOT tracked to the card the removal left as its only candidate',
  pg_temp.unresolved_range('b-k', 10000, pg_temp.bb()) and pg_temp.srep('be-k', pg_temp.bb()) = 'unresolved/ambiguous/0 partner=-');
select pg_temp.req('N2', 'when bb''s card is later INCLUDED the payment that owned the tie is unresolved, a range {−150, 0}, with the kept card''s leg as its one candidate — NOT tracked to it',
  pg_temp.unresolved_range('b-k2', 15000, pg_temp.bb()) and pg_temp.competitors('b-k2', pg_temp.bb()) = 'be-k2' and pg_temp.srep('be-k2', pg_temp.bb()) = 'unresolved/ambiguous/0 partner=-');

-- ---- G. An explicit user decision wins over the system hold --------------------------------------------
select pg_temp.call('link', format('select public.link_card_payment(%L, %L, %L, 0, %s)', pg_temp.aa(), pg_temp.tid('k-g'), pg_temp.tid('e-g'), pg_temp.iv()));
select pg_temp.req('G', 'the user confirms the excluded card: saved, and it decides the payment (the destination is outside the tracked set: −800)',
  pg_temp.called('link') = 'saved' and pg_temp.srep('k-g') = 'untracked/partner_excluded/-80000 partner=e-g' and pg_temp.holder_kind('k-g') = 'pair');
select pg_temp.req('G', 'the hold neither blocked the confirmation nor conflicts with it, and is left in place',
  (select pg_temp.dstatus(d.id) = 'active' from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-g')
  and pg_temp.holds('k-g') = 'removed_cash_account:e-g/k-g@2026-09-10');
select pg_temp.call('undo-own', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(),
  (select d.id from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-g'), pg_temp.iv()));
select pg_temp.req('G', 'when the user undoes their own confirmation, the pair is withheld again, as before they decided', pg_temp.called('undo-own') = 'undone' and pg_temp.unresolved_range('k-g', 80000));
select pg_temp.call('undo-hold', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(), pg_temp.hold_id('k-g'), pg_temp.iv()));
select pg_temp.req('G', 'the hold itself is not the user''s to undo', pg_temp.called('undo-hold') like 'refused: card_payment_invalid: undo_card_payment_decision: system_decision%');
select pg_temp.call('mark', format('select public.mark_card_payment_destination(%L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-g'), pg_temp.iv()));
select pg_temp.req('G', '"a card I haven''t linked" decides too', pg_temp.called('mark') = 'saved' and pg_temp.srep('k-g') = 'untracked/user_confirmed_unlinked/-80000 partner=-');
select pg_temp.observe('at the end', array['k-a', 'k-b', 'kc-c', 'k-d', 'ke-e', 'k-g', 'k-i-posted']);

-- ---- The verdict ------------------------------------------------------------------------------------
\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only on
select 'OBSERVED', moment, leg, what from observed order by seq;
select 'OBSERVED', 'ambiguity holds at the end', d.kind, d.a_plaid_transaction_id || ' / ' || d.b_plaid_transaction_id || ' @ ' || d.counterpart_date
       || case when d.superseded_by is null then '' else ' (superseded)' end
from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' order by d.user_id, d.b_plaid_transaction_id collate "C", d.a_plaid_transaction_id collate "C", d.counterpart_date;
select 'CONTRACT ' || case when ok then 'ok      ' else 'VIOLATED' end, kase, requirement from contract order by seq;
select 'CONTRACT SUMMARY', count(*) filter (where ok) || ' of ' || count(*) || ' requirements hold',
       coalesce('violated in: ' || string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none violated') from contract;
select th.assert((select bool_and(ok) from contract),
  'institution removal is not evidence where an excluded account is involved either: an ambiguity in the complete matching pool is held; violated in: '
  || (select coalesce(string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none') || ' (' || count(*) filter (where not ok) || ' of ' || count(*) || ' requirements)' from contract));

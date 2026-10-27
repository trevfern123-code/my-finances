-- Institution removal: PASSIVE invalidation versus a NEWER EXPLICIT USER ACTION (Phase B I3A; Trevor's
-- decisions of 2026-10-06; 20261006110000 and 20261006120000).
--
--   * A user confirmation that data or the lifecycle made inactive (a row re-classified by the classifier, a
--     row the bank withdrew) is PRESERVED through the removal, reserved and unresolved. (Waiting to post,
--     amount changes and conflicting lineage are in a20_lim_removal_user_confirmations.sql.)
--   * A confirmation the USER has since superseded is NOT carried forward and holds nothing afterwards:
--     undone; replaced by another decision; or a leg re-classified by the user away from card payment.
--   * After the removal a preserved decision is the user's to supersede: undo, a new match, or "a card I
--     haven't linked" each release or replace it. Nothing else does.
--   * The "no included card" rule can establish an effect on its own; it does not revive a confirmation.
--   * A leg that was unresolved gets NO destination: removal is not evidence. Nor does it become resolved
--     because one of its candidates was deleted: a tie between the removed card and a kept one stays a tie
--     (the system ambiguity hold; its own test is a22_lim_removal_ambiguity_hold.sql).
--
-- User aa. Item 1 "Card Bank" (card X) is REMOVED. Item 3 "Kept Bank" survives: checking C and card Y. Every
-- case has a competing leg on Y: the opposite amount, two days after the cash leg (X is one day after).
--
--   E-undo       k-eu +410   confirmed, then UNDONE by the user (so: an ordinary automatic match to X again)
--   E-replaced   k-er +420   confirmed, then replaced by "a card I haven't linked"
--   E-role-card  k-rc +430   confirmed, then the USER re-classified the card leg as an expense
--   E-role-cash  k-rk +440   confirmed, then the USER re-classified the cash leg as an expense
--   P-role       k-pr +450   confirmed, then the CLASSIFIER re-classified the card leg (no user override)
--   P-gone       k-pg +460   confirmed, then the bank withdrew the card leg (no carry-over)
--   V1, V2, V3   +470, +480, +490   confirmed and valid: undone / re-matched / marked unlinked AFTER the removal
--   T            k-t  +700   never confirmed: a tie between X and Y
-- User bb. Item 2 (card BX) is REMOVED; item 5 survives with a checking account only — no card is left.
--   b-k  +400 confirmed with b-x −400, which the bank then changed to −399
--   b-k2 +300 confirmed with b-x2 −300, valid
--   b-open +50, never confirmed (a possible match 20 days away)
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.states(p_user uuid default pg_temp.aa()) returns jsonb language sql as $$ select public.get_card_payment_states(p_user) $$;
create function pg_temp.iv(p_user uuid default pg_temp.aa()) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- A leg's state. Raises when the states are not fresh, so no assertion can pass on a stale read.
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
create function pg_temp.dstatus(p_decision uuid, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (d->>'status') || coalesce('/' || (d->>'detail'), '')
  from jsonb_array_elements(pg_temp.states(p_user)->'decisions') d where (d->>'decisionId')::uuid = p_decision $$;
-- The live preserved user decision on a surviving leg, and the live user decision (of any user kind) that holds a leg.
create function pg_temp.preserved(p_plaid text) returns public.card_payment_decisions language sql as $$
  select d.* from public.card_payment_decisions d
  where d.kind = 'pair_counterpart_removed' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid $$;
create function pg_temp.holder_kind(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid and d.superseded_by is null), 'none')
  from pg_temp.leg(p_plaid, p_user) l $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, user_role_override)
  values (p_account::uuid, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, false, 'credit_card_payment') $$;
create function pg_temp.link(p_cash text, p_card text, p_user uuid default pg_temp.aa()) returns void language plpgsql as $$
begin
  perform th.assert(public.link_card_payment(p_user, pg_temp.tid(p_cash), pg_temp.tid(p_card), 0, pg_temp.iv(p_user))->>'status' = 'saved',
    'fixture: the user confirms ' || p_cash || ' with ' || p_card);
end $$;
create function pg_temp.pair_of(p_cash_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = p_cash_plaid $$;
create function pg_temp.remove(p_user uuid, p_item uuid) returns void language plpgsql as $$
begin
  perform th.assert(public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item))->>'outcome' = 'started', 'removal begins');
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
  perform th.assert((public.remove_plaid_item_local(p_user, p_item)->>'replayed')::boolean = false, 'the removal runs');
end $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'BB Kept Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000021a1', '00000000-0000-0000-0000-000000000001', 'a21-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-0000000021b1', '00000000-0000-0000-0000-000000000003', 'a21-c', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000021b3', '00000000-0000-0000-0000-000000000003', 'a21-y', 'Kept Card Y', 'credit'),
  ('00000000-0000-0000-0000-0000000021c2', '00000000-0000-0000-0000-000000000002', 'a21-bx', 'BB Card', 'credit'),
  ('00000000-0000-0000-0000-0000000021c1', '00000000-0000-0000-0000-000000000005', 'a21-bc', 'BB Checking', 'depository');
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000021a1' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000021b1' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000021b3' $$;
create function pg_temp.bx() returns text language sql as $$ select '00000000-0000-0000-0000-0000000021c2' $$;
create function pg_temp.bc() returns text language sql as $$ select '00000000-0000-0000-0000-0000000021c1' $$;

-- aa: the cash leg on C, the card leg on X one day later, the competitor on Y two days later.
select pg_temp.cardleg('k-' || s, pg_temp.c(), amt, '2026-09-01'), pg_temp.cardleg('x-' || s, pg_temp.x(), -amt, '2026-09-02'),
       pg_temp.cardleg('y-' || s, pg_temp.y(), -amt, '2026-09-03')
from (values ('eu', 410), ('er', 420), ('rc', 430), ('rk', 440), ('pg', 460), ('v1', 470), ('v2', 480), ('v3', 490)) v(s, amt);
-- P-role: the card leg is a card payment by the CLASSIFIER (auto_role), with no user override.
select pg_temp.cardleg('k-pr', pg_temp.c(), 450, '2026-09-01'), pg_temp.cardleg('y-pr', pg_temp.y(), -450, '2026-09-03');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, auto_role, role_source, role_confidence, classifier_version)
values (pg_temp.x()::uuid, 'x-pr', -450, '2026-09-02', 'Leg x-pr', false, 'credit_card_payment', 'category_detailed', 'high', 1);
-- T: a tie between the two cards; never confirmed.
select pg_temp.cardleg('k-t', pg_temp.c(), 700, '2026-09-10'), pg_temp.cardleg('x-t', pg_temp.x(), -700, '2026-09-11'), pg_temp.cardleg('y-t', pg_temp.y(), -700, '2026-09-11');
-- bb.
select pg_temp.cardleg('b-k', pg_temp.bc(), 400, '2026-09-01'), pg_temp.cardleg('b-x', pg_temp.bx(), -400, '2026-09-02'),
       pg_temp.cardleg('b-k2', pg_temp.bc(), 300, '2026-09-05'), pg_temp.cardleg('b-x2', pg_temp.bx(), -300, '2026-09-06'),
       pg_temp.cardleg('b-open', pg_temp.bc(), 50, '2026-09-01'), pg_temp.cardleg('b-xo', pg_temp.bx(), -50, '2026-09-21');
select public.evaluate_card_payments(pg_temp.aa()), public.evaluate_card_payments(pg_temp.bb());

-- The confirmations, through the real RPC.
select pg_temp.link('k-' || s, 'x-' || s) from unnest(array['eu', 'er', 'rc', 'rk', 'pr', 'pg', 'v1', 'v2', 'v3']) s;
select pg_temp.link('b-k', 'b-x', pg_temp.bb()), pg_temp.link('b-k2', 'b-x2', pg_temp.bb());
create temporary table pairs as select s, pg_temp.pair_of('k-' || s) as id from unnest(array['eu', 'er', 'rc', 'rk', 'pr', 'pg', 'v1', 'v2', 'v3']) s;
select th.assert((select count(id) = 9 from pairs), 'fixture: nine confirmed pairs');

-- NEWER EXPLICIT USER ACTIONS, before the removal.
select th.assert(public.undo_card_payment_decision(pg_temp.aa(), (select id from pairs where s = 'eu'), pg_temp.iv())->>'status' = 'undone', 'E-undo: the user undoes the confirmation');
select th.assert(public.mark_card_payment_destination(pg_temp.aa(), pg_temp.tid('k-er'), pg_temp.iv())->>'status' = 'saved', 'E-replaced: the user says it went to a card that is not linked');
update public.transactions set user_role_override = 'expense' where plaid_transaction_id = 'x-rc';   -- E-role-card (the role endpoint, later)
update public.transactions set user_role_override = 'expense' where plaid_transaction_id = 'k-rk';   -- E-role-cash
-- PASSIVE changes, before the removal.
update public.transactions set auto_role = 'expense', role_source = 'sign_default', role_confidence = 'low' where plaid_transaction_id = 'x-pr';   -- P-role
delete from public.transactions where plaid_transaction_id = 'x-pg';                                                                              -- P-gone
update public.transactions set amount = -399 where plaid_transaction_id = 'b-x';                                                                  -- bb
select public.evaluate_card_payments(pg_temp.aa()), public.evaluate_card_payments(pg_temp.bb());

-- Before the removal (what holds today; the fixture, not the subject).
select th.assert(pg_temp.srep('k-eu') = 'tracked/auto_pair/0 partner=x-eu' and pg_temp.holder_kind('k-eu') = 'none', 'before: E-undo is an ordinary automatic pair again');
select th.assert(pg_temp.srep('k-er') = 'untracked/user_confirmed_unlinked/-42000 partner=-', 'before: E-replaced is held by the newer "unlinked" decision');
select th.assert(pg_temp.srep('k-rc') = 'unresolved/decision_invalidated/null partner=-' and pg_temp.dstatus((select id from pairs where s = 'rc')) = 'inactive/role_changed',
  'before: E-role-card is inactive (role_changed)');
select th.assert(pg_temp.leg('k-rk') is null and pg_temp.dstatus((select id from pairs where s = 'rk')) = 'inactive/role_changed', 'before: E-role-cash: the cash row is no longer a card payment at all');
select th.assert(pg_temp.srep('k-pr') = 'unresolved/decision_invalidated/null partner=-' and pg_temp.dstatus((select id from pairs where s = 'pr')) = 'inactive/role_changed',
  'before: P-role is inactive (role_changed) and still holds its cash leg');
select th.assert(pg_temp.srep('k-pg') = 'unresolved/decision_invalidated/null partner=-' and pg_temp.dstatus((select id from pairs where s = 'pg')) = 'inactive/partner_gone',
  'before: P-gone is inactive (partner_gone) and still holds its cash leg');
select th.assert((select bool_and(pg_temp.srep('k-' || s) = 'tracked/user_pair/0 partner=x-' || s) from unnest(array['v1', 'v2', 'v3']) s), 'before: V1–V3 are active user pairs');
select th.assert(pg_temp.srep('k-t') = 'unresolved/ambiguous/null partner=-' and pg_temp.holder_kind('k-t') = 'none', 'before: T is a tie, unresolved, with no decision');
select th.assert(pg_temp.srep('b-k', pg_temp.bb()) = 'unresolved/decision_invalidated/null partner=-' and pg_temp.srep('b-k2', pg_temp.bb()) = 'tracked/user_pair/0 partner=b-x2'
                 and pg_temp.srep('b-open', pg_temp.bb()) = 'unresolved/possible_match/null partner=-', 'before: bb''s three payments');

-- ---- The removals ------------------------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000001');
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');

-- 1. Exactly the confirmations that were still the user's standing word were preserved.
select th.assert((select jsonb_object_agg(d.a_plaid_transaction_id, d.counterpart_status)
                  from public.card_payment_decisions d where d.user_id = pg_temp.aa() and d.kind = 'pair_counterpart_removed')
                 = '{"k-pr": "role_changed", "k-pg": "partner_gone", "k-v1": "valid", "k-v2": "valid", "k-v3": "valid"}'::jsonb,
  'aa: preserved — the two passively invalidated confirmations (each with the removed side''s reason) and the three valid ones; NOT the undone, the replaced, or the two the user re-classified a leg of');

-- 2. A NEWER EXPLICIT USER ACTION wins: nothing is carried forward, nothing is held.
-- E-undo. The undone confirmation is not resurrected: no USER decision is carried forward, and nothing holds the
-- leg at user strength. What the payment was when the card was removed is an ordinary AUTOMATIC match to X, and
-- Y's leg — two days away, one day farther than X's — was already there. Trevor's decision of 2026-10-06
-- ("Option B"): the removal is not evidence for Y. The payment keeps its known removed destination (the SYSTEM
-- record, untracked, −410) and is NOT switched to the card that is left. (Until revision 5 this file pinned the
-- opposite — tracked / auto_pair with y-eu — which is exactly the behaviour that decision forbids.
-- a25_lim_removal_automatic_destination.sql is that contract's own test.)
select th.assert(pg_temp.srep('k-eu') = 'untracked/removed_card/-41000 partner=-' and pg_temp.holder_kind('k-eu') = 'destination_removed_card'
                 and not exists (select 1 from public.card_payment_decisions d
                                 where d.a_plaid_transaction_id = 'k-eu' and d.superseded_by is null and d.kind in ('pair', 'pair_counterpart_removed', 'destination_unlinked')),
  'E-undo: the undone confirmation is not resurrected (no user decision is left on the payment); it was an automatic match to the removed card, so it keeps that known destination — a system record, not a reservation');
select th.assert(pg_temp.srep('y-eu') = 'unresolved/ambiguous/0 partner=-'
                 and (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_card' and d.a_plaid_transaction_id = 'y-eu' and d.counterpart_date = '2026-09-02')
                      from public.card_payment_decisions d where d.b_plaid_transaction_id = 'k-eu' and d.superseded_by is null),
  'E-undo: the payment is not switched to the card that was already there — Y''s leg is unmatched, held off by one system hold on that pair with the removed destination''s date');
select th.assert(pg_temp.srep('k-er') = 'untracked/user_confirmed_unlinked/-42000 partner=-' and pg_temp.holder_kind('k-er') = 'destination_unlinked',
  'E-replaced: the user''s newer decision stands, untouched by the removal');
select th.assert(pg_temp.srep('k-rc') = 'tracked/auto_pair/0 partner=y-rc' and pg_temp.holder_kind('k-rc') = 'none',
  'E-role-card: the user said the card leg was not a card payment; the old confirmation holds nothing after the removal');
select th.assert(pg_temp.leg('k-rk') is null
                 and not exists (select 1 from public.card_payment_decisions d where d.superseded_by is null and d.a_plaid_transaction_id = 'k-rk'),
  'E-role-cash: the row the user re-classified is not a card payment, and no decision is left on it to come back');

-- 3. PASSIVE invalidation: preserved, reserved, unresolved.
select th.assert(pg_temp.srep('k-pr') = 'unresolved/decision_invalidated/null partner=-' and pg_temp.leg('k-pr')->>'detail' = 'role_changed'
                 and pg_temp.holder_kind('k-pr') = 'pair_counterpart_removed' and pg_temp.srep('y-pr') like 'unresolved/%partner=-',
  'P-role: a confirmation the classifier invalidated is preserved; its cash leg is reserved and unresolved, and the competitor is not paired');
select th.assert(pg_temp.srep('k-pg') = 'unresolved/decision_invalidated/null partner=-' and pg_temp.leg('k-pg')->>'detail' = 'partner_gone'
                 and pg_temp.holder_kind('k-pg') = 'pair_counterpart_removed' and pg_temp.srep('y-pg') like 'unresolved/%partner=-',
  'P-gone: a confirmation whose card leg the bank withdrew is preserved; its cash leg is reserved and unresolved, and the competitor is not paired');
select th.assert((select bool_and(pg_temp.srep('k-' || s) = 'untracked/removed_card/-' || amt || '00 partner=-' and pg_temp.holder_kind('k-' || s) = 'pair_counterpart_removed'
                                  and pg_temp.srep('y-' || s) like 'unresolved/%partner=-')
                  from (values ('v1', 470), ('v2', 480), ('v3', 490)) v(s, amt)),
  'V1–V3: valid confirmations count as removed-card payments, held by the user''s decision; no competitor is paired');

-- 4. bb has no card left. "No included card" establishes effects by itself; it revives nothing.
select th.assert((select jsonb_object_agg(d.a_plaid_transaction_id, d.counterpart_status)
                  from public.card_payment_decisions d where d.user_id = pg_temp.bb() and d.kind = 'pair_counterpart_removed')
                 = '{"b-k": "amount_changed", "b-k2": "valid"}'::jsonb, 'bb: both confirmations preserved');
select th.assert(pg_temp.srep('b-k', pg_temp.bb()) = 'untracked/no_included_card/-40000 partner=-' and pg_temp.leg('b-k', pg_temp.bb())->>'detail' = 'amount_changed'
                 and pg_temp.dstatus((pg_temp.leg('b-k', pg_temp.bb())->>'decisionId')::uuid, pg_temp.bb()) = 'inactive/amount_changed',
  'bb: the amount-invalidated confirmation stays INACTIVE; the payment counts because no card is left at all (no_included_card), not because of it');
select th.assert(pg_temp.srep('b-k2', pg_temp.bb()) = 'untracked/removed_card/-30000 partner=-' and pg_temp.holder_kind('b-k2', pg_temp.bb()) = 'pair_counterpart_removed',
  'bb: the valid confirmation decides its leg (a user decision comes before the no-included-card rule)');
select th.assert(pg_temp.srep('b-open', pg_temp.bb()) = 'untracked/no_included_card/-5000 partner=-' and pg_temp.holder_kind('b-open', pg_temp.bb()) = 'none'
                 and not exists (select 1 from public.card_payment_decisions d where d.a_plaid_transaction_id = 'b-open'),
  'bb: the never-confirmed payment got NO record; it counts by current evidence alone — the user has no included card');

-- 5. A leg that was unresolved. Removal is not evidence: it gets no destination. And deleting one of its two
-- candidates is not evidence for the other one either (Trevor's decision of 2026-10-06): the tie between X and Y
-- is kept as a SYSTEM ambiguity hold on the two legs that are left, and the payment stays unresolved — it is
-- NOT matched to Y's leg merely because X's is gone. (a22_lim_removal_ambiguity_hold.sql is that contract's
-- own test; this is the case this file pinned the other way before the decision.)
select th.assert(pg_temp.srep('k-t') = 'unresolved/ambiguous/null partner=-' and pg_temp.holder_kind('k-t') = 'none'
                 and pg_temp.srep('y-t') = 'unresolved/ambiguous/0 partner=-',
  'T: the tie the removal must not resolve is still a tie — the payment is unresolved, not matched to the card that is left, and no decision is attached to it');
select th.assert(not exists (select 1 from public.card_payment_decisions d where d.a_plaid_transaction_id = 'k-t')
                 and (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_card' and d.a_plaid_transaction_id = 'y-t'
                                                       and d.counterpart_date = '2026-09-11' and d.superseded_by is null)
                      from public.card_payment_decisions d where d.b_plaid_transaction_id = 'k-t'),
  'T: the removal wrote no destination for the unresolved payment, and one system hold on the pair of the two legs that are left');

-- ---- After the removal: a preserved decision is the user's to supersede --------------------------------
create temporary table kept as
  select s, (pg_temp.preserved('k-' || s)).id as id from unnest(array['v1', 'v2', 'v3', 'pr']) s;
-- Undo releases the leg.
select th.assert(public.undo_card_payment_decision(pg_temp.aa(), (select id from kept where s = 'v1'), pg_temp.iv())->>'status' = 'undone', 'V1: the user undoes the preserved decision');
select th.assert((select superseded_by = id from public.card_payment_decisions where id = (select id from kept where s = 'v1'))
                 and pg_temp.srep('k-v1') = 'tracked/auto_pair/0 partner=y-v1' and pg_temp.holder_kind('k-v1') = 'none',
  'V1: undone (kept as history, superseded by itself); the leg is released and now matches automatically');
-- A new match supersedes it.
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-v2'), pg_temp.tid('y-v2'), 0, pg_temp.iv())->>'status' = 'saved', 'V2: the user matches the payment with the other card');
select th.assert((select superseded_by = pg_temp.pair_of('k-v2') from public.card_payment_decisions where id = (select id from kept where s = 'v2'))
                 and pg_temp.srep('k-v2') = 'tracked/user_pair/0 partner=y-v2',
  'V2: the newer match supersedes the preserved decision and decides the leg');
-- "A card I haven't linked" supersedes it.
select th.assert(public.mark_card_payment_destination(pg_temp.aa(), pg_temp.tid('k-v3'), pg_temp.iv())->>'status' = 'saved', 'V3: the user says it went to a card that is not linked');
select th.assert((select superseded_by is not null and superseded_by <> id from public.card_payment_decisions where id = (select id from kept where s = 'v3'))
                 and pg_temp.srep('k-v3') = 'untracked/user_confirmed_unlinked/-49000 partner=-' and pg_temp.holder_kind('k-v3') = 'destination_unlinked',
  'V3: the newer decision supersedes the preserved one');
-- A leg a preserved decision holds cannot be taken as someone else's counterpart until that decision is undone.
select th.expect_error(format($q$ select public.link_card_payment(%L, %L, %L, 0, %s) $q$, pg_temp.aa(), pg_temp.tid('y-pr'), pg_temp.tid('k-pr'), pg_temp.iv()),
  '%card_payment_counterpart_reserved%');
select th.assert((select superseded_by is null from public.card_payment_decisions where id = (select id from kept where s = 'pr'))
                 and pg_temp.srep('k-pr') = 'unresolved/decision_invalidated/null partner=-',
  'P-role: the refused attempt changed nothing; the preserved decision still holds its leg');
select th.assert((select count(*) from public.card_payment_decisions where kind = 'pair_counterpart_removed' and user_id = pg_temp.aa()) = 5,
  'nothing was deleted: every preserved decision is still there, live or superseded');

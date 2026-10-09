-- Institution removal and EXPLICIT user confirmations (Phase B I3A; Trevor's decision of 2026-10-06 on the
-- independent review's finding I3A-2). The approved product contract:
--
--   A permanent institution removal must not erase explicit user-confirmed destination evidence merely
--   because the confirmation is temporarily inactive, and must not release the surviving cash leg for
--   automatic reuse by another card solely because the destination account is being deleted.
--     * waiting to post, lineage unambiguous, amount not invalidated: the confirmation is preserved, stays
--       stronger than automatic matching, and once the surviving lineage is determinable the removed
--       destination gives the removed-card effect;
--     * amount changed: the decision and its reservation are preserved, the old amount is NOT proof, the leg
--       stays unresolved — and a removal (or a relink) never makes the confirmation valid again;
--     * conflicting replacement lineage: preserved and reserved, unresolved, no replacement chosen, no
--       removed-card effect.
--
-- EVERY case below has a COMPETING QUALIFYING CARD: a leg on the kept card Y with exactly the opposite
-- amount within five days, which pairs automatically (tier 1) with the cash leg the moment that leg is free.
--
-- This file was written BEFORE the behaviour existed, as the statement of the contract, and failed against the
-- candidate of that time (30 of its then 31 requirements; the run is kept in the review evidence). The first
-- seven cases are unchanged since. The checks are written against what a reader observes, plus one assumption
-- about the representation: the preserved evidence is a live decision of the user, keyed on the surviving
-- leg's lineage (a_account_id, a_plaid_transaction_id), whose kind is not the non-reserving system kind
-- destination_removed_card. (It is pair_counterpart_removed, 20261006110000.)
--
-- User aa. Item 1 "Card Bank" (card X, and a checking account R) is REMOVED. Item 3 "Kept Bank" survives:
-- checking C and card Y.
--
--   case     cash leg on C         confirmed with X    then, before the removal                 competitor on Y
--   W-card   k-wc  +210            x-wc  −210 pending  a sync removes the pending card row      y-wc −210
--   W-cash   k-wk  +215 pending    x-wk  −215          a sync removes the pending cash row      y-wk −215
--   A-card   k-ac  +220            x-ac  −220          the bank changes the CARD leg to −219    y-ac −220
--   A-cash   k-ak  +230            x-ak  −230          the bank changes the CASH leg to +231    y-ak −231
--   L-card   k-lc  +240            x-lc  −240 pending  two posted card rows name x-lc           y-lc −240
--   L-cash   k-lk  +260 pending    x-lk  −260          two posted cash rows name k-lk           y-lk −260
--   U-tie    k-ut  +500            x-ut  −500          nothing: the confirmation is ACTIVE; the user chose X over
--                                                      the equally close y-ut −500
-- U-tie is the ACTIVE confirmation: it must be preserved at user strength too, not downgraded to the
-- non-reserving system record (which the competitor's tier 1 pair would outrank).
--
-- THE MIRROR CASE: the CASH account (R) is on the removed institution and the CARD leg, on the kept card Y,
-- survives. The competitor is another cash leg, on the kept checking C, that pairs automatically with that
-- card leg the moment it is free — and would then wrongly read as a tracked payment.
--
--   case      cash leg on R (removed)   confirmed with Y   then, before the removal            competitor on C
--   M-active  r-ma +300                 y-ma −300          nothing: the confirmation is active  k-ma +300
--   M-amount  r-mc +310                 y-mc −310          the bank changes r-mc to +311        k-mc +310
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.item1() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.states() returns jsonb language sql as $$ select public.get_card_payment_states(pg_temp.aa()) $$;
create function pg_temp.iv() returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = pg_temp.aa() $$;
create function pg_temp.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- A leg's state. Raises when the states are not fresh, so no assertion can pass on a stale read.
create function pg_temp.leg(p_plaid text) returns jsonb language plpgsql as $$
declare
  v jsonb := pg_temp.states();
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  return (select l from jsonb_array_elements(v->'legs') l where (l->>'transactionId')::uuid = pg_temp.tid(p_plaid));
end $$;
create function pg_temp.sre(p_plaid text) returns text language sql as $$
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') from pg_temp.leg(p_plaid) l $$;
create function pg_temp.dstatus(p_decision uuid) returns text language sql as $$
  select (d->>'status') || coalesce('/' || (d->>'detail'), '')
  from jsonb_array_elements(pg_temp.states()->'decisions') d where (d->>'decisionId')::uuid = p_decision $$;
create function pg_temp.pair_of(p_cash_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = p_cash_plaid $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending boolean default false,
                                p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, pending_transaction_id, user_role_override)
  values (p_account::uuid, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, p_pending_of, 'credit_card_payment') $$;
-- One sync-shaped insert object (the batch RPC's own input format).
create function pg_temp.syncrow(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending_of text) returns jsonb language sql as $$
  select jsonb_build_object('plaid_transaction_id', p_plaid, 'account_id', p_account::uuid, 'amount', p_amount,
    'iso_currency_code', 'USD', 'date', p_date, 'name', 'Synthetic', 'merchant_name', null, 'category', null,
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null,
    'pending', false, 'needs_review', false, 'budget_category_id', null, 'auto_role', 'credit_card_payment',
    'role_source', 'category_detailed', 'role_confidence', 'high', 'classifier_version', 1, 'pending_transaction_id', p_pending_of) $$;
create function pg_temp.link(p_cash text, p_card text) returns void language plpgsql as $$
begin
  perform th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid(p_cash), pg_temp.tid(p_card), 0, pg_temp.iv())->>'status' = 'saved',
    'fixture: the user confirms ' || p_cash || ' with ' || p_card);
end $$;

-- ---- The contract's checks: recorded, all printed, asserted together at the end -----------------------
create temporary table contract (seq integer generated always as identity, kase text not null, requirement text not null, ok boolean not null);
create function pg_temp.req(p_case text, p_requirement text, p_ok boolean) returns void language sql as $$
  insert into pg_temp.contract (kase, requirement, ok) values (p_case, p_requirement, coalesce(p_ok, false)) $$;
-- The explicit user evidence on a cash lineage: a live decision of the user that is not the system record.
create function pg_temp.user_evidence(p_cash_plaid text) returns boolean language sql as $$
  select exists (select 1 from public.card_payment_decisions d
                 where d.user_id = pg_temp.aa() and d.superseded_by is null and d.kind <> 'destination_removed_card'
                   and d.a_plaid_transaction_id = p_cash_plaid) $$;
-- The leg is held by that evidence: its state names a live user decision (not the system record).
create function pg_temp.held_by_user(p_plaid text) returns boolean language sql as $$
  select coalesce(exists (select 1 from public.card_payment_decisions d
                          where d.id = (l->>'decisionId')::uuid and d.user_id = pg_temp.aa() and d.superseded_by is null
                            and d.kind <> 'destination_removed_card'), false)
  from pg_temp.leg(p_plaid) l $$;
create function pg_temp.unpaired(p_plaid text) returns boolean language sql as $$
  select coalesce(l->>'partnerTransactionId' is null and l->>'reason' <> 'auto_pair', false) from pg_temp.leg(p_plaid) l $$;
-- What was observed, for the transcript: state/reason/effect, the partner's Plaid id and the decision's kind.
create temporary table observed (seq integer generated always as identity, moment text not null, leg text not null, what text not null);
create function pg_temp.observe(p_moment text, p_legs text[]) returns void language sql as $$
  insert into pg_temp.observed (moment, leg, what)
  select p_moment, p,
         coalesce((select pg_temp.sre(p) || '  partner=' || coalesce((select t.plaid_transaction_id from public.transactions t
                                                                      where t.id = (l->>'partnerTransactionId')::uuid), '-')
                          || '  decision=' || coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid), '-')
                   from pg_temp.leg(p) l), '(no current leg)')
  from unnest(p_legs) with ordinality as u(p, n) order by n $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
update public.plaid_items set institution_name = 'Card Bank' where id = pg_temp.item1();
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000020a1', '00000000-0000-0000-0000-000000000001', 'a20-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-0000000020a2', '00000000-0000-0000-0000-000000000001', 'a20-r', 'Removed Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000020b1', '00000000-0000-0000-0000-000000000003', 'a20-c', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000020b3', '00000000-0000-0000-0000-000000000003', 'a20-y', 'Kept Card Y', 'credit');
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000020a1' $$;
create function pg_temp.r() returns text language sql as $$ select '00000000-0000-0000-0000-0000000020a2' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000020b1' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000020b3' $$;

-- Every cash leg, the card leg on X one day later, and the competitor on Y two days later (U-tie: one day
-- later too, so the two cards tie).
select pg_temp.cardleg('k-wc', pg_temp.c(), 210, '2026-09-01'),       pg_temp.cardleg('x-wc', pg_temp.x(), -210, '2026-09-02', true), pg_temp.cardleg('y-wc', pg_temp.y(), -210, '2026-09-03');
select pg_temp.cardleg('k-wk', pg_temp.c(), 215, '2026-09-05', true), pg_temp.cardleg('x-wk', pg_temp.x(), -215, '2026-09-06'),       pg_temp.cardleg('y-wk', pg_temp.y(), -215, '2026-09-07');
select pg_temp.cardleg('k-ac', pg_temp.c(), 220, '2026-09-09'),       pg_temp.cardleg('x-ac', pg_temp.x(), -220, '2026-09-10'),       pg_temp.cardleg('y-ac', pg_temp.y(), -220, '2026-09-11');
select pg_temp.cardleg('k-ak', pg_temp.c(), 230, '2026-09-13'),       pg_temp.cardleg('x-ak', pg_temp.x(), -230, '2026-09-14'),       pg_temp.cardleg('y-ak', pg_temp.y(), -231, '2026-09-15');
select pg_temp.cardleg('k-lc', pg_temp.c(), 240, '2026-09-17'),       pg_temp.cardleg('x-lc', pg_temp.x(), -240, '2026-09-18', true), pg_temp.cardleg('y-lc', pg_temp.y(), -240, '2026-09-19');
select pg_temp.cardleg('k-lk', pg_temp.c(), 260, '2026-09-21', true), pg_temp.cardleg('x-lk', pg_temp.x(), -260, '2026-09-22'),       pg_temp.cardleg('y-lk', pg_temp.y(), -260, '2026-09-23');
select pg_temp.cardleg('k-ut', pg_temp.c(), 500, '2026-09-25'),       pg_temp.cardleg('x-ut', pg_temp.x(), -500, '2026-09-26'),       pg_temp.cardleg('y-ut', pg_temp.y(), -500, '2026-09-26');
-- The mirror cases: the cash leg on the removed checking R, the card leg on Y one day later, and the
-- competing cash leg on the kept checking C two days after that.
select pg_temp.cardleg('r-ma', pg_temp.r(), 300, '2026-10-01'),       pg_temp.cardleg('y-ma', pg_temp.y(), -300, '2026-10-02'),       pg_temp.cardleg('k-ma', pg_temp.c(), 300, '2026-10-04');
select pg_temp.cardleg('r-mc', pg_temp.r(), 310, '2026-10-08'),       pg_temp.cardleg('y-mc', pg_temp.y(), -310, '2026-10-09'),       pg_temp.cardleg('k-mc', pg_temp.c(), 310, '2026-10-11');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.sre('k-ut') = 'unresolved/ambiguous/null', 'fixture: U-tie is a tie between the two cards before the user decides');

-- The user's explicit confirmations, through the real RPC.
select pg_temp.link('k-wc', 'x-wc'), pg_temp.link('k-wk', 'x-wk'), pg_temp.link('k-ac', 'x-ac'), pg_temp.link('k-ak', 'x-ak'),
       pg_temp.link('k-lc', 'x-lc'), pg_temp.link('k-lk', 'x-lk'), pg_temp.link('k-ut', 'x-ut'),
       pg_temp.link('r-ma', 'y-ma'), pg_temp.link('r-mc', 'y-mc');
select th.assert((select bool_and(pg_temp.sre(p) = 'tracked/user_pair/0') from unnest(array['k-wc', 'k-wk', 'k-ac', 'k-ak', 'k-lc', 'k-lk', 'k-ut', 'r-ma', 'r-mc']) p),
  'fixture: nine confirmed pairs, all active');
create temporary table pairs as
  select p as cash, pg_temp.pair_of(p) as id from unnest(array['k-wc', 'k-wk', 'k-ac', 'k-ak', 'k-lc', 'k-lk', 'k-ut', 'r-ma', 'r-mc']) p;
select th.assert((select count(*) = 9 and count(id) = 9 from pairs), 'fixture: one live pair decision per case');

-- What happens between the confirmation and the removal.
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['x-wc']);   -- W-card
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['k-wk']);   -- W-cash
update public.transactions set amount = -219 where plaid_transaction_id = 'x-ac';                          -- A-card
update public.transactions set amount = 231 where plaid_transaction_id = 'k-ak';                           -- A-cash
select pg_temp.cardleg('x-lc-p1', pg_temp.x(), -240, '2026-09-18', false, 'x-lc'),                         -- L-card
       pg_temp.cardleg('x-lc-p2', pg_temp.x(), -240, '2026-09-19', false, 'x-lc');
select pg_temp.cardleg('k-lk-p1', pg_temp.c(), 260, '2026-09-21', false, 'k-lk'),                          -- L-cash
       pg_temp.cardleg('k-lk-p2', pg_temp.c(), 260, '2026-09-22', false, 'k-lk');
update public.transactions set amount = 311 where plaid_transaction_id = 'r-mc';                           -- M-amount
select public.evaluate_card_payments(pg_temp.aa());

-- Before the removal: every confirmation holds its cash leg (so no competitor can take it), and each is in
-- the state its case names. These hold today; they are the fixture, not the contract.
select th.assert(pg_temp.sre('k-wc') = 'unresolved/matched_leg_not_posted/null' and pg_temp.dstatus((select id from pairs where cash = 'k-wc')) = 'inactive/waiting_to_post',
  'before: W-card is waiting for its card leg to post; the cash leg is reserved');
select th.assert(pg_temp.tid('k-wk') is null and pg_temp.dstatus((select id from pairs where cash = 'k-wk')) = 'inactive/waiting_to_post',
  'before: W-cash is waiting for its cash leg to post');
select th.assert(pg_temp.sre('k-ac') = 'unresolved/decision_invalidated/null' and pg_temp.dstatus((select id from pairs where cash = 'k-ac')) = 'inactive/amount_changed',
  'before: A-card is invalidated by the card leg''s amount; the cash leg is reserved');
select th.assert(pg_temp.sre('k-ak') = 'unresolved/decision_invalidated/null' and pg_temp.dstatus((select id from pairs where cash = 'k-ak')) = 'inactive/amount_changed',
  'before: A-cash is invalidated by the cash leg''s amount; the cash leg is reserved');
select th.assert(pg_temp.sre('k-lc') = 'unresolved/decision_invalidated/null' and pg_temp.dstatus((select id from pairs where cash = 'k-lc')) = 'inactive/lineage_ambiguous',
  'before: L-card has two posted card rows for one pending leg; the cash leg is reserved');
select th.assert(pg_temp.sre('k-lk-p1') = 'unresolved/ambiguous_replacement/null' and pg_temp.sre('k-lk-p2') = 'unresolved/ambiguous_replacement/null'
                 and pg_temp.dstatus((select id from pairs where cash = 'k-lk')) = 'inactive/lineage_ambiguous',
  'before: L-cash has two posted cash rows for one pending leg');
select th.assert(pg_temp.sre('k-ut') = 'tracked/user_pair/0', 'before: U-tie is an active user pair');
select th.assert(pg_temp.sre('y-ma') = 'paired/user_pair/0' and pg_temp.dstatus((select id from pairs where cash = 'r-ma')) = 'active',
  'before: M-active is an active user pair; its card leg is on the kept card');
select th.assert(pg_temp.sre('y-mc') = 'unresolved/decision_invalidated/0' and pg_temp.dstatus((select id from pairs where cash = 'r-mc')) = 'inactive/amount_changed',
  'before: M-amount is invalidated by the cash leg''s amount; the card leg is reserved');
select th.assert((select bool_and(pg_temp.unpaired(p)) from unnest(array['y-wc', 'y-wk', 'y-ac', 'y-ak', 'y-lc', 'y-lk', 'y-ut', 'k-ma', 'k-mc']) p),
  'before: no competitor is paired with anything');
select th.assert((select bool_and(pg_temp.held_by_user(p)) from unnest(array['k-wc', 'k-ac', 'k-ak', 'k-lc', 'k-ut', 'y-ma', 'y-mc']) p),
  'before: every current leg is held by its user confirmation');

-- ---- The removal of Card Bank, through its state machine -------------------------------------------
select th.assert(public.begin_plaid_item_removal(pg_temp.aa(), pg_temp.item1(),
                 public.plaid_item_removal_digest(pg_temp.aa(), pg_temp.item1()))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt(pg_temp.aa(), pg_temp.item1(), 'removed', null);
select th.assert((public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item1())->>'replayed')::boolean = false, 'the removal runs');
select th.assert(not exists (select 1 from public.accounts where id in (pg_temp.x()::uuid, pg_temp.r()::uuid)), 'card X and checking R are gone');
-- The checks read published states; if the removal's final (best-effort) evaluation did not publish, evaluate.
select public.evaluate_card_payments(pg_temp.aa());

select pg_temp.observe('after the removal', array['k-wc', 'y-wc', 'k-ac', 'y-ac', 'k-ak', 'y-ak', 'k-lc', 'y-lc', 'k-lk-p1', 'k-lk-p2', 'y-lk', 'k-ut', 'y-ut',
                                                  'y-ma', 'k-ma', 'y-mc', 'k-mc']);

-- M-active: the confirmed pair's CASH account was removed; the card leg on the kept card survives.
select pg_temp.req('M-active', 'the explicit confirmation is not lost: it is kept on the surviving card leg', pg_temp.user_evidence('y-ma'));
select pg_temp.req('M-active', 'the card leg does not auto-match the competing cash leg', pg_temp.unpaired('y-ma') and pg_temp.unpaired('k-ma'));
select pg_temp.req('M-active', 'the card leg is held by the user''s confirmation (reserved)', pg_temp.held_by_user('y-ma'));
select pg_temp.req('M-active', 'no cash-flow effect is invented on the credit side: funded from outside the tracked set, effect 0',
  pg_temp.leg('y-ma')->>'state' = 'funded_from_excluded' and (pg_temp.leg('y-ma')->>'effectCents')::bigint = 0);
select pg_temp.req('M-active', 'the competing cash leg is not given a pair it never had: still unresolved, a range',
  pg_temp.leg('k-ma')->>'state' = 'unresolved' and pg_temp.leg('k-ma')->>'effectCents' is null);

-- M-amount: the same, with a confirmation the removed cash leg's amount had invalidated.
select pg_temp.req('M-amount', 'the explicit confirmation is not lost', pg_temp.user_evidence('y-mc'));
select pg_temp.req('M-amount', 'the card leg does not auto-match the competing cash leg', pg_temp.unpaired('y-mc') and pg_temp.unpaired('k-mc'));
select pg_temp.req('M-amount', 'the reservation is preserved', pg_temp.held_by_user('y-mc'));
select pg_temp.req('M-amount', 'the old confirmation is not proof: the card leg is unresolved, effect 0; the competing cash leg unresolved',
  pg_temp.leg('y-mc')->>'state' = 'unresolved' and (pg_temp.leg('y-mc')->>'effectCents')::bigint = 0 and pg_temp.leg('k-mc')->>'state' = 'unresolved');

-- W-card: waiting for the card leg, which can no longer post. The surviving lineage is a current row.
select pg_temp.req('W-card', 'the explicit confirmation is not lost', pg_temp.user_evidence('k-wc'));
select pg_temp.req('W-card', 'the cash leg does not auto-match the competitor', pg_temp.unpaired('k-wc') and pg_temp.unpaired('y-wc'));
select pg_temp.req('W-card', 'the cash leg is held by the user''s confirmation (reserved)', pg_temp.held_by_user('k-wc'));
select pg_temp.req('W-card', 'the confirmed, removed destination counts: untracked, −210',
  pg_temp.leg('k-wc')->>'state' = 'untracked' and (pg_temp.leg('k-wc')->>'effectCents')::bigint = -21000);

-- W-cash: waiting for the cash leg. Nothing to read until it posts; the confirmation must still be there.
select pg_temp.req('W-cash', 'the explicit confirmation is not lost while the cash leg waits to post', pg_temp.user_evidence('k-wk'));
select public.apply_synced_transaction_batch_v2(pg_temp.aa(),
  jsonb_build_array(pg_temp.syncrow('k-wk-posted', pg_temp.c(), 215, '2026-09-06', 'k-wk')), '[]'::jsonb, '{}'::text[]);
select public.evaluate_card_payments(pg_temp.aa());
select pg_temp.observe('after the waiting cash leg posted', array['k-wk-posted', 'y-wk']);
select pg_temp.req('W-cash', 'when it posts, the cash leg does not auto-match the competitor', pg_temp.unpaired('k-wk-posted') and pg_temp.unpaired('y-wk'));
select pg_temp.req('W-cash', 'when it posts, the cash leg is held by the user''s confirmation (through its lineage)', pg_temp.held_by_user('k-wk-posted'));
select pg_temp.req('W-cash', 'when it posts at the confirmed amount, the removed destination counts: untracked, −215',
  pg_temp.leg('k-wk-posted')->>'state' = 'untracked' and (pg_temp.leg('k-wk-posted')->>'effectCents')::bigint = -21500);

-- A-card: the confirmed amount no longer held on the card side (the reviewer's counterexample).
select pg_temp.req('A-card', 'the explicit confirmation is not lost', pg_temp.user_evidence('k-ac'));
select pg_temp.req('A-card', 'the cash leg does not auto-match the competitor', pg_temp.unpaired('k-ac') and pg_temp.unpaired('y-ac'));
select pg_temp.req('A-card', 'the reservation is preserved', pg_temp.held_by_user('k-ac'));
select pg_temp.req('A-card', 'the old confirmation is not proof: unresolved, no effect',
  pg_temp.leg('k-ac')->>'state' = 'unresolved' and pg_temp.leg('k-ac')->>'effectCents' is null);

-- A-cash: the confirmed amount no longer held on the cash side.
select pg_temp.req('A-cash', 'the explicit confirmation is not lost', pg_temp.user_evidence('k-ak'));
select pg_temp.req('A-cash', 'the cash leg does not auto-match the competitor', pg_temp.unpaired('k-ak') and pg_temp.unpaired('y-ak'));
select pg_temp.req('A-cash', 'the reservation is preserved', pg_temp.held_by_user('k-ak'));
select pg_temp.req('A-cash', 'the old confirmation is not proof: unresolved, no effect',
  pg_temp.leg('k-ak')->>'state' = 'unresolved' and pg_temp.leg('k-ak')->>'effectCents' is null);

-- L-card: the confirmed card leg had conflicting replacements when the card was removed.
select pg_temp.req('L-card', 'the explicit confirmation is not lost', pg_temp.user_evidence('k-lc'));
select pg_temp.req('L-card', 'the cash leg does not auto-match the competitor', pg_temp.unpaired('k-lc') and pg_temp.unpaired('y-lc'));
select pg_temp.req('L-card', 'the reservation is preserved', pg_temp.held_by_user('k-lc'));
select pg_temp.req('L-card', 'no removed-card effect from an ambiguous lineage: unresolved, no effect',
  pg_temp.leg('k-lc')->>'state' = 'unresolved' and pg_temp.leg('k-lc')->>'effectCents' is null);

-- L-cash: the surviving cash leg itself has conflicting replacements.
select pg_temp.req('L-cash', 'the explicit confirmation is not lost', pg_temp.user_evidence('k-lk'));
select pg_temp.req('L-cash', 'no replacement is chosen: both stay unresolved, and neither pairs with the competitor',
  pg_temp.sre('k-lk-p1') = 'unresolved/ambiguous_replacement/null' and pg_temp.sre('k-lk-p2') = 'unresolved/ambiguous_replacement/null'
  and pg_temp.unpaired('y-lk'));
delete from public.transactions where plaid_transaction_id = 'k-lk-p2';
select public.evaluate_card_payments(pg_temp.aa());
select pg_temp.observe('after one conflicting cash replacement was withdrawn', array['k-lk-p1', 'y-lk']);
select pg_temp.req('L-cash', 'once one replacement is left, the leg still does not auto-match the competitor', pg_temp.unpaired('k-lk-p1') and pg_temp.unpaired('y-lk'));
select pg_temp.req('L-cash', 'once one replacement is left, it is held by the user''s confirmation', pg_temp.held_by_user('k-lk-p1'));

-- U-tie: an ACTIVE confirmation that chose X over an equally close leg on Y.
select pg_temp.req('U-tie', 'the explicit confirmation is not lost', pg_temp.user_evidence('k-ut'));
select pg_temp.req('U-tie', 'the cash leg does not auto-match the card the user did not choose', pg_temp.unpaired('k-ut') and pg_temp.unpaired('y-ut'));
select pg_temp.req('U-tie', 'the cash leg is held by the user''s confirmation, not by a non-reserving record', pg_temp.held_by_user('k-ut'));
select pg_temp.req('U-tie', 'the confirmed, removed destination counts: untracked, −500',
  pg_temp.leg('k-ut')->>'state' = 'untracked' and (pg_temp.leg('k-ut')->>'effectCents')::bigint = -50000);

-- ---- Relinking: a new item, a new account, new Plaid ids; the card's history re-imports ----------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000004', pg_temp.aa(), 'harness-item-a4', 'placeholder-token-a4', 'Card Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000020d1', '00000000-0000-0000-0000-000000000004', 'a20-x2', 'Card X (relinked)', 'credit');
create function pg_temp.x2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000020d1' $$;
select pg_temp.cardleg('x2-wc', pg_temp.x2(), -210, '2026-09-02'),
       pg_temp.cardleg('x2-ac', pg_temp.x2(), -220, '2026-09-10'),   -- the amount the user ORIGINALLY confirmed
       pg_temp.cardleg('x2-lc', pg_temp.x2(), -240, '2026-09-18');
select public.evaluate_card_payments(pg_temp.aa());
select pg_temp.observe('after the relink', array['k-wc', 'x2-wc', 'k-ac', 'x2-ac', 'k-lc', 'x2-lc']);
select pg_temp.req('W-card', 'after a relink the preserved confirmation keeps its precedence: still held, still −210, the re-imported leg only a suggestion',
  pg_temp.held_by_user('k-wc') and pg_temp.leg('k-wc')->>'state' = 'untracked' and (pg_temp.leg('k-wc')->>'effectCents')::bigint = -21000
  and exists (select 1 from jsonb_array_elements(pg_temp.leg('k-wc')->'candidates') c
              where (c->>'transactionId')::uuid = pg_temp.tid('x2-wc') and (c->>'contradictsDecision')::boolean));
select pg_temp.req('A-card', 'after a relink the invalidated confirmation does not become a valid effect: still reserved and unresolved',
  pg_temp.held_by_user('k-ac') and pg_temp.leg('k-ac')->>'state' = 'unresolved' and pg_temp.leg('k-ac')->>'effectCents' is null);
select pg_temp.req('L-card', 'after a relink the ambiguous confirmation does not become a valid effect: still reserved and unresolved',
  pg_temp.held_by_user('k-lc') and pg_temp.leg('k-lc')->>'state' = 'unresolved' and pg_temp.leg('k-lc')->>'effectCents' is null);

-- ---- The verdict ------------------------------------------------------------------------------------
\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only on
select 'OBSERVED', moment, leg, what from observed order by seq;
select 'OBSERVED', 'live decisions at the end', d.kind, d.a_plaid_transaction_id || coalesce(' / ' || d.b_plaid_transaction_id, '')
from public.card_payment_decisions d where d.user_id = pg_temp.aa() and d.superseded_by is null order by d.kind, d.a_plaid_transaction_id;
select 'CONTRACT ' || case when ok then 'ok      ' else 'VIOLATED' end, kase, requirement from contract order by seq;
select 'CONTRACT SUMMARY', count(*) filter (where ok) || ' of ' || count(*) || ' requirements hold',
       coalesce('violated in: ' || string_agg(distinct kase, ', ') filter (where not ok), 'none violated') from contract;
select th.assert((select bool_and(ok) from contract),
  'institution removal keeps explicit user confirmations and their reservations (Decision 2); violated in: '
  || (select coalesce(string_agg(distinct kase, ', ') filter (where not ok), 'none') || ' (' || count(*) filter (where not ok) || ' of ' || count(*) || ' requirements)' from contract));

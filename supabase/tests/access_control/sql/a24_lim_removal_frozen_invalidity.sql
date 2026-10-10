-- A preserved user confirmation whose REMOVED side was invalid stays invalid, whatever happens to the amount of
-- the leg that survived (Phase B I3A revision 5; the independent audit's finding P2; 20261006110000).
--
-- The contract. A `pair_counterpart_removed` decision freezes what was true of the removed side when its
-- account was deleted (counterpart_status). A frozen status other than valid / waiting_to_post keeps the
-- confirmation inactive until the user undoes or replaces it. The ONE approved way an inactive confirmation's
-- leg can still publish an effect is the narrow known-effect exception: the decision's only inactive reason is
-- an AMOUNT change (the surviving leg's, the removed leg's, or both), the correction is in the same direction,
-- the leg is on the cash side, and the user has no included card at all — then "no included card" establishes
-- the effect by itself. A later amount correction of the surviving leg must not turn any OTHER frozen
-- disqualifier — lineage_ambiguous, partner_gone, role_changed, sides_not_opposite, direction_mismatch,
-- difference_not_accepted, conflicting_decisions — into that exception: what was wrong with the removed
-- counterpart was never resolved, and an amount correction of the other leg does not resolve it.
--   * the user's confirmation is kept, as the user's (provenance);
--   * it keeps holding its leg: no competitor is matched with it automatically (reservation);
--   * it is never read as active, and no known effect is published;
--   * the leg is unresolved, with the frozen reason;
--   * and it recovers only when the evidence genuinely supports it: a restored amount re-activates a
--     confirmation whose removed side was valid; a frozen disqualifier is released only by the user.
--
-- PART 1, through the real removal. User aa: item 1 "Card Bank" (card X) is REMOVED; item 3 "Kept Bank" survives
-- with a checking account C ONLY, so after the removal aa has no card at all — exactly where the exception can
-- apply. User bb: item 2 (card BX) is REMOVED; item 5 survives with checking BC and an INCLUDED card BY, which
-- carries a competing leg.
--
--   case      cash leg         confirmed with          before the removal                       frozen status
--   L-amount  k-la +100 on C   x-la −100 pending       two posted card rows name x-la           lineage_ambiguous
--   G-amount  k-ga +120 on C   x-ga −120               the bank withdraws x-ga                  partner_gone
--   R-amount  k-ra +140 on C   x-ra −140 (classifier)  the classifier re-classifies x-ra        role_changed
--   V-amount  k-va +200 on C   x-va −200               nothing: the confirmation is active      valid
--   W-amount  k-wa +160 on C   x-wa −160 pending       a sync removes the pending card row      waiting_to_post
--   A-amount  k-aa +180 on C   x-aa −180               the bank changes x-aa to −179            amount_changed
--   C-amount  b-k  +300 on BC  bx-k −300 pending       two posted card rows name bx-k           lineage_ambiguous
--             competitor: by-k −298 on bb's kept card BY — exactly the amount b-k is later corrected to
-- After the removal the bank corrects each surviving payment by −2.00, and later restores it.
--
-- PART 2, every frozen status. The seven disqualifiers cannot all be produced through the application (three of
-- them need a pair that was already inconsistent at its recorded amounts), so the decision a removal writes is
-- written here directly, once per status, on a payment of aa that the bank has since corrected by −2.00:
--   m-<status>, recorded at +(n × 10 + 500).00, for all ten statuses.
-- Last, after the amounts were restored, each of these payments is re-classified, so that the row that survived
-- is no card leg at all: a frozen disqualifier is the decision's reason whatever the surviving row's ROLE is, too.
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
-- state / reason / effect / detail, then the partner's Plaid id ("-" when none).
create function pg_temp.srep(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') || '/' || coalesce(l->>'detail', '-') || ' partner='
         || coalesce((select t.plaid_transaction_id from public.transactions t where t.id = (l->>'partnerTransactionId')::uuid), '-')
  from pg_temp.leg(p_plaid, p_user) l $$;
create function pg_temp.dstatus(p_decision uuid, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (d->>'status') || coalesce('/' || (d->>'detail'), '')
  from jsonb_array_elements(pg_temp.states(p_user)->'decisions') d where (d->>'decisionId')::uuid = p_decision $$;
-- The live preserved user decision on a surviving leg.
create function pg_temp.preserved(p_plaid text) returns public.card_payment_decisions language sql as $$
  select d.* from public.card_payment_decisions d
  where d.kind = 'pair_counterpart_removed' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid $$;
-- The kind of the live decision a leg's state names ("none" when it names none).
create function pg_temp.holder_kind(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid and d.superseded_by is null), 'none')
  from pg_temp.leg(p_plaid, p_user) l $$;
-- The contract for a frozen disqualifier, as a reader sees it: the leg is reserved by the preserved confirmation
-- (the user's own decision, still live, named on the leg), that decision is NOT active, the leg is unresolved
-- with the frozen reason, and it publishes no effect: a range {−cents, 0}.
create function pg_temp.reserved_unresolved(p_plaid text, p_detail text, p_cents bigint, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select pg_temp.srep(p_plaid, p_user) = 'unresolved/decision_invalidated/null/' || p_detail || ' partner=-'
         and (l->>'lowCents')::bigint = -p_cents and (l->>'highCents')::bigint = 0
         and pg_temp.holder_kind(p_plaid, p_user) = 'pair_counterpart_removed'
         and pg_temp.dstatus((l->>'decisionId')::uuid, p_user) = 'inactive/' || p_detail
         and (select d.user_id = p_user and d.superseded_by is null from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid)
  from pg_temp.leg(p_plaid, p_user) l $$;
-- The exception, as a reader sees it: the corrected amount counts by itself, and the confirmation stays inactive.
create function pg_temp.known_effect(p_plaid text, p_cents bigint, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select pg_temp.srep(p_plaid, p_user) = 'untracked/no_included_card/' || (-p_cents)::text || '/amount_changed partner=-'
         and pg_temp.holder_kind(p_plaid, p_user) = 'pair_counterpart_removed'
         and pg_temp.dstatus((l->>'decisionId')::uuid, p_user) = 'inactive/amount_changed'
  from pg_temp.leg(p_plaid, p_user) l $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending boolean default false,
                                p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, pending_transaction_id, user_role_override)
  values (p_account::uuid, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, p_pending_of, 'credit_card_payment') $$;
create function pg_temp.link(p_cash text, p_card text, p_user uuid default pg_temp.aa()) returns void language plpgsql as $$
begin
  perform th.assert(public.link_card_payment(p_user, pg_temp.tid(p_cash), pg_temp.tid(p_card), 0, pg_temp.iv(p_user))->>'status' = 'saved',
    'fixture: the user confirms ' || p_cash || ' with ' || p_card);
end $$;
create function pg_temp.pair_of(p_cash_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = p_cash_plaid $$;
create function pg_temp.evaluate() returns void language sql as $$
  select public.evaluate_card_payments(pg_temp.aa()); select public.evaluate_card_payments(pg_temp.bb()); $$;
create function pg_temp.remove(p_user uuid, p_item uuid) returns void language plpgsql as $$
begin
  perform th.assert(public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item))->>'outcome' = 'started', 'removal begins');
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
  perform th.assert((public.remove_plaid_item_local(p_user, p_item)->>'replayed')::boolean = false, 'the removal runs');
end $$;
create temporary table statuses (n integer primary key, status text not null, amount_only boolean not null);
insert into statuses values (1, 'lineage_ambiguous', false), (2, 'partner_gone', false), (3, 'role_changed', false), (4, 'sides_not_opposite', false),
  (5, 'direction_mismatch', false), (6, 'difference_not_accepted', false), (7, 'conflicting_decisions', false),
  (8, 'valid', true), (9, 'waiting_to_post', true), (10, 'amount_changed', true);

-- ---- The contract's checks: recorded, all printed, asserted together at the end -----------------------
create temporary table contract (seq integer generated always as identity, kase text not null, requirement text not null, ok boolean not null);
create function pg_temp.req(p_case text, p_requirement text, p_ok boolean) returns void language sql as $$
  insert into pg_temp.contract (kase, requirement, ok) values (p_case, p_requirement, coalesce(p_ok, false)) $$;
create temporary table observed (seq integer generated always as identity, moment text not null, leg text not null, what text not null);
create function pg_temp.observe(p_moment text, p_legs text[], p_user uuid default pg_temp.aa()) returns void language sql as $$
  insert into pg_temp.observed (moment, leg, what)
  select p_moment, p, coalesce(pg_temp.srep(p, p_user), '(no current leg)') || '  decision=' || coalesce(pg_temp.holder_kind(p, p_user), '-')
         || coalesce(' ' || pg_temp.dstatus((pg_temp.leg(p, p_user)->>'decisionId')::uuid, p_user), '')
  from unnest(p_legs) with ordinality as u(p, n) order by n $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'BB Kept Bank');
update public.plaid_items set institution_name = 'Card Bank' where id = '00000000-0000-0000-0000-000000000001';
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000024a1', '00000000-0000-0000-0000-000000000001', 'a24-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-0000000024b1', '00000000-0000-0000-0000-000000000003', 'a24-c', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000024c2', '00000000-0000-0000-0000-000000000002', 'a24-bx', 'BB Card BX', 'credit'),
  ('00000000-0000-0000-0000-0000000024c1', '00000000-0000-0000-0000-000000000005', 'a24-bc', 'BB Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000024c3', '00000000-0000-0000-0000-000000000005', 'a24-by', 'BB Kept Card BY', 'credit');
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000024a1' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000024b1' $$;
create function pg_temp.bx() returns text language sql as $$ select '00000000-0000-0000-0000-0000000024c2' $$;
create function pg_temp.bc() returns text language sql as $$ select '00000000-0000-0000-0000-0000000024c1' $$;
create function pg_temp.by_() returns text language sql as $$ select '00000000-0000-0000-0000-0000000024c3' $$;

select pg_temp.cardleg('k-la', pg_temp.c(), 100, '2026-09-01'), pg_temp.cardleg('x-la', pg_temp.x(), -100, '2026-09-02', true);
select pg_temp.cardleg('k-ga', pg_temp.c(), 120, '2026-09-01'), pg_temp.cardleg('x-ga', pg_temp.x(), -120, '2026-09-02');
select pg_temp.cardleg('k-ra', pg_temp.c(), 140, '2026-09-01');
-- R-amount: the card leg is a card payment by the CLASSIFIER (auto_role), with no user override.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, auto_role, role_source, role_confidence, classifier_version)
values (pg_temp.x()::uuid, 'x-ra', -140, '2026-09-02', 'Leg x-ra', false, 'credit_card_payment', 'category_detailed', 'high', 1);
select pg_temp.cardleg('k-va', pg_temp.c(), 200, '2026-09-05'), pg_temp.cardleg('x-va', pg_temp.x(), -200, '2026-09-06');
select pg_temp.cardleg('k-wa', pg_temp.c(), 160, '2026-09-05'), pg_temp.cardleg('x-wa', pg_temp.x(), -160, '2026-09-06', true);
select pg_temp.cardleg('k-aa', pg_temp.c(), 180, '2026-09-05'), pg_temp.cardleg('x-aa', pg_temp.x(), -180, '2026-09-06');
select pg_temp.cardleg('b-k', pg_temp.bc(), 300, '2026-09-01'), pg_temp.cardleg('bx-k', pg_temp.bx(), -300, '2026-09-02', true),
       pg_temp.cardleg('by-k', pg_temp.by_(), -298, '2026-09-03');
select pg_temp.evaluate();

-- The user's explicit confirmations, through the real RPC.
select pg_temp.link('k-la', 'x-la'), pg_temp.link('k-ga', 'x-ga'), pg_temp.link('k-ra', 'x-ra'), pg_temp.link('k-va', 'x-va'),
       pg_temp.link('k-wa', 'x-wa'), pg_temp.link('k-aa', 'x-aa');
select pg_temp.link('b-k', 'bx-k', pg_temp.bb());
create temporary table pairs as select p as cash, pg_temp.pair_of(p) as id from unnest(array['k-la', 'k-ga', 'k-ra', 'k-va', 'k-wa', 'k-aa', 'b-k']) p;
select th.assert((select count(id) = 7 from pairs), 'fixture: one live pair decision per case');

-- What happens between the confirmation and the removal.
select pg_temp.cardleg('x-la-p1', pg_temp.x(), -100, '2026-09-02', false, 'x-la'),                     -- L-amount: conflicting replacements
       pg_temp.cardleg('x-la-p2', pg_temp.x(), -100, '2026-09-03', false, 'x-la');                     -- of the confirmed CARD leg
delete from public.transactions where plaid_transaction_id = 'x-ga';                                   -- G-amount: withdrawn by the bank
update public.transactions set auto_role = 'expense', role_source = 'sign_default', role_confidence = 'low' where plaid_transaction_id = 'x-ra';   -- R-amount
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['x-wa']);  -- W-amount: waiting to post
update public.transactions set amount = -179 where plaid_transaction_id = 'x-aa';                      -- A-amount
select pg_temp.cardleg('bx-k-p1', pg_temp.bx(), -300, '2026-09-02', false, 'bx-k'),                    -- C-amount (bb)
       pg_temp.cardleg('bx-k-p2', pg_temp.bx(), -300, '2026-09-03', false, 'bx-k');
select pg_temp.evaluate();
select th.assert((select bool_and(pg_temp.dstatus((select id from pairs where cash = v.cash)) = v.status)
                  from (values ('k-la', 'inactive/lineage_ambiguous'), ('k-ga', 'inactive/partner_gone'), ('k-ra', 'inactive/role_changed'), ('k-va', 'active'),
                               ('k-wa', 'inactive/waiting_to_post'), ('k-aa', 'inactive/amount_changed')) v(cash, status))
                 and pg_temp.dstatus((select id from pairs where cash = 'b-k'), pg_temp.bb()) = 'inactive/lineage_ambiguous',
  'before: each confirmation is in the state its case names');

-- ---- The removals -------------------------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000001');
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select pg_temp.observe('right after the removal', array['k-la', 'k-ga', 'k-ra', 'k-va', 'k-wa', 'k-aa']);
select pg_temp.observe('right after the removal (bb)', array['b-k', 'by-k'], pg_temp.bb());
select th.assert((select jsonb_object_agg(d.a_plaid_transaction_id, d.counterpart_status)
                  from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed')
                 = '{"k-la": "lineage_ambiguous", "k-ga": "partner_gone", "k-ra": "role_changed", "k-va": "valid", "k-wa": "waiting_to_post", "k-aa": "amount_changed", "b-k": "lineage_ambiguous"}'::jsonb,
  'after the removal: every confirmation is preserved, each with the removed side''s frozen status');
select th.assert(not exists (select 1 from public.accounts a join public.plaid_items i on i.id = a.item_id where i.user_id = pg_temp.aa() and a.type = 'credit')
                 and exists (select 1 from public.accounts a join public.plaid_items i on i.id = a.item_id
                             where i.user_id = pg_temp.bb() and a.type = 'credit' and not a.exclude_from_cash_flow),
  'after the removal: aa has no card at all; bb still has an included card');
select pg_temp.req(v.kase, 'right after the removal: reserved, unresolved, no effect — the frozen reason is the reason', pg_temp.reserved_unresolved(v.leg, v.status, v.cents))
from (values ('L-amount', 'k-la', 'lineage_ambiguous', 10000), ('G-amount', 'k-ga', 'partner_gone', 12000), ('R-amount', 'k-ra', 'role_changed', 14000)) v(kase, leg, status, cents);
select pg_temp.req('V-amount', 'right after the removal: the valid confirmation counts as a removed-card payment',
  pg_temp.srep('k-va') = 'untracked/removed_card/-20000/- partner=-' and pg_temp.holder_kind('k-va') = 'pair_counterpart_removed');
select pg_temp.req('W-amount', 'right after the removal: a counterpart that was only waiting to post invalidates nothing',
  pg_temp.srep('k-wa') = 'untracked/removed_card/-16000/- partner=-' and pg_temp.dstatus((pg_temp.preserved('k-wa')).id) = 'active');
select pg_temp.req('A-amount', 'right after the removal: the removed leg''s amount had changed, no card is left: the payment counts by the no-included-card rule; the confirmation is inactive',
  pg_temp.known_effect('k-aa', 18000));
select pg_temp.req('C-amount', 'right after the removal: reserved and unresolved; the competing card leg is not paired', pg_temp.reserved_unresolved('b-k', 'lineage_ambiguous', 30000, pg_temp.bb())
  and pg_temp.srep('by-k', pg_temp.bb()) like 'unresolved/%partner=-');

-- ---- PART 2: the decision a removal writes, once for every frozen status ---------------------------
select pg_temp.cardleg('m-' || s.status, pg_temp.c(), s.n * 10 + 500, '2026-09-20') from statuses s;
insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents, accepted_difference_cents, counterpart_status)
select pg_temp.aa(), 'pair_counterpart_removed', pg_temp.c()::uuid, 'm-' || s.status, (s.n * 10 + 500) * 100, 'gone-' || s.status, -(s.n * 10 + 500) * 100, 0, s.status
from statuses s order by s.n;
select pg_temp.evaluate();
select pg_temp.req('M-' || s.status, 'at the recorded amount: ' || case when s.status = 'amount_changed' then 'the frozen amount change with no card left — the exception'
                                                                when s.amount_only then 'active: a removed-card payment' else 'reserved, unresolved, the frozen reason' end,
  case when s.status = 'amount_changed' then pg_temp.known_effect('m-' || s.status, (s.n * 10 + 500) * 100)
       when s.amount_only then pg_temp.srep('m-' || s.status) = 'untracked/removed_card/-' || ((s.n * 10 + 500) * 100)::text || '/- partner=-'
       else pg_temp.reserved_unresolved('m-' || s.status, s.status, (s.n * 10 + 500) * 100) end)
from statuses s order by s.n;

-- ---- Later: the bank corrects each surviving payment by −2.00 ----------------------------------------
update public.transactions set amount = amount - 2
where plaid_transaction_id in ('k-la', 'k-ga', 'k-ra', 'k-va', 'k-wa', 'k-aa', 'b-k') or plaid_transaction_id like 'm-%';
select pg_temp.evaluate();
select pg_temp.observe('after the surviving amounts were corrected', array['k-la', 'k-ga', 'k-ra', 'k-va', 'k-wa', 'k-aa']);
select pg_temp.observe('after the surviving amounts were corrected', array(select 'm-' || s.status from statuses s order by s.n));
select pg_temp.observe('after the surviving amounts were corrected (bb)', array['b-k', 'by-k'], pg_temp.bb());

-- THE AUDIT'S COUNTEREXAMPLE (L-amount), and the same with every other frozen disqualifier.
select pg_temp.req(v.kase, 'the surviving amount correction does NOT publish a known effect: still unresolved, a range {−' || (v.cents / 100)::text || ', 0}',
  pg_temp.leg(v.leg)->>'state' = 'unresolved' and pg_temp.leg(v.leg)->>'effectCents' is null
  and (pg_temp.leg(v.leg)->>'lowCents')::bigint = -v.cents and (pg_temp.leg(v.leg)->>'highCents')::bigint = 0)
from (values ('L-amount', 'k-la', 9800), ('G-amount', 'k-ga', 11800), ('R-amount', 'k-ra', 13800)) v(kase, leg, cents);
select pg_temp.req(v.kase, 'the frozen disqualifier is not masked by the amount change: the leg and the decision still say ' || v.status || '; the confirmation is the user''s, live, inactive, and still holds the leg',
  pg_temp.reserved_unresolved(v.leg, v.status, v.cents))
from (values ('L-amount', 'k-la', 'lineage_ambiguous', 9800), ('G-amount', 'k-ga', 'partner_gone', 11800), ('R-amount', 'k-ra', 'role_changed', 13800)) v(kase, leg, status, cents);
select pg_temp.req('M-' || s.status, 'after the correction: ' || case when s.amount_only then 'an amount is the only thing wrong, no card is left — the exception applies' else 'NOT the exception: reserved, unresolved, the frozen reason' end,
  case when s.amount_only then pg_temp.known_effect('m-' || s.status, (s.n * 10 + 498) * 100)
       else pg_temp.reserved_unresolved('m-' || s.status, s.status, (s.n * 10 + 498) * 100) end)
from statuses s order by s.n;

-- The approved exception still applies where an amount is the ONLY thing wrong.
select pg_temp.req('V-amount', 'an amount correction of a confirmation whose removed side was valid: no card is left, so the corrected amount counts by itself; the confirmation stays inactive', pg_temp.known_effect('k-va', 19800));
select pg_temp.req('W-amount', 'the same for a counterpart that was waiting to post', pg_temp.known_effect('k-wa', 15800));
select pg_temp.req('A-amount', 'the same when both sides'' amounts changed', pg_temp.known_effect('k-aa', 17800));

-- C-amount: the reservation holds against a competitor that now fits the corrected amount exactly.
select pg_temp.req('C-amount', 'the corrected payment now matches the kept card''s leg to the cent and is NOT paired with it: reserved, unresolved, the frozen reason; the card leg unmatched',
  pg_temp.reserved_unresolved('b-k', 'lineage_ambiguous', 29800, pg_temp.bb()) and pg_temp.srep('by-k', pg_temp.bb()) like 'unresolved/%partner=-'
  and pg_temp.leg('by-k', pg_temp.bb())->'candidates' = '[]'::jsonb);

-- ---- Later still: the bank restores every amount ------------------------------------------------------
update public.transactions set amount = amount + 2
where plaid_transaction_id in ('k-la', 'k-ga', 'k-ra', 'k-va', 'k-wa', 'k-aa', 'b-k') or plaid_transaction_id like 'm-%';
select pg_temp.evaluate();
select pg_temp.observe('after the surviving amounts were restored', array['k-la', 'k-ga', 'k-ra', 'k-va', 'k-wa', 'k-aa']);
select pg_temp.req(v.kase, 'restoring the amount does not make the frozen disqualifier valid: still reserved and unresolved', pg_temp.reserved_unresolved(v.leg, v.status, v.cents))
from (values ('L-amount', 'k-la', 'lineage_ambiguous', 10000), ('G-amount', 'k-ga', 'partner_gone', 12000), ('R-amount', 'k-ra', 'role_changed', 14000)) v(kase, leg, status, cents);
select pg_temp.req('V-amount', 'restoring the amount makes the valid confirmation active again, by itself: a removed-card payment',
  pg_temp.srep('k-va') = 'untracked/removed_card/-20000/- partner=-' and pg_temp.dstatus((pg_temp.preserved('k-va')).id) = 'active');
select pg_temp.req('W-amount', 'and the waiting one', pg_temp.srep('k-wa') = 'untracked/removed_card/-16000/- partner=-' and pg_temp.dstatus((pg_temp.preserved('k-wa')).id) = 'active');
select pg_temp.req('A-amount', 'a frozen amount change stays: the exception at the restored amount, the confirmation inactive', pg_temp.known_effect('k-aa', 18000));
select pg_temp.req('M-' || s.status, 'after the amounts were restored: as at the recorded amount (no false recovery of a frozen disqualifier; genuine recovery where the removed side was valid)',
  case when s.status = 'amount_changed' then pg_temp.known_effect('m-' || s.status, (s.n * 10 + 500) * 100)
       when s.amount_only then pg_temp.srep('m-' || s.status) = 'untracked/removed_card/-' || ((s.n * 10 + 500) * 100)::text || '/- partner=-'
                               and pg_temp.dstatus((pg_temp.preserved('m-' || s.status)).id) = 'active'
       else pg_temp.reserved_unresolved('m-' || s.status, s.status, (s.n * 10 + 500) * 100) end)
from statuses s order by s.n;

-- ---- Last for PART 2: each payment is re-classified, at its recorded amount -----------------------------
-- The row that survived is no card leg any more, so no leg state exists for it. A frozen disqualifier is still
-- the decision's reason (checked before the surviving row's role, as before its amount); where the removed side
-- was valid, waiting to post, or wrong in its amount only, the surviving row's own role is the reason.
update public.transactions set user_role_override = 'expense' where plaid_transaction_id like 'm-%';
select pg_temp.evaluate();
select pg_temp.req('M-' || s.status, 'after the surviving payment was re-classified (no card leg any more): the confirmation is inactive, with '
                                     || case when s.amount_only then 'role_changed — the surviving row''s own role' else 'the frozen reason, ' || s.status end,
  pg_temp.leg('m-' || s.status) is null
  and pg_temp.dstatus((pg_temp.preserved('m-' || s.status)).id) = 'inactive/' || case when s.amount_only then 'role_changed' else s.status end)
from statuses s order by s.n;

-- ---- Recovery of a frozen disqualifier: only the user releases it --------------------------------------
select th.assert(public.undo_card_payment_decision(pg_temp.aa(), (pg_temp.preserved('k-la')).id, pg_temp.iv())->>'status' = 'undone', 'L-amount: the user undoes the preserved confirmation');
select th.assert(public.undo_card_payment_decision(pg_temp.bb(), (pg_temp.preserved('b-k')).id, pg_temp.iv(pg_temp.bb()))->>'status' = 'undone', 'C-amount: the user undoes the preserved confirmation');
update public.transactions set amount = 298 where plaid_transaction_id = 'b-k';
select pg_temp.evaluate();
select pg_temp.observe('after the user undid the confirmation', array['k-la']);
select pg_temp.observe('after the user undid the confirmation (bb)', array['b-k', 'by-k'], pg_temp.bb());
select pg_temp.req('L-amount', 'once the USER undoes it, the leg is free and current evidence decides alone: no card is left, so the payment counts — attached to no decision',
  pg_temp.srep('k-la') = 'untracked/no_included_card/-10000/- partner=-' and pg_temp.holder_kind('k-la') = 'none'
  and (select superseded_by = id from public.card_payment_decisions where a_plaid_transaction_id = 'k-la' and kind = 'pair_counterpart_removed'));
-- 20261009120000 (guarded manual recovery). b-k was held by the user's confirmation at the removal, and by-k
-- (−298) did not even fit it then (b-k was +300): the removal knew no surviving edge of b-k. Once the user undoes
-- the confirmation and the bank corrects b-k to +298, the pair b-k / by-k is selected by the ordinary rule — and
-- withheld: the range {−298, 0}, no partner, no decision; the kept card's leg unresolved, 0.
select pg_temp.req('C-amount', 'once the USER undoes it, the corrected payment''s pair with the kept card''s leg is selected by the ordinary rule and WITHHELD for review: the range {−298, 0}, no partner, attached to no decision',
  pg_temp.srep('b-k', pg_temp.bb()) = 'unresolved/relink_review_required/null/- partner=-' and pg_temp.holder_kind('b-k', pg_temp.bb()) = 'none'
  and (pg_temp.leg('b-k', pg_temp.bb())->>'lowCents')::bigint = -29800 and (pg_temp.leg('b-k', pg_temp.bb())->>'highCents')::bigint = 0
  and pg_temp.srep('by-k', pg_temp.bb()) = 'unresolved/relink_review_required/0/- partner=-'
  and (pg_temp.leg('by-k', pg_temp.bb())->>'lowCents')::bigint = 0 and (pg_temp.leg('by-k', pg_temp.bb())->>'highCents')::bigint = 0);

-- ---- The verdict ------------------------------------------------------------------------------------
\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only on
select 'OBSERVED', moment, leg, what from observed order by seq;
select 'CONTRACT ' || case when ok then 'ok      ' else 'VIOLATED' end, kase, requirement from contract order by seq;
select 'CONTRACT SUMMARY', count(*) filter (where ok) || ' of ' || count(*) || ' requirements hold',
       coalesce('violated in: ' || string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none violated') from contract;
select th.assert((select bool_and(ok) from contract),
  'a frozen counterpart invalidity is never masked by a surviving amount correction; violated in: '
  || (select coalesce(string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none') || ' (' || count(*) filter (where not ok) || ' of ' || count(*) || ' requirements)' from contract));

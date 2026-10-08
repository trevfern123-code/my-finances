-- Institution removal is not evidence: the SYSTEM ambiguity hold (Phase B I3A; Trevor's decision of 2026-10-06 on
-- design §4.7; 20261006110000 and 20261006120000). The approved contract:
--
--   A leg that was unresolved before a removal because one of its candidates was on the removed institution and
--   another on an institution that stays does NOT become resolved merely because the first was deleted.
--     * The removal preserves the uncertainty: a system record on the pair of the two legs that are left. It
--       publishes no effect, names no destination, is not a user decision and has no user-strength precedence.
--     * A later evaluation resolves the leg when genuinely new or changed evidence supports it under the
--       ordinary rules: a new transaction, a changed amount, a date change that brings the kept candidate
--       strictly closer than the removed one was, relinked history, or an explicit user decision.
--     * A leg with no removed-versus-kept ambiguity is not held at all.
--
-- User aa. Item 1 "Card Bank" (card X, checking R) is REMOVED. Item 3 "Kept Bank" survives: checking C, checking
-- C2, cards Y and Z. Every case has its own amount (at least 10.00 apart, so cases never suggest each other).
--
--   case      payment on C         removed candidate    kept candidate(s)        what is exercised
--   A         k-a  +700 09-10      x-a  −700 09-11      y-a −700 09-11           the two-way tie
--   B         k-b  +710 09-10      x-b  −710 09-11      y-b, z-b −710 09-11      three candidates, one removed
--   C-new     k-cn +720 09-10      x-cn −720 09-11      y-cn −720 09-11          later: a new, strictly closer leg
--   C-date    k-cd +730 09-10      x-cd −730 09-12      y-cd −730 09-12          later: the kept leg is re-dated
--   C-amount  k-ca +740 09-10      x-ca −740 09-11      y-ca −740 09-11          later: the bank corrects both legs
--   C-posted  k-cp +750 pending    x-cp −750 09-11      y-cp −750 09-11          later: the payment posts, unchanged
--   D         k-d1 +760, k-d2 +850, k-d3 +860 (each with x-… and y-… one day later)   the user decides
--   E         k-e  +770 09-10      x-e  −770 09-11      y-e −770 09-11           later: the card is linked again
--   G         k-g  +810 09-10      x-g  −810 09-11      y-g −810 09-11           later: a second removal
--   N         k-n  +780 09-10      —                    y-n, z-n −780 09-11      a tie between two KEPT cards
--   P         k-p  +790 09-10 and k-p2 +790 09-12 (C2)  x-p −790 09-13           y-p −790 09-11: the kept card is
--                                                                                strictly closer to k-p
--   R         k-r  +820 09-10      x-r  −820 09-11      y-r, z-r −820 09-11      before the removal the user DISMISSED
--                                                                                the removed leg x-r against k-r
--   S         k-s  +830 09-10      x-s  −830 09-16      y-s, z-s −830 09-11      the removed leg is six days away: it
--                                                                                fits by amount, no tier 1 candidate
--   T         k-t  +840 09-10      x-t  −840 09-11      y-t, z-t −840 09-11      before the removal the user DISMISSED
--                                                                                the kept leg y-t against k-t
--   M (mirror) card leg y-m −800 09-20 on Y; removed CASH leg r-m +800 09-23 on R; kept cash leg k-m +800 09-23
-- User bb (F, ownership). Item 2 (card BX) is REMOVED; item 5 survives (checking BC, card BY):
--             b-k  +700 09-10      bx-k −700 09-11      by-k −700 09-11          the same amounts as aa's case A
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
-- The Plaid ids of a leg's tier-1-shaped candidates, sorted.
create function pg_temp.competitors(p_plaid text) returns text language sql as $$
  select coalesce(string_agg(t.plaid_transaction_id, ',' order by t.plaid_transaction_id collate "C"), '')
  from jsonb_array_elements(pg_temp.leg(p_plaid)->'candidates') c
  join public.transactions t on t.id = (c->>'transactionId')::uuid where c->>'kind' = 'tier1_competitor' $$;
create function pg_temp.dstatus(p_decision uuid, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (d->>'status') || coalesce('/' || (d->>'detail'), '')
  from jsonb_array_elements(pg_temp.states(p_user)->'decisions') d where (d->>'decisionId')::uuid = p_decision $$;
-- The live ambiguity holds on a cash leg's Plaid id, as "kind:card-leg@date", sorted.
create function pg_temp.holds(p_cash_plaid text) returns text language sql as $$
  select coalesce(string_agg(replace(d.kind, 'ambiguity_hold_', '') || ':' || d.a_plaid_transaction_id || '@' || d.counterpart_date, ','
                             order by d.a_plaid_transaction_id collate "C", d.counterpart_date), 'none')
  from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and d.b_plaid_transaction_id = p_cash_plaid $$;
create function pg_temp.hold_id(p_cash_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and d.b_plaid_transaction_id = p_cash_plaid
  order by d.a_plaid_transaction_id collate "C" limit 1 $$;
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
create function pg_temp.observe(p_moment text, p_legs text[]) returns void language sql as $$
  insert into pg_temp.observed (moment, leg, what)
  select p_moment, p, coalesce(pg_temp.srep(p), '(no current leg)') || '  holds=' || pg_temp.holds(p)
  from unnest(p_legs) with ordinality as u(p, n) order by n $$;
create function pg_temp.unresolved_range(p_plaid text, p_cents bigint) returns boolean language sql as $$
  select pg_temp.srep(p_plaid) = 'unresolved/ambiguous/null partner=-'
         and (l->>'lowCents')::bigint = -p_cents and (l->>'highCents')::bigint = 0 and l->>'decisionId' is null and l->>'detail' is null
  from pg_temp.leg(p_plaid) l $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'BB Kept Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000022a1', '00000000-0000-0000-0000-000000000001', 'a22-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-0000000022a2', '00000000-0000-0000-0000-000000000001', 'a22-r', 'Removed Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-000000000003', 'a22-c', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000022b2', '00000000-0000-0000-0000-000000000003', 'a22-c2', 'Kept Checking 2', 'depository'),
  ('00000000-0000-0000-0000-0000000022b3', '00000000-0000-0000-0000-000000000003', 'a22-y', 'Kept Card Y', 'credit'),
  ('00000000-0000-0000-0000-0000000022b4', '00000000-0000-0000-0000-000000000003', 'a22-z', 'Kept Card Z', 'credit'),
  ('00000000-0000-0000-0000-0000000022c2', '00000000-0000-0000-0000-000000000002', 'a22-bx', 'BB Card', 'credit'),
  ('00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-000000000005', 'a22-bc', 'BB Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000022c3', '00000000-0000-0000-0000-000000000005', 'a22-by', 'BB Kept Card', 'credit');
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000022a1' $$;
create function pg_temp.r() returns text language sql as $$ select '00000000-0000-0000-0000-0000000022a2' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000022b1' $$;
create function pg_temp.c2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000022b2' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000022b3' $$;
create function pg_temp.z() returns text language sql as $$ select '00000000-0000-0000-0000-0000000022b4' $$;

-- The plain ties: the payment on C, a leg on the removed card X and a leg on the kept card Y on the same later day.
select pg_temp.cardleg('k-' || s, pg_temp.c(), amt, '2026-09-10'), pg_temp.cardleg('x-' || s, pg_temp.x(), -amt, d::date), pg_temp.cardleg('y-' || s, pg_temp.y(), -amt, d::date)
from (values ('a', 700, '2026-09-11'), ('b', 710, '2026-09-11'), ('cn', 720, '2026-09-11'), ('cd', 730, '2026-09-12'), ('ca', 740, '2026-09-11'),
             ('d1', 760, '2026-09-11'), ('d2', 850, '2026-09-11'), ('d3', 860, '2026-09-11'), ('e', 770, '2026-09-11'), ('g', 810, '2026-09-11')) v(s, amt, d);
select pg_temp.cardleg('z-b', pg_temp.z(), -710, '2026-09-11');                                           -- B: a third candidate, kept
select pg_temp.cardleg('k-cp', pg_temp.c(), 750, '2026-09-10', true),                                     -- C-posted: the payment is pending
       pg_temp.cardleg('x-cp', pg_temp.x(), -750, '2026-09-11'), pg_temp.cardleg('y-cp', pg_temp.y(), -750, '2026-09-11');
select pg_temp.cardleg('k-n', pg_temp.c(), 780, '2026-09-10'),                                            -- N: two KEPT cards tie
       pg_temp.cardleg('y-n', pg_temp.y(), -780, '2026-09-11'), pg_temp.cardleg('z-n', pg_temp.z(), -780, '2026-09-11');
select pg_temp.cardleg('k-p', pg_temp.c(), 790, '2026-09-10'), pg_temp.cardleg('k-p2', pg_temp.c2(), 790, '2026-09-12'),  -- P
       pg_temp.cardleg('y-p', pg_temp.y(), -790, '2026-09-11'), pg_temp.cardleg('x-p', pg_temp.x(), -790, '2026-09-13');
select pg_temp.cardleg('y-m', pg_temp.y(), -800, '2026-09-20'),                                           -- M: the mirror
       pg_temp.cardleg('r-m', pg_temp.r(), 800, '2026-09-23'), pg_temp.cardleg('k-m', pg_temp.c(), 800, '2026-09-23');
-- R, S, T: the payment on C, a leg on the removed card X, and a leg on each of the kept cards Y and Z one day later.
select pg_temp.cardleg('k-' || s, pg_temp.c(), amt, '2026-09-10'), pg_temp.cardleg('x-' || s, pg_temp.x(), -amt, d::date),
       pg_temp.cardleg('y-' || s, pg_temp.y(), -amt, '2026-09-11'), pg_temp.cardleg('z-' || s, pg_temp.z(), -amt, '2026-09-11')
from (values ('r', 820, '2026-09-11'), ('s', 830, '2026-09-16'), ('t', 840, '2026-09-11')) v(s, amt, d);
select pg_temp.cardleg('b-k', '00000000-0000-0000-0000-0000000022c1', 700, '2026-09-10'),                 -- bb
       pg_temp.cardleg('bx-k', '00000000-0000-0000-0000-0000000022c2', -700, '2026-09-11'),
       pg_temp.cardleg('by-k', '00000000-0000-0000-0000-0000000022c3', -700, '2026-09-11');
select pg_temp.evaluate();

-- The fixture is what the header says: every payment unresolved by a tie, no decision anywhere.
select th.assert((select bool_and(pg_temp.srep('k-' || s) = 'unresolved/ambiguous/null partner=-')
                  from unnest(array['a', 'b', 'cn', 'cd', 'ca', 'cp', 'd1', 'd2', 'd3', 'e', 'g', 'n', 'p', 'p2', 'm']) s),
  'before: every payment is unresolved, with tier-1-shaped candidates and no pair');
select th.assert(pg_temp.srep('y-m') = 'unresolved/ambiguous/0 partner=-' and pg_temp.srep('b-k', pg_temp.bb()) = 'unresolved/ambiguous/null partner=-',
  'before: the mirror''s card leg and bb''s payment are unresolved ties too');
select th.assert(pg_temp.competitors('k-a') = 'x-a,y-a' and pg_temp.competitors('k-b') = 'x-b,y-b,z-b' and pg_temp.competitors('k-n') = 'y-n,z-n'
                 and pg_temp.competitors('k-p') = 'x-p,y-p' and pg_temp.competitors('y-m') = 'k-m,r-m',
  'before: the candidates are the ones the header names');
select th.assert((select count(*) from public.card_payment_decisions) = 0, 'before: no decision of any kind exists');
create temporary table bb_before as select pg_temp.iv(pg_temp.bb()) as iv;

-- R, S, T before the removal. As imported, R and T are three-way ties; in S the leg on X is outside the five days.
-- Then the user dismisses the removed leg x-r against k-r, and the kept leg y-t against k-t.
select th.assert(pg_temp.competitors('k-r') = 'x-r,y-r,z-r' and pg_temp.competitors('k-s') = 'y-s,z-s' and pg_temp.competitors('k-t') = 'x-t,y-t,z-t'
                 and pg_temp.srep('x-s') = 'unresolved/possible_match/0 partner=-',
  'before: k-r and k-t have three tier 1 candidates each; x-s fits k-s by amount but, six days away, is not one');
select pg_temp.call('dismiss-r', format('select public.dismiss_card_payment_candidate(%L, %L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-r'), pg_temp.tid('x-r'), pg_temp.iv()));
select pg_temp.call('dismiss-t', format('select public.dismiss_card_payment_candidate(%L, %L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-t'), pg_temp.tid('y-t'), pg_temp.iv()));
select th.assert(pg_temp.called('dismiss-r') = 'saved' and pg_temp.called('dismiss-t') = 'saved'
                 and pg_temp.competitors('k-r') = 'y-r,z-r' and pg_temp.competitors('k-t') = 'x-t,z-t'
                 and (select bool_and(pg_temp.srep('k-' || s) = 'unresolved/ambiguous/null partner=-') from unnest(array['r', 's', 't']) s),
  'before: both dismissals are saved; k-r is left tied between two KEPT cards, k-t between the removed card and kept card Z; the three payments are unresolved');

-- ---- The removal of aa's Card Bank ----------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000001');
select pg_temp.observe('right after the removal', array['k-a', 'k-b', 'k-cn', 'k-cd', 'k-ca', 'k-cp', 'k-d1', 'k-e', 'k-g', 'k-n', 'k-p', 'k-p2', 'k-r', 'k-s', 'k-t', 'k-m']);

-- A. The two-way tie.
select pg_temp.req('A', 'the removal recorded the ambiguity: one system hold on the two legs that are left, card leg first, with the removed candidate''s date',
  (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_card' and d.a_plaid_transaction_id = 'y-a' and d.a_cents = -70000 and d.a_account_id = pg_temp.y()::uuid
                                    and d.b_account_id = pg_temp.c()::uuid and d.b_cents = 70000 and d.counterpart_date = '2026-09-11' and d.superseded_by is null
                                    and d.accepted_difference_cents is null and d.counterpart_status is null and d.user_id = pg_temp.aa())
   from public.card_payment_decisions d where d.b_plaid_transaction_id = 'k-a'));
select pg_temp.req('A', 'the payment is NOT matched to the card that is left: both legs still unresolved, each other''s candidate',
  pg_temp.srep('k-a') = 'unresolved/ambiguous/null partner=-' and pg_temp.srep('y-a') = 'unresolved/ambiguous/0 partner=-'
  and pg_temp.competitors('k-a') = 'y-a' and pg_temp.competitors('y-a') = 'k-a');
select pg_temp.req('A', 'the hold publishes no effect and is no leg''s decision: the payment keeps its range {−700, 0}', pg_temp.unresolved_range('k-a', 70000)
  and pg_temp.leg('y-a')->>'decisionId' is null);
select pg_temp.call('undo-hold', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(), pg_temp.hold_id('k-a'), pg_temp.iv()));
select pg_temp.req('A', 'it is a system record that applies (active), not the user''s to undo',
  pg_temp.dstatus(pg_temp.hold_id('k-a')) = 'active'
  and pg_temp.called('undo-hold') like 'refused: card_payment_invalid: undo_card_payment_decision: system_decision%'
  and (select superseded_by is null from public.card_payment_decisions where id = pg_temp.hold_id('k-a')));

-- B. Three candidates, one removed.
select pg_temp.req('B', 'a hold for each of the two candidates that are left', pg_temp.holds('k-b') = 'removed_card:y-b@2026-09-11,removed_card:z-b@2026-09-11');
select pg_temp.req('B', 'still unresolved: the two that are left tie by themselves', pg_temp.unresolved_range('k-b', 71000) and pg_temp.competitors('k-b') = 'y-b,z-b');

-- N. No removed candidate: nothing for the removal to preserve.
select pg_temp.req('N', 'a tie between two KEPT cards is not held: the removal writes nothing for it',
  pg_temp.holds('k-n') = 'none' and not exists (select 1 from public.card_payment_decisions d where 'k-n' in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)));

-- P. The kept card was strictly closer than the removed one; the payment was unresolved for another reason.
select pg_temp.req('P', 'the hold carries the REMOVED candidate''s date, for each payment that had it as a candidate',
  pg_temp.holds('k-p') = 'removed_card:y-p@2026-09-13' and pg_temp.holds('k-p2') = 'removed_card:y-p@2026-09-13');
select pg_temp.req('P', 'unresolved as before (the kept card''s leg still fits two payments)',
  pg_temp.srep('k-p') = 'unresolved/ambiguous/null partner=-' and pg_temp.srep('k-p2') = 'unresolved/ambiguous/null partner=-');

-- R, S, T. A candidate, removed or kept, is the evaluator's tier 1 edge: at most five days away, and not dismissed.
select pg_temp.req('R', 'a removed leg that the user had dismissed against the payment is not a removed candidate: the tie is between two KEPT cards, and the removal writes no hold',
  pg_temp.holds('k-r') = 'none');
select pg_temp.req('S', 'a removed leg that fits by amount but is six days from the payment is not a removed candidate either: no hold',
  pg_temp.holds('k-s') = 'none');
select pg_temp.req('T', 'a kept leg that the user had dismissed against the payment is not a competitor: the one hold is on the pair with the other kept card, none on the dismissed pair',
  pg_temp.holds('k-t') = 'removed_card:z-t@2026-09-11');

-- M. The mirror: a card leg that a removed CASH leg and a kept cash leg both fitted.
select pg_temp.req('M', 'the hold is of the other kind, on the same two-leg shape (card leg first), with the removed cash leg''s date',
  pg_temp.holds('k-m') = 'removed_cash_account:y-m@2026-09-23');
select pg_temp.req('M', 'the kept payment is NOT read as tracked: unresolved, a range; the card leg unresolved, 0',
  pg_temp.unresolved_range('k-m', 80000) and pg_temp.srep('y-m') = 'unresolved/ambiguous/0 partner=-');

-- The cases that continue below are held too.
select pg_temp.req('C-new', 'held through the removal', pg_temp.unresolved_range('k-cn', 72000) and pg_temp.holds('k-cn') = 'removed_card:y-cn@2026-09-11');
select pg_temp.req('C-date', 'held through the removal', pg_temp.unresolved_range('k-cd', 73000) and pg_temp.holds('k-cd') = 'removed_card:y-cd@2026-09-12');
select pg_temp.req('C-amount', 'held through the removal', pg_temp.unresolved_range('k-ca', 74000) and pg_temp.holds('k-ca') = 'removed_card:y-ca@2026-09-11');
select pg_temp.req('C-posted', 'held through the removal, on the pending row''s own id', pg_temp.unresolved_range('k-cp', 75000) and pg_temp.holds('k-cp') = 'removed_card:y-cp@2026-09-11');
select pg_temp.req('D', 'held through the removal', pg_temp.unresolved_range('k-d1', 76000) and pg_temp.unresolved_range('k-d2', 85000) and pg_temp.unresolved_range('k-d3', 86000));
select pg_temp.req('E', 'held through the removal', pg_temp.unresolved_range('k-e', 77000) and pg_temp.holds('k-e') = 'removed_card:y-e@2026-09-11');

-- F. Ownership: the other user is untouched, then gets their own.
select pg_temp.req('F', 'another user is untouched by this removal: no decision, the same version, still their own tie',
  not exists (select 1 from public.card_payment_decisions d where d.user_id = pg_temp.bb())
  and pg_temp.iv(pg_temp.bb()) = (select iv from bb_before) and pg_temp.srep('b-k', pg_temp.bb()) = 'unresolved/ambiguous/null partner=-');
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select pg_temp.req('F', 'the other user''s removal holds their own tie, on their own accounts',
  (select count(*) = 1 and bool_and(d.kind = 'ambiguity_hold_removed_card' and d.a_plaid_transaction_id = 'by-k' and d.b_plaid_transaction_id = 'b-k')
   from public.card_payment_decisions d where d.user_id = pg_temp.bb())
  and pg_temp.srep('b-k', pg_temp.bb()) = 'unresolved/ambiguous/null partner=-');
select pg_temp.req('F', 'no hold names an account of a user other than its own',
  not exists (select 1 from public.card_payment_decisions d
              join public.accounts a on a.id in (d.a_account_id, d.b_account_id) join public.plaid_items i on i.id = a.item_id
              where i.user_id <> d.user_id));
select pg_temp.call('foreign-hold',
  $q$ insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, counterpart_date)
      values ('00000000-0000-0000-0000-0000000000aa', 'ambiguity_hold_removed_card', '00000000-0000-0000-0000-0000000022c3', 'by-k', -70000,
              '00000000-0000-0000-0000-0000000022b1', 'k-a', 70000, '2026-09-11') returning '{}'::jsonb $q$);
select pg_temp.req('F', 'and none can be written across users', pg_temp.called('foreign-hold') like 'refused: card_payment_decision_foreign_account%');

-- ---- Later: nothing but the removal has happened → nothing is resolved --------------------------------
select pg_temp.evaluate();
select pg_temp.req('A', 'a later evaluation of unchanged evidence resolves nothing', pg_temp.unresolved_range('k-a', 70000));

-- ---- Later: genuinely new or changed evidence -------------------------------------------------------
-- B: one of the two kept candidates is withdrawn by the bank. The other is not thereby proven.
delete from public.transactions where plaid_transaction_id = 'z-b';
-- N: the same happens to the tie that had no removed candidate. That one resolves by the ordinary rule.
delete from public.transactions where plaid_transaction_id = 'z-n';
-- C-new: a new transaction on kept card Z, on the payment's own day (strictly closer than either old candidate).
select pg_temp.cardleg('z-cn', pg_temp.z(), -720, '2026-09-10');
-- C-date, step 1: the kept leg is re-dated to 09-08: two days from the payment, as the removed one was.
update public.transactions set date = '2026-09-08' where plaid_transaction_id = 'y-cd';
-- C-amount: the bank corrects both legs to 743.00.
update public.transactions set amount = 743 where plaid_transaction_id = 'k-ca';
update public.transactions set amount = -743 where plaid_transaction_id = 'y-ca';
-- C-posted: the pending payment posts, same amount, same day (the posted row names the pending id; the pending row goes).
select pg_temp.cardleg('k-cp-posted', pg_temp.c(), 750, '2026-09-10', false, 'k-cp');
delete from public.transactions where plaid_transaction_id = 'k-cp';
-- P: the bank corrects the second payment; the kept card's leg now fits only the first.
update public.transactions set amount = 799 where plaid_transaction_id = 'k-p2';
-- M, step 1: the kept cash leg is re-dated to 09-24: four days from the card leg, farther than the removed one was.
update public.transactions set date = '2026-09-24' where plaid_transaction_id = 'k-m';
select pg_temp.evaluate();
select pg_temp.observe('after later evidence', array['k-b', 'k-n', 'k-cn', 'k-cd', 'k-ca', 'k-cp-posted', 'k-p', 'k-m']);

select pg_temp.req('B', 'when one of the two kept candidates drops out, the other is not thereby proven: still unresolved', pg_temp.unresolved_range('k-b', 71000));
select pg_temp.req('N', 'without a hold the same change resolves by the ordinary rule', pg_temp.srep('k-n') = 'tracked/auto_pair/0 partner=y-n');
select pg_temp.req('C-new', 'a NEW, strictly closer transaction pairs by the ordinary rule: the hold is not a reservation of the payment',
  pg_temp.srep('k-cn') = 'tracked/auto_pair/0 partner=z-cn' and pg_temp.srep('y-cn') like 'unresolved/%partner=-');
select pg_temp.req('C-date', 'a date change that leaves the kept leg no closer than the removed one was changes nothing', pg_temp.unresolved_range('k-cd', 73000));
select pg_temp.req('C-amount', 'a corrected amount is new evidence: the hold no longer applies, and the two legs pair by the ordinary rule',
  pg_temp.srep('k-ca') = 'tracked/auto_pair/0 partner=y-ca' and pg_temp.dstatus(pg_temp.hold_id('k-ca')) = 'inactive/amount_changed');
select pg_temp.req('C-posted', 'the same payment posting with the same amount is not new evidence: the hold follows it',
  pg_temp.unresolved_range('k-cp-posted', 75000) and pg_temp.dstatus(pg_temp.hold_id('k-cp')) = 'active');
select pg_temp.req('P', 'the kept card was strictly closer than the removed one all along: once the other payment no longer fits, the pair forms — the removal never stood in its way',
  pg_temp.srep('k-p') = 'tracked/auto_pair/0 partner=y-p');
select pg_temp.req('M', 'a date change that leaves the kept cash leg no closer to the card leg than the removed one was changes nothing',
  pg_temp.srep('k-m') = 'unresolved/ambiguous/null partner=-' and pg_temp.srep('y-m') = 'unresolved/ambiguous/0 partner=-');

-- C-date, step 2: re-dated to 09-11, one day from the payment — strictly closer than the removed candidate (two days).
update public.transactions set date = '2026-09-11' where plaid_transaction_id = 'y-cd';
-- M, step 2: the kept cash leg is re-dated to 09-22: two days from the card leg, the removed one was three.
update public.transactions set date = '2026-09-22' where plaid_transaction_id = 'k-m';
select pg_temp.evaluate();
select pg_temp.req('C-date', 'a date change that brings the kept leg strictly closer than the removed one was releases the pair', pg_temp.srep('k-cd') = 'tracked/auto_pair/0 partner=y-cd');
select pg_temp.req('M', 'the mirror releases the same way, measured from the CARD leg (the leg the removed candidate competed for)',
  pg_temp.srep('k-m') = 'tracked/auto_pair/0 partner=y-m' and pg_temp.srep('y-m') = 'paired/auto_pair/0 partner=k-m');

-- ---- D. An explicit user decision wins --------------------------------------------------------------
select pg_temp.call('link', format('select public.link_card_payment(%L, %L, %L, 0, %s)', pg_temp.aa(), pg_temp.tid('k-d1'), pg_temp.tid('y-d1'), pg_temp.iv()));
select pg_temp.req('D', 'the user confirms the kept card: saved, and it decides the payment',
  pg_temp.called('link') = 'saved' and pg_temp.srep('k-d1') = 'tracked/user_pair/0 partner=y-d1');
select pg_temp.req('D', 'the hold neither blocked the confirmation nor conflicts with it, and is left in place',
  (select pg_temp.dstatus(d.id) = 'active' from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-d1')
  and pg_temp.holds('k-d1') = 'removed_card:y-d1@2026-09-11');
select pg_temp.call('undo-own', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(),
  (select d.id from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-d1'), pg_temp.iv()));
select pg_temp.req('D', 'when the user undoes their own confirmation, the pair is withheld again, as before they decided',
  pg_temp.called('undo-own') = 'undone' and pg_temp.unresolved_range('k-d1', 76000));
select pg_temp.call('mark', format('select public.mark_card_payment_destination(%L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-d2'), pg_temp.iv()));
select pg_temp.req('D', '"a card I haven''t linked" decides too',
  pg_temp.called('mark') = 'saved' and pg_temp.srep('k-d2') = 'untracked/user_confirmed_unlinked/-85000 partner=-');
select pg_temp.call('dismiss', format('select public.dismiss_card_payment_candidate(%L, %L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-d3'), pg_temp.tid('y-d3'), pg_temp.iv()));
select pg_temp.req('D', 'dismissing the candidate works as without a hold',
  pg_temp.called('dismiss') = 'saved' and pg_temp.srep('k-d3') = 'unresolved/no_candidate/null partner=-');

-- ---- E. The card is linked again: new institution, new account, new Plaid ids -------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000007', pg_temp.aa(), 'harness-item-a7', 'placeholder-token-a7', 'Card Bank (relinked)');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000022d1', '00000000-0000-0000-0000-000000000007', 'a22-x2', 'Card X (relinked)', 'credit');
select pg_temp.cardleg('x2-e', '00000000-0000-0000-0000-0000000022d1', -770, '2026-09-11'), pg_temp.cardleg('x2-g', '00000000-0000-0000-0000-0000000022d1', -810, '2026-09-11');
select pg_temp.evaluate();
select pg_temp.req('E', 'after a relink the re-imported leg and the kept card''s leg tie again, by the ordinary rule: the hold creates no pair',
  pg_temp.unresolved_range('k-e', 77000) and pg_temp.competitors('k-e') = 'x2-e,y-e');
delete from public.transactions where plaid_transaction_id = 'y-e';
select pg_temp.evaluate();
select pg_temp.req('E', 'when the kept card''s leg is then withdrawn, the payment pairs with the re-imported leg: the hold does not stand in the way',
  pg_temp.srep('k-e') = 'tracked/auto_pair/0 partner=x2-e');
select pg_temp.observe('after the relink', array['k-e', 'k-g']);

-- ---- G. A second removal with the same ambiguity ----------------------------------------------------
select pg_temp.req('G', 'before the second removal the tie is back: the kept card''s leg and the re-imported one', pg_temp.unresolved_range('k-g', 81000) and pg_temp.competitors('k-g') = 'x2-g,y-g');
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000007');
select pg_temp.req('G', 'the second removal writes no second hold for the same ambiguity, and the payment is still unresolved',
  (select count(*) = 1 from public.card_payment_decisions d where d.b_plaid_transaction_id = 'k-g') and pg_temp.holds('k-g') = 'removed_card:y-g@2026-09-11'
  and pg_temp.unresolved_range('k-g', 81000));
select pg_temp.observe('at the end', array['k-a', 'k-b', 'k-d1', 'k-e', 'k-g']);

-- ---- The verdict ------------------------------------------------------------------------------------
\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only on
select 'OBSERVED', moment, leg, what from observed order by seq;
select 'OBSERVED', 'ambiguity holds at the end', d.kind, d.a_plaid_transaction_id || ' / ' || d.b_plaid_transaction_id || ' @ ' || d.counterpart_date
       || case when d.superseded_by is null then '' else ' (superseded)' end
from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' order by d.user_id, d.b_plaid_transaction_id collate "C", d.a_plaid_transaction_id collate "C";
select 'CONTRACT ' || case when ok then 'ok      ' else 'VIOLATED' end, kase, requirement from contract order by seq;
select 'CONTRACT SUMMARY', count(*) filter (where ok) || ' of ' || count(*) || ' requirements hold',
       coalesce('violated in: ' || string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none violated') from contract;
select th.assert((select bool_and(ok) from contract),
  'institution removal is not evidence: an unresolved tie stays unresolved until new evidence or the user decides; violated in: '
  || (select coalesce(string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none') || ' (' || count(*) filter (where not ok) || ' of ' || count(*) || ' requirements)' from contract));

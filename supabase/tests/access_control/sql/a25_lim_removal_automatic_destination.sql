-- A payment that was AUTOMATICALLY matched to a card of the removed institution is not automatically switched to
-- another card that was already there (Phase B I3A revision 5; Trevor's decision "Option B" of 2026-10-06 on the
-- point the revision 4 handoff left open; 20261006110000 and 20261006120000).
--
-- The contract. Institution removal is not new financial evidence.
--   * CASE 2 — previously RESOLVED by automatic matching to the card being removed. The removal preserves the
--     known removed destination (the system record destination_removed_card) and its financial treatment
--     (untracked, −amount). A card leg that was ALREADY THERE and merely fitted less well must not take the
--     payment by tier 1 solely because the original destination disappeared.
--   * CASE 1 — genuinely UNRESOLVED before the removal (a tie). It stays unresolved. It gets NO destination.
--     The two states stay distinct: known removed-destination evidence is not collapsed into an ambiguity.
--   * The protection is PAIR-SPECIFIC and of SYSTEM strength: the existing ambiguity hold, on the pair of the
--     surviving payment and the pre-existing competitor, carrying the date of a candidate that was removed. It
--     claims no leg and publishes nothing. Genuinely NEW bank evidence is evaluated by the ordinary rules, and
--     so is genuinely CHANGED evidence (an amount; a date that brings the competitor strictly closer than the
--     removed one was). A relinked card matches again where its re-imported leg is the closest, as the
--     removed one was (H, O2). An explicit user decision wins.
--   * No protection is written where there is nothing to protect against.
--
-- User aa. Item 1 "Card Bank" (cards X and EXCLUDED XE, checking R) is REMOVED. Item 3 "Kept Bank" survives:
-- checking C, EXCLUDED checking CE, cards Y and Z, EXCLUDED card E. Every case has its own amount. Dates are days
-- of 2026-09; "d" is the distance from the payment.
--
--   case    payment            removed leg(s)                kept leg(s)               what is exercised
--   A       k-a  +100 C 10     x-a −100 X 11 (d1)            y-a −100 Y 13 (d3)        THE APPROVED EXAMPLE
--   B       k-b  +110 C 10     x-b −110 X 11                 —                         no competitor
--   C       k-c  +120 C 10     x-c −120 X 11                 y-c −120 Y 11             CASE 1: a tie
--   D       k-d  +130 C 10     x-d −130 X 10 (d0)            y-d Y 12, z-d Z 13        several competitors
--   E       k-e  +140 C 10     x-e −140 X 12 (d2)            y-e −140 Y 14 (d4)        later: NEW evidence
--   E2      k-e2 +150 C 10     x-e2 −150 X 11                y-e2 −150 Y 13            later: a new, EQUALLY close leg
--   F-date  k-fd +160 C 10     x-fd −160 X 12 (d2)           y-fd −160 Y 14 (d4)       later: the competitor is re-dated
--   F-amt   k-fa +170 C 10     x-fa −170 X 11                y-fa −170 Y 13            later: both amounts corrected
--   F-own   k-fo +180 C 10     x-fo −180 X 11                y-fo −180 Y 13            later: only the payment corrected
--   G       k-g  +190 C 10 pending   x-g −190 X 11           y-g −190 Y 13             later: posts unchanged
--   G-card  k-gc +360 C 10     x-gc −360 X 11                y-gc −360 Y 13 pending    later: the kept leg posts unchanged
--   G-two   k-gt +200 C 10 pending   x-gt −200 X 09 (d1), x2-gt −200 X 13 (d3)   y-gt −200 Y 14 (d4)
--                                                                                      later: posts on the 12th
--   G-date  k-gd +210 C 10 pending   x-gd −210 X 10 (d0)     y-gd −210 Y 12 (d2)       later: posts on the 12th
--   H       k-h  +220 C 10     x-h −220 X 11                 y-h −220 Y 13             later: relink, 2nd removal
--   I       k-i  +230 C 10     x-i −230 X 11, CONFIRMED BY THE USER   y-i −230 Y 13    a user confirmation
--   J-link / J-mark / J-dis    k-jl +240, k-jm +250, k-jd +260 (x-… d1, y-… d3)        later: the user decides
--   K-xe    k-kx +270 C 10     xe-kx −270 XE 11 (EXCLUDED)   y-kx −270 Y 13            the removed card was excluded
--   K-ce    kc-kc +280 CE 10 (EXCLUDED)   x-kc −280 X 11     y-kc −280 Y 13            the payment's account is excluded
--   K-e     k-ke +290 C 10     x-ke −290 X 11                e-ke −290 E 13 (EXCLUDED) the competitor is excluded
--   L       card leg y-l −300 Y 10; removed CASH r-l +300 R 11 (d1); kept cash k-l +300 C 13 (d3)   the mirror
--   O       k-o  +310 C 10     x-o −310 X 10 (d0)            y-o −310 Y 12 (d2)        later: new evidence outranks
--   O2      k-o2 +320 C 10     x-o2 −320 X 10 (d0)           y-o2 −320 Y 13 (d3)       later: relink, 2nd removal
--   O3      k-o3 +350 C 10     x-o3 −350 X 10 (d0)           — (later: the relinked card's leg and a NEW kept
--                                                              leg, both on the 12th: a tie behind the record)
--   P       k-p  +330 C 10     x-p −330 X 12 (d2)            y-p −330 Y 10 (d0)        the automatic match STAYS
--   Q       k-q  +340 C 10     x-q −340 X 11                 y-q −340 Y 17 (d7)        the kept leg is no tier 1 candidate
-- NOT PART OF THE CONTRACT — OPEN QUESTION 7 (PHASE_B_I3A_LIM_REMOVAL_MATCHING.md §9.3), recorded and not decided:
-- what a held payment reads after the removed institution is linked again and no pair with the re-imported
-- leg forms. The hold still judges its own pair against the removed leg's STORED date. Today's reading is kept
-- in a table of its own and asserted after the contract's verdict, under its own message.
--   OQ7     k-q7  +370 C 10    x-q7  −370 X 11 (d1)          y-q7  −370 Y 12 (d2)      later: relinked; the leg comes back on the 14th (d4)
--   OQ7-dis k-q7d +380 C 10    x-q7d −380 X 11 (d1)          y-q7d −380 Y 12 (d2)      later: relinked (the 11th); the user dismisses it
-- User bb (N). Item 2 (card BX) is REMOVED; item 5 survives (checking BC, card BY). The amounts and dates of aa's A:
--           b-k  +100 BC 10    bx-k −100 BX 11               by-k −100 BY 13
--
-- The second removal (H, O2, O3) is read against 20261008120000_card_payment_removal_provenance.sql (one system row
-- per source): a removal writes a record for the automatic match it deletes and a hold for each candidate it
-- deletes, and merges neither into a row an earlier removal wrote; each row has a provenance row naming the leg
-- its own removal deleted; and the payment reads as with one record and one hold. Against 20261006120000 alone
-- (EXCLUDE=20261008120000_card_payment_removal_provenance.sql) the file runs to its verdict and H, O2 and O3 are
-- violated: that body wrote no second record and no second hold with the same date, and it has no provenance.
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
-- One of them: the first by card leg and date, and among holds that differ only in their source the least id.
create function pg_temp.hold_id(p_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and p_plaid in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)
  order by d.a_plaid_transaction_id collate "C", d.counterpart_date, d.id limit 1 $$;
-- The live system destination records on a cash leg's own Plaid id, and one record's id: with several (a second
-- removal writes its own), the least — the one a leg names while they all apply.
create function pg_temp.records(p_plaid text) returns bigint language sql as $$
  select count(*) from public.card_payment_decisions d
  where d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid $$;
create function pg_temp.record_id(p_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid
  order by d.id limit 1 $$;
-- ---- Provenance (20261008120000), read so that this file also RUNS where its tables do not exist ----------
create function pg_temp.has_provenance() returns boolean language sql as $$
  select to_regclass('public.card_payment_removal_sources') is not null
         and to_regclass('public.card_payment_removal_generations') is not null $$;
-- The live decisions a removal wrote that name a Plaid id as either leg, each with its source, sorted:
--   kind(card-or-surviving leg[/other leg][@removed date])<=removed item:removed account:removed transaction[relation]
-- ("-" for the transaction when the source had no single row; the relation is confirmed, partner or candidate;
-- "NO SOURCE" for a decision without a provenance row). "NO PROVENANCE TABLES" where the tables do not exist.
create function pg_temp.deps(p_plaid text, p_user uuid default pg_temp.aa()) returns text language plpgsql as $$
declare
  v text;
begin
  if not pg_temp.has_provenance() then return 'NO PROVENANCE TABLES'; end if;
  execute $q$
    select coalesce(string_agg(q.x, ' ; ' order by q.x collate "C"), 'none')
    from (select replace(replace(d.kind, 'ambiguity_hold_', 'hold_'), 'destination_removed_card', 'record')
                 || '(' || d.a_plaid_transaction_id || coalesce('/' || d.b_plaid_transaction_id, '') || coalesce('@' || d.counterpart_date, '') || ')<='
                 || coalesce(r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || coalesce(s.source_plaid_transaction_id, '-')
                             || '[' || replace(replace(replace(s.source_relation, 'confirmed_counterpart', 'confirmed'),
                                                       'automatic_partner', 'partner'), 'removed_candidate', 'candidate') || ']',
                             'NO SOURCE') as x
          from public.card_payment_decisions d
          left join public.card_payment_removal_sources s on s.decision_id = d.id
          left join public.plaid_item_removals r on r.id = s.removal_id
          where d.user_id = $2 and d.superseded_by is null
            and d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
            and $1 in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)) q $q$
  into v using p_plaid, p_user;
  return v;
end $$;
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

-- ---- Open question 7: today's reading, recorded apart from the contract (see the header) --------------
create temporary table open_question_7 (seq integer generated always as identity, what text not null, today boolean not null);
create function pg_temp.oq7(p_what text, p_today boolean) returns void language sql as $$
  insert into pg_temp.open_question_7 (what, today) values (p_what, coalesce(p_today, false)) $$;

-- ---- The contract's checks: recorded, all printed, asserted together at the end -----------------------
create temporary table contract (seq integer generated always as identity, kase text not null, requirement text not null, ok boolean not null);
create function pg_temp.req(p_case text, p_requirement text, p_ok boolean) returns void language sql as $$
  insert into pg_temp.contract (kase, requirement, ok) values (p_case, p_requirement, coalesce(p_ok, false)) $$;
create temporary table observed (seq integer generated always as identity, moment text not null, leg text not null, what text not null);
create function pg_temp.observe(p_moment text, p_legs text[], p_user uuid default pg_temp.aa()) returns void language sql as $$
  insert into pg_temp.observed (moment, leg, what)
  select p_moment, p, coalesce(pg_temp.srep(p, p_user), '(no current leg)') || '  decision=' || coalesce(pg_temp.holder_kind(p, p_user), '-') || '  holds=' || pg_temp.holds(p)
  from unnest(p_legs) with ordinality as u(p, n) order by n $$;
-- CASE 2 as a reader sees it: the payment counts as money that went to a card that was removed — untracked,
-- −cents, no partner — and the decision named on it is the SYSTEM record, not a user decision.
create function pg_temp.removed_destination(p_plaid text, p_cents bigint, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select pg_temp.srep(p_plaid, p_user) = 'untracked/removed_card/' || (-p_cents)::text || ' partner=-'
         and (l->>'lowCents')::bigint = -p_cents and (l->>'highCents')::bigint = -p_cents
         and pg_temp.holder_kind(p_plaid, p_user) = 'destination_removed_card'
  from pg_temp.leg(p_plaid, p_user) l $$;
-- CASE 1 as a reader sees it: unresolved by a tier-1-shaped ambiguity, the range {−cents, 0}, no decision.
create function pg_temp.unresolved_range(p_plaid text, p_cents bigint, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select pg_temp.srep(p_plaid, p_user) = 'unresolved/ambiguous/null partner=-'
         and (l->>'lowCents')::bigint = -p_cents and (l->>'highCents')::bigint = 0 and l->>'decisionId' is null and l->>'detail' is null
  from pg_temp.leg(p_plaid, p_user) l $$;
-- The competitor that was already there, as it must read afterwards: unmatched, no decision.
create function pg_temp.unmatched(p_plaid text, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select coalesce(l->>'partnerTransactionId' is null and l->>'decisionId' is null and l->>'state' in ('unresolved', 'not_counted'), false)
  from pg_temp.leg(p_plaid, p_user) l $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'BB Kept Bank');
update public.plaid_items set institution_name = 'Card Bank' where id = '00000000-0000-0000-0000-000000000001';
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-0000000025a1', '00000000-0000-0000-0000-000000000001', 'a25-x', 'Card X', 'credit', false),
  ('00000000-0000-0000-0000-0000000025a2', '00000000-0000-0000-0000-000000000001', 'a25-xe', 'Card XE (excluded)', 'credit', true),
  ('00000000-0000-0000-0000-0000000025a3', '00000000-0000-0000-0000-000000000001', 'a25-r', 'Removed Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000025b1', '00000000-0000-0000-0000-000000000003', 'a25-c', 'Kept Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000025b2', '00000000-0000-0000-0000-000000000003', 'a25-ce', 'Kept Checking CE (excluded)', 'depository', true),
  ('00000000-0000-0000-0000-0000000025b3', '00000000-0000-0000-0000-000000000003', 'a25-y', 'Kept Card Y', 'credit', false),
  ('00000000-0000-0000-0000-0000000025b4', '00000000-0000-0000-0000-000000000003', 'a25-z', 'Kept Card Z', 'credit', false),
  ('00000000-0000-0000-0000-0000000025b5', '00000000-0000-0000-0000-000000000003', 'a25-e', 'Kept Card E (excluded)', 'credit', true),
  ('00000000-0000-0000-0000-0000000025c2', '00000000-0000-0000-0000-000000000002', 'a25-bx', 'BB Card BX', 'credit', false),
  ('00000000-0000-0000-0000-0000000025c1', '00000000-0000-0000-0000-000000000005', 'a25-bc', 'BB Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000025c3', '00000000-0000-0000-0000-000000000005', 'a25-by', 'BB Kept Card BY', 'credit', false);
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025a1' $$;
create function pg_temp.xe() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025a2' $$;
create function pg_temp.r() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025a3' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025b1' $$;
create function pg_temp.ce() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025b2' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025b3' $$;
create function pg_temp.z() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025b4' $$;
create function pg_temp.e() returns text language sql as $$ select '00000000-0000-0000-0000-0000000025b5' $$;

-- The plain shape: the payment on C on the 10th, a leg on the removed card X, a leg on the kept card Y.
select pg_temp.cardleg('k-' || s, pg_temp.c(), amt, '2026-09-10', pending), pg_temp.cardleg('x-' || s, pg_temp.x(), -amt, xd::date), pg_temp.cardleg('y-' || s, pg_temp.y(), -amt, yd::date)
from (values ('a', 100, '2026-09-11', '2026-09-13', false), ('c', 120, '2026-09-11', '2026-09-11', false), ('d', 130, '2026-09-10', '2026-09-12', false),
             ('e', 140, '2026-09-12', '2026-09-14', false), ('e2', 150, '2026-09-11', '2026-09-13', false), ('fd', 160, '2026-09-12', '2026-09-14', false),
             ('fa', 170, '2026-09-11', '2026-09-13', false), ('fo', 180, '2026-09-11', '2026-09-13', false), ('g', 190, '2026-09-11', '2026-09-13', true),
             ('gt', 200, '2026-09-09', '2026-09-14', true), ('gd', 210, '2026-09-10', '2026-09-12', true), ('h', 220, '2026-09-11', '2026-09-13', false),
             ('i', 230, '2026-09-11', '2026-09-13', false), ('jl', 240, '2026-09-11', '2026-09-13', false), ('jm', 250, '2026-09-11', '2026-09-13', false),
             ('jd', 260, '2026-09-11', '2026-09-13', false), ('o', 310, '2026-09-10', '2026-09-12', false), ('o2', 320, '2026-09-10', '2026-09-13', false),
             ('p', 330, '2026-09-12', '2026-09-10', false), ('q', 340, '2026-09-11', '2026-09-17', false),
             ('q7', 370, '2026-09-11', '2026-09-12', false), ('q7d', 380, '2026-09-11', '2026-09-12', false)) v(s, amt, xd, yd, pending);
select pg_temp.cardleg('k-b', pg_temp.c(), 110, '2026-09-10'), pg_temp.cardleg('x-b', pg_temp.x(), -110, '2026-09-11');                                                      -- B
select pg_temp.cardleg('k-o3', pg_temp.c(), 350, '2026-09-10'), pg_temp.cardleg('x-o3', pg_temp.x(), -350, '2026-09-10');                                                    -- O3
select pg_temp.cardleg('z-d', pg_temp.z(), -130, '2026-09-13');                                                                                                            -- D: a second competitor
select pg_temp.cardleg('x2-gt', pg_temp.x(), -200, '2026-09-13');                                                                                                          -- G-two: a second removed leg
select pg_temp.cardleg('k-gc', pg_temp.c(), 360, '2026-09-10'), pg_temp.cardleg('x-gc', pg_temp.x(), -360, '2026-09-11'), pg_temp.cardleg('y-gc', pg_temp.y(), -360, '2026-09-13', true);   -- G-card: the kept card's leg is pending
select pg_temp.cardleg('k-kx', pg_temp.c(), 270, '2026-09-10'), pg_temp.cardleg('xe-kx', pg_temp.xe(), -270, '2026-09-11'), pg_temp.cardleg('y-kx', pg_temp.y(), -270, '2026-09-13');   -- K-xe
select pg_temp.cardleg('kc-kc', pg_temp.ce(), 280, '2026-09-10'), pg_temp.cardleg('x-kc', pg_temp.x(), -280, '2026-09-11'), pg_temp.cardleg('y-kc', pg_temp.y(), -280, '2026-09-13');   -- K-ce
select pg_temp.cardleg('k-ke', pg_temp.c(), 290, '2026-09-10'), pg_temp.cardleg('x-ke', pg_temp.x(), -290, '2026-09-11'), pg_temp.cardleg('e-ke', pg_temp.e(), -290, '2026-09-13');     -- K-e
select pg_temp.cardleg('y-l', pg_temp.y(), -300, '2026-09-10'), pg_temp.cardleg('r-l', pg_temp.r(), 300, '2026-09-11'), pg_temp.cardleg('k-l', pg_temp.c(), 300, '2026-09-13');         -- L
select pg_temp.cardleg('b-k', '00000000-0000-0000-0000-0000000025c1', 100, '2026-09-10'),                                                                                  -- bb
       pg_temp.cardleg('bx-k', '00000000-0000-0000-0000-0000000025c2', -100, '2026-09-11'),
       pg_temp.cardleg('by-k', '00000000-0000-0000-0000-0000000025c3', -100, '2026-09-13');
select pg_temp.evaluate();
-- I: the user confirms the automatic match, through the real RPC.
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-i'), pg_temp.tid('x-i'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, I: the user confirms k-i with x-i');

-- The fixture is what the header says.
select th.assert((select bool_and(pg_temp.srep('k-' || s) = 'tracked/auto_pair/0 partner=x-' || s and pg_temp.leg('k-' || s)->>'decisionId' is null)
                  from unnest(array['a', 'b', 'd', 'e', 'e2', 'fd', 'fa', 'fo', 'g', 'gc', 'gt', 'gd', 'h', 'jl', 'jm', 'jd', 'ke', 'o', 'o2', 'o3']) s),
  'before: every CASE 2 payment is matched AUTOMATICALLY to its leg on the removed card X, with no decision');
select th.assert((select bool_and(pg_temp.srep('y-' || s) = 'unresolved/ambiguous/0 partner=-' and pg_temp.competitors('y-' || s) = 'k-' || s)
                  from unnest(array['a', 'e', 'e2', 'fd', 'fa', 'fo', 'g', 'gc', 'gt', 'gd', 'h', 'jl', 'jm', 'jd', 'o', 'o2']) s),
  'before: the kept card''s leg also fits the payment, less well, and is left unmatched');
select th.assert((pg_temp.leg('y-gc')->>'pending')::boolean and not (pg_temp.leg('k-gc')->>'pending')::boolean,
  'before, G-card: the kept card''s leg is PENDING; the payment is posted');
select th.assert(pg_temp.unresolved_range('k-c', 12000) and pg_temp.competitors('k-c') = 'x-c,y-c', 'before, C: a genuine tie between the two cards — unresolved');
select th.assert(pg_temp.srep('k-i') = 'tracked/user_pair/0 partner=x-i' and pg_temp.holder_kind('k-i') = 'pair', 'before, I: a user-confirmed pair');
select th.assert(pg_temp.srep('k-kx') = 'untracked/partner_excluded/-27000 partner=xe-kx' and pg_temp.srep('kc-kc') = 'not_counted/excluded_account/0 partner=x-kc',
  'before, K: a payment matched automatically to an EXCLUDED removed card counts in full; a payment on an EXCLUDED account is matched and not counted');
select th.assert(pg_temp.srep('y-l') = 'paired/auto_pair/0 partner=r-l' and pg_temp.unresolved_range('k-l', 30000) and pg_temp.competitors('k-l') = 'y-l',
  'before, L: the kept card''s leg is matched automatically to the removed CASH leg; the kept payment also fits it, less well, and is unresolved');
select th.assert(pg_temp.srep('k-p') = 'tracked/auto_pair/0 partner=y-p', 'before, P: matched automatically to the card that STAYS; the removed card''s leg merely fitted less well');
select th.assert(pg_temp.srep('k-q') = 'tracked/auto_pair/0 partner=x-q' and pg_temp.srep('y-q') = 'unresolved/no_candidate/0 partner=-',
  'before, Q: matched automatically to X; the kept card''s leg is seven days away — outside the automatic window, not a candidate at all');
select th.assert(pg_temp.srep('b-k', pg_temp.bb()) = 'tracked/auto_pair/0 partner=bx-k', 'before, bb: the same shape as aa''s case A');
select th.assert((select count(*) = 1 and bool_and(kind = 'pair') from public.card_payment_decisions), 'before: one decision exists, the user''s pair of case I');
create temporary table bb_before as select pg_temp.iv(pg_temp.bb()) as iv;

-- ---- The removal of aa's Card Bank ----------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000001');
select pg_temp.observe('right after the removal', array['k-a', 'y-a', 'k-b', 'k-c', 'y-c', 'k-d', 'k-e', 'k-g', 'k-gc', 'y-gc', 'k-gt', 'k-gd', 'k-h', 'k-i', 'k-kx', 'kc-kc', 'y-kc', 'k-ke', 'y-l', 'k-l', 'k-o', 'k-o2', 'k-p']);

-- A. Previously automatic, with a surviving competitor that was already there.
select pg_temp.req('A', 'the historical destination is preserved: one system record on the payment (not a user decision)', pg_temp.records('k-a') = 1);
select pg_temp.req('A', 'the payment keeps the removed-card treatment: untracked, −100, named by the system record', pg_temp.removed_destination('k-a', 10000));
select pg_temp.req('A', 'it is NOT switched to the card that was already there: card Y''s leg is unmatched, exactly as before the removal',
  pg_temp.srep('y-a') = 'unresolved/ambiguous/0 partner=-' and pg_temp.competitors('y-a') = 'k-a' and pg_temp.leg('y-a')->>'decisionId' is null);
select pg_temp.req('A', 'the protection is pair-specific and of system strength: one ambiguity hold on exactly (y-a, k-a), with the removed destination''s date',
  pg_temp.holds('k-a') = 'removed_card:y-a/k-a@2026-09-11' and pg_temp.dstatus(pg_temp.hold_id('k-a')) = 'active');
select pg_temp.call('undo-hold', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(), pg_temp.hold_id('k-a'), pg_temp.iv()));
select pg_temp.call('undo-record', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(), pg_temp.record_id('k-a'), pg_temp.iv()));
select pg_temp.req('A', 'neither system record is the user''s to undo',
  pg_temp.called('undo-hold') like 'refused: card_payment_invalid: undo_card_payment_decision: system_decision%'
  and pg_temp.called('undo-record') like 'refused: card_payment_invalid: undo_card_payment_decision: system_decision%');

-- B. Previously automatic, no competitor: the record alone; nothing else is written.
select pg_temp.req('B', 'the payment counts as a removed-card payment', pg_temp.removed_destination('k-b', 11000));
select pg_temp.req('B', 'no hold is written where there is no competitor to protect against', pg_temp.holds('k-b') = 'none');

-- C. CASE 1 stays distinct from CASE 2.
select pg_temp.req('C', 'a payment that was a genuine tie stays unresolved, a range — it is not given the removed-card treatment',
  pg_temp.unresolved_range('k-c', 12000) and pg_temp.competitors('k-c') = 'y-c');
select pg_temp.req('C', 'and it gets NO destination record: only the hold on the pair that is left', pg_temp.records('k-c') = 0 and pg_temp.holds('k-c') = 'removed_card:y-c/k-c@2026-09-11');

-- D. Several surviving competitors.
select pg_temp.req('D', 'a hold for each competitor that was already there; the payment keeps its removed destination',
  pg_temp.holds('k-d') = 'removed_card:y-d/k-d@2026-09-10,removed_card:z-d/k-d@2026-09-10' and pg_temp.removed_destination('k-d', 13000)
  and pg_temp.unmatched('y-d') and pg_temp.unmatched('z-d'));

-- Open question 7 starts from the same place too (recorded apart from the contract).
select pg_temp.oq7('through the removal, ' || v.s || ': the approved outcome — the record, one hold on the kept pair with the removed leg''s date, the competitor unmatched',
  pg_temp.removed_destination('k-' || v.s, v.cents) and pg_temp.records('k-' || v.s) = 1 and pg_temp.holds('k-' || v.s) = 'removed_card:y-' || v.s || '/k-' || v.s || '@2026-09-11'
  and pg_temp.unmatched('y-' || v.s))
from (values ('q7', 37000), ('q7d', 38000)) v(s, cents);

-- The cases that continue below start from the same place.
select pg_temp.req(v.kase, 'through the removal: the removed destination is kept (record + pair-specific hold); the competitor is unmatched',
  pg_temp.removed_destination('k-' || v.s, v.cents) and pg_temp.records('k-' || v.s) = 1 and pg_temp.holds('k-' || v.s) = 'removed_card:y-' || v.s || '/k-' || v.s || '@' || v.d
  and pg_temp.unmatched('y-' || v.s))
from (values ('E', 'e', 14000, '2026-09-12'), ('E2', 'e2', 15000, '2026-09-11'), ('F-date', 'fd', 16000, '2026-09-12'), ('F-amt', 'fa', 17000, '2026-09-11'),
             ('F-own', 'fo', 18000, '2026-09-11'), ('G', 'g', 19000, '2026-09-11'), ('G-card', 'gc', 36000, '2026-09-11'), ('G-date', 'gd', 21000, '2026-09-10'), ('H', 'h', 22000, '2026-09-11'),
             ('J', 'jl', 24000, '2026-09-11'), ('J', 'jm', 25000, '2026-09-11'), ('J', 'jd', 26000, '2026-09-11'), ('O', 'o', 31000, '2026-09-10'),
             ('O2', 'o2', 32000, '2026-09-10')) v(kase, s, cents, d);
select pg_temp.req('G-two', 'through the removal: a hold for EACH candidate of the removed card (the partner on the 9th and the farther leg on the 13th); the removed destination is kept',
  pg_temp.removed_destination('k-gt', 20000) and pg_temp.holds('k-gt') = 'removed_card:y-gt/k-gt@2026-09-09,removed_card:y-gt/k-gt@2026-09-13' and pg_temp.unmatched('y-gt'));

-- I. A user-confirmed pair is the user's: preserved at user strength, not through system records.
select pg_temp.req('I', 'the user''s confirmation is preserved as the user''s decision and holds the leg: removed-card payment, −230',
  pg_temp.srep('k-i') = 'untracked/removed_card/-23000 partner=-' and pg_temp.holder_kind('k-i') = 'pair_counterpart_removed');
select pg_temp.req('I', 'no system record and no hold is written for a leg the user''s decision holds; the competitor is only a suggestion',
  pg_temp.records('k-i') = 0 and pg_temp.holds('k-i') = 'none' and pg_temp.unmatched('y-i')
  and exists (select 1 from jsonb_array_elements(pg_temp.leg('k-i')->'candidates') c
              where (c->>'transactionId')::uuid = pg_temp.tid('y-i') and (c->>'contradictsDecision')::boolean));

-- K. Excluded accounts.
select pg_temp.req('K-xe', 'the removed destination was an EXCLUDED card: the payment counted in full before (−270) and still does, as a removed-card payment; it is NOT switched to the included card that was already there (which would read tracked, 0)',
  pg_temp.removed_destination('k-kx', 27000) and pg_temp.holds('k-kx') = 'removed_card:y-kx/k-kx@2026-09-11' and pg_temp.unmatched('y-kx'));
select pg_temp.req('K-ce', 'the payment is on an EXCLUDED account: still not counted, with its record and its hold; the kept card''s leg is NOT read as funded by it',
  pg_temp.srep('kc-kc') = 'not_counted/excluded_account/0 partner=-' and pg_temp.holder_kind('kc-kc') = 'destination_removed_card' and pg_temp.records('kc-kc') = 1
  and pg_temp.holds('kc-kc') = 'removed_card:y-kc/kc-kc@2026-09-11' and pg_temp.srep('y-kc') = 'unresolved/ambiguous/0 partner=-');
select pg_temp.req('K-e', 'the competitor that was already there is on an EXCLUDED card: the payment keeps its removed destination and is not paired with it',
  pg_temp.removed_destination('k-ke', 29000) and pg_temp.holds('k-ke') = 'removed_card:e-ke/k-ke@2026-09-11'
  and pg_temp.srep('e-ke') = 'not_counted/excluded_account/0 partner=-');

-- L. The mirror: the CASH-side institution was removed.
select pg_temp.req('L', 'a kept card leg that was matched automatically to a removed cash leg is not switched to the kept payment that was already there: a hold of the removed-CASH kind on that pair',
  pg_temp.holds('k-l') = 'removed_cash_account:y-l/k-l@2026-09-11');
select pg_temp.req('L', 'the kept payment is NOT read as a tracked payment it never was: unresolved, a range {−300, 0}, exactly as before the removal',
  pg_temp.unresolved_range('k-l', 30000) and pg_temp.competitors('k-l') = 'y-l');
select pg_temp.req('L', 'the card leg gets no destination record (a credit-side leg never moves cash flow): unresolved, 0',
  pg_temp.srep('y-l') = 'unresolved/ambiguous/0 partner=-' and pg_temp.records('y-l') = 0 and pg_temp.leg('y-l')->>'decisionId' is null);

-- P. The automatic match stays: nothing is written.
select pg_temp.req('P', 'a payment matched to a card that STAYS gets no record and no hold, and reads as before',
  pg_temp.records('k-p') = 0 and pg_temp.holds('k-p') = 'none' and pg_temp.srep('k-p') = 'tracked/auto_pair/0 partner=y-p');

-- O3 starts like B: the record, and nothing else.
select pg_temp.req('O3', 'through the first removal: a removed-card payment with its record and no hold (nothing else fitted it)', pg_temp.removed_destination('k-o3', 35000) and pg_temp.holds('k-o3') = 'none');

-- Q. A kept leg outside the automatic window is not a competitor: the record, and nothing else.
select pg_temp.req('Q', 'a kept card leg that was no tier 1 candidate (seven days away) is not "a competitor that was already there": no hold; the payment keeps its removed destination',
  pg_temp.removed_destination('k-q', 34000) and pg_temp.holds('k-q') = 'none' and pg_temp.holds('y-q') = 'none');

-- N. Ownership: the other user — the same amounts on the same days — is untouched, then gets their own.
select pg_temp.req('N', 'another user is untouched by this removal: no decision, the same version, still their own automatic match',
  not exists (select 1 from public.card_payment_decisions d where d.user_id = pg_temp.bb())
  and pg_temp.iv(pg_temp.bb()) = (select iv from bb_before) and pg_temp.srep('b-k', pg_temp.bb()) = 'tracked/auto_pair/0 partner=bx-k');
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select pg_temp.req('N', 'the other user''s removal protects their own payment, on their own accounts',
  pg_temp.removed_destination('b-k', 10000, pg_temp.bb())
  and (select count(*) = 2 and count(*) filter (where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'b-k') = 1
              and count(*) filter (where d.kind = 'ambiguity_hold_removed_card' and d.a_plaid_transaction_id = 'by-k' and d.b_plaid_transaction_id = 'b-k' and d.counterpart_date = '2026-09-11') = 1
       from public.card_payment_decisions d where d.user_id = pg_temp.bb()));
select pg_temp.req('N', 'no system record or hold names an account of a user other than its own',
  not exists (select 1 from public.card_payment_decisions d
              join public.accounts a on a.id in (d.a_account_id, d.b_account_id) join public.plaid_items i on i.id = a.item_id
              where i.user_id <> d.user_id));
select pg_temp.call('foreign-hold',
  $q$ insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, counterpart_date)
      values ('00000000-0000-0000-0000-0000000000aa', 'ambiguity_hold_removed_card', '00000000-0000-0000-0000-0000000025c3', 'by-k', -10000,
              '00000000-0000-0000-0000-0000000025b1', 'k-a', 10000, '2026-09-11') returning '{}'::jsonb $q$);
select pg_temp.req('N', 'and none can be written across users', pg_temp.called('foreign-hold') like 'refused: card_payment_decision_foreign_account%');

-- ---- M. Later: nothing but the removals has happened → nothing changes --------------------------------
create temporary table after_removal as
  select p as leg, pg_temp.srep(p) || ' ' || pg_temp.holder_kind(p) || ' ' || pg_temp.competitors(p) || ' ' || pg_temp.holds(p) as reading
  from unnest(array['k-a', 'y-a', 'k-b', 'k-c', 'y-c', 'k-d', 'y-d', 'z-d', 'k-e', 'k-g', 'k-gt', 'k-gd', 'k-h', 'k-i', 'k-kx', 'kc-kc', 'y-kc', 'k-ke', 'y-l', 'k-l', 'k-o', 'k-o2', 'k-p']) p;
create temporary table decisions_after_removal as select count(*) as n, pg_temp.iv() as iv from public.card_payment_decisions;
select pg_temp.evaluate();
select pg_temp.evaluate();
select pg_temp.req('M', 'two further evaluations of unchanged evidence change no reading, write no decision and do not advance the input version',
  (select bool_and(a.reading = pg_temp.srep(a.leg) || ' ' || pg_temp.holder_kind(a.leg) || ' ' || pg_temp.competitors(a.leg) || ' ' || pg_temp.holds(a.leg)) from after_removal a)
  and (select d.n = (select count(*) from public.card_payment_decisions) and d.iv = pg_temp.iv() from decisions_after_removal d));

-- ---- Later: genuinely new or changed bank evidence ---------------------------------------------------
-- D: one of the two competitors is withdrawn by the bank. The other is not thereby proven.
delete from public.transactions where plaid_transaction_id = 'y-d';
-- E: a NEW transaction on kept card Z, one day from the payment — strictly closer than the old competitor.
select pg_temp.cardleg('z-e', pg_temp.z(), -140, '2026-09-11');
-- E2: a NEW transaction on Z exactly as far as the old competitor (3 days): a tie of its own.
select pg_temp.cardleg('z-e2', pg_temp.z(), -150, '2026-09-13');
-- F-date, step 1: the competitor is re-dated to the 8th — two days from the payment, as the removed leg was.
update public.transactions set date = '2026-09-08' where plaid_transaction_id = 'y-fd';
-- F-amt: the bank corrects both the payment and the kept card's leg to 173.00.
update public.transactions set amount = 173 where plaid_transaction_id = 'k-fa';
update public.transactions set amount = -173 where plaid_transaction_id = 'y-fa';
-- F-own: the bank corrects the payment alone, to 183.00 — 3.00 from its own old competitor, and more than 5.00
-- (the near-amount window) from every other case's leg.
update public.transactions set amount = 183 where plaid_transaction_id = 'k-fo';
-- G: the pending payment posts, same amount, same day.
select pg_temp.cardleg('k-g-posted', pg_temp.c(), 190, '2026-09-10', false, 'k-g');
delete from public.transactions where plaid_transaction_id = 'k-g';
-- G-card: the pending COMPETITOR posts, same amount, same day (the posted row names the pending id; the pending row goes).
select pg_temp.cardleg('y-gc-posted', pg_temp.y(), -360, '2026-09-13', false, 'y-gc');
delete from public.transactions where plaid_transaction_id = 'y-gc';
-- G-two, G-date: the pending payment posts with the same amount, dated the 12th.
select pg_temp.cardleg('k-gt-posted', pg_temp.c(), 200, '2026-09-12', false, 'k-gt'), pg_temp.cardleg('k-gd-posted', pg_temp.c(), 210, '2026-09-12', false, 'k-gd');
delete from public.transactions where plaid_transaction_id in ('k-gt', 'k-gd');
-- K-ce: the excluded checking account is included in cash flow again.
update public.accounts set exclude_from_cash_flow = false where id = pg_temp.ce()::uuid;
-- O: a NEW transaction on Z one day from the payment, strictly closer than the old competitor (2 days).
select pg_temp.cardleg('z-o', pg_temp.z(), -310, '2026-09-11');
select pg_temp.evaluate();
select pg_temp.observe('after later evidence', array['k-d', 'z-d', 'k-e', 'y-e', 'k-e2', 'k-fd', 'k-fa', 'k-fo', 'k-g-posted', 'k-gc', 'y-gc-posted', 'k-gt-posted', 'k-gd-posted', 'kc-kc', 'y-kc', 'k-o', 'y-o']);

select pg_temp.req('D', 'when one of the two competitors drops out, the other is not thereby proven: the payment keeps its removed destination',
  pg_temp.removed_destination('k-d', 13000) and pg_temp.unmatched('z-d'));
select pg_temp.req('E', 'a NEW, strictly closer transaction pairs by the ordinary rule — the protection is not a reservation of the payment; the record is dormant behind it',
  pg_temp.srep('k-e') = 'tracked/auto_pair/0 partner=z-e' and pg_temp.leg('k-e')->>'decisionId' is null and pg_temp.records('k-e') = 1 and pg_temp.unmatched('y-e'));
select pg_temp.req('E2', 'a NEW transaction no closer than the old competitor is a tie of its own: nothing pairs, and the payment keeps its removed destination',
  pg_temp.removed_destination('k-e2', 15000) and pg_temp.unmatched('y-e2') and pg_temp.unmatched('z-e2'));
select pg_temp.req('F-date', 'a date change that leaves the competitor no closer than the removed destination was changes nothing', pg_temp.removed_destination('k-fd', 16000) and pg_temp.unmatched('y-fd'));
select pg_temp.req('F-amt', 'corrected amounts are new evidence: neither the hold nor the record applies any more, and the two legs pair by the ordinary rule',
  pg_temp.srep('k-fa') = 'tracked/auto_pair/0 partner=y-fa' and pg_temp.dstatus(pg_temp.hold_id('k-fa')) = 'inactive/amount_changed'
  and pg_temp.dstatus(pg_temp.record_id('k-fa')) = 'inactive/amount_changed');
select pg_temp.req('F-own', 'a corrected payment is evaluated from current evidence alone: the old record is not proof of the new amount, and the old competitor no longer fits to the cent',
  pg_temp.srep('k-fo') = 'unresolved/amount_differs/null partner=-' and pg_temp.dstatus(pg_temp.record_id('k-fo')) = 'inactive/amount_changed');
select pg_temp.req('G', 'the same payment posting with the same amount on the same day is not new evidence: record and hold follow it',
  pg_temp.removed_destination('k-g-posted', 19000) and pg_temp.dstatus(pg_temp.hold_id('k-g')) = 'active' and pg_temp.unmatched('y-g'));
select pg_temp.req('G-card', 'the COMPETITOR posting with the same amount on the same day is not new evidence either: the hold follows the kept card''s leg, and the payment keeps its removed destination',
  pg_temp.removed_destination('k-gc', 36000) and pg_temp.dstatus(pg_temp.hold_id('k-gc')) = 'active' and pg_temp.unmatched('y-gc-posted'));
select pg_temp.req('G-two', 'posted two days later: the removed partner (the 9th) would now be farther than the competitor, but the removed card''s OTHER leg (the 13th) would be closer — the payment is still not switched',
  pg_temp.removed_destination('k-gt-posted', 20000) and pg_temp.unmatched('y-gt'));
select pg_temp.req('G-date', 'posted on the competitor''s own day: a date change is changed evidence, judged like any other — the competitor is now strictly closer than the removed destination was, and pairs',
  pg_temp.srep('k-gd-posted') = 'tracked/auto_pair/0 partner=y-gd');
select pg_temp.req('K-ce', 'when the payment''s account is later INCLUDED, it counts as a removed-card payment (−280) — it is NOT a tracked payment to the card that was already there',
  pg_temp.removed_destination('kc-kc', 28000) and pg_temp.unmatched('y-kc'));
select pg_temp.req('O', 'precedence: current automatic evidence that is genuinely NEW outranks the system record (tracked with the new leg); the old competitor is still unmatched',
  pg_temp.srep('k-o') = 'tracked/auto_pair/0 partner=z-o' and pg_temp.unmatched('y-o') and pg_temp.dstatus(pg_temp.record_id('k-o')) = 'active');

-- F-date, step 2: re-dated to the 11th — one day from the payment, strictly closer than the removed leg was (two).
update public.transactions set date = '2026-09-11' where plaid_transaction_id = 'y-fd';
select pg_temp.evaluate();
select pg_temp.req('F-date', 'a date change that brings the competitor strictly closer than the removed destination was releases the pair: not frozen for ever',
  pg_temp.srep('k-fd') = 'tracked/auto_pair/0 partner=y-fd');

-- ---- J. An explicit, newer user decision wins ---------------------------------------------------------
select pg_temp.call('link', format('select public.link_card_payment(%L, %L, %L, 0, %s)', pg_temp.aa(), pg_temp.tid('k-jl'), pg_temp.tid('y-jl'), pg_temp.iv()));
select pg_temp.req('J', 'the user confirms the card that was already there: saved, and it decides the payment',
  pg_temp.called('link') = 'saved' and pg_temp.srep('k-jl') = 'tracked/user_pair/0 partner=y-jl' and pg_temp.holder_kind('k-jl') = 'pair');
select pg_temp.req('J', 'neither system record blocked the confirmation or conflicts with it; both are left in place',
  (select pg_temp.dstatus(d.id) = 'active' from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-jl')
  and pg_temp.holds('k-jl') = 'removed_card:y-jl/k-jl@2026-09-11' and pg_temp.records('k-jl') = 1);
select pg_temp.call('undo-own', format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(),
  (select d.id from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-jl'), pg_temp.iv()));
select pg_temp.req('J', 'when the user undoes their own confirmation, the payment reads its removed destination again, as before they decided',
  pg_temp.called('undo-own') = 'undone' and pg_temp.removed_destination('k-jl', 24000) and pg_temp.unmatched('y-jl'));
select pg_temp.call('mark', format('select public.mark_card_payment_destination(%L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-jm'), pg_temp.iv()));
select pg_temp.req('J', '"a card I haven''t linked" decides too', pg_temp.called('mark') = 'saved' and pg_temp.srep('k-jm') = 'untracked/user_confirmed_unlinked/-25000 partner=-');
select pg_temp.call('dismiss', format('select public.dismiss_card_payment_candidate(%L, %L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-jd'), pg_temp.tid('y-jd'), pg_temp.iv()));
select pg_temp.req('J', 'dismissing the competitor works as without a hold; the payment keeps its removed destination',
  pg_temp.called('dismiss') = 'saved' and pg_temp.removed_destination('k-jd', 26000));

-- ---- H, O2. The card is linked again: new institution, new account, new Plaid ids; then removed again ----
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000007', pg_temp.aa(), 'harness-item-a7', 'placeholder-token-a7', 'Card Bank (relinked)');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000025d1', '00000000-0000-0000-0000-000000000007', 'a25-x2', 'Card X (relinked)', 'credit');
select pg_temp.cardleg('x2-h', '00000000-0000-0000-0000-0000000025d1', -220, '2026-09-11'), pg_temp.cardleg('x2-o2', '00000000-0000-0000-0000-0000000025d1', -320, '2026-09-11');
-- O3: the re-imported leg and a NEW leg on the kept card Y, both two days from the payment: a tie.
select pg_temp.cardleg('x2-o3', '00000000-0000-0000-0000-0000000025d1', -350, '2026-09-12'), pg_temp.cardleg('y-o3', pg_temp.y(), -350, '2026-09-12');
-- Open question 7: one re-imported leg comes back dated the 14th (four days from the payment; the kept card's
-- leg is two); the other comes back on its original date.
select pg_temp.cardleg('x2-q7', '00000000-0000-0000-0000-0000000025d1', -370, '2026-09-14'), pg_temp.cardleg('x2-q7d', '00000000-0000-0000-0000-0000000025d1', -380, '2026-09-11');
select pg_temp.evaluate();
select pg_temp.oq7('OQ7: relinked, the leg re-imported FARTHER away than the kept card''s leg — today the hold still withholds the kept pair by the stored date: the payment reads untracked / removed_card, -370, although both cards are linked; the kept leg and the re-imported leg are unmatched',
  pg_temp.removed_destination('k-q7', 37000) and pg_temp.dstatus(pg_temp.hold_id('k-q7')) = 'active' and pg_temp.unmatched('y-q7') and pg_temp.unmatched('x2-q7'));
select pg_temp.oq7('OQ7-dis: relinked, the leg re-imported on its original date — it pairs again, as in H',
  pg_temp.srep('k-q7d') = 'tracked/auto_pair/0 partner=x2-q7d' and pg_temp.unmatched('y-q7d'));
select pg_temp.call('dismiss-q7', format('select public.dismiss_card_payment_candidate(%L, %L, %L, %s)', pg_temp.aa(), pg_temp.tid('k-q7d'), pg_temp.tid('x2-q7d'), pg_temp.iv()));
select pg_temp.oq7('OQ7-dis: the user then dismisses the re-imported leg — today that does not release the hold''s own pair: the payment reads untracked / removed_card, -380, again; the kept leg is unmatched',
  pg_temp.called('dismiss-q7') = 'saved' and pg_temp.removed_destination('k-q7d', 38000) and pg_temp.unmatched('y-q7d'));
select pg_temp.observe('open question 7, after the relink', array['k-q7', 'y-q7', 'x2-q7', 'k-q7d', 'y-q7d', 'x2-q7d']);
select pg_temp.req('O3', 'after the relink two cards tie for the payment: nothing pairs, and it is still PUBLISHED untracked / removed_card through the earlier record — no reader sees it as unresolved',
  pg_temp.removed_destination('k-o3', 35000) and pg_temp.holds('k-o3') = 'none' and pg_temp.unmatched('x2-o3') and pg_temp.unmatched('y-o3'));
select pg_temp.req('H', 'after a relink the re-imported leg — closer than the competitor, as the removed one was — matches again by the ordinary rule: the hold is on the other pair and does not stand in the way; the record is dormant',
  pg_temp.srep('k-h') = 'tracked/auto_pair/0 partner=x2-h' and pg_temp.unmatched('y-h') and pg_temp.records('k-h') = 1);
select pg_temp.req('O2', 'after a relink the payment matches the re-imported leg (one day; the competitor is three)', pg_temp.srep('k-o2') = 'tracked/auto_pair/0 partner=x2-o2');
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000007');
select pg_temp.observe('after the relink and the second removal', array['k-h', 'y-h', 'k-o2', 'y-o2']);
-- Each removal records what IT removed (20261008120000): a record for the automatic match it deletes, a hold for
-- each candidate it deletes, and neither merged into a row an earlier removal wrote. Rows that differ only in
-- their source read as one: nothing a reader is shown changes.
select pg_temp.req('H', 'a second removal with the same evidence writes its OWN record and its OWN hold: two live records on the payment, and two live holds on the one pair with the one date',
  pg_temp.records('k-h') = 2 and pg_temp.holds('k-h') = 'removed_card:y-h/k-h@2026-09-11,removed_card:y-h/k-h@2026-09-11');
select pg_temp.req('H', 'each of the four names the leg its own removal deleted, the payment''s automatic match both times: Card Bank''s, and the relinked card''s',
  pg_temp.deps('k-h') = 'hold_removed_card(y-h/k-h@2026-09-11)<=harness-item-a7:a25-x2:x2-h[partner] ; hold_removed_card(y-h/k-h@2026-09-11)<=harness-item-a:a25-x:x-h[partner] ; '
                        || 'record(k-h)<=harness-item-a7:a25-x2:x2-h[partner] ; record(k-h)<=harness-item-a:a25-x:x-h[partner]');
select pg_temp.req('H', 'the payment reads its removed destination again, as with one record and one hold; the competitor is unmatched',
  pg_temp.removed_destination('k-h', 22000) and pg_temp.unmatched('y-h'));
select pg_temp.req('H', 'the record the payment NAMES is the one of its two with the lesser id — a name, not an attribution: both are its dependencies',
  pg_temp.records('k-h') = 2 and (pg_temp.leg('k-h')->>'decisionId')::uuid = pg_temp.record_id('k-h'));
select pg_temp.req('O2', 'competing system history: the second removal writes its own record — two live records on the payment — and its own hold on the same pair, with the second removed leg''s date',
  pg_temp.records('k-o2') = 2 and pg_temp.holds('k-o2') = 'removed_card:y-o2/k-o2@2026-09-10,removed_card:y-o2/k-o2@2026-09-11');
select pg_temp.req('O2', 'each record and each hold names the leg its own removal deleted, the payment''s automatic match both times: Card Bank''s on the 10th, and the relinked card''s on the 11th',
  pg_temp.deps('k-o2') = 'hold_removed_card(y-o2/k-o2@2026-09-10)<=harness-item-a:a25-x:x-o2[partner] ; hold_removed_card(y-o2/k-o2@2026-09-11)<=harness-item-a7:a25-x2:x2-o2[partner] ; '
                         || 'record(k-o2)<=harness-item-a7:a25-x2:x2-o2[partner] ; record(k-o2)<=harness-item-a:a25-x:x-o2[partner]');
select pg_temp.req('O2', 'the payment is not switched: it reads its removed destination, as with one record; the competitor is unmatched',
  pg_temp.removed_destination('k-o2', 32000) and pg_temp.unmatched('y-o2'));
select pg_temp.req('O2', 'the record the payment NAMES is the one of its two with the lesser id',
  pg_temp.records('k-o2') = 2 and (pg_temp.leg('k-o2')->>'decisionId')::uuid = pg_temp.record_id('k-o2'));
select pg_temp.req('O3', 'the second removal deletes one of the two tied candidates; the tie is held although the payment was never published unresolved: one hold on the kept leg, still ONE record (the payment had no automatic match for this removal to record), and the payment is not switched to the card that is left',
  pg_temp.holds('k-o3') = 'removed_card:y-o3/k-o3@2026-09-12' and pg_temp.records('k-o3') = 1 and pg_temp.removed_destination('k-o3', 35000) and pg_temp.unmatched('y-o3'));
select pg_temp.req('O3', 'the record is the first removal''s, from the automatic match it deleted; the hold is the second removal''s, from the tied candidate it deleted, which was no match',
  pg_temp.deps('k-o3') = 'hold_removed_card(y-o3/k-o3@2026-09-12)<=harness-item-a7:a25-x2:x2-o3[candidate] ; record(k-o3)<=harness-item-a:a25-x:x-o3[partner]');
select pg_temp.observe('at the end', array['k-a', 'k-c', 'k-d', 'k-e', 'k-fd', 'k-g-posted', 'k-gt-posted', 'k-h', 'k-jl', 'kc-kc', 'k-l', 'k-o', 'k-o2']);

-- ---- The verdict ------------------------------------------------------------------------------------
\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only on
select 'OBSERVED', moment, leg, what from observed order by seq;
select 'OBSERVED', 'system records and holds at the end', d.kind,
       d.a_plaid_transaction_id || coalesce(' / ' || d.b_plaid_transaction_id, '') || coalesce(' @ ' || d.counterpart_date, '')
       || case when d.superseded_by is null then '' else ' (superseded)' end
from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' or d.kind = 'destination_removed_card'
order by d.user_id, d.kind, d.a_plaid_transaction_id collate "C", d.b_plaid_transaction_id collate "C", d.counterpart_date;
select 'OBSERVED', 'sources at the end', p, pg_temp.deps(p) from unnest(array['k-h', 'k-o2', 'k-o3']) with ordinality as u(p, n) order by n;
select 'OPEN QUESTION 7 (not a contract) ' || case when today then 'as recorded' else 'CHANGED    ' end, what from open_question_7 order by seq;
select 'CONTRACT ' || case when ok then 'ok      ' else 'VIOLATED' end, kase, requirement from contract order by seq;
select 'CONTRACT SUMMARY', count(*) filter (where ok) || ' of ' || count(*) || ' requirements hold',
       coalesce('violated in: ' || string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none violated') from contract;
select th.assert((select bool_and(ok) from contract),
  'a removal does not switch an automatically matched payment to a card that was already there; violated in: '
  || (select coalesce(string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none') || ' (' || count(*) filter (where not ok) || ' of ' || count(*) || ' requirements)' from contract));
-- After the contract's own verdict: open question 7. Not an approved contract — a record of today's reading.
select th.assert((select bool_and(today) from open_question_7),
  'OPEN QUESTION 7 (PHASE_B_I3A_LIM_REMOVAL_MATCHING.md 9.3; NOT an approved contract): what a held payment reads after the removed institution is linked again is no longer what this file records. That behaviour is undecided: if the change is the owner''s decision, update the record here. Changed: '
  || (select coalesce(string_agg(seq::text, ', ' order by seq) filter (where not today), 'none') || ' (of ' || count(*) || ' recorded readings)' from open_question_7));

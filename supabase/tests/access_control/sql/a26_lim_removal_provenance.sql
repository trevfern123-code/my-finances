-- Institution removal records the SOURCE of everything it preserves (Phase B, I3A-R packet 1; 20261008120000).
--
-- The contract.
--   * Every decision a removal writes — the user's preserved pair, a system record, a system hold — depends on
--     ONE removed transaction, its source, and has exactly one provenance row that names it: this removal (its
--     generation), the removed account, the removed transaction, and what that transaction was to the surviving
--     leg (the counterpart the USER confirmed; its automatic partner; a competing candidate).
--   * A user's decision is never a system dependency. Only for it can the source have had no single row; then
--     what was there instead is recorded (waiting to post, ambiguous, gone), and nothing is invented.
--   * One system row per source. Two removals never share a row. Two removed transactions never share a row,
--     even with the same account, amount and date. One source may justify several rows.
--   * Nothing published changes. Identical live holds withhold as one; several live records read as one.
--   * Nothing is settled, ended or retired, and nothing reads the provenance.
--   * If the provenance cannot be written, nothing is removed. It is written by the removal, while it runs,
--     and never afterwards.
--   * A removal that ran WITHOUT provenance is marked by the next removal of that user, in its place in the
--     user's order: the rows it may have merged into are those written before the marker.
--
-- Each requirement says what it NEEDS, so that a run against Revision 5 (20261006120000, without this
-- migration) can be read: "rows" = visible in card_payment_decisions alone — Revision 5 MERGES there, and that
-- is the missing behaviour; "provenance" = needs the new tables, which Revision 5 does not have; "unchanged" =
-- a published reading that must be the same under both (these must hold on Revision 5 too).
--
-- User aa. Item 1 "Bank A" (institution ins_a: cards XA, XA2, excluded card XAE, checking RA) is removed FIRST.
-- Item 4 "Bank B" (no institution id: card XB, the same mask as XA) is removed SECOND. Item 6 "Bank F" (card
-- XF) is removed once after a refused attempt. Item 3 "Kept Bank" stays: checking C, cards Y and Z, excluded
-- card E. Item 7 is Bank A linked again (card XA', new ids), then removed. Item 8 "Bank U" (card XU, no
-- subtype, no mask) is removed LAST, after Bank F's removal was made to look unrecorded. Every case has its
-- own amount.
-- Dates are days of 2026-09.
--
--   case  surviving leg(s)                  removed leg(s)                                what is exercised
--   A     k-a  +100 C 10, y-a −100 Y 11     xa-a −100 XA 11 (item 1), xb-a −100 XB 11     TWO REMOVALS, one pair, one date
--                                           (item 4)
--   B     k-b  +110 C 10, y-b −110 Y 12     xa-b1 −110 XA 11, xa-b2 −110 XA 11            two IDENTICAL removed payments
--   D     k-d  +120 C 10, y-d Y 13, z-d Z 13   xa-d −120 XA 10 (partner), xa2-d XA2 12    several dependencies on one payment
--   E     k-e  +130 C 10                    xa-e −130 XA 11                               an automatic match, no competitor
--   F     k-f  +140 C 10, y-f −140 Y 11     xa-f −140 XA 11                               a tie: unresolved before and after
--   G     y-g  −150 Y 10, k-g +150 C 13     ra-g +150 RA 11                               the mirror: a removed CASH leg
--   H     k-h  +160 C 10, e-h −160 E 11     xae-h −160 XAE 11                             excluded accounts on both sides
--   H2    k-h2 +170 C 10                    xae-h2 −170 XAE 11                            matched to an excluded removed card
--   I1    k-i1 +180 C 10                    xa-i1 −180 XA 11, posted from 'xa-i1-pend'    the source's own lineage
--   I2    k-i2 +190 C 10                    xa-i2 −190 XA 11, PENDING                     a pending source
--   I3    k-i3 +200 C 10 pending, y-i3 Y 13 xa-i3 −200 XA 11                              later: the surviving payment posts
--   J1    k-j1 +210 C 10, y-j1 Y 13         xa-j1 −210 XA 11, CONFIRMED by the user       an active user pair
--   J2    k-j2 +220 C 10                    xa-j2, confirmed, then re-priced to −221      an inactive pair: amount changed
--   J3    k-j3 +230 C 10                    xa-j3, confirmed, then withdrawn by the bank  an inactive pair: no row left
--   J4    y-j4 −240 Y 10                    ra-j4 +240 RA 11, confirmed                   a user pair, the card side survives
--   JW    k-jw +280 C 10                    xa-jw −280 XA 12 pending, confirmed, then     a pair whose card leg waits to post
--                                           removed by a sync: a carry-over waits
--   JA    k-ja +290 C 10                    xa-ja pending, confirmed; then two posted     a pair whose lineage is ambiguous
--                                           rows both name it
--   P     (E, F, J1)                        xa-e, xa-f, xa-j1 have a NULL pending flag    a schema-legal row must not block a removal
--   L     k-l  +250 C 10                    xf-l −250 XF 11 (item 6)                      a refused removal, then the real one
--   R     k-r  +260 C 10                    xa-r −260 XA 11; later xr2 −260 XA' 11        a second removal after a relink
--   U     k-u  +270 C 10                    xu-u −270 XU 11 (item 8)                      an earlier removal that ran unrecorded
-- User bb (K). Item 2 (card BX, the same mask as aa's XA) is removed; item 5 (checking BC, card BY) stays until the
-- very end, where its removal marks bb's own unrecorded removal (U):
--           b-k +100 BC 10, by-k −100 BY 13   bx-k −100 BX 11
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
create function pg_temp.hold_id(p_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and p_plaid in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)
  order by d.a_plaid_transaction_id collate "C", d.counterpart_date limit 1 $$;
-- The live system destination records on a cash leg's own Plaid id, and the one record's id.
create function pg_temp.records(p_plaid text) returns bigint language sql as $$
  select count(*) from public.card_payment_decisions d
  where d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid $$;
create function pg_temp.record_id(p_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid $$;
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

-- CASE 2 as a reader sees it: untracked, −cents, no partner, named by the SYSTEM record.
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
create function pg_temp.unmatched(p_plaid text, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select coalesce(l->>'partnerTransactionId' is null and l->>'decisionId' is null and l->>'state' in ('unresolved', 'not_counted'), false)
  from pg_temp.leg(p_plaid, p_user) l $$;
-- Everything a reader is shown for a leg, as one string (state/reason/effect, partner, range, the kind of the
-- decision named on it, its tier-1-shaped candidates).
create function pg_temp.reading(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select pg_temp.srep(p_plaid, p_user) || ' range=' || coalesce(l->>'lowCents', 'null') || '..' || coalesce(l->>'highCents', 'null')
         || ' decision=' || pg_temp.holder_kind(p_plaid, p_user) || ' candidates=' || pg_temp.competitors(p_plaid, p_user)
  from pg_temp.leg(p_plaid, p_user) l $$;

-- ---- Provenance, read so that this file also RUNS on Revision 5 (where the tables do not exist) ---------
create function pg_temp.has_provenance() returns boolean language sql as $$
  select to_regclass('public.card_payment_removal_sources') is not null
         and to_regclass('public.card_payment_removal_generations') is not null $$;
-- A boolean question about the provenance tables: false when they do not exist.
create function pg_temp.pq(p_sql text) returns boolean language plpgsql as $$
declare
  v boolean;
begin
  if not pg_temp.has_provenance() then return false; end if;
  execute p_sql into v;
  return coalesce(v, false);
end $$;
-- The live decisions a removal wrote that name a Plaid id as either leg, each with its source, sorted:
--   kind(card-or-surviving leg[/other leg][@removed date])<=removed item:removed account:removed transaction[relation]
-- ("-" for the transaction when the source had no single row; the relation is confirmed, partner or candidate).
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
-- What is recorded of a source: every provenance row a condition selects, reduced to its DISTINCT descriptions
-- (one, when the rows agree):
--   removed item|institution id|removed account|type/subtype/mask|resolution:transaction|pending=…|of=…|date|cents|currency
create function pg_temp.srcq(p_where text, p_arg text, p_user uuid) returns text language plpgsql as $$
declare
  v text;
begin
  if not pg_temp.has_provenance() then return 'NO PROVENANCE TABLES'; end if;
  execute $q$
    select coalesce(string_agg(distinct
             r.plaid_item_id || '|' || coalesce(g.institution_id, 'null') || '|' || s.source_plaid_account_id || '|'
             || coalesce(s.source_account_type, 'null') || '/' || coalesce(s.source_account_subtype, 'null') || '/'
             || coalesce(s.source_account_mask, 'null')
             || '|' || s.source_resolution || ':' || coalesce(s.source_plaid_transaction_id, '-')
             || '|pending=' || coalesce(s.source_pending::text, 'null')
             || '|of=' || coalesce(s.source_pending_transaction_id, 'null') || '|' || coalesce(s.source_date::text, 'null')
             || '|' || coalesce(s.source_cents::text, 'null') || '|' || coalesce(s.source_iso_currency_code, 'null'), ' ## '), 'none')
    from public.card_payment_removal_sources s
    join public.card_payment_removal_generations g on g.removal_id = s.removal_id
    join public.plaid_item_removals r on r.id = s.removal_id
    where s.user_id = $2 and $q$ || p_where
  into v using p_arg, p_user;
  return v;
end $$;
-- … of one removed transaction, by its own Plaid id;
create function pg_temp.src(p_source_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select pg_temp.srcq('s.source_plaid_transaction_id = $1', p_source_plaid, p_user) $$;
-- … of the removed side of the user's preserved confirmation on a surviving leg (which may have had no row).
create function pg_temp.src_on(p_leg_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select pg_temp.srcq($w$s.decision_id in (select d.id from public.card_payment_decisions d
                                             where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = $1)$w$,
                      p_leg_plaid, p_user) $$;
-- The user's generations in their order: "ordinal:removed item:recorded|marker", comma separated.
create function pg_temp.generations(p_user uuid default pg_temp.aa()) returns text language plpgsql as $$
declare
  v text;
begin
  if not pg_temp.has_provenance() then return 'NO PROVENANCE TABLES'; end if;
  execute $q$
    select coalesce(string_agg(g.ordinal || ':' || r.plaid_item_id || ':' || case when g.sources_recorded then 'recorded' else 'marker' end,
                               ', ' order by g.ordinal), 'none')
    from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
    where g.user_id = $1 $q$
  into v using p_user;
  return v;
end $$;
create function pg_temp.live_holds(p_card_plaid text, p_cash_plaid text) returns bigint language sql as $$
  select count(*) from public.card_payment_decisions d
  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null
    and d.a_plaid_transaction_id = p_card_plaid and d.b_plaid_transaction_id = p_cash_plaid $$;

-- ---- The contract's checks: recorded with what each needs, all printed, asserted together at the end -----
create temporary table contract (seq integer generated always as identity, kase text not null, needs text not null,
                                 requirement text not null, ok boolean not null,
                                 check (needs in ('rows', 'provenance', 'unchanged')));
create function pg_temp.req(p_case text, p_needs text, p_requirement text, p_ok boolean) returns void language sql as $$
  insert into pg_temp.contract (kase, needs, requirement, ok) values (p_case, p_needs, p_requirement, coalesce(p_ok, false)) $$;
create temporary table observed (seq integer generated always as identity, moment text not null, leg text not null, what text not null);
create function pg_temp.observe(p_moment text, p_legs text[], p_user uuid default pg_temp.aa()) returns void language sql as $$
  insert into pg_temp.observed (moment, leg, what)
  select p_moment, p, coalesce(pg_temp.reading(p, p_user), '(no current leg)') || '  sources=' || pg_temp.deps(p, p_user)
  from unnest(p_legs) with ordinality as u(p, n) order by n $$;
-- A reading kept at one moment, to require it unchanged at a later one.
create temporary table kept (moment text not null, leg text not null, reading text, primary key (moment, leg));
create function pg_temp.keep(p_moment text, p_legs text[], p_user uuid default pg_temp.aa()) returns void language sql as $$
  insert into pg_temp.kept select p_moment, p, pg_temp.reading(p, p_user) from unnest(p_legs) p $$;
create function pg_temp.same_as(p_moment text, p_leg text, p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select k.reading is not null and k.reading = pg_temp.reading(p_leg, p_user) from pg_temp.kept k where k.moment = p_moment and k.leg = p_leg $$;

-- ---- Fixture -------------------------------------------------------------------------------------
update public.plaid_items set institution_id = 'ins_a', institution_name = 'Bank A' where id = '00000000-0000-0000-0000-000000000001';
update public.plaid_items set institution_id = 'ins_bb', institution_name = 'BB Card Bank' where id = '00000000-0000-0000-0000-000000000002';
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_id, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'ins_kept', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000004', pg_temp.aa(), 'harness-item-a4', 'placeholder-token-a4', null, 'Bank B'),
  ('00000000-0000-0000-0000-000000000006', pg_temp.aa(), 'harness-item-a6', 'placeholder-token-a6', 'ins_f', 'Bank F'),
  ('00000000-0000-0000-0000-000000000008', pg_temp.aa(), 'harness-item-a8', 'placeholder-token-a8', 'ins_u', 'Bank U'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'ins_bbkept', 'BB Kept Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type, subtype, mask, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-0000000026a1', '00000000-0000-0000-0000-000000000001', 'a26-xa', 'A Card', 'credit', 'credit card', '1111', false),
  ('00000000-0000-0000-0000-0000000026a2', '00000000-0000-0000-0000-000000000001', 'a26-xa2', 'A Second Card', 'credit', 'credit card', '2222', false),
  ('00000000-0000-0000-0000-0000000026a3', '00000000-0000-0000-0000-000000000001', 'a26-ra', 'A Checking', 'depository', 'checking', '3333', false),
  ('00000000-0000-0000-0000-0000000026a4', '00000000-0000-0000-0000-000000000001', 'a26-xae', 'A Excluded Card', 'credit', 'credit card', '4444', true),
  -- Bank B's card has the SAME type, subtype and mask as Bank A's: a description is not an identity.
  ('00000000-0000-0000-0000-0000000026b1', '00000000-0000-0000-0000-000000000004', 'a26-xb', 'B Card', 'credit', 'credit card', '1111', false),
  ('00000000-0000-0000-0000-0000000026c1', '00000000-0000-0000-0000-000000000003', 'a26-c', 'Kept Checking', 'depository', 'checking', '9001', false),
  ('00000000-0000-0000-0000-0000000026c2', '00000000-0000-0000-0000-000000000003', 'a26-y', 'Kept Card Y', 'credit', 'credit card', '9002', false),
  ('00000000-0000-0000-0000-0000000026c3', '00000000-0000-0000-0000-000000000003', 'a26-z', 'Kept Card Z', 'credit', 'credit card', '9003', false),
  ('00000000-0000-0000-0000-0000000026c4', '00000000-0000-0000-0000-000000000003', 'a26-e', 'Kept Card E (excluded)', 'credit', 'credit card', '9004', true),
  ('00000000-0000-0000-0000-0000000026f1', '00000000-0000-0000-0000-000000000006', 'a26-xf', 'F Card', 'credit', 'credit card', '6001', false),
  ('00000000-0000-0000-0000-0000000026f8', '00000000-0000-0000-0000-000000000008', 'a26-xu', 'U Card', 'credit', null, null, false),
  ('00000000-0000-0000-0000-0000000026d2', '00000000-0000-0000-0000-000000000002', 'a26-bx', 'BB Card BX', 'credit', 'credit card', '1111', false),
  ('00000000-0000-0000-0000-0000000026d1', '00000000-0000-0000-0000-000000000005', 'a26-bc', 'BB Checking', 'depository', 'checking', '9101', false),
  ('00000000-0000-0000-0000-0000000026d3', '00000000-0000-0000-0000-000000000005', 'a26-by', 'BB Kept Card BY', 'credit', 'credit card', '9102', false);
create function pg_temp.xa() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026a1' $$;
create function pg_temp.xa2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026a2' $$;
create function pg_temp.ra() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026a3' $$;
create function pg_temp.xae() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026a4' $$;
create function pg_temp.xb() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026b1' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026c1' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026c2' $$;
create function pg_temp.z() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026c3' $$;
create function pg_temp.e() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026c4' $$;
create function pg_temp.xf() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026f1' $$;
create function pg_temp.xu() returns text language sql as $$ select '00000000-0000-0000-0000-0000000026f8' $$;

select pg_temp.cardleg('k-a', pg_temp.c(), 100, '2026-09-10'), pg_temp.cardleg('xa-a', pg_temp.xa(), -100, '2026-09-11'),
       pg_temp.cardleg('xb-a', pg_temp.xb(), -100, '2026-09-11'), pg_temp.cardleg('y-a', pg_temp.y(), -100, '2026-09-11');                       -- A
select pg_temp.cardleg('k-b', pg_temp.c(), 110, '2026-09-10'), pg_temp.cardleg('xa-b1', pg_temp.xa(), -110, '2026-09-11'),
       pg_temp.cardleg('xa-b2', pg_temp.xa(), -110, '2026-09-11'), pg_temp.cardleg('y-b', pg_temp.y(), -110, '2026-09-12');                      -- B
select pg_temp.cardleg('k-d', pg_temp.c(), 120, '2026-09-10'), pg_temp.cardleg('xa-d', pg_temp.xa(), -120, '2026-09-10'),
       pg_temp.cardleg('xa2-d', pg_temp.xa2(), -120, '2026-09-12'), pg_temp.cardleg('y-d', pg_temp.y(), -120, '2026-09-13'),
       pg_temp.cardleg('z-d', pg_temp.z(), -120, '2026-09-13');                                                                                  -- D
select pg_temp.cardleg('k-e', pg_temp.c(), 130, '2026-09-10'), pg_temp.cardleg('xa-e', pg_temp.xa(), -130, '2026-09-11');                        -- E
select pg_temp.cardleg('k-f', pg_temp.c(), 140, '2026-09-10'), pg_temp.cardleg('xa-f', pg_temp.xa(), -140, '2026-09-11'),
       pg_temp.cardleg('y-f', pg_temp.y(), -140, '2026-09-11');                                                                                  -- F
select pg_temp.cardleg('y-g', pg_temp.y(), -150, '2026-09-10'), pg_temp.cardleg('ra-g', pg_temp.ra(), 150, '2026-09-11'),
       pg_temp.cardleg('k-g', pg_temp.c(), 150, '2026-09-13');                                                                                   -- G
select pg_temp.cardleg('k-h', pg_temp.c(), 160, '2026-09-10'), pg_temp.cardleg('xae-h', pg_temp.xae(), -160, '2026-09-11'),
       pg_temp.cardleg('e-h', pg_temp.e(), -160, '2026-09-11');                                                                                  -- H
select pg_temp.cardleg('k-h2', pg_temp.c(), 170, '2026-09-10'), pg_temp.cardleg('xae-h2', pg_temp.xae(), -170, '2026-09-11');                    -- H2
select pg_temp.cardleg('k-i1', pg_temp.c(), 180, '2026-09-10'), pg_temp.cardleg('xa-i1', pg_temp.xa(), -180, '2026-09-11', false, 'xa-i1-pend'); -- I1
select pg_temp.cardleg('k-i2', pg_temp.c(), 190, '2026-09-10'), pg_temp.cardleg('xa-i2', pg_temp.xa(), -190, '2026-09-11', true);                -- I2
select pg_temp.cardleg('k-i3', pg_temp.c(), 200, '2026-09-10', true), pg_temp.cardleg('xa-i3', pg_temp.xa(), -200, '2026-09-11'),
       pg_temp.cardleg('y-i3', pg_temp.y(), -200, '2026-09-13');                                                                                 -- I3
select pg_temp.cardleg('k-j1', pg_temp.c(), 210, '2026-09-10'), pg_temp.cardleg('xa-j1', pg_temp.xa(), -210, '2026-09-11'),
       pg_temp.cardleg('y-j1', pg_temp.y(), -210, '2026-09-13');                                                                                 -- J1
select pg_temp.cardleg('k-j2', pg_temp.c(), 220, '2026-09-10'), pg_temp.cardleg('xa-j2', pg_temp.xa(), -220, '2026-09-11');                      -- J2
select pg_temp.cardleg('k-j3', pg_temp.c(), 230, '2026-09-10'), pg_temp.cardleg('xa-j3', pg_temp.xa(), -230, '2026-09-11');                      -- J3
select pg_temp.cardleg('y-j4', pg_temp.y(), -240, '2026-09-10'), pg_temp.cardleg('ra-j4', pg_temp.ra(), 240, '2026-09-11');                      -- J4
select pg_temp.cardleg('k-l', pg_temp.c(), 250, '2026-09-10'), pg_temp.cardleg('xf-l', pg_temp.xf(), -250, '2026-09-11');                        -- L
select pg_temp.cardleg('k-r', pg_temp.c(), 260, '2026-09-10'), pg_temp.cardleg('xa-r', pg_temp.xa(), -260, '2026-09-11');                        -- R
select pg_temp.cardleg('k-jw', pg_temp.c(), 280, '2026-09-10'), pg_temp.cardleg('xa-jw', pg_temp.xa(), -280, '2026-09-12', true);                -- JW
select pg_temp.cardleg('k-ja', pg_temp.c(), 290, '2026-09-10'), pg_temp.cardleg('xa-ja', pg_temp.xa(), -290, '2026-09-11', true);                -- JA
select pg_temp.cardleg('k-u', pg_temp.c(), 270, '2026-09-10'), pg_temp.cardleg('xu-u', pg_temp.xu(), -270, '2026-09-11');                        -- U
select pg_temp.cardleg('b-k', '00000000-0000-0000-0000-0000000026d1', 100, '2026-09-10'),                                                        -- bb
       pg_temp.cardleg('bx-k', '00000000-0000-0000-0000-0000000026d2', -100, '2026-09-11'),
       pg_temp.cardleg('by-k', '00000000-0000-0000-0000-0000000026d3', -100, '2026-09-13');
select pg_temp.evaluate();

-- J: the user's confirmations, through the real RPC; then the bank changes two of the confirmed card legs.
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-j1'), pg_temp.tid('xa-j1'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, J1: the user confirms k-j1 with xa-j1');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-j2'), pg_temp.tid('xa-j2'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, J2: the user confirms k-j2 with xa-j2');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-j3'), pg_temp.tid('xa-j3'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, J3: the user confirms k-j3 with xa-j3');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('y-j4'), pg_temp.tid('ra-j4'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, J4: the user confirms the card leg y-j4 with the cash leg ra-j4');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-jw'), pg_temp.tid('xa-jw'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, JW: the user confirms k-jw with the pending xa-jw');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-ja'), pg_temp.tid('xa-ja'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture, JA: the user confirms k-ja with the pending xa-ja');
update public.transactions set amount = -221 where plaid_transaction_id = 'xa-j2';
delete from public.transactions where plaid_transaction_id = 'xa-j3';
-- JW: a sync removes the pending card row; its carry-over waits for the posted row (amount −280, date 09-12).
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['xa-jw']);
-- JA: two posted rows both name the pending row the user confirmed.
select pg_temp.cardleg('xa-ja-p1', pg_temp.xa(), -290, '2026-09-12', false, 'xa-ja'), pg_temp.cardleg('xa-ja-p2', pg_temp.xa(), -290, '2026-09-13', false, 'xa-ja');
-- P: the pending flag of a transaction may be NULL (the column allows it; the evaluator reads it as false).
-- One such row is about to be the source of a record (xa-e), one of a hold (xa-f), one of a user pair (xa-j1).
update public.transactions set pending = null where plaid_transaction_id in ('xa-e', 'xa-f', 'xa-j1');
select pg_temp.evaluate();

-- The fixture is what the header says.
select th.assert(pg_temp.unresolved_range('k-a', 10000) and pg_temp.competitors('k-a') = 'xa-a,xb-a,y-a', 'before, A: a three-way tie — unresolved');
select th.assert(pg_temp.unresolved_range('k-b', 11000) and pg_temp.competitors('k-b') = 'xa-b1,xa-b2,y-b', 'before, B: the two identical payments tie — unresolved');
select th.assert((select bool_and(pg_temp.srep('k-' || s) = 'tracked/auto_pair/0 partner=' || x and pg_temp.leg('k-' || s)->>'decisionId' is null)
                  from (values ('d', 'xa-d'), ('e', 'xa-e'), ('i1', 'xa-i1'), ('i2', 'xa-i2'), ('i3', 'xa-i3'), ('l', 'xf-l'), ('r', 'xa-r')) v(s, x)),
  'before, D E I1 I2 I3 L R: each payment is matched AUTOMATICALLY to its leg on the card that will be removed');
select th.assert(pg_temp.unresolved_range('k-f', 14000) and pg_temp.competitors('k-f') = 'xa-f,y-f', 'before, F: a tie — unresolved');
select th.assert(pg_temp.srep('y-g') = 'paired/auto_pair/0 partner=ra-g' and pg_temp.unresolved_range('k-g', 15000),
  'before, G: the kept card leg is matched automatically to the cash leg that will be removed; the kept payment also fits, less well');
select th.assert(pg_temp.srep('k-h2') = 'untracked/partner_excluded/-17000 partner=xae-h2', 'before, H2: matched automatically to an EXCLUDED card');
select th.assert(pg_temp.srep('k-j1') = 'tracked/user_pair/0 partner=xa-j1' and pg_temp.holder_kind('k-j1') = 'pair'
                 and pg_temp.srep('y-j4') = 'paired/user_pair/0 partner=ra-j4', 'before, J1 J4: active user pairs');
select th.assert(pg_temp.holder_kind('k-j2') = 'pair' and pg_temp.holder_kind('k-j3') = 'pair'
                 and (select count(*) = 2 from jsonb_array_elements(pg_temp.states()->'decisions') d
                      where d->>'kind' = 'pair' and d->>'status' = 'inactive' and d->>'detail' in ('amount_changed', 'partner_gone')),
  'before, J2 J3: the two other confirmations are inactive — an amount changed, a leg is gone — and still hold their payments');
select th.assert(pg_temp.srep('b-k', pg_temp.bb()) = 'tracked/auto_pair/0 partner=bx-k', 'before, bb: an automatic match with a competitor, as aa''s I3');
select th.assert(pg_temp.holder_kind('k-jw') = 'pair', 'before, JW: the confirmation holds its payment while its card leg waits to post');
select th.assert((select count(*) = 1 from public.transaction_carryovers c where c.pending_plaid_transaction_id = 'xa-jw' and c.consumed_at is null),
  'before, JW: the removed pending row left one unconsumed carry-over');
select th.assert(pg_temp.holder_kind('k-ja') = 'pair' and pg_temp.srep('k-ja') like 'unresolved/decision_invalidated/%', 'before, JA: an ambiguous lineage invalidates the confirmation, which still holds its payment');
select th.assert((select count(*) = 3 from public.transactions where pending is null and plaid_transaction_id in ('xa-e', 'xa-f', 'xa-j1')), 'before, P: three removed source rows have a NULL pending flag');
select th.assert(pg_temp.srep('k-u') = 'tracked/auto_pair/0 partner=xu-u', 'before, U: matched automatically to the card of the institution removed last');
select th.assert((select count(*) = 6 and bool_and(kind = 'pair') from public.card_payment_decisions), 'before: six decisions exist, the user''s six pairs');
select pg_temp.observe('before any removal', array['k-a', 'k-b', 'k-d', 'k-f', 'y-g', 'k-g', 'k-h', 'k-h2', 'k-j1', 'k-j2', 'k-j3', 'y-j4', 'k-jw', 'k-ja', 'k-l', 'k-r', 'k-u']);
-- What must read exactly the same after Bank A is removed: every leg that had NO automatic match.
select pg_temp.keep('before A', array['k-a', 'k-b', 'k-f', 'k-g', 'k-h', 'k-j2', 'k-j3', 'k-ja', 'k-u', 'y-a']);

-- ---- L. A removal whose provenance cannot be written removes NOTHING ------------------------------------
-- Bank F's removal is begun and confirmed at Plaid. Then its generation row is put in the way (it is unique
-- per removal), so the function's own first provenance write must fail.
select th.assert(public.begin_plaid_item_removal(pg_temp.aa(), '00000000-0000-0000-0000-000000000006',
                   public.plaid_item_removal_digest(pg_temp.aa(), '00000000-0000-0000-0000-000000000006'))->>'outcome' = 'started', 'L: the removal of Bank F begins');
select public.record_plaid_item_removal_attempt(pg_temp.aa(), '00000000-0000-0000-0000-000000000006', 'removed', null);
create temporary table l_before as
  select (select count(*) from public.card_payment_decisions) as decisions, (select count(*) from public.transactions) as transactions,
         (select count(*) from public.accounts) as accounts, pg_temp.iv() as iv, pg_temp.reading('k-l') as k_l;
do $$
begin
  if pg_temp.has_provenance() then
    execute $q$ insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)
                select r.id, r.user_id, true, 'in-the-way' from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-a6' $q$;
  end if;
end $$;
select pg_temp.call('remove-f-refused', format('select public.remove_plaid_item_local(%L, %L)', pg_temp.aa(), '00000000-0000-0000-0000-000000000006'));
select pg_temp.req('L', 'provenance', 'a removal that cannot write its provenance is refused with the fixed message, naming only the SQLSTATE',
  pg_temp.called('remove-f-refused') = 'refused: remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE 23505); nothing was removed');
select pg_temp.req('L', 'provenance', 'and it removed nothing and wrote nothing: the item, its account and its transactions are there, no decision was written, the removal is still plaid_removed, and the payment reads as before',
  pg_temp.has_provenance()
  and exists (select 1 from public.plaid_items i where i.id = '00000000-0000-0000-0000-000000000006' and i.status = 'removing')
  and (select b.decisions = (select count(*) from public.card_payment_decisions) and b.transactions = (select count(*) from public.transactions)
              and b.accounts = (select count(*) from public.accounts) and b.iv = pg_temp.iv() and b.k_l = pg_temp.reading('k-l') from l_before b)
  and (select r.status = 'plaid_removed' from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-a6')
  and pg_temp.pq($q$ select count(*) = 0 from public.card_payment_removal_sources $q$));
-- The obstacle is taken away (by the table's owner: the service role may not delete), and the removal is retried.
reset role;
do $$
begin
  if to_regclass('public.card_payment_removal_generations') is not null then
    execute $q$ delete from public.card_payment_removal_generations where institution_id = 'in-the-way' $q$;
  end if;
end $$;
set role service_role;
select pg_temp.call('remove-f', format('select public.remove_plaid_item_local(%L, %L)', pg_temp.aa(), '00000000-0000-0000-0000-000000000006'));
select pg_temp.req('L', 'provenance', 'retried, the removal runs once and records its one generation and the payment''s source',
  pg_temp.called('remove-f') = 'done' and pg_temp.deps('k-l') = 'record(k-l)<=harness-item-a6:a26-xf:xf-l[partner]'
  and pg_temp.generations() = '1:harness-item-a6:recorded'
  and pg_temp.pq($q$ select count(*) = 1 and bool_and(g.institution_id = 'ins_f') from public.card_payment_removal_generations g
                     join public.plaid_item_removals r on r.id = g.removal_id where r.plaid_item_id = 'harness-item-a6' $q$));
select pg_temp.req('L', 'unchanged', 'the payment then counts as a removed-card payment, as Revision 5 has it', pg_temp.removed_destination('k-l', 25000));
select pg_temp.keep('after F', array['k-l']);

-- ---- The removal of Bank A (item 1) ---------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000001');
select pg_temp.observe('after Bank A is removed', array['k-a', 'y-a', 'xb-a', 'k-b', 'y-b', 'k-d', 'k-e', 'k-f', 'y-g', 'k-g', 'k-h', 'e-h', 'k-h2', 'k-i1', 'k-i2', 'k-i3', 'k-j1', 'k-j2', 'k-j3', 'y-j4', 'k-jw', 'k-ja', 'k-r']);

select pg_temp.req('GEN', 'provenance', 'the removal has one generation row: this user, the institution id the item had, recorded, second in the user''s order',
  pg_temp.generations() = '1:harness-item-a6:recorded, 2:harness-item-a:recorded'
  and pg_temp.pq($q$ select count(*) = 1 and bool_and(g.user_id = '00000000-0000-0000-0000-0000000000aa' and g.institution_id = 'ins_a' and g.sources_recorded)
                 from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
                 where r.plaid_item_id = 'harness-item-a' $q$));

-- A, first half: the tie is held against BOTH surviving candidates, each hold with Bank A's leg as its source.
select pg_temp.req('A', 'provenance', 'after the first removal: a hold on each surviving candidate — Bank B''s card and the kept card — both depending on Bank A''s leg',
  pg_temp.deps('k-a') = 'hold_removed_card(xb-a/k-a@2026-09-11)<=harness-item-a:a26-xa:xa-a[candidate] ; hold_removed_card(y-a/k-a@2026-09-11)<=harness-item-a:a26-xa:xa-a[candidate]');
select pg_temp.req('A', 'unchanged', 'the payment reads what it read before the removal, the removed candidate aside: unresolved, a range',
  pg_temp.unresolved_range('k-a', 10000) and pg_temp.competitors('k-a') = 'xb-a,y-a');

-- B. Two removed transactions with the same account, amount and date are two sources.
select pg_temp.req('B', 'rows', 'two IDENTICAL removed payments (one card, one day, one amount) are two holds on the pair, not one',
  pg_temp.live_holds('y-b', 'k-b') = 2);
select pg_temp.req('B', 'provenance', 'and each hold names its own removed transaction',
  pg_temp.deps('k-b') = 'hold_removed_card(y-b/k-b@2026-09-11)<=harness-item-a:a26-xa:xa-b1[candidate] ; hold_removed_card(y-b/k-b@2026-09-11)<=harness-item-a:a26-xa:xa-b2[candidate]');
select pg_temp.req('B', 'provenance', 'the two sources are described alike in everything but their own id: nothing but the id tells them apart',
  pg_temp.src('xa-b1') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-b1|pending=false|of=null|2026-09-11|-11000|USD'
  and replace(pg_temp.src('xa-b2'), 'xa-b2', 'xa-b1') = pg_temp.src('xa-b1') and pg_temp.src('xa-b2') <> pg_temp.src('xa-b1'));
select pg_temp.req('B', 'unchanged', 'two identical holds withhold as one: the payment is unresolved, a range, with the kept card as its candidate',
  pg_temp.unresolved_range('k-b', 11000) and pg_temp.competitors('k-b') = 'y-b' and pg_temp.unmatched('y-b'));

-- D. Several dependencies on one payment; one source justifies several rows.
select pg_temp.req('D', 'provenance', 'the record and the four holds of one payment, each with its own source: the removed partner (card XA) or the other removed candidate (card XA2)',
  pg_temp.deps('k-d') = 'hold_removed_card(y-d/k-d@2026-09-10)<=harness-item-a:a26-xa:xa-d[partner] ; hold_removed_card(y-d/k-d@2026-09-12)<=harness-item-a:a26-xa2:xa2-d[candidate] ; '
                        || 'hold_removed_card(z-d/k-d@2026-09-10)<=harness-item-a:a26-xa:xa-d[partner] ; hold_removed_card(z-d/k-d@2026-09-12)<=harness-item-a:a26-xa2:xa2-d[candidate] ; '
                        || 'record(k-d)<=harness-item-a:a26-xa:xa-d[partner]');
select pg_temp.req('D', 'provenance', 'one source justifies three rows (the record and two holds), and all three describe it identically; the other source is on the other removed account',
  pg_temp.pq($q$ select count(*) = 3 from public.card_payment_removal_sources s where s.source_plaid_transaction_id = 'xa-d' $q$)
  and pg_temp.src('xa-d') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-d|pending=false|of=null|2026-09-10|-12000|USD'
  and pg_temp.src('xa2-d') = 'harness-item-a|ins_a|a26-xa2|credit/credit card/2222|row:xa2-d|pending=false|of=null|2026-09-12|-12000|USD');
select pg_temp.req('D', 'unchanged', 'the payment keeps its removed destination; neither kept card takes it', pg_temp.removed_destination('k-d', 12000) and pg_temp.unmatched('y-d') and pg_temp.unmatched('z-d'));

-- E. An automatic match with no competitor: the record, and its source.
select pg_temp.req('E', 'provenance', 'the record names the removed partner', pg_temp.deps('k-e') = 'record(k-e)<=harness-item-a:a26-xa:xa-e[partner]');
select pg_temp.req('E', 'unchanged', 'the payment counts as a removed-card payment', pg_temp.removed_destination('k-e', 13000));

-- F. A tie: unresolved before and after; a hold, no record.
select pg_temp.req('F', 'provenance', 'the hold names the removed candidate; there is no record', pg_temp.deps('k-f') = 'hold_removed_card(y-f/k-f@2026-09-11)<=harness-item-a:a26-xa:xa-f[candidate]' and pg_temp.records('k-f') = 0);
select pg_temp.req('F', 'unchanged', 'the payment reads what it read before, the removed candidate aside', pg_temp.unresolved_range('k-f', 14000) and pg_temp.competitors('k-f') = 'y-f');

-- G. The mirror: the removed source is a CASH leg, on a depository account.
select pg_temp.req('G', 'provenance', 'the hold of the removed-CASH kind names the removed cash leg, with its account as it was — and that it WAS the kept card leg''s automatic match, which no record says',
  pg_temp.deps('k-g') = 'hold_removed_cash_account(y-g/k-g@2026-09-11)<=harness-item-a:a26-ra:ra-g[partner]'
  and pg_temp.src('ra-g') = 'harness-item-a|ins_a|a26-ra|depository/checking/3333|row:ra-g|pending=false|of=null|2026-09-11|15000|USD');
select pg_temp.req('G', 'unchanged', 'the kept card leg is unresolved (0) and gets no record; the kept payment reads exactly as before',
  pg_temp.srep('y-g') = 'unresolved/ambiguous/0 partner=-' and pg_temp.records('y-g') = 0 and pg_temp.same_as('before A', 'k-g'));

-- H. Excluded accounts, on both sides of the removal.
select pg_temp.req('H', 'provenance', 'a source on an EXCLUDED removed card, held against a candidate on an EXCLUDED kept card',
  pg_temp.deps('k-h') = 'hold_removed_card(e-h/k-h@2026-09-11)<=harness-item-a:a26-xae:xae-h[candidate]'
  and pg_temp.src('xae-h') = 'harness-item-a|ins_a|a26-xae|credit/credit card/4444|row:xae-h|pending=false|of=null|2026-09-11|-16000|USD');
select pg_temp.req('H2', 'provenance', 'a payment that was matched to an excluded removed card: the record names it', pg_temp.deps('k-h2') = 'record(k-h2)<=harness-item-a:a26-xae:xae-h2[partner]');
select pg_temp.req('H2', 'unchanged', 'it counted in full before (−170) and still does, as a removed-card payment', pg_temp.removed_destination('k-h2', 17000));

-- I. The source's own lineage, and a pending source.
select pg_temp.req('I1', 'provenance', 'a source that had replaced a pending transaction keeps that pending id',
  pg_temp.deps('k-i1') = 'record(k-i1)<=harness-item-a:a26-xa:xa-i1[partner]'
  and pg_temp.src('xa-i1') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-i1|pending=false|of=xa-i1-pend|2026-09-11|-18000|USD');
select pg_temp.req('I2', 'provenance', 'a source that was still PENDING at the removal says so',
  pg_temp.src('xa-i2') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-i2|pending=true|of=null|2026-09-11|-19000|USD');
select pg_temp.req('I3', 'provenance', 'a pending surviving payment: its record and its hold, both from the removed partner',
  pg_temp.deps('k-i3') = 'hold_removed_card(y-i3/k-i3@2026-09-11)<=harness-item-a:a26-xa:xa-i3[partner] ; record(k-i3)<=harness-item-a:a26-xa:xa-i3[partner]');
select pg_temp.req('I1', 'unchanged', 'I1, I2, I3: each payment keeps its removed destination',
  pg_temp.removed_destination('k-i1', 18000) and pg_temp.removed_destination('k-i2', 19000) and pg_temp.removed_destination('k-i3', 20000));

-- J. The user's confirmations: user decisions as before, each now with its source.
select pg_temp.req('J1', 'provenance', 'an ACTIVE confirmation: the preserved user decision names the removed card leg, which had a row',
  pg_temp.deps('k-j1') = 'pair_counterpart_removed(k-j1/xa-j1)<=harness-item-a:a26-xa:xa-j1[confirmed]'
  and pg_temp.src('xa-j1') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-j1|pending=false|of=null|2026-09-11|-21000|USD'
  and pg_temp.src_on('k-j1') = pg_temp.src('xa-j1'));
select pg_temp.req('J1', 'unchanged', 'it is still the USER''s decision and still decides the payment: removed-card payment, −210; no system record, no hold; the kept card is only a suggestion',
  pg_temp.srep('k-j1') = 'untracked/removed_card/-21000 partner=-' and pg_temp.holder_kind('k-j1') = 'pair_counterpart_removed'
  and pg_temp.records('k-j1') = 0 and pg_temp.holds('k-j1') = 'none' and pg_temp.unmatched('y-j1'));
select pg_temp.req('J2', 'provenance', 'an INACTIVE confirmation (the removed leg was re-priced): the source is the row as it was at the removal (−221), while the decision keeps what the user confirmed (−220) and why it is invalid',
  pg_temp.deps('k-j2') = 'pair_counterpart_removed(k-j2/xa-j2)<=harness-item-a:a26-xa:xa-j2[confirmed]'
  and pg_temp.src('xa-j2') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-j2|pending=false|of=null|2026-09-11|-22100|USD'
  and (select d.b_cents = -22000 and d.counterpart_status = 'amount_changed' from public.card_payment_decisions d
       where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = 'k-j2'));
select pg_temp.req('J3', 'provenance', 'an INACTIVE confirmation whose removed leg had NO row left: the source is the removed ACCOUNT, marked gone — no transaction id, date or amount is invented; the reference and the confirmed cents stay on the decision',
  pg_temp.deps('k-j3') = 'pair_counterpart_removed(k-j3/xa-j3)<=harness-item-a:a26-xa:-[confirmed]'
  and pg_temp.src_on('k-j3') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|gone:-|pending=null|of=null|null|null|null'
  and (select d.counterpart_status = 'partner_gone' and d.b_plaid_transaction_id = 'xa-j3' and d.b_cents = -23000 from public.card_payment_decisions d
       where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = 'k-j3'));
select pg_temp.req('JW', 'provenance', 'a confirmation whose removed leg was WAITING TO POST: the carry-over went with the removed account, and its date and amount are what is recorded of it',
  pg_temp.deps('k-jw') = 'pair_counterpart_removed(k-jw/xa-jw)<=harness-item-a:a26-xa:-[confirmed]'
  and pg_temp.src_on('k-jw') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|waiting_to_post:-|pending=null|of=null|2026-09-12|-28000|null'
  and not exists (select 1 from public.transaction_carryovers c where c.pending_plaid_transaction_id = 'xa-jw')
  and (select d.counterpart_status = 'waiting_to_post' from public.card_payment_decisions d
       where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = 'k-jw'));
select pg_temp.req('JW', 'unchanged', 'a waiting counterpart invalidates nothing: the user''s decision decides the payment, a removed-card payment, −280',
  pg_temp.srep('k-jw') = 'untracked/removed_card/-28000 partner=-' and pg_temp.holder_kind('k-jw') = 'pair_counterpart_removed');
select pg_temp.req('JA', 'provenance', 'a confirmation whose reference had become AMBIGUOUS (two posted rows named it): marked ambiguous; neither row is recorded as the source',
  pg_temp.deps('k-ja') = 'pair_counterpart_removed(k-ja/xa-ja)<=harness-item-a:a26-xa:-[confirmed]'
  and pg_temp.src_on('k-ja') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|ambiguous:-|pending=null|of=null|null|null|null'
  and (select d.counterpart_status = 'lineage_ambiguous' from public.card_payment_decisions d
       where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = 'k-ja'));
select pg_temp.req('JA', 'unchanged', 'the invalid confirmation still holds its payment, which reads as before the removal',
  pg_temp.holder_kind('k-ja') = 'pair_counterpart_removed'
  and pg_temp.srep('k-ja') = (select split_part(k.reading, ' range=', 1) from kept k where k.moment = 'before A' and k.leg = 'k-ja'));
select pg_temp.req('P', 'provenance', 'a source row whose pending flag was NULL is recorded as not pending, as the evaluator reads it — for a record, a hold and a user pair (the three checks above); the removal was not refused',
  pg_temp.src('xa-e') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-e|pending=false|of=null|2026-09-11|-13000|USD'
  and pg_temp.src('xa-f') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-f|pending=false|of=null|2026-09-11|-14000|USD');
select pg_temp.req('J2', 'unchanged', 'J2, J3: an invalid confirmation still holds its payment, which reads exactly as before the removal',
  pg_temp.holder_kind('k-j2') = 'pair_counterpart_removed' and pg_temp.holder_kind('k-j3') = 'pair_counterpart_removed'
  and pg_temp.srep('k-j2') = (select split_part(k.reading, ' range=', 1) from kept k where k.moment = 'before A' and k.leg = 'k-j2')
  and pg_temp.srep('k-j3') = (select split_part(k.reading, ' range=', 1) from kept k where k.moment = 'before A' and k.leg = 'k-j3'));
select pg_temp.req('J4', 'provenance', 'a confirmation whose CARD side survives: the source is the removed cash leg',
  pg_temp.deps('y-j4') = 'pair_counterpart_removed(y-j4/ra-j4)<=harness-item-a:a26-ra:ra-j4[confirmed]'
  and pg_temp.src('ra-j4') = 'harness-item-a|ins_a|a26-ra|depository/checking/3333|row:ra-j4|pending=false|of=null|2026-09-11|24000|USD');
select pg_temp.req('J4', 'unchanged', 'the card leg reads funded from a removed cash account, 0, by the user''s decision',
  pg_temp.srep('y-j4') = 'funded_from_excluded/removed_cash_account/0 partner=-' and pg_temp.holder_kind('y-j4') = 'pair_counterpart_removed');

-- R, first half.
select pg_temp.req('R', 'provenance', 'after the first removal: one record, from Bank A''s leg', pg_temp.deps('k-r') = 'record(k-r)<=harness-item-a:a26-xa:xa-r[partner]');

-- O. The provenance outlives the rows it describes, and references none of them.
select pg_temp.req('O', 'provenance', 'the removed accounts and transactions are gone, and every provenance row of this removal is still there, describing them',
  not exists (select 1 from public.accounts a where a.item_id = '00000000-0000-0000-0000-000000000001')
  and not exists (select 1 from public.transactions t where t.plaid_transaction_id in ('xa-a', 'xa-b1', 'xa-b2', 'xa-d', 'xa2-d', 'ra-g', 'xae-h'))
  and pg_temp.pq($q$ select count(*) = 25 and count(distinct s.source_plaid_transaction_id) = 17 and count(*) filter (where s.source_plaid_transaction_id is null) = 3
                      and not exists (select 1 from public.accounts a where a.plaid_account_id in (select x.source_plaid_account_id from public.card_payment_removal_sources x))
                 from public.card_payment_removal_sources s join public.plaid_item_removals r on r.id = s.removal_id
                 where r.plaid_item_id = 'harness-item-a' $q$));
select pg_temp.req('O', 'provenance', 'no foreign key leads from the provenance to an account, a transaction or an item',
  pg_temp.pq($q$ select not exists (select 1 from pg_constraint c where c.contype = 'f'
                      and c.conrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
                      and c.confrelid in ('public.accounts'::regclass, 'public.transactions'::regclass, 'public.plaid_items'::regclass)) $q$));

-- The legs that had no automatic match read exactly what they read before Bank A was removed. (A, B, F, H
-- lose the removed candidate from their list; that is checked above. Here: the legs whose list had none.)
select pg_temp.req('N', 'unchanged', 'legs the removal did not concern read exactly as before: a bystander match and a bystander candidate',
  pg_temp.same_as('after F', 'k-l') and pg_temp.same_as('before A', 'k-u') and pg_temp.srep('y-a') = 'unresolved/ambiguous/0 partner=-');
select pg_temp.req('H', 'unchanged', 'the payment tied between two excluded cards reads as before, the removed candidate aside',
  split_part(pg_temp.reading('k-h'), ' candidates=', 1) = (select split_part(k.reading, ' candidates=', 1) from kept k where k.moment = 'before A' and k.leg = 'k-h'));

-- ---- C. Asking again changes nothing ---------------------------------------------------------------------
create temporary table c_before as
  select (select count(*) from public.card_payment_decisions) as decisions, pg_temp.iv() as iv,
         (select string_agg(d.id::text, ',' order by d.id) from public.card_payment_decisions d) as ids;
select pg_temp.call('replay-a', format('select to_jsonb((public.remove_plaid_item_local(%L, %L)->>''replayed'')::boolean)', pg_temp.aa(), '00000000-0000-0000-0000-000000000001'));
select pg_temp.evaluate();
select pg_temp.evaluate();
select pg_temp.req('C', 'provenance', 'a repeated call for a finished removal, and two further evaluations, write no decision, no source and no generation, and do not advance the input version',
  pg_temp.called('replay-a') = 'done'
  and (select b.decisions = (select count(*) from public.card_payment_decisions) and b.iv = pg_temp.iv()
              and b.ids = (select string_agg(d.id::text, ',' order by d.id) from public.card_payment_decisions d) from c_before b)
  and pg_temp.pq($q$ select (select count(*) from public.card_payment_removal_sources) = (select count(*) from public.card_payment_decisions d
                              where d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account'))
                        and (select count(*) from public.card_payment_removal_generations) = 2 $q$));

-- ---- K. Another user ---------------------------------------------------------------------------------------
select pg_temp.req('K', 'provenance', 'another user is untouched by these removals: no decision, no provenance, still their own automatic match',
  not exists (select 1 from public.card_payment_decisions d where d.user_id = pg_temp.bb())
  and pg_temp.srep('b-k', pg_temp.bb()) = 'tracked/auto_pair/0 partner=bx-k'
  and pg_temp.pq($q$ select not exists (select 1 from public.card_payment_removal_sources s where s.user_id = '00000000-0000-0000-0000-0000000000bb')
                        and not exists (select 1 from public.card_payment_removal_generations g where g.user_id = '00000000-0000-0000-0000-0000000000bb') $q$));
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select pg_temp.req('K', 'provenance', 'the other user''s removal records its own sources under its own generation, first in THAT user''s order — a card with the same mask as aa''s',
  pg_temp.deps('b-k', pg_temp.bb()) = 'hold_removed_card(by-k/b-k@2026-09-11)<=harness-item-b:a26-bx:bx-k[partner] ; record(b-k)<=harness-item-b:a26-bx:bx-k[partner]'
  and pg_temp.src('bx-k', pg_temp.bb()) = 'harness-item-b|ins_bb|a26-bx|credit/credit card/1111|row:bx-k|pending=false|of=null|2026-09-11|-10000|USD'
  and pg_temp.generations(pg_temp.bb()) = '1:harness-item-b:recorded');
select pg_temp.req('K', 'provenance', 'every provenance row, its decision, its generation and its removal belong to one user',
  pg_temp.pq($q$ select count(*) > 0 and bool_and(s.user_id = d.user_id and s.user_id = g.user_id and s.user_id = r.user_id)
                 from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id
                 join public.card_payment_removal_generations g on g.removal_id = s.removal_id
                 join public.plaid_item_removals r on r.id = g.removal_id $q$));

-- ---- I3, later: the surviving payment posts -----------------------------------------------------------------
select pg_temp.cardleg('k-i3-posted', pg_temp.c(), 200, '2026-09-10', false, 'k-i3');
delete from public.transactions where plaid_transaction_id = 'k-i3';
select pg_temp.evaluate();
select pg_temp.req('I3', 'unchanged', 'the surviving payment posts with the same amount and day: record and hold follow it, as in Revision 5',
  pg_temp.removed_destination('k-i3-posted', 20000) and pg_temp.unmatched('y-i3'));
select pg_temp.req('I3', 'provenance', 'and the provenance is untouched: the same two decisions, the same source',
  pg_temp.deps('k-i3') = 'hold_removed_card(y-i3/k-i3@2026-09-11)<=harness-item-a:a26-xa:xa-i3[partner] ; record(k-i3)<=harness-item-a:a26-xa:xa-i3[partner]');

-- ---- R, later: Bank A is linked again (new item, new account, new ids), then removed again ----------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_id, institution_name) values
  ('00000000-0000-0000-0000-000000000007', pg_temp.aa(), 'harness-item-a7', 'placeholder-token-a7', 'ins_a', 'Bank A');
insert into public.accounts (id, item_id, plaid_account_id, name, type, subtype, mask) values
  ('00000000-0000-0000-0000-0000000026e1', '00000000-0000-0000-0000-000000000007', 'a26-xa-again', 'A Card', 'credit', 'credit card', '1111');
select pg_temp.cardleg('xr2', '00000000-0000-0000-0000-0000000026e1', -260, '2026-09-11');
select pg_temp.evaluate();
select pg_temp.req('R', 'unchanged', 'after the relink the payment matches the re-imported leg again; the record is dormant, and nothing was ended or retired',
  pg_temp.srep('k-r') = 'tracked/auto_pair/0 partner=xr2' and pg_temp.records('k-r') = 1
  and not exists (select 1 from public.card_payment_decisions d where d.superseded_by is not null and d.kind <> 'pair'));

-- ---- The removal of Bank B (item 4): A, second half -------------------------------------------------------
select pg_temp.keep('before B', array['k-a', 'y-a', 'k-b', 'k-d', 'k-f', 'k-g', 'k-j1']);
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000004');
select pg_temp.observe('after Bank B is removed', array['k-a', 'y-a']);
select pg_temp.req('A', 'rows', 'TWO REMOVALS, one surviving pair, one date: the second removal writes its own hold on that pair — two live holds, not one',
  pg_temp.live_holds('y-a', 'k-a') = 2);
select pg_temp.req('A', 'provenance', 'each hold names the leg of its OWN removal: Bank A''s and Bank B''s — the hold on the pair with Bank B''s card went with that card',
  pg_temp.deps('k-a') = 'hold_removed_card(y-a/k-a@2026-09-11)<=harness-item-a4:a26-xb:xb-a[candidate] ; hold_removed_card(y-a/k-a@2026-09-11)<=harness-item-a:a26-xa:xa-a[candidate]');
select pg_temp.req('A', 'provenance', 'the two sources have the same account type, subtype and mask, the same amount and the same date; their generation, account and transaction ids differ — and Bank B''s generation has no institution id, as its item had none',
  pg_temp.src('xa-a') = 'harness-item-a|ins_a|a26-xa|credit/credit card/1111|row:xa-a|pending=false|of=null|2026-09-11|-10000|USD'
  and pg_temp.src('xb-a') = 'harness-item-a4|null|a26-xb|credit/credit card/1111|row:xb-a|pending=false|of=null|2026-09-11|-10000|USD');
select pg_temp.req('A', 'unchanged', 'the payment is still unresolved, a range, with the kept card as its candidate; the kept card''s leg is unmatched',
  pg_temp.unresolved_range('k-a', 10000) and pg_temp.competitors('k-a') = 'y-a' and pg_temp.unmatched('y-a'));
select pg_temp.req('N', 'unchanged', 'legs Bank B''s removal did not concern read exactly as before it',
  pg_temp.same_as('before B', 'k-b') and pg_temp.same_as('before B', 'k-d') and pg_temp.same_as('before B', 'k-f')
  and pg_temp.same_as('before B', 'k-g') and pg_temp.same_as('before B', 'k-j1'));

-- ---- The second removal of Bank A (item 7): R, second half ------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '00000000-0000-0000-0000-000000000007');
select pg_temp.observe('after Bank A is removed a second time', array['k-r']);
select pg_temp.req('R', 'rows', 'a second removal after a relink writes its OWN record for the payment — two live records, not one', pg_temp.records('k-r') = 2);
select pg_temp.req('R', 'provenance', 'each record names the leg of its own removal: the first Bank A item''s, and the relinked one''s',
  pg_temp.deps('k-r') = 'record(k-r)<=harness-item-a7:a26-xa-again:xr2[partner] ; record(k-r)<=harness-item-a:a26-xa:xa-r[partner]');
select pg_temp.req('R', 'unchanged', 'two live records read as one: a removed-card payment, −260', pg_temp.removed_destination('k-r', 26000));
select pg_temp.req('R', 'rows', 'the decision the payment NAMES is one of its two records (the one with the lesser id) — not an attribution: both are its dependencies',
  (select (pg_temp.leg('k-r')->>'decisionId')::uuid = (select d.id from public.card_payment_decisions d
                                                     where d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-r'
                                                     order by d.id limit 1))
  and pg_temp.records('k-r') = 2);

-- ---- INV. The whole ----------------------------------------------------------------------------------------
select pg_temp.req('INV', 'provenance', 'every decision a removal wrote has exactly one provenance row, and no other decision has one',
  pg_temp.pq($q$ select not exists (select 1 from public.card_payment_decisions d
                                      where d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
                                        and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = d.id))
                        and not exists (select 1 from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id
                                        where d.kind not in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')) $q$));
select pg_temp.req('INV', 'provenance', 'five removals, five generations, all recorded, each user''s numbered in the order the removals ran',
  pg_temp.generations() = '1:harness-item-a6:recorded, 2:harness-item-a:recorded, 3:harness-item-a4:recorded, 4:harness-item-a7:recorded'
  and pg_temp.generations(pg_temp.bb()) = '1:harness-item-b:recorded'
  and (select count(*) from public.plaid_item_removals r where r.status = 'cleaned') = 5);
select pg_temp.req('INV', 'provenance', 'rows that share a source describe it identically, in every column',
  pg_temp.pq($q$ select count(*) > 0 and bool_and(x.n = 1)
                 from (select count(distinct (s.source_resolution, s.source_pending_transaction_id, s.source_pending, s.source_date, s.source_cents,
                                              s.source_iso_currency_code, s.source_account_type, s.source_account_subtype, s.source_account_mask)) as n
                       from public.card_payment_removal_sources s where s.source_plaid_transaction_id is not null
                       group by s.removal_id, s.source_plaid_account_id, s.source_plaid_transaction_id) x $q$));
select pg_temp.req('INV', 'provenance', 'no two rows of one removal share kind, legs and source: one row per dependency, never two',
  pg_temp.pq($q$ select not exists (select 1 from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id
                                      where s.source_plaid_transaction_id is not null
                                      group by s.removal_id, d.kind, d.a_plaid_transaction_id, d.b_plaid_transaction_id, s.source_plaid_transaction_id
                                      having count(*) > 1) $q$));
select pg_temp.req('INV', 'provenance', 'a user''s decision is never a system dependency, and the reverse: the relation follows the kind, and only a confirmed pair can lack a row',
  pg_temp.pq($q$ select bool_and((d.kind = 'pair_counterpart_removed') = (s.source_relation = 'confirmed_counterpart')
                                  and (d.kind <> 'destination_removed_card' or s.source_relation = 'automatic_partner')
                                  and (s.source_relation = 'confirmed_counterpart' or s.source_resolution = 'row')
                                  and (d.kind not like 'ambiguity_hold_%' or d.counterpart_date = s.source_date))
                 from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id $q$));
select pg_temp.req('INV', 'unchanged', 'nothing was settled, ended or retired by any removal: no system decision is superseded',
  not exists (select 1 from public.card_payment_decisions d
              where d.superseded_by is not null
                and d.kind in ('destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account', 'pair_counterpart_removed')));

-- ---- K, last: references across users are refused -----------------------------------------------------------
-- A hold written directly (as an earlier version of the removal wrote them: no provenance row), to attach to.
insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, counterpart_date)
values ('00000000-0000-0000-0000-00000026ffff', pg_temp.aa(), 'ambiguity_hold_removed_card', pg_temp.y()::uuid, 'y-f', -14000, pg_temp.c()::uuid, 'k-f', 14000, '2026-09-11');
select pg_temp.evaluate();
select pg_temp.req('F', 'unchanged', 'a hold that has no provenance (written before this packet) keeps working as it did, beside one that has',
  pg_temp.unresolved_range('k-f', 14000) and pg_temp.live_holds('y-f', 'k-f') = 2);
select th.assert(public.begin_plaid_item_removal(pg_temp.aa(), '00000000-0000-0000-0000-000000000008',
                   public.plaid_item_removal_digest(pg_temp.aa(), '00000000-0000-0000-0000-000000000008'))->>'outcome' = 'started', 'U: the removal of Bank U begins');
do $$
declare
  v_other uuid;
  v_own uuid;
  v_cols text := '(decision_id, user_id, removal_id, source_relation, source_resolution, source_plaid_account_id, source_plaid_transaction_id, source_pending, source_date, source_cents)';
begin
  if not pg_temp.has_provenance() then
    insert into pg_temp.calls
    select n, 'no provenance tables' from unnest(array['foreign-generation', 'foreign-user', 'foreign-removal', 'late-source', 'late-generation', 'early-marker', 'client-read']) n;
    return;
  end if;
  execute $q$ select g.removal_id from public.card_payment_removal_generations g where g.user_id = '00000000-0000-0000-0000-0000000000bb' $q$ into v_other;
  execute $q$ select g.removal_id from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id where r.plaid_item_id = 'harness-item-a' $q$ into v_own;
  -- aa's decision under bb's generation, as aa: aa has no such generation.
  perform pg_temp.call('foreign-generation', format($q$ insert into public.card_payment_removal_sources %s
      values ('00000000-0000-0000-0000-00000026ffff', %L, %L, 'removed_candidate', 'row', 'a26-bx', 'bx-k', false, '2026-09-11', -10000) returning '{}'::jsonb $q$, v_cols, pg_temp.aa(), v_other));
  -- the same, claiming to be bb's: the decision is not bb's.
  perform pg_temp.call('foreign-user', format($q$ insert into public.card_payment_removal_sources %s
      values ('00000000-0000-0000-0000-00000026ffff', %L, %L, 'removed_candidate', 'row', 'a26-bx', 'bx-k', false, '2026-09-11', -10000) returning '{}'::jsonb $q$, v_cols, pg_temp.bb(), v_other));
  -- a generation for bb's removal, claimed by aa.
  perform pg_temp.call('foreign-removal', format($q$ insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)
      values (%L, %L, false) returning '{}'::jsonb $q$, v_other, pg_temp.aa()));
  -- NEVER BACKFILLED: a source for a hold that has none, under aa's OWN finished removal.
  perform pg_temp.call('late-source', format($q$ insert into public.card_payment_removal_sources %s
      values ('00000000-0000-0000-0000-00000026ffff', %L, %L, 'removed_candidate', 'row', 'a26-xa', 'xa-f', false, '2026-09-11', -14000) returning '{}'::jsonb $q$, v_cols, pg_temp.aa(), v_own));
  -- a finished removal cannot be declared recorded afterwards,
  perform pg_temp.call('late-generation', format($q$ insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)
      values (%L, %L, true) returning '{}'::jsonb $q$, v_own, pg_temp.aa()));
  -- and a removal that has not run cannot be marked as having run without provenance.
  perform pg_temp.call('early-marker', format($q$ insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)
      select r.id, r.user_id, false from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-a8' returning '{}'::jsonb $q$));
end $$;
select pg_temp.req('K', 'provenance', 'a provenance row cannot attach one user''s decision to another user''s removal, under either user''s name; nor a generation to another user''s removal',
  pg_temp.called('foreign-generation') = 'refused: card_payment_removal_provenance_wrong_moment'
  and pg_temp.called('foreign-user') = 'refused: card_payment_removal_provenance_foreign_decision'
  and pg_temp.called('foreign-removal') = 'refused: card_payment_removal_provenance_foreign_removal');
select pg_temp.req('K', 'provenance', 'provenance is written by the removal, while it runs, and never afterwards: no source for an old hold, no generation for a finished removal, no marker for one that has not run',
  pg_temp.called('late-source') = 'refused: card_payment_removal_provenance_wrong_moment'
  and pg_temp.called('late-generation') = 'refused: card_payment_removal_provenance_wrong_moment'
  and pg_temp.called('early-marker') = 'refused: card_payment_removal_provenance_wrong_moment'
  and pg_temp.deps('k-f') = 'hold_removed_card(y-f/k-f@2026-09-11)<=NO SOURCE ; hold_removed_card(y-f/k-f@2026-09-11)<=harness-item-a:a26-xa:xa-f[candidate]');

-- ---- U. A removal that ran WITHOUT provenance is marked by the next one, in its place ---------------------------
-- Bank F's removal is made to look as a removal that ran while this migration was rolled back does: a cleaned
-- ledger row, its decisions, and no generation (its provenance goes with it). Only the tables' owner can do
-- that. The OTHER user's one removal is made to look the same. Then Bank U is removed, by aa.
reset role;
do $$
begin
  if to_regclass('public.card_payment_removal_generations') is not null then
    execute $q$ delete from public.card_payment_removal_generations g using public.plaid_item_removals r
                where r.id = g.removal_id and r.plaid_item_id in ('harness-item-a6', 'harness-item-b') $q$;
  end if;
end $$;
set role service_role;
select public.record_plaid_item_removal_attempt(pg_temp.aa(), '00000000-0000-0000-0000-000000000008', 'removed', null);
select th.assert((public.remove_plaid_item_local(pg_temp.aa(), '00000000-0000-0000-0000-000000000008')->>'replayed')::boolean = false, 'U: the removal of Bank U runs');
select pg_temp.observe('after Bank U is removed', array['k-u', 'k-l']);
select pg_temp.req('U', 'provenance', 'the unrecorded removal gets a MARKER — after every generation that existed, before this removal''s own — so the rows it may have merged into are known: those of generations 2, 3 and 4, not those of 6',
  pg_temp.generations() = '2:harness-item-a:recorded, 3:harness-item-a4:recorded, 4:harness-item-a7:recorded, 5:harness-item-a6:marker, 6:harness-item-a8:recorded');
select pg_temp.req('U', 'provenance', 'this removal records its own source (an account with no subtype and no mask); the unrecorded removal''s record has none, and none is made up for it',
  pg_temp.deps('k-u') = 'record(k-u)<=harness-item-a8:a26-xu:xu-u[partner]'
  and pg_temp.src('xu-u') = 'harness-item-a8|ins_u|a26-xu|credit/null/null|row:xu-u|pending=false|of=null|2026-09-11|-27000|USD'
  and pg_temp.deps('k-l') = 'record(k-l)<=NO SOURCE');
select pg_temp.req('U', 'unchanged', 'both payments read as removed-card payments: with a source, without one, the reading is the same',
  pg_temp.removed_destination('k-u', 27000) and pg_temp.removed_destination('k-l', 25000));
-- A marker has a place in ITS user's order, and that order is assigned under that user's advisory lock. aa's
-- removal holds aa's lock, so it must leave bb's unrecorded removal alone.
select pg_temp.req('U', 'provenance', 'a removal marks only its OWN user''s unrecorded removals: after aa''s removal the other user''s unrecorded removal has no marker',
  pg_temp.generations(pg_temp.bb()) = 'none');
select pg_temp.remove(pg_temp.bb(), '00000000-0000-0000-0000-000000000005');
select pg_temp.req('U', 'provenance', 'the other user''s own next removal marks it, first in THAT user''s order, before its own generation; aa''s order is untouched',
  pg_temp.generations(pg_temp.bb()) = '1:harness-item-b:marker, 2:harness-item-b5:recorded'
  and pg_temp.generations() = '2:harness-item-a:recorded, 3:harness-item-a4:recorded, 4:harness-item-a7:recorded, 5:harness-item-a6:marker, 6:harness-item-a8:recorded');

-- ---- The verdict ----------------------------------------------------------------------------------------------
\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only on
select 'OBSERVED', moment, leg, what from observed order by seq;
select 'CONTRACT ' || case when ok then 'ok      ' else 'VIOLATED' end, kase, needs, requirement from contract order by seq;
select 'CONTRACT SUMMARY', count(*) filter (where ok) || ' of ' || count(*) || ' requirements hold',
       coalesce('violated in: ' || string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none violated'),
       'violated by need: rows ' || count(*) filter (where not ok and needs = 'rows') || ', provenance ' || count(*) filter (where not ok and needs = 'provenance')
       || ', unchanged ' || count(*) filter (where not ok and needs = 'unchanged')
from contract;
select th.assert((select bool_and(ok) from contract),
  'institution removal records the source of everything it preserves; violated in: '
  || (select coalesce(string_agg(distinct kase, ', ' order by kase) filter (where not ok), 'none') || ' (' || count(*) filter (where not ok) || ' of ' || count(*)
             || ' requirements; rows ' || count(*) filter (where not ok and needs = 'rows') || ', provenance ' || count(*) filter (where not ok and needs = 'provenance')
             || ', unchanged ' || count(*) filter (where not ok and needs = 'unchanged') || ')' from contract));

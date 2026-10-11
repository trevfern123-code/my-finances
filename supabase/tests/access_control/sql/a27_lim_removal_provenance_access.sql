-- Institution-removal provenance (20261008120000): the access model and the referential integrity of every
-- object the migration adds — the two tables, their grants, their two guard triggers and trigger functions, every
-- foreign key and every check. a26 is the contract of WHAT a removal records. This file is about who can read or
-- write it, what the guards refuse, and how the rows live and go:
--   1. catalog: row security, privileges, the guards, the keys, the installed body;
--   2. runtime, as each role: a client is refused, never shown an empty table; the service role reads and inserts;
--   3. the guards and the checks, by direct service-role INSERTs built from the rows of a real removal: in the
--      transaction that writes the generation, and in a later one;
--   4. the keys and the checks behind the guards;
--   5. two users whose fixtures look alike; what the client-facing results expose;
--   6. immutability and redaction;
--   7. deletion: with the decision, the surviving account, the generation, the ledger row;
--   8. the removal's scratch table, reused within a transaction and across transactions;
--   9. a source whose Plaid ids are empty strings;
--  10. the deletion of a user.
--
-- A probe is one statement run in a subtransaction that is always rolled back; it reports 'accepted: <rows>' or
-- '<SQLSTATE>: <message>'. So a refusal is a recorded result, and a probe never changes what the next one meets.
-- The refusals have their controls: the row as the function writes it is accepted, and a refused row differs from
-- it in the one thing its label names (except where the comment beside a group says a row fails several conditions
-- of one test). A provenance row is accepted only in the transaction that wrote its
-- generation, so a control and the probes beside it share ONE transaction, in which the decisions and the
-- generation are written by hand first, as the function writes them; that transaction is rolled back.
--
-- User aa. Item 3 "Kept Bank" stays: checking C, card Y. Removed, in this order:
--   R0  item 7 "Bank U"  card XU               really removed; then made to look as a removal that ran without
--                                              provenance does (its generation is deleted by the tables' owner)
--   R1  item 1 "Bank A"  card X1, checking RA  really removed: the rows the later sections read, change and delete
--   R2  item 4 "Bank B"  card X2, checking RB  RUNNING (confirmed at Plaid, not yet removed) while the guards are
--                                              probed; really removed afterwards
--   R3  item 6 "Bank F"  card XF               only requested; never proceeds
-- User bb. Item 5 stays: checking BC, card BY. RB: item 2, card BX — running beside R2, then really removed.
-- User cc. Item c0 stays: checking CC, card CY. Items c1 to c4, one card each (T1 to T4), are removed in section 8.
--          Item c5 "Bank E" is linked and removed in section 9: card E1, whose Plaid account id is the EMPTY
--          STRING, and card E2, with the leg whose Plaid transaction id is the empty string.
-- Every case has its own amount; dates are days of 2026-09.
--
--   case  surviving leg(s)                      removed leg(s)                         what the removal writes
--   U     k-u  +270 C 10                        xu-u  −270 XU 11 (R0)                  a record
--   P     k-p  +210 C 10                        x1-p  −210 X1 11, CONFIRMED (R1)       the user's preserved pair
--   R     k-r  +130 C 10                        x1-r  −130 X1 11 (R1)                  a record
--   H     k-h  +140 C 10, y-h −140 Y 11         x1-h  −140 X1 11 (R1)                  a hold, removed card
--   G     y-g  −150 Y 10, k-g +150 C 13         ra-g  +150 RA 11 (R1)                  a hold, removed cash account
--   P2    k-p2 +310 C 10                        x2-p2 −310 X2 12 (R2), CONFIRMED while the user's preserved pair, whose
--                                               pending as 'x2-p2-pend', then posted   reference is the PENDING id
--   R2    k-r2 +230 C 10                        x2-r2 −230 X2 11 (R2)                  a record
--   H2    k-h2 +240 C 10, y-h2 −240 Y 11        x2-h2 −240 X2 11 (R2)                  a hold, removed card
--   G2    y-g2 −250 Y 10, k-g2 +250 C 13        rb-g2 +250 RB 11 (R2)                  a hold, removed cash account
--   N     k-n  +350 C 10, y-n −350 Y 12         —                                      (the user DISMISSED the pair)
--   M     k-m  +360 C 10                        —                                      (the user MARKED it untracked)
--   bb    b-p +210, b-r +130, b-h +140 BC 10,   bx-p (confirmed), bx-r, bx-h BX 11     as aa's P, R and H: the same
--         by-h −140 BY 11                                                              masks, amounts and dates
--   cc    m1 +410 CC 10, cy1 −410 CY 12         t1x −410 T1 10                         a record and a hold
--         m2 +420 CC 10, cy2 −420 CY 11         t2x −420 T2 11                         a hold
--         m3 +430 CC 10, cy3 −430 CY 12         t3x −430 T3 10                         a record and a hold
--         m4 +440 CC 10, cy4 −440 CY 11         t4x −440 T4 11                         a hold
--         m5 +450 CC 10                         e1x −450 E1 11 (section 9)             a record
--         m6 +460 CC 10                         ''  −460 E2 11 (section 9)             a record
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000cc', 'third@example.test');
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.cc() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000cc'::uuid $$;
-- An item or account id of this file, by its last digits.
create function pg_temp.u(p text) returns uuid language sql as $$ select ('00000000-0000-0000-0000-' || lpad(p, 12, '0'))::uuid $$;
create function pg_temp.iv(p_user uuid) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- The removal of an item, by the item's Plaid item id.
create function pg_temp.rid(p_plaid_item text) returns uuid language sql as $$
  select id from public.plaid_item_removals where plaid_item_id = p_plaid_item $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending boolean default false,
                                p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, pending_transaction_id, user_role_override)
  values (pg_temp.u(p_account), p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, p_pending_of, 'credit_card_payment') $$;
create function pg_temp.evaluate() returns void language sql as $$
  select public.evaluate_card_payments(pg_temp.aa()); select public.evaluate_card_payments(pg_temp.bb());
  select public.evaluate_card_payments(pg_temp.cc()); $$;
-- state/reason/effect of a leg; raises when the states are not fresh.
create function pg_temp.srep(p_plaid text, p_user uuid default pg_temp.aa()) returns text language plpgsql as $$
declare
  v jsonb := public.get_card_payment_states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  return (select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null')
          from jsonb_array_elements(v->'legs') l where (l->>'transactionId')::uuid = pg_temp.tid(p_plaid));
end $$;

-- ---- Probes ------------------------------------------------------------------------------------------------
-- How one statement ends, as whoever calls this: 'accepted: <rows>' or '<SQLSTATE>: <message>'. Undone either way.
create function pg_temp.attempt(p_sql text) returns text language plpgsql as $$
declare
  n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'TH001', message = 'probe: undo';
  exception
    when sqlstate 'TH001' then return 'accepted: ' || n;
    when others then return sqlstate || ': ' || sqlerrm;
  end;
end $$;
-- One row, given as JSON, inserted into a provenance table as it stands.
create function pg_temp.put_row(p_table text, p_row jsonb) returns text language plpgsql as $$
begin
  if p_row is null then
    raise exception 'ASSERTION FAILED: no row to build the INSERT into % from', p_table;
  end if;
  return pg_temp.attempt(format('insert into public.%I select * from jsonb_populate_record(null::public.%I, %L::jsonb)', p_table, p_table, p_row));
end $$;
create function pg_temp.put_generation(p_removal uuid, p_user uuid, p_recorded boolean, p_institution text default null,
                                       p_ordinal bigint default 999) returns text language sql as $$
  select pg_temp.put_row('card_payment_removal_generations',
           jsonb_build_object('removal_id', p_removal, 'user_id', p_user, 'ordinal', p_ordinal, 'sources_recorded', p_recorded,
                              'institution_id', p_institution, 'recorded_at', now())) $$;
-- The ordinal a generation is given when the INSERT supplies p_ordinal (the INSERT is undone).
create function pg_temp.ordinal_given(p_removal uuid, p_user uuid, p_recorded boolean, p_ordinal bigint) returns bigint language plpgsql as $$
declare
  v bigint;
begin
  begin
    insert into public.card_payment_removal_generations (removal_id, user_id, ordinal, sources_recorded)
    values (p_removal, p_user, p_ordinal, p_recorded) returning ordinal into v;
    raise exception using errcode = 'TH001', message = 'probe: undo';
  exception when sqlstate 'TH001' then null;
  end;
  return v;
end $$;
-- The time a generation is given when the INSERT supplies p_at (the INSERT is undone).
create function pg_temp.recorded_at_given(p_removal uuid, p_user uuid, p_recorded boolean, p_at timestamp with time zone)
returns timestamp with time zone language plpgsql as $$
declare
  v timestamp with time zone;
begin
  begin
    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, recorded_at)
    values (p_removal, p_user, p_recorded, p_at) returning recorded_at into v;
    raise exception using errcode = 'TH001', message = 'probe: undo';
  exception when sqlstate 'TH001' then null;
  end;
  return v;
end $$;
create function pg_temp.violates(p_table text, p_constraint text) returns text language sql as $$
  select format('23514: new row for relation "card_payment_removal_%s" violates check constraint "card_payment_removal_%s_%s"',
                p_table, p_table, p_constraint) $$;
create function pg_temp.orphan(p_table text, p_constraint text) returns text language sql as $$
  select format('23503: insert or update on table "card_payment_removal_%s" violates foreign key constraint "card_payment_removal_%s_%s"',
                p_table, p_table, p_constraint) $$;

-- ---- A removal, step by step, with every result kept -----------------------------------------------------------
create temporary table rpc (plaid_item text not null, step text not null, result jsonb, primary key (plaid_item, step));
create function pg_temp.begin_removal(p_user uuid, p_item text) returns void language plpgsql as $$
declare
  v jsonb := public.begin_plaid_item_removal(p_user, pg_temp.u(p_item), public.plaid_item_removal_digest(p_user, pg_temp.u(p_item)));
begin
  insert into pg_temp.rpc values (v->'removal'->>'plaid_item_id', 'begin', v);
  perform th.assert(v->>'outcome' = 'started', 'the removal of item ' || p_item || ' begins');
end $$;
create function pg_temp.confirm_removal(p_user uuid, p_item text) returns void language plpgsql as $$
declare
  v jsonb := public.record_plaid_item_removal_attempt(p_user, pg_temp.u(p_item), 'removed', null);
begin
  insert into pg_temp.rpc values (v->>'plaid_item_id', 'record', v);
  perform th.assert(v->>'status' = 'plaid_removed', 'the removal of item ' || p_item || ' is confirmed at Plaid');
end $$;
create function pg_temp.run_removal(p_user uuid, p_item text) returns void language plpgsql as $$
declare
  v jsonb := public.remove_plaid_item_local(p_user, pg_temp.u(p_item));
begin
  insert into pg_temp.rpc select r.plaid_item_id, 'remove', v from public.plaid_item_removals r where r.item_id = pg_temp.u(p_item);
  perform th.assert((v->>'replayed')::boolean = false, 'the removal of item ' || p_item || ' runs');
end $$;
create function pg_temp.remove(p_user uuid, p_item text) returns void language plpgsql as $$
begin
  perform pg_temp.begin_removal(p_user, p_item);
  perform pg_temp.confirm_removal(p_user, p_item);
  perform pg_temp.run_removal(p_user, p_item);
end $$;

-- ---- What a removal that has NOT run yet would write -------------------------------------------------------------
-- remove_plaid_item_local is called in a subtransaction that is then rolled back; the rows it wrote are carried out
-- of it and kept here. Nothing it did remains: the removal is still plaid_removed and has no generation.
create temporary table dry_generations (like public.card_payment_removal_generations);
create temporary table dry_decisions (like public.card_payment_decisions);
create temporary table dry_sources (like public.card_payment_removal_sources);
create function pg_temp.dry_run(p_user uuid, p_item text) returns void language plpgsql as $$
declare
  v_removal uuid := (select r.id from public.plaid_item_removals r where r.item_id = pg_temp.u(p_item) and r.user_id = p_user);
  v_g jsonb;
  v_d jsonb;
  v_s jsonb;
begin
  begin
    perform th.assert((public.remove_plaid_item_local(p_user, pg_temp.u(p_item))->>'replayed')::boolean = false, 'dry run: the removal runs');
    select jsonb_agg(to_jsonb(g)) into v_g from public.card_payment_removal_generations g where g.removal_id = v_removal;
    select jsonb_agg(to_jsonb(d)) into v_d from public.card_payment_decisions d
    where d.id in (select s.decision_id from public.card_payment_removal_sources s where s.removal_id = v_removal);
    select jsonb_agg(to_jsonb(s)) into v_s from public.card_payment_removal_sources s where s.removal_id = v_removal;
    raise exception using errcode = 'TH001', message = 'dry run: undo';
  exception when sqlstate 'TH001' then null;
  end;
  insert into pg_temp.dry_generations select * from jsonb_populate_recordset(null::public.card_payment_removal_generations, v_g);
  insert into pg_temp.dry_decisions select * from jsonb_populate_recordset(null::public.card_payment_decisions, v_d);
  insert into pg_temp.dry_sources select * from jsonb_populate_recordset(null::public.card_payment_removal_sources, v_s);
end $$;

-- ---- Readings of the provenance ------------------------------------------------------------------------------------
-- The provenance rows of one removal (by its item's Plaid item id), sorted — as stored, or (p_dry) as its dry run
-- wrote them:
--   kind(surviving-or-card leg[/other leg][@removed date])<=removed account:removed transaction[relation]
-- ("-" for the transaction when the source had no single row; the relation is confirmed, partner or candidate).
create function pg_temp.sources_of(p_plaid_item text, p_dry boolean default false) returns text language sql as $$
  select coalesce(string_agg(q.x, ' ; ' order by q.x collate "C"), 'none')
  from (select replace(replace(d.kind, 'ambiguity_hold_', 'hold_'), 'destination_removed_card', 'record')
               || '(' || d.a_plaid_transaction_id || coalesce('/' || d.b_plaid_transaction_id, '') || coalesce('@' || d.counterpart_date, '') || ')<='
               || s.source_plaid_account_id || ':' || coalesce(s.source_plaid_transaction_id, '-')
               || '[' || replace(replace(replace(s.source_relation, 'confirmed_counterpart', 'confirmed'),
                                         'automatic_partner', 'partner'), 'removed_candidate', 'candidate') || ']' as x
        from (select * from public.card_payment_removal_sources where not p_dry
              union all select * from pg_temp.dry_sources where p_dry) s
        join (select * from public.card_payment_decisions where not p_dry
              union all select * from pg_temp.dry_decisions where p_dry) d on d.id = s.decision_id and d.user_id = s.user_id
        join public.plaid_item_removals r on r.id = s.removal_id and r.user_id = s.user_id
        where r.plaid_item_id = p_plaid_item) q $$;
-- What the rows of one removal say of their sources on one removed account, the ids that name a source left out:
--   relation|resolution|type/subtype/mask|pending|replaced pending id|date|cents|currency   (by cents)
create function pg_temp.described(p_plaid_item text, p_account text) returns text language sql as $$
  select coalesce(string_agg(s.source_relation || '|' || s.source_resolution || '|' || coalesce(s.source_account_type, 'null') || '/'
                             || coalesce(s.source_account_subtype, 'null') || '/' || coalesce(s.source_account_mask, 'null')
                             || '|' || coalesce(s.source_pending::text, 'null') || '|' || coalesce(s.source_pending_transaction_id, 'null')
                             || '|' || coalesce(s.source_date::text, 'null') || '|' || coalesce(s.source_cents::text, 'null')
                             || '|' || coalesce(s.source_iso_currency_code, 'null'), ' ; ' order by s.source_cents), 'none')
  from public.card_payment_removal_sources s join public.plaid_item_removals r on r.id = s.removal_id
  where r.plaid_item_id = p_plaid_item and s.source_plaid_account_id = p_account $$;
-- A user's generations in their order: "ordinal:removed item:recorded|marker[:institution id]".
create function pg_temp.generations(p_user uuid) returns text language sql as $$
  select coalesce(string_agg(g.ordinal || ':' || r.plaid_item_id || ':' || case when g.sources_recorded then 'recorded' else 'marker' end
                             || coalesce(':' || g.institution_id, ''), ', ' order by g.ordinal), 'none')
  from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
  where g.user_id = p_user $$;
-- The decision a removal wrote, by the removed item and a short kind (pair, record, hold_card, hold_cash): the one
-- that has its provenance row, or (p_dry) the one its dry run wrote.
create function pg_temp.written(p_item text, p_kind text, p_dry boolean default false) returns uuid language plpgsql as $$
declare
  v_kind text := case p_kind when 'pair' then 'pair_counterpart_removed' when 'record' then 'destination_removed_card'
                             when 'hold_card' then 'ambiguity_hold_removed_card' when 'hold_cash' then 'ambiguity_hold_removed_cash_account' end;
  v uuid[];
begin
  if p_dry then
    v := array(select d.id from pg_temp.dry_decisions d join pg_temp.dry_sources s on s.decision_id = d.id
               where s.removal_id = pg_temp.rid('harness-item-' || p_item) and d.kind = v_kind);
  else
    v := array(select d.id from public.card_payment_decisions d join public.card_payment_removal_sources s on s.decision_id = d.id
               where s.removal_id = pg_temp.rid('harness-item-' || p_item) and d.kind = v_kind);
  end if;
  if cardinality(v) <> 1 then
    raise exception 'ASSERTION FAILED: expected one % decision of the removal of item %, found %', p_kind, p_item, cardinality(v);
  end if;
  return v[1];
end $$;
-- A provenance row of a dry run — the one of the decision of that kind — with the columns in p_change replaced,
-- inserted as it stands.
create function pg_temp.put_source(p_item text, p_kind text, p_change jsonb default '{}') returns text language sql as $$
  select pg_temp.put_row('card_payment_removal_sources',
           (select to_jsonb(s) || p_change from pg_temp.dry_sources s where s.decision_id = pg_temp.written(p_item, p_kind, true))) $$;
-- What a source that had no single row looks like: nothing of a transaction's own, and a date and an amount only
-- when a carry-over waited for it.
create function pg_temp.no_row(p_resolution text) returns jsonb language sql as $$
  select jsonb_build_object('source_resolution', p_resolution, 'source_plaid_transaction_id', null, 'source_pending_transaction_id', null,
                            'source_pending', null, 'source_iso_currency_code', null)
         || case when p_resolution = 'waiting_to_post' then '{}'::jsonb else jsonb_build_object('source_date', null, 'source_cents', null) end $$;
-- Every table or column privilege that one of the roles holds on a provenance table; '' when none.
create function pg_temp.privileges_of(p_roles text[]) returns text language sql as $$
  select coalesce(string_agg(format('%s %s %s', t, r, p), '; ' order by t, r, p), '')
  from unnest(array['card_payment_removal_generations', 'card_payment_removal_sources']) t
  cross join unnest(p_roles) r
  cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain']) p
  where has_table_privilege(r, ('public.' || t)::regclass, p)
     or (p in ('select', 'insert', 'update', 'references') and has_any_column_privilege(r, ('public.' || t)::regclass, p)) $$;
-- The keys of a JSON object, and of the objects of a JSON array taken together, sorted.
create function pg_temp.keys(p jsonb) returns text language sql as $$
  select coalesce(string_agg(k, ', ' order by k collate "C"), '') from jsonb_object_keys(p) k $$;
create function pg_temp.element_keys(p jsonb) returns text language sql as $$
  select coalesce(string_agg(x.k, ', ' order by x.k collate "C"), '')
  from (select distinct k from jsonb_array_elements(p) e cross join lateral jsonb_object_keys(e) k) x $$;

-- ---- Fixture -----------------------------------------------------------------------------------------------------
update public.plaid_items set institution_id = 'ins_a', institution_name = 'Bank A' where id = pg_temp.u('1');
update public.plaid_items set institution_id = 'ins_bb', institution_name = 'BB Card Bank' where id = pg_temp.u('2');
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_id, institution_name) values
  (pg_temp.u('3'), pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'ins_kept', 'Kept Bank'),
  (pg_temp.u('4'), pg_temp.aa(), 'harness-item-a4', 'placeholder-token-a4', 'ins_b', 'Bank B'),
  (pg_temp.u('6'), pg_temp.aa(), 'harness-item-a6', 'placeholder-token-a6', 'ins_f', 'Bank F'),
  (pg_temp.u('7'), pg_temp.aa(), 'harness-item-a7', 'placeholder-token-a7', 'ins_u', 'Bank U'),
  (pg_temp.u('5'), pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'ins_bbkept', 'BB Kept Bank'),
  (pg_temp.u('c0'), pg_temp.cc(), 'harness-item-c0', 'placeholder-token-c0', 'ins_cckept', 'CC Kept Bank'),
  (pg_temp.u('c1'), pg_temp.cc(), 'harness-item-c1', 'placeholder-token-c1', 'ins_t1', 'Bank T1'),
  (pg_temp.u('c2'), pg_temp.cc(), 'harness-item-c2', 'placeholder-token-c2', 'ins_t2', 'Bank T2'),
  (pg_temp.u('c3'), pg_temp.cc(), 'harness-item-c3', 'placeholder-token-c3', 'ins_t3', 'Bank T3'),
  (pg_temp.u('c4'), pg_temp.cc(), 'harness-item-c4', 'placeholder-token-c4', 'ins_t4', 'Bank T4');
insert into public.accounts (id, item_id, plaid_account_id, name, type, subtype, mask) values
  (pg_temp.u('27a1'), pg_temp.u('1'), 'a27-x1', 'A Card', 'credit', 'credit card', '1111'),
  (pg_temp.u('27a2'), pg_temp.u('1'), 'a27-ra', 'A Checking', 'depository', 'checking', '3333'),
  -- Bank B's accounts and bb's card have the SAME type, subtype and mask as Bank A's: a description is not an identity.
  (pg_temp.u('27b1'), pg_temp.u('4'), 'a27-x2', 'B Card', 'credit', 'credit card', '1111'),
  (pg_temp.u('27b2'), pg_temp.u('4'), 'a27-rb', 'B Checking', 'depository', 'checking', '3333'),
  (pg_temp.u('27c1'), pg_temp.u('3'), 'a27-c', 'Kept Checking', 'depository', 'checking', '9001'),
  (pg_temp.u('27c2'), pg_temp.u('3'), 'a27-y', 'Kept Card Y', 'credit', 'credit card', '9002'),
  (pg_temp.u('27f1'), pg_temp.u('6'), 'a27-xf', 'F Card', 'credit', 'credit card', '6001'),
  (pg_temp.u('27f7'), pg_temp.u('7'), 'a27-xu', 'U Card', 'credit', 'credit card', '7001'),
  (pg_temp.u('27d2'), pg_temp.u('2'), 'a27-bx', 'BB Card BX', 'credit', 'credit card', '1111'),
  (pg_temp.u('27d1'), pg_temp.u('5'), 'a27-bc', 'BB Checking', 'depository', 'checking', '9001'),
  (pg_temp.u('27d3'), pg_temp.u('5'), 'a27-by', 'BB Kept Card BY', 'credit', 'credit card', '9002'),
  (pg_temp.u('27e1'), pg_temp.u('c0'), 'a27-cc', 'CC Checking', 'depository', 'checking', '9001'),
  (pg_temp.u('27e2'), pg_temp.u('c0'), 'a27-cy', 'CC Kept Card', 'credit', 'credit card', '9002'),
  (pg_temp.u('27e3'), pg_temp.u('c1'), 'a27-t1', 'T1 Card', 'credit', 'credit card', '1111'),
  (pg_temp.u('27e4'), pg_temp.u('c2'), 'a27-t2', 'T2 Card', 'credit', 'credit card', '1111'),
  (pg_temp.u('27e5'), pg_temp.u('c3'), 'a27-t3', 'T3 Card', 'credit', 'credit card', '1111'),
  (pg_temp.u('27e6'), pg_temp.u('c4'), 'a27-t4', 'T4 Card', 'credit', 'credit card', '1111');
select pg_temp.cardleg('k-u', '27c1', 270, '2026-09-10'), pg_temp.cardleg('xu-u', '27f7', -270, '2026-09-11');                                  -- U
select pg_temp.cardleg('k-p', '27c1', 210, '2026-09-10'), pg_temp.cardleg('x1-p', '27a1', -210, '2026-09-11');                                  -- P
select pg_temp.cardleg('k-r', '27c1', 130, '2026-09-10'), pg_temp.cardleg('x1-r', '27a1', -130, '2026-09-11');                                  -- R
select pg_temp.cardleg('k-h', '27c1', 140, '2026-09-10'), pg_temp.cardleg('x1-h', '27a1', -140, '2026-09-11'),
       pg_temp.cardleg('y-h', '27c2', -140, '2026-09-11');                                                                                     -- H
select pg_temp.cardleg('y-g', '27c2', -150, '2026-09-10'), pg_temp.cardleg('ra-g', '27a2', 150, '2026-09-11'),
       pg_temp.cardleg('k-g', '27c1', 150, '2026-09-13');                                                                                      -- G
select pg_temp.cardleg('k-p2', '27c1', 310, '2026-09-10'), pg_temp.cardleg('x2-p2-pend', '27b1', -310, '2026-09-11', true);                     -- P2
select pg_temp.cardleg('k-r2', '27c1', 230, '2026-09-10'), pg_temp.cardleg('x2-r2', '27b1', -230, '2026-09-11');                                -- R2
select pg_temp.cardleg('k-h2', '27c1', 240, '2026-09-10'), pg_temp.cardleg('x2-h2', '27b1', -240, '2026-09-11'),
       pg_temp.cardleg('y-h2', '27c2', -240, '2026-09-11');                                                                                    -- H2
select pg_temp.cardleg('y-g2', '27c2', -250, '2026-09-10'), pg_temp.cardleg('rb-g2', '27b2', 250, '2026-09-11'),
       pg_temp.cardleg('k-g2', '27c1', 250, '2026-09-13');                                                                                     -- G2
-- An ordinary transaction (no card payment) on Bank B's checking account, a day BEFORE the cash leg rb-g2: a real
-- row of the removed item for the probe of a hold whose source is dated before the hold.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version) values
  (pg_temp.u('27b2'), 'rb-early', 12.34, '2026-09-10', 'Ordinary', 'expense', 'sign_default', 'low', 1);
select pg_temp.cardleg('k-n', '27c1', 350, '2026-09-10'), pg_temp.cardleg('y-n', '27c2', -350, '2026-09-12');                                   -- N
select pg_temp.cardleg('k-m', '27c1', 360, '2026-09-10');                                                                                      -- M
select pg_temp.cardleg('b-p', '27d1', 210, '2026-09-10'), pg_temp.cardleg('bx-p', '27d2', -210, '2026-09-11'),                                  -- bb
       pg_temp.cardleg('b-r', '27d1', 130, '2026-09-10'), pg_temp.cardleg('bx-r', '27d2', -130, '2026-09-11'),
       pg_temp.cardleg('b-h', '27d1', 140, '2026-09-10'), pg_temp.cardleg('bx-h', '27d2', -140, '2026-09-11'),
       pg_temp.cardleg('by-h', '27d3', -140, '2026-09-11');
select pg_temp.cardleg('m1', '27e1', 410, '2026-09-10'), pg_temp.cardleg('t1x', '27e3', -410, '2026-09-10'), pg_temp.cardleg('cy1', '27e2', -410, '2026-09-12'),  -- cc
       pg_temp.cardleg('m2', '27e1', 420, '2026-09-10'), pg_temp.cardleg('t2x', '27e4', -420, '2026-09-11'), pg_temp.cardleg('cy2', '27e2', -420, '2026-09-11'),
       pg_temp.cardleg('m3', '27e1', 430, '2026-09-10'), pg_temp.cardleg('t3x', '27e5', -430, '2026-09-10'), pg_temp.cardleg('cy3', '27e2', -430, '2026-09-12'),
       pg_temp.cardleg('m4', '27e1', 440, '2026-09-10'), pg_temp.cardleg('t4x', '27e6', -440, '2026-09-11'), pg_temp.cardleg('cy4', '27e2', -440, '2026-09-11');
select pg_temp.evaluate();

-- The users' own decisions, through the real RPCs. Then P2's pending card leg posts, a day later.
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-p'), pg_temp.tid('x1-p'), 0, pg_temp.iv(pg_temp.aa()))->>'status' = 'saved', 'fixture, P: aa confirms k-p with x1-p');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-p2'), pg_temp.tid('x2-p2-pend'), 0, pg_temp.iv(pg_temp.aa()))->>'status' = 'saved', 'fixture, P2: aa confirms k-p2 with the pending x2-p2-pend');
select th.assert(public.dismiss_card_payment_candidate(pg_temp.aa(), pg_temp.tid('k-n'), pg_temp.tid('y-n'), pg_temp.iv(pg_temp.aa()))->>'status' = 'saved', 'fixture, N: aa dismisses y-n as the match of k-n');
select th.assert(public.mark_card_payment_destination(pg_temp.aa(), pg_temp.tid('k-m'), pg_temp.iv(pg_temp.aa()))->>'status' = 'saved', 'fixture, M: aa marks k-m as a payment to an untracked card');
select th.assert(public.link_card_payment(pg_temp.bb(), pg_temp.tid('b-p'), pg_temp.tid('bx-p'), 0, pg_temp.iv(pg_temp.bb()))->>'status' = 'saved', 'fixture, bb: bb confirms b-p with bx-p');
select pg_temp.cardleg('x2-p2', '27b1', -310, '2026-09-12', false, 'x2-p2-pend');
delete from public.transactions where plaid_transaction_id = 'x2-p2-pend';
select pg_temp.evaluate();

select th.assert((select string_agg(v.p || '=' || pg_temp.srep(v.p), ' ' order by v.n)
                  from (values (1, 'k-u'), (2, 'k-p'), (3, 'k-r'), (4, 'k-h'), (5, 'y-g'), (6, 'k-p2'), (7, 'k-r2'), (8, 'k-h2'), (9, 'y-g2')) v(n, p))
                 = 'k-u=tracked/auto_pair/0 k-p=tracked/user_pair/0 k-r=tracked/auto_pair/0 k-h=unresolved/ambiguous/null y-g=paired/auto_pair/0 '
                   || 'k-p2=tracked/user_pair/0 k-r2=tracked/auto_pair/0 k-h2=unresolved/ambiguous/null y-g2=paired/auto_pair/0',
  'fixture, aa: U R R2 are matched automatically, P P2 by the user (P2 through its posted row), H H2 are ties, G G2 kept card legs matched to a cash leg that will be removed');
select th.assert((select string_agg(d.kind, ', ' order by d.kind) from public.card_payment_decisions d where d.user_id = pg_temp.aa() and d.superseded_by is null)
                 = 'destination_unlinked, not_this_pair, pair, pair'
                 and (select string_agg(d.kind, ', ') from public.card_payment_decisions d where d.user_id = pg_temp.bb()) = 'pair'
                 and not exists (select 1 from public.card_payment_decisions d where d.user_id = pg_temp.cc()),
  'fixture: the only decisions are the users'' own — aa''s two pairs, a dismissal and a mark; bb''s pair');
select th.assert((select count(*) from public.card_payment_removal_generations) = 0 and (select count(*) from public.card_payment_removal_sources) = 0,
  'fixture: both provenance tables are empty');

-- ---- R0: a real removal; then it is made to look as a removal that ran WITHOUT provenance does ---------------
select pg_temp.remove(pg_temp.aa(), '7');
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:recorded:ins_u'
                 and pg_temp.sources_of('harness-item-a7') = 'record(k-u)<=a27-xu:xu-u[partner]',
  'R0: the removal of Bank U is the user''s first generation and records the source of its one record');
-- Only the tables' owner can delete a generation; its provenance row goes with it, the record stays.
reset role;
delete from public.card_payment_removal_generations where removal_id = pg_temp.rid('harness-item-a7');
set role service_role;
select th.assert(pg_temp.generations(pg_temp.aa()) = 'none' and (select count(*) from public.card_payment_removal_sources) = 0
                 and (select count(*) = 1 from public.card_payment_decisions d
                      where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u' and d.superseded_by is null)
                 and (select r.status = 'cleaned' from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-a7'),
  'R0 now looks unrecorded: a cleaned removal, its record, no generation and no provenance');
-- A removal that is finished: it can be MARKED, and nothing else.
select th.assert(pg_temp.put_generation(pg_temp.rid('harness-item-a7'), pg_temp.aa(), false) = 'accepted: 1',
  'generations guard: a marker for a finished removal that has no generation is accepted (the control)');
select th.assert(pg_temp.recorded_at_given(pg_temp.rid('harness-item-a7'), pg_temp.aa(), false, '2020-01-01 00:00:00+00') = transaction_timestamp()
                 and pg_temp.recorded_at_given(pg_temp.rid('harness-item-a7'), pg_temp.aa(), false, '2099-01-01 00:00:00+00') = transaction_timestamp()
                 and pg_temp.recorded_at_given(pg_temp.rid('harness-item-a7'), pg_temp.aa(), false, null) = transaction_timestamp(),
  'the time an INSERT supplies for a MARKER is ignored — a time years ago, one years ahead, or none: it is the start of the transaction that writes it');
select th.assert(pg_temp.put_generation(pg_temp.rid('harness-item-a7'), pg_temp.aa(), true, 'ins_u') = '42501: card_payment_removal_provenance_wrong_moment',
  'generations guard, wrong moment: a finished removal cannot be declared recorded afterwards');
select th.assert(pg_temp.put_generation(pg_temp.rid('harness-item-a7'), pg_temp.aa(), false, 'ins_u') = pg_temp.violates('generations', 'unrecorded_check'),
  'unrecorded_check: a marker carries no institution id');

-- ---- R1: a real removal, complete --------------------------------------------------------------------------------
select pg_temp.remove(pg_temp.aa(), '1');
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a',
  'R1: the removal of Bank A first marks the unrecorded removal, then records its own generation');
select th.assert(pg_temp.sources_of('harness-item-a') = 'hold_removed_card(y-h/k-h@2026-09-11)<=a27-x1:x1-h[candidate] ; '
                   || 'hold_removed_cash_account(y-g/k-g@2026-09-11)<=a27-ra:ra-g[partner] ; '
                   || 'pair_counterpart_removed(k-p/x1-p)<=a27-x1:x1-p[confirmed] ; record(k-r)<=a27-x1:x1-r[partner]'
                 and pg_temp.sources_of('harness-item-a7') = 'none' and (select count(*) from public.card_payment_removal_sources) = 4,
  'R1: one decision of each kind a removal writes, each with its source; the marked removal has none');

-- ---- R2 and RB are confirmed at Plaid and stop there: RUNNING. R3 is only requested ---------------------------------
select pg_temp.begin_removal(pg_temp.aa(), '4'), pg_temp.confirm_removal(pg_temp.aa(), '4');
select pg_temp.begin_removal(pg_temp.bb(), '2'), pg_temp.confirm_removal(pg_temp.bb(), '2');
select pg_temp.begin_removal(pg_temp.aa(), '6');
select th.assert((select string_agg(r.plaid_item_id || '=' || r.status, ', ' order by r.plaid_item_id collate "C") from public.plaid_item_removals r)
                 = 'harness-item-a=cleaned, harness-item-a4=plaid_removed, harness-item-a6=requested, harness-item-a7=cleaned, harness-item-b=plaid_removed',
  'the ledger: two finished removals, two running, one requested');
create temporary table before_dry as
  select pg_temp.iv(pg_temp.aa()) as iv_aa, pg_temp.iv(pg_temp.bb()) as iv_bb,
         (select string_agg(d.id::text, ',' order by d.id) from public.card_payment_decisions d) as decisions,
         (select count(*) from public.transactions) as transactions, (select count(*) from public.accounts) as accounts;
select pg_temp.dry_run(pg_temp.aa(), '4'), pg_temp.dry_run(pg_temp.bb(), '2');
select th.assert(pg_temp.sources_of('harness-item-a4', true) = 'hold_removed_card(y-h2/k-h2@2026-09-11)<=a27-x2:x2-h2[candidate] ; '
                   || 'hold_removed_cash_account(y-g2/k-g2@2026-09-11)<=a27-rb:rb-g2[partner] ; '
                   || 'pair_counterpart_removed(k-p2/x2-p2-pend)<=a27-x2:x2-p2[confirmed] ; record(k-r2)<=a27-x2:x2-r2[partner]'
                 and pg_temp.sources_of('harness-item-b', true) = 'hold_removed_card(by-h/b-h@2026-09-11)<=a27-bx:bx-h[candidate] ; '
                   || 'pair_counterpart_removed(b-p/bx-p)<=a27-bx:bx-p[confirmed] ; record(b-r)<=a27-bx:bx-r[partner]'
                 and (select string_agg(r.plaid_item_id || ':' || g.ordinal || ':' || g.sources_recorded || ':' || g.institution_id, ', ' order by r.plaid_item_id collate "C")
                      from pg_temp.dry_generations g join public.plaid_item_removals r on r.id = g.removal_id and r.user_id = g.user_id)
                     = 'harness-item-a4:3:true:ins_b, harness-item-b:1:true:ins_bb',
  'dry runs: what R2 and RB will write — R2 one decision of each kind, as aa''s third generation; RB three, as bb''s first');
select th.assert((select s.source_plaid_transaction_id = 'x2-p2' and s.source_pending_transaction_id = 'x2-p2-pend' and s.source_date = '2026-09-12'
                         and d.b_plaid_transaction_id = 'x2-p2-pend'
                  from pg_temp.dry_sources s join pg_temp.dry_decisions d on d.id = s.decision_id where d.id = pg_temp.written('a4', 'pair', true)),
  'dry runs, P2: the preserved pair keeps the reference the user confirmed (the pending id); its source is the posted row, which names that id as the one it replaced');
select th.assert((select b.iv_aa = pg_temp.iv(pg_temp.aa()) and b.iv_bb = pg_temp.iv(pg_temp.bb()) and b.transactions = (select count(*) from public.transactions)
                         and b.accounts = (select count(*) from public.accounts)
                         and b.decisions = (select string_agg(d.id::text, ',' order by d.id) from public.card_payment_decisions d) from before_dry b)
                 and (select count(*) = 2 from public.plaid_item_removals r where r.status = 'plaid_removed')
                 and pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a' and pg_temp.generations(pg_temp.bb()) = 'none'
                 and (select count(*) from public.card_payment_removal_sources) = 4
                 and (select count(*) = 2 from public.plaid_items i where i.id in (pg_temp.u('4'), pg_temp.u('2')) and i.status = 'removing'),
  'dry runs: nothing of them remains — both removals are still running, with no generation, no decision and no provenance row');

-- ==== 1. Catalog ======================================================================================================
select th.assert((select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class c
                  where c.oid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)),
  'catalog: row level security is enabled on both tables');
select th.assert(not exists (select 1 from pg_policy p
                             where p.polrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)),
  'catalog: neither table has a policy');
select th.assert(pg_temp.privileges_of(array['public', 'anon', 'authenticated']) = '',
  'catalog: PUBLIC, anon and authenticated hold no table or column privilege of any kind on either table: ' || pg_temp.privileges_of(array['public', 'anon', 'authenticated']));
select th.assert(pg_temp.privileges_of(array['service_role'])
                 = 'card_payment_removal_generations service_role insert; card_payment_removal_generations service_role select; '
                   || 'card_payment_removal_sources service_role insert; card_payment_removal_sources service_role select',
  'catalog: service_role holds exactly SELECT and INSERT on both tables: ' || pg_temp.privileges_of(array['service_role']));
select th.assert(not exists (select 1 from pg_attribute a
                             where a.attrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
                               and a.attnum > 0 and a.attacl is not null),
  'catalog: no column of either table has a grant of its own, for any role');
select th.assert((select bool_and(x.acl = 'postgres DELETE, postgres INSERT, postgres MAINTAIN, postgres REFERENCES, postgres SELECT, postgres TRIGGER, '
                                          || 'postgres TRUNCATE, postgres UPDATE, service_role INSERT, service_role SELECT') and count(*) = 2
                  from (select (select string_agg(pg_get_userbyid(a.grantee) || ' ' || a.privilege_type || case when a.is_grantable then ' WITH GRANT OPTION' else '' end,
                                                  ', ' order by pg_get_userbyid(a.grantee), a.privilege_type)
                                from aclexplode(c.relacl) a) as acl
                        from pg_class c
                        where c.oid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)) x),
  'catalog: the complete privilege list of each table is its owner''s and the service role''s SELECT and INSERT — no other role appears, and nothing can be granted on');
select th.assert((select count(*) = 2 and bool_and(p.pronargs = 0 and p.prorettype = 'trigger'::regtype and l.lanname = 'plpgsql')
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
                  where n.nspname = 'public' and p.proname in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard')),
  'catalog: the two guard functions exist, once each');
select th.assert((select bool_and(not p.prosecdef and p.proconfig = array['search_path=""'])
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard')),
  'catalog: both guard functions are SECURITY INVOKER with the search path pinned empty');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) r
                             where n.nspname = 'public' and p.proname in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard')
                               and has_function_privilege(r, p.oid, 'execute')),
  'catalog: neither guard function is executable by PUBLIC, anon, authenticated or service_role');
-- tgtype 23: a row trigger (1), before (2), on insert (4) and update (16) — not on delete (8) or truncate (32).
select th.assert((select string_agg(c.relname || ' ' || t.tgname || ' ' || t.tgtype || ' ' || t.tgenabled::text || ' ' || p.proname || ' '
                                    || (t.tgqual is null and t.tgattr::text = '' and t.tgnargs = 0), ', ' order by c.relname)
                  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass) and not t.tgisinternal)
                 = 'card_payment_removal_generations card_payment_removal_generations_guard 23 O card_payment_removal_generations_guard true, '
                   || 'card_payment_removal_sources card_payment_removal_sources_guard 23 O card_payment_removal_sources_guard true',
  'catalog: each table has its guard, enabled, BEFORE INSERT OR UPDATE FOR EACH ROW, unconditional — and no other trigger');
select th.assert(not exists (select 1 from pg_constraint c
                             where c.contype = 'f'
                               and c.conrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
                               and c.confrelid in ('public.accounts'::regclass, 'public.transactions'::regclass, 'public.plaid_items'::regclass)),
  'catalog: no foreign key leads from either table to accounts, transactions or plaid_items');
select th.assert((select string_agg(c.conname || ' (' || (select string_agg(a.attname, ',' order by k.n) from unnest(c.conkey) with ordinality k(attnum, n)
                                                             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
                                    || ') -> ' || fn.nspname || '.' || f.relname || ' (' || (select string_agg(a.attname, ',' order by k.n) from unnest(c.confkey) with ordinality k(attnum, n)
                                                                                              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
                                    || ') delete=' || c.confdeltype::text || ' update=' || c.confupdtype::text || ' ' || (c.convalidated and not c.condeferrable), ' | ' order by c.conname)
                  from pg_constraint c join pg_class f on f.oid = c.confrelid join pg_namespace fn on fn.oid = f.relnamespace
                  where c.contype = 'f'
                    and c.conrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass))
                 = 'card_payment_removal_generations_removal_id_fkey (removal_id) -> public.plaid_item_removals (id) delete=c update=a true | '
                   || 'card_payment_removal_generations_user_id_fkey (user_id) -> auth.users (id) delete=c update=a true | '
                   || 'card_payment_removal_sources_decision_id_fkey (decision_id) -> public.card_payment_decisions (id) delete=c update=a true | '
                   || 'card_payment_removal_sources_generation_fkey (removal_id,user_id) -> public.card_payment_removal_generations (removal_id,user_id) delete=c update=a true | '
                   || 'card_payment_removal_sources_user_id_fkey (user_id) -> auth.users (id) delete=c update=a true',
  'catalog: the five foreign keys — to the ledger, the user, the decision and the generation — each ON DELETE CASCADE, validated, not deferrable');
select th.assert((select string_agg(c.conname, ', ' order by c.conname) from pg_constraint c
                  where c.contype = 'f'
                    and c.confrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass))
                 = 'card_payment_removal_sources_generation_fkey',
  'catalog: nothing references either table but the provenance row''s own key to its generation');
select th.assert((select string_agg(c.conname || ':' || c.contype::text, ', ' order by c.conname) from pg_constraint c
                  where c.conrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
                    and c.contype in ('p', 'u', 'c') and c.convalidated)
                 = 'card_payment_removal_generations_ordinal_check:c, card_payment_removal_generations_pkey:p, card_payment_removal_generations_removal_user_key:u, '
                   || 'card_payment_removal_generations_unrecorded_check:c, card_payment_removal_generations_user_ordinal_key:u, '
                   || 'card_payment_removal_sources_observed_check:c, card_payment_removal_sources_pkey:p, '
                   || 'card_payment_removal_sources_relation_check:c, card_payment_removal_sources_resolution_check:c',
  'catalog: the two primary keys, the two unique keys and the five checks — none of them on the content of a Plaid id');
-- Nothing a client can call or read is built on either table.
select th.assert((select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname)
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_temp' and p.prosrc ~ 'card_payment_removal_(generations|sources)')
                 = 'public.card_payment_removal_generations_guard, public.card_payment_removal_sources_guard, public.card_payment_review_capture, '
                   || 'public.card_payment_review_record_gaps, public.card_payment_review_seed_retained, public.remove_plaid_item_local'
                 -- No client role can execute ANY function of that inventory (not only the removal).
                 and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 cross join unnest(array['public', 'anon', 'authenticated']) r
                                 where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_temp'
                                   and p.prosrc ~ 'card_payment_removal_(generations|sources)' and has_function_privilege(r, p.oid, 'execute'))
                 -- The three functions 20261009120000 adds to the inventory only READ the provenance: none of them
                 -- inserts into, updates or deletes from either table.
                 and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public'
                                   and p.proname in ('card_payment_review_capture', 'card_payment_review_record_gaps', 'card_payment_review_seed_retained')
                                   and p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+public[.]card_payment_removal_(generations|sources)'),
  'catalog: the only functions whose source names a provenance table are the removal, the two guards, and the three functions of 20261009120000 that READ it (the review capture, the gap recorder, the seeding of retained history); none of those three writes to it, and no client role can execute any of the six');
select th.assert(not exists (select 1 from pg_depend d
                             where d.refclassid = 'pg_class'::regclass
                               and d.refobjid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
                               and d.classid in ('pg_rewrite'::regclass, 'pg_proc'::regclass, 'pg_policy'::regclass, 'pg_publication_rel'::regclass)),
  'catalog: no view, rule, policy, SQL-bodied function or publication is built on either table');
select th.assert(not exists (select 1 from pg_publication_tables t where t.schemaname = 'public' and t.tablename like 'card\_payment\_removal\_%')
                 and not exists (select 1 from pg_publication p where p.puballtables),
  'catalog: no publication carries either table to a subscriber');
-- (The literal is the one the postcondition of 20261009120000 names: that file replaces 20261008120000's body,
-- cc12b7a12c6510924781b93c658ee854, with the same text plus the review capture. It must follow that file.)
select th.assert((select md5(replace(p.prosrc, E'\r', '')) from pg_proc p where p.oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure)
                 = '5b3cb3fdc0ab9570a345cf1ace387481',
  'catalog: the installed remove_plaid_item_local is the body 20261009120000 installs');

-- ==== 2. Runtime, as each role ==========================================================================================
-- Both tables hold rows now (R1's generation and the marker; R1's four provenance rows): a refusal below is a
-- refusal, not an empty table.
create function pg_temp.client_statements() returns table (tbl text, what text, statement text) language sql as $$
  values
    ('card_payment_removal_generations', 'SELECT *', 'select * from public.card_payment_removal_generations'),
    ('card_payment_removal_generations', 'SELECT of one column', 'select ordinal from public.card_payment_removal_generations'),
    ('card_payment_removal_generations', 'SELECT count', 'select count(*) from public.card_payment_removal_generations'),
    ('card_payment_removal_generations', 'INSERT', $q$ insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)
                                                      values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', false) $q$),
    ('card_payment_removal_generations', 'UPDATE of a descriptive column', 'update public.card_payment_removal_generations set institution_id = null'),
    ('card_payment_removal_generations', 'UPDATE of an identity column', 'update public.card_payment_removal_generations set ordinal = ordinal + 1'),
    ('card_payment_removal_generations', 'DELETE', 'delete from public.card_payment_removal_generations'),
    ('card_payment_removal_generations', 'TRUNCATE', 'truncate public.card_payment_removal_generations'),
    ('card_payment_removal_sources', 'SELECT *', 'select * from public.card_payment_removal_sources'),
    ('card_payment_removal_sources', 'SELECT of one column', 'select source_account_mask from public.card_payment_removal_sources'),
    ('card_payment_removal_sources', 'SELECT count', 'select count(*) from public.card_payment_removal_sources'),
    ('card_payment_removal_sources', 'INSERT', $q$ insert into public.card_payment_removal_sources
                                                    (decision_id, user_id, removal_id, source_relation, source_resolution, source_plaid_account_id)
                                                  values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), 'confirmed_counterpart', 'gone', 'x') $q$),
    ('card_payment_removal_sources', 'UPDATE of a descriptive column', 'update public.card_payment_removal_sources set source_account_mask = null'),
    ('card_payment_removal_sources', 'UPDATE of an identity column', $q$ update public.card_payment_removal_sources set source_plaid_transaction_id = 'x' $q$),
    ('card_payment_removal_sources', 'DELETE', 'delete from public.card_payment_removal_sources'),
    ('card_payment_removal_sources', 'TRUNCATE', 'truncate public.card_payment_removal_sources') $$;
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.assert(x.got = '42501: permission denied for table ' || s.tbl,
                 format('authenticated, as the user the rows are about: %s on %s is refused with a permission error (%s)', s.what, s.tbl, x.got))
from pg_temp.client_statements() s cross join lateral (select pg_temp.attempt(s.statement) as got) x;
rollback;
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000bb","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000bb';
select th.assert(x.got = '42501: permission denied for table ' || s.tbl,
                 format('authenticated, as another user: %s on %s is refused with a permission error (%s)', s.what, s.tbl, x.got))
from pg_temp.client_statements() s cross join lateral (select pg_temp.attempt(s.statement) as got) x;
rollback;
begin;
set local role anon;
select th.assert(x.got = '42501: permission denied for table ' || s.tbl,
                 format('anon: %s on %s is refused with a permission error (%s)', s.what, s.tbl, x.got))
from pg_temp.client_statements() s cross join lateral (select pg_temp.attempt(s.statement) as got) x;
rollback;
-- The service role reads and inserts; it can change, delete or empty nothing.
select th.assert((select count(*) from public.card_payment_removal_generations) = 2 and (select count(*) from public.card_payment_removal_sources) = 4,
  'service_role reads both tables: two generations, four provenance rows');
select th.assert(x.got = '42501: permission denied for table ' || s.tbl,
                 format('service_role: %s on %s is refused with a permission error (%s)', s.what, s.tbl, x.got))
from pg_temp.client_statements() s cross join lateral (select pg_temp.attempt(s.statement) as got) x
where s.what like 'UPDATE%' or s.what in ('DELETE', 'TRUNCATE');
select th.assert((select string_agg(s.tbl || '=' || pg_temp.attempt(s.statement), ', ' order by s.tbl) from pg_temp.client_statements() s where s.what = 'INSERT')
                 = 'card_payment_removal_generations=42501: card_payment_removal_provenance_foreign_removal, '
                   || 'card_payment_removal_sources=42501: card_payment_removal_provenance_foreign_decision',
  'service_role: an INSERT is not refused for want of a privilege — it reaches the table''s guard, which refuses these two');
select th.assert(pg_temp.attempt('select 1 from public.card_payment_removal_sources for update') = '42501: permission denied for table card_payment_removal_sources'
                 and pg_temp.attempt('select 1 from public.card_payment_removal_generations for key share') = '42501: permission denied for table card_payment_removal_generations',
  'service_role cannot lock a row of either table');
-- Row security is the second layer: with SELECT granted back (and rolled back), a client still reads no row.
reset role;
begin;
grant select on public.card_payment_removal_generations, public.card_payment_removal_sources to anon, authenticated;
select th.assert(pg_temp.privileges_of(array['public', 'anon', 'authenticated'])
                 = 'card_payment_removal_generations anon select; card_payment_removal_generations authenticated select; '
                   || 'card_payment_removal_sources anon select; card_payment_removal_sources authenticated select',
  'negative control: a re-granted SELECT is detected: ' || pg_temp.privileges_of(array['public', 'anon', 'authenticated']));
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.assert((select count(*) from public.card_payment_removal_generations) = 0 and (select count(*) from public.card_payment_removal_sources) = 0,
  'negative control: even with SELECT granted, row security with no policy shows a user no row — not its own either');
rollback;
select th.assert(pg_temp.privileges_of(array['public', 'anon', 'authenticated']) = '', 'negative control rolled back');
set role service_role;

-- ==== 3. The guards and the checks, while R2 (and bb's RB) are running ====================================================
-- One transaction, rolled back at its end. What the function itself would write is written here by hand, from the
-- dry runs' rows — the decisions, then the generations, then the provenance rows: those rows are the controls, and
-- every probe is one of them with one thing changed. The sources guard accepts a row only in the transaction that
-- wrote its generation: that is why the generations are written in this transaction too. What a LATER transaction
-- meets comes after it.
begin;

-- ---- A generation: this user's removal, at the right moment; its ordinal and its time are assigned ----------------------
select th.assert(x.got = v.want, format('generations guard, %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('a recorded generation for a removal that is running (the control)',         'harness-item-a4', pg_temp.aa(), true,  'accepted: 1'),
  ('a MARKER for a removal that is running',                                    'harness-item-a4', pg_temp.aa(), false, '42501: card_payment_removal_provenance_wrong_moment'),
  ('a recorded generation for a removal that is only requested',                'harness-item-a6', pg_temp.aa(), true,  '42501: card_payment_removal_provenance_wrong_moment'),
  ('a marker for a removal that is only requested',                             'harness-item-a6', pg_temp.aa(), false, '42501: card_payment_removal_provenance_wrong_moment'),
  ('a recorded generation for a finished removal, which has one',               'harness-item-a',  pg_temp.aa(), true,  '42501: card_payment_removal_provenance_wrong_moment'),
  ('a second marker for a finished removal: the guard passes it, the key not',  'harness-item-a7', pg_temp.aa(), false, '23505: duplicate key value violates unique constraint "card_payment_removal_generations_pkey"'),
  ('another user''s running removal, under that user (the control)',            'harness-item-b',  pg_temp.bb(), true,  'accepted: 1'),
  ('another user''s running removal, claimed by this user',                     'harness-item-b',  pg_temp.aa(), true,  '42501: card_payment_removal_provenance_foreign_removal'),
  ('this user''s running removal, claimed by another user',                     'harness-item-a4', pg_temp.bb(), true,  '42501: card_payment_removal_provenance_foreign_removal')
) v(what, item, usr, recorded, want)
cross join lateral (select pg_temp.put_generation(pg_temp.rid(v.item), v.usr, v.recorded) as got) x;
select th.assert(pg_temp.put_generation(gen_random_uuid(), pg_temp.aa(), true) = '42501: card_payment_removal_provenance_foreign_removal',
  'generations guard, foreign removal: a removal that does not exist');
select th.assert(pg_temp.ordinal_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, 999) = 3
                 and pg_temp.ordinal_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, 0) = 3
                 and pg_temp.ordinal_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, 1) = 3
                 and pg_temp.ordinal_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, null) = 3
                 and pg_temp.ordinal_given(pg_temp.rid('harness-item-b'), pg_temp.bb(), true, 999) = 1,
  'the ordinal an INSERT supplies is ignored — 999, 0, one that is taken, or none: aa''s next generation is its third, bb''s its first');
select th.assert(pg_temp.recorded_at_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, '2020-01-01 00:00:00+00') = transaction_timestamp()
                 and pg_temp.recorded_at_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, '2099-01-01 00:00:00+00') = transaction_timestamp()
                 and pg_temp.recorded_at_given(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, null) = transaction_timestamp()
                 and transaction_timestamp() < statement_timestamp(),
  'the time an INSERT supplies for a recorded generation is ignored — a time years ago, one years ahead, or none: it is the start of this transaction, not the time of the statement');

-- ---- A provenance row needs the generation of its removal, written in this transaction --------------------------------------
-- The decisions first, as the function writes them (their ids are the dry runs'). Before any generation exists,
-- the very rows the function writes are refused.
insert into public.card_payment_decisions select * from pg_temp.dry_decisions;
select th.assert(x.got = '42501: card_payment_removal_provenance_wrong_moment',
                 format('sources guard, wrong moment: while its removal has no generation, the row the function writes for the %s of the removal of %s is refused (got %s)', v.kind, v.item, x.got))
from (values ('a4', 'pair'), ('a4', 'record'), ('a4', 'hold_card'), ('a4', 'hold_cash'), ('b', 'pair'), ('b', 'record'), ('b', 'hold_card')) v(item, kind)
cross join lateral (select pg_temp.put_source(v.item, v.kind) as got) x;
-- Nor is a MARKER enough. No path gives a running removal one (a marker is accepted only for a finished removal, and
-- nothing moves a removal back), so the ledger row is moved by hand, forth and back, to have one: then the marker
-- is the ONE thing wrong — it was written in this transaction, the removal is running, the account and the
-- transaction are there.
savepoint marked;
update public.plaid_item_removals set status = 'cleaned', cleaned_at = now(), loan_adjustments = '[]', deleted_counts = '{}' where plaid_item_id = 'harness-item-a4';
insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded) values (pg_temp.rid('harness-item-a4'), pg_temp.aa(), false);
update public.plaid_item_removals set status = 'plaid_removed', cleaned_at = null, loan_adjustments = null, deleted_counts = null where plaid_item_id = 'harness-item-a4';
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a, 3:harness-item-a4:marker'
                 and (select r.status = 'plaid_removed' from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-a4')
                 and pg_temp.put_source('a4', 'hold_card') = '42501: card_payment_removal_provenance_wrong_moment',
  'sources guard, wrong moment: under a MARKER — written in this transaction, for a removal that is running — the row the function writes is refused');
rollback to savepoint marked;
-- The generations of R2 and RB, by hand. They and the decisions stay for the rest of this transaction.
insert into public.card_payment_removal_generations (removal_id, user_id, ordinal, sources_recorded, institution_id)
select g.removal_id, g.user_id, 999, g.sources_recorded, g.institution_id from pg_temp.dry_generations g;
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a, 3:harness-item-a4:recorded:ins_b'
                 and pg_temp.generations(pg_temp.bb()) = '1:harness-item-b:recorded:ins_bb',
  'written by hand as the function writes them, the two generations are stored with the next ordinal of their users, not the 999 supplied');
select th.assert(pg_temp.put_generation(pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, 'ins_b')
                 = '23505: duplicate key value violates unique constraint "card_payment_removal_generations_pkey"',
  'a removal has one generation: a second execution stops at the primary key');

-- ---- A provenance row: the controls ---------------------------------------------------------------------------------------
select th.assert(x.got = 'accepted: 1', format('sources guard, the control: the row the function writes for the %s of the removal of %s is accepted (got %s)', v.kind, v.item, x.got))
from (values ('a4', 'pair'), ('a4', 'record'), ('a4', 'hold_card'), ('a4', 'hold_cash'), ('b', 'pair'), ('b', 'record'), ('b', 'hold_card')) v(item, kind)
cross join lateral (select pg_temp.put_source(v.item, v.kind) as got) x;

-- ---- Wrong moment: not under a recorded generation of a running removal; not about an account of its item ----------------
-- The first three name another removal of the user and fail several conditions at once, as such a row really
-- does: no recorded generation of this transaction (an earlier transaction's, a marker, or none), a removal that is
-- not running, and no such account on its item. The others break one condition each.
select th.assert(x.got = '42501: card_payment_removal_provenance_wrong_moment', format('sources guard, wrong moment: %s (got %s)', v.what, x.got))
from (values
  ('under the recorded generation of a FINISHED removal',                             jsonb_build_object('removal_id', pg_temp.rid('harness-item-a'))),
  ('under the MARKER of a finished removal',                                          jsonb_build_object('removal_id', pg_temp.rid('harness-item-a7'))),
  ('under a removal that is only requested, and has no generation',                   jsonb_build_object('removal_id', pg_temp.rid('harness-item-a6'))),
  ('under ANOTHER USER''s running removal, about that removal''s own account and transaction',
     jsonb_build_object('removal_id', pg_temp.rid('harness-item-b'), 'source_plaid_account_id', 'a27-bx', 'source_plaid_transaction_id', 'bx-h', 'source_cents', -14000)),
  ('about an account nobody has',                                                     '{"source_plaid_account_id": "a27-nowhere"}'),
  ('about ANOTHER USER''s account (on an item that is itself being removed)',         '{"source_plaid_account_id": "a27-bx"}'),
  ('about an account of the same user''s KEPT item',                                  '{"source_plaid_account_id": "a27-c"}'),
  ('about an account of another item of the same user whose removal is requested',    '{"source_plaid_account_id": "a27-xf"}'),
  ('about an account that an earlier removal deleted',                                '{"source_plaid_account_id": "a27-x1"}'),
  ('about an account with an empty Plaid id, which no account of the item has',       '{"source_plaid_account_id": ""}')
) v(what, change)
cross join lateral (select pg_temp.put_source('a4', 'hold_card', v.change::jsonb) as got) x;
-- The removal must still be running. Its ledger row is marked cleaned by hand — the item, its accounts and its
-- transactions stay, and the generation was written in this transaction — so that is the ONE thing wrong.
savepoint finished;
update public.plaid_item_removals set status = 'cleaned', cleaned_at = now(), loan_adjustments = '[]', deleted_counts = '{}' where plaid_item_id = 'harness-item-a4';
select th.assert(pg_temp.put_source('a4', 'hold_card') = '42501: card_payment_removal_provenance_wrong_moment',
  'sources guard, wrong moment: once its removal is no longer running, the row the function writes is refused, in the very transaction that wrote the generation');
rollback to savepoint finished;
select th.assert(pg_temp.put_source('a4', 'hold_card') = 'accepted: 1',
  'sources guard, the control again: with the removal running, the same row is accepted');

-- ---- Foreign decision: not this user's, or not of a kind a removal writes -------------------------------------------------
select th.assert(x.got = '42501: card_payment_removal_provenance_foreign_decision', format('sources guard, foreign decision: %s (got %s)', v.what, x.got))
from (values
  ('another user''s decision, of the same kind',     jsonb_build_object('decision_id', pg_temp.written('b', 'hold_card', true))),
  ('this user''s decision under another user''s name', jsonb_build_object('user_id', pg_temp.bb())),
  ('a decision that does not exist',                 jsonb_build_object('decision_id', gen_random_uuid())),
  ('the user''s own PAIR',                           jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.user_id = pg_temp.aa() and d.kind = 'pair' and d.superseded_by is null))),
  ('the user''s DISMISSAL (not_this_pair)',          jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.user_id = pg_temp.aa() and d.kind = 'not_this_pair'))),
  ('the user''s MARK (destination_unlinked)',        jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.user_id = pg_temp.aa() and d.kind = 'destination_unlinked')))
) v(what, change)
cross join lateral (select pg_temp.put_source('a4', 'hold_card', v.change) as got) x;
select th.assert(pg_temp.put_source('b', 'hold_card', jsonb_build_object('user_id', pg_temp.aa())) = '42501: card_payment_removal_provenance_foreign_decision',
  'sources guard, foreign decision: another user''s whole row, claimed by this user');

-- ---- Wrong relation: a user's decision is never a system dependency, and the reverse ----------------------------------------
select th.assert(x.got = v.want, format('sources guard, the relation %s on a %s: %s (got %s)', v.relation, v.kind, v.want, x.got))
from (values
  ('pair',      'confirmed_counterpart', 'accepted: 1'),
  ('pair',      'automatic_partner',     '42501: card_payment_removal_provenance_wrong_relation'),
  ('pair',      'removed_candidate',     '42501: card_payment_removal_provenance_wrong_relation'),
  ('record',    'confirmed_counterpart', '42501: card_payment_removal_provenance_wrong_relation'),
  ('record',    'automatic_partner',     'accepted: 1'),
  ('record',    'removed_candidate',     '42501: card_payment_removal_provenance_wrong_relation'),
  ('hold_card', 'confirmed_counterpart', '42501: card_payment_removal_provenance_wrong_relation'),
  ('hold_card', 'automatic_partner',     'accepted: 1'),
  ('hold_card', 'removed_candidate',     'accepted: 1'),
  ('hold_cash', 'confirmed_counterpart', '42501: card_payment_removal_provenance_wrong_relation'),
  ('hold_cash', 'automatic_partner',     'accepted: 1'),
  ('hold_cash', 'removed_candidate',     'accepted: 1')
) v(kind, relation, want)
cross join lateral (select pg_temp.put_source('a4', v.kind, jsonb_build_object('source_relation', v.relation)) as got) x;

-- ---- Disagreement with the decision: a hold's date is its source's; a confirmed pair's reference is its source's id or pending id
-- Each refused row describes a transaction that IS on the account it names (the item's other card payments, as they
-- are), so the row test of the next group would pass it: what refuses it is the decision.
select th.assert(x.got = v.want, format('sources guard, %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('a hold (removed card) given a transaction of that card dated a day after the hold', 'a4', 'hold_card',
     '{"source_plaid_transaction_id": "x2-p2", "source_date": "2026-09-12", "source_cents": -31000}'::jsonb, '42501: card_payment_removal_provenance_disagrees'),
  ('a hold (removed cash account) given a transaction of the item dated a day after the hold', 'a4', 'hold_cash',
     '{"source_plaid_account_id": "a27-x2", "source_plaid_transaction_id": "x2-p2", "source_date": "2026-09-12", "source_cents": -31000}', '42501: card_payment_removal_provenance_disagrees'),
  ('a hold (removed cash account) given a transaction of that account dated a day before the hold', 'a4', 'hold_cash',
     '{"source_plaid_transaction_id": "rb-early", "source_date": "2026-09-10", "source_cents": 1234}', '42501: card_payment_removal_provenance_disagrees'),
  ('a hold whose source was gone, and so has no date (the guard refuses it before resolution_check can)', 'a4', 'hold_card',
     pg_temp.no_row('gone'), '42501: card_payment_removal_provenance_disagrees'),
  ('a confirmed pair whose reference is the pending id its source replaced (the control)', 'a4', 'pair', '{}', 'accepted: 1'),
  ('a confirmed pair whose reference is its source''s own id (the control)',            'b',  'pair', '{}', 'accepted: 1'),
  ('a confirmed pair whose source names another id and replaced none',                  'a4', 'pair',
     '{"source_pending_transaction_id": null}', '42501: card_payment_removal_provenance_disagrees'),
  ('a confirmed pair given another transaction of that card, which replaced another id', 'a4', 'pair',
     '{"source_plaid_transaction_id": "x2-r2", "source_pending_transaction_id": "x2-other-pend", "source_date": "2026-09-11", "source_cents": -23000}',
     '42501: card_payment_removal_provenance_disagrees')
) v(what, item, kind, change, want)
cross join lateral (select pg_temp.put_source(v.item, v.kind, v.change) as got) x;

-- ---- Disagreement with the row: where a row is described, it is there — on that account, with that id, date and amount -----
select th.assert(x.got = v.want, format('sources guard, %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('a record as the function writes it (the control)',                                  'record',    '{}'::jsonb, 'accepted: 1'),
  ('a record whose transaction id is no transaction''s',                                'record',    '{"source_plaid_transaction_id": "x2-other"}', '42501: card_payment_removal_provenance_disagrees'),
  ('a record dated a day after its transaction',                                        'record',    '{"source_date": "2026-09-12"}', '42501: card_payment_removal_provenance_disagrees'),
  ('a record a cent off its transaction',                                               'record',    '{"source_cents": -23001}', '42501: card_payment_removal_provenance_disagrees'),
  ('a record with the sign of its amount flipped',                                      'record',    '{"source_cents": 23000}', '42501: card_payment_removal_provenance_disagrees'),
  ('a hold whose transaction is on the removed card, about the item''s OTHER account',  'hold_card', '{"source_plaid_account_id": "a27-rb"}', '42501: card_payment_removal_provenance_disagrees'),
  ('a hold about that other account whose transaction is on it (the control)',          'hold_cash', '{}', 'accepted: 1'),
  ('a confirmed pair given the id the user confirmed: the pending row, which is gone',  'pair',
     '{"source_plaid_transaction_id": "x2-p2-pend", "source_pending_transaction_id": null}', '42501: card_payment_removal_provenance_disagrees'),
  ('a row without its transaction id (the guard refuses it before observed_check can)', 'record',    '{"source_plaid_transaction_id": null}', '42501: card_payment_removal_provenance_disagrees'),
  ('a row without its date (the guard refuses it before observed_check can)',           'record',    '{"source_date": null}', '42501: card_payment_removal_provenance_disagrees'),
  ('a row without its amount (the guard refuses it before observed_check can)',         'record',    '{"source_cents": null}', '42501: card_payment_removal_provenance_disagrees')
) v(what, kind, change, want)
cross join lateral (select pg_temp.put_source('a4', v.kind, v.change) as got) x;
-- A LIMIT of the guard, stated (the migration's header, OWNERSHIP AND ACCESS). It knows that the transaction is
-- there. It cannot know that this transaction was the surviving leg's partner or candidate, nor that it replaced
-- the pending id a row names: any transaction of the item passes when it is described as it is and agrees with
-- the decision. The function reads each source from its plan; a26 pins which.
select th.assert(x.got = 'accepted: 1', format('LIMIT: the guard accepts %s (got %s)', v.what, x.got))
from (values
  ('a record given ANOTHER transaction of the removed card, as that transaction is',                    'record',
     '{"source_plaid_transaction_id": "x2-h2", "source_cents": -24000}'::jsonb),
  ('a hold (removed card) given a transaction of the item''s CHECKING account that has the hold''s date', 'hold_card',
     '{"source_plaid_account_id": "a27-rb", "source_plaid_transaction_id": "rb-g2", "source_cents": 25000}'),
  ('a confirmed pair given ANOTHER transaction of the removed card, said to have replaced the pending id the user confirmed', 'pair',
     '{"source_plaid_transaction_id": "x2-r2", "source_date": "2026-09-11", "source_cents": -23000}')
) v(what, kind, change)
cross join lateral (select pg_temp.put_source('a4', v.kind, v.change) as got) x;

-- ---- The checks. Each row passes the guard and breaks ONE clause of one check -----------------------------------------------
-- What a confirmed pair's source may have been instead of a row, and what a system row's may never be.
select th.assert(x.got = v.want, format('resolution_check, %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('a confirmed pair whose source was gone (the control)',                    'pair',      pg_temp.no_row('gone'), 'accepted: 1'),
  ('a confirmed pair whose source was ambiguous (the control)',               'pair',      pg_temp.no_row('ambiguous'), 'accepted: 1'),
  ('a confirmed pair whose source was waiting to post (the control)',         'pair',      pg_temp.no_row('waiting_to_post'), 'accepted: 1'),
  ('a resolution that is none of the four',                                   'pair',      pg_temp.no_row('missing'), pg_temp.violates('sources', 'resolution_check')),
  ('a RECORD whose source was gone',                                          'record',    pg_temp.no_row('gone'), pg_temp.violates('sources', 'resolution_check')),
  ('a RECORD whose source was ambiguous',                                     'record',    pg_temp.no_row('ambiguous'), pg_temp.violates('sources', 'resolution_check')),
  ('a RECORD whose source was waiting to post',                               'record',    pg_temp.no_row('waiting_to_post'), pg_temp.violates('sources', 'resolution_check')),
  ('a HOLD (removed card) whose source was waiting to post',                  'hold_card', pg_temp.no_row('waiting_to_post'), pg_temp.violates('sources', 'resolution_check')),
  ('a HOLD (removed cash account) whose source was waiting to post',          'hold_cash', pg_temp.no_row('waiting_to_post'), pg_temp.violates('sources', 'resolution_check'))
) v(what, kind, change, want)
cross join lateral (select pg_temp.put_source('a4', v.kind, v.change) as got) x;
select th.assert(pg_temp.put_source('a4', 'hold_card', '{"source_relation": "competitor"}') = pg_temp.violates('sources', 'relation_check'),
  'relation_check: a relation that is none of the three');
-- observed_check, clause by clause: a transaction's own id, its pending flag, its pending predecessor and currency
-- only when there was ONE row; a date and an amount when there was that row or a carry-over of it. (A row that says
-- there was a row and lacks its id, its date or its amount never reaches the check: the guard refuses it, above.
-- Section 4 shows those three clauses behind the guard.)
select th.assert(x.got = pg_temp.violates('sources', 'observed_check'), format('observed_check, %s (got %s)', v.what, x.got))
from (values
  ('clause 1: no row, yet a transaction id',                     'pair',   pg_temp.no_row('gone') || '{"source_plaid_transaction_id": "x2-p2"}'),
  ('clause 2: a row without its pending flag',                   'record', '{"source_pending": null}'),
  ('clause 2: no row, yet a pending flag',                       'pair',   pg_temp.no_row('gone') || '{"source_pending": false}'),
  ('clause 3: no row, yet a pending predecessor',                'pair',   pg_temp.no_row('gone') || '{"source_pending_transaction_id": "x2-p2-pend"}'),
  ('clause 3: no row, yet a currency',                           'pair',   pg_temp.no_row('ambiguous') || '{"source_iso_currency_code": "USD"}'),
  ('clause 3: waiting to post, yet a currency',                  'pair',   pg_temp.no_row('waiting_to_post') || '{"source_iso_currency_code": "USD"}'),
  ('clause 4: waiting to post without the carry-over''s date',   'pair',   pg_temp.no_row('waiting_to_post') || '{"source_date": null}'),
  ('clause 4: gone, yet a date',                                 'pair',   pg_temp.no_row('gone') || '{"source_date": "2026-09-12"}'),
  ('clause 5: waiting to post without the carry-over''s amount', 'pair',   pg_temp.no_row('waiting_to_post') || '{"source_cents": null}'),
  ('clause 5: ambiguous, yet an amount',                         'pair',   pg_temp.no_row('ambiguous') || '{"source_cents": -31000}')
) v(what, kind, change)
cross join lateral (select pg_temp.put_source('a4', v.kind, v.change) as got) x;

-- ---- One provenance row per decision, whoever writes it ----------------------------------------------------------------
select th.assert(pg_temp.put_source('a4', 'hold_card', jsonb_build_object('decision_id', pg_temp.written('a', 'hold_card')))
                 = '23505: duplicate key value violates unique constraint "card_payment_removal_sources_pkey"',
  'a decision that has its provenance row cannot be given a second one by a later removal: the guard passes the row, the primary key refuses it');
-- A LIMIT of the guards, stated (the migration's header, OWNERSHIP AND ACCESS). Inside ONE transaction that has
-- itself written the recorded generation of a running removal — this one has, by hand — a row for an OLDER decision
-- of the same user that has none is accepted when it describes a transaction of that item: the guard cannot know
-- which decisions the removal wrote. The function writes its plan and nothing else, and it finishes the removal
-- in the transaction that writes the generation; in any later transaction the same row is refused (below).
select th.assert(pg_temp.put_source('a4', 'record', jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d
                                                                                      where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u')))
                 = 'accepted: 1',
  'LIMIT: in the transaction that itself wrote the generation of a running removal, the guard accepts a row that attaches that removal to an OLD unattributed record');
-- The controls once more, at the end: no probe above was refused for what an earlier one left behind.
select th.assert(x.got = 'accepted: 1', format('sources guard, the control at the end of the transaction: the row the function writes for the %s of the removal of %s is still accepted (got %s)', v.kind, v.item, x.got))
from (values ('a4', 'pair'), ('a4', 'record'), ('a4', 'hold_card'), ('a4', 'hold_cash'), ('b', 'pair'), ('b', 'record'), ('b', 'hold_card')) v(item, kind)
cross join lateral (select pg_temp.put_source(v.item, v.kind) as got) x;

rollback;
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a' and pg_temp.generations(pg_temp.bb()) = 'none'
                 and (select count(*) from public.card_payment_removal_sources) = 4
                 and not exists (select 1 from public.card_payment_decisions d where d.id in (select x.id from pg_temp.dry_decisions x))
                 and (select count(*) = 2 from public.plaid_item_removals r where r.status = 'plaid_removed'),
  'the probes left nothing: R2 and RB are still running, with no generation');

-- ---- A later transaction ----------------------------------------------------------------------------------------------------
-- The function writes a removal's generation and finishes the removal in one transaction. So a generation that a
-- later transaction finds for a removal that is still RUNNING was put there by hand; one is, here, and committed,
-- as a direct service-role INSERT can. Nothing can be attached under it afterwards: not the rows the function
-- itself would write, and not a row for an older decision. (What such a generation does to the removal itself —
-- it cannot run until the tables' owner takes the generation away — is a26's case L.)
-- The control stands beside it: in that same later transaction RB's generation is written by hand, and RB's rows
-- are accepted. The one difference between the two removals is the transaction that wrote the generation.
insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)
values (pg_temp.rid('harness-item-a4'), pg_temp.aa(), true, 'ins_b');
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a, 3:harness-item-a4:recorded:ins_b'
                 and (select g.recorded_at < transaction_timestamp() from public.card_payment_removal_generations g where g.removal_id = pg_temp.rid('harness-item-a4'))
                 and (select r.status = 'plaid_removed' from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-a4'),
  'a later transaction: R2 is still running, and has the recorded generation that an earlier transaction committed by hand');
begin;
insert into public.card_payment_decisions select * from pg_temp.dry_decisions;
insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)
select g.removal_id, g.user_id, g.sources_recorded, g.institution_id from pg_temp.dry_generations g where g.user_id = pg_temp.bb();
select th.assert(x.got = '42501: card_payment_removal_provenance_wrong_moment',
                 format('sources guard, wrong moment: in a LATER transaction than its generation, the row the function writes for the %s of the removal of a4 is refused, though the removal is still running (got %s)', v.kind, x.got))
from (values ('pair'), ('record'), ('hold_card'), ('hold_cash')) v(kind)
cross join lateral (select pg_temp.put_source('a4', v.kind) as got) x;
select th.assert(x.got = 'accepted: 1',
                 format('sources guard, the control in that later transaction: under the generation it wrote itself, the row the function writes for the %s of the removal of b is accepted (got %s)', v.kind, x.got))
from (values ('pair'), ('record'), ('hold_card')) v(kind)
cross join lateral (select pg_temp.put_source('b', v.kind) as got) x;
select th.assert(pg_temp.put_source('a4', 'record', jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d
                                                                                      where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u')))
                 = '42501: card_payment_removal_provenance_wrong_moment',
  'never backfilled: while another removal of the user is running, and has its generation, a row that attaches that removal to an OLD unattributed record is refused');
rollback;
-- Only the tables' owner can take the generation away again.
reset role;
delete from public.card_payment_removal_generations where removal_id = pg_temp.rid('harness-item-a4');
set role service_role;
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a' and pg_temp.generations(pg_temp.bb()) = 'none'
                 and (select count(*) from public.card_payment_removal_sources) = 4
                 and not exists (select 1 from public.card_payment_decisions d where d.id in (select x.id from pg_temp.dry_decisions x))
                 and (select count(*) = 2 from public.plaid_item_removals r where r.status = 'plaid_removed'),
  'the generation committed by hand is gone again: R2 and RB are still running, with no generation');

-- ==== 4. The keys and the checks behind the guards ==========================================================================
-- With both guards disabled by the tables' owner — in a transaction that is rolled back — what remains is what the
-- keys and checks alone enforce. The guards refuse first in every case above; these stand behind them.
reset role;
begin;
alter table public.card_payment_removal_generations disable trigger card_payment_removal_generations_guard;
alter table public.card_payment_removal_sources disable trigger card_payment_removal_sources_guard;
select th.assert(x.got = v.want, format('behind the generations guard, %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('a generation for a requested removal, with a free ordinal (the control: the guard is what refuses it)', pg_temp.rid('harness-item-a6'), pg_temp.aa(), 77, null, 'accepted: 1'),
  ('removal_id_fkey: a removal that is not in the ledger',     gen_random_uuid(),               pg_temp.aa(),      77, null, pg_temp.orphan('generations', 'removal_id_fkey')),
  ('user_id_fkey: a user that does not exist',                 pg_temp.rid('harness-item-a6'),  gen_random_uuid(), 77, null, pg_temp.orphan('generations', 'user_id_fkey')),
  ('ordinal_check: an ordinal below 1',                        pg_temp.rid('harness-item-a6'),  pg_temp.aa(),      0,  null, pg_temp.violates('generations', 'ordinal_check')),
  ('user_ordinal_key: an ordinal the user already has',        pg_temp.rid('harness-item-a6'),  pg_temp.aa(),      2,  null, '23505: duplicate key value violates unique constraint "card_payment_removal_generations_user_ordinal_key"'),
  ('pkey: a removal that has a generation',                    pg_temp.rid('harness-item-a'),   pg_temp.aa(),      77, null, '23505: duplicate key value violates unique constraint "card_payment_removal_generations_pkey"')
) v(what, removal, usr, ordinal, institution, want)
cross join lateral (select pg_temp.put_generation(v.removal, v.usr, true, v.institution, v.ordinal) as got) x;
-- R1's record row, re-pointed at the record of the unrecorded removal (the one decision of a removal that has no row).
select th.assert(x.got = v.want, format('behind the sources guard, %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('a second row for R1''s record: pkey',                                '{}'::jsonb, '23505: duplicate key value violates unique constraint "card_payment_removal_sources_pkey"'),
  ('a row for a decision that has none (the control: the guard is what refuses a late row)',
     jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u')), 'accepted: 1'),
  ('decision_id_fkey: a decision that does not exist',                   jsonb_build_object('decision_id', gen_random_uuid()), pg_temp.orphan('sources', 'decision_id_fkey')),
  ('generation_fkey: a removal that has no generation',
     jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u'),
                        'removal_id', pg_temp.rid('harness-item-a6')), pg_temp.orphan('sources', 'generation_fkey')),
  -- (A row of an unknown user has no generation either; the user's own key is checked first.)
  ('user_id_fkey: a user that does not exist',
     jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u'),
                        'user_id', gen_random_uuid()), pg_temp.orphan('sources', 'user_id_fkey')),
  -- (The three clauses of observed_check that the guard's row test keeps a row from reaching.)
  ('observed_check, clause 1: a row without its transaction id',
     jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u'),
                        'source_plaid_transaction_id', null), pg_temp.violates('sources', 'observed_check')),
  ('observed_check, clause 4: a row without its date',
     jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u'),
                        'source_date', null), pg_temp.violates('sources', 'observed_check')),
  ('observed_check, clause 5: a row without its amount',
     jsonb_build_object('decision_id', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-u'),
                        'source_cents', null), pg_temp.violates('sources', 'observed_check'))
) v(what, change, want)
cross join lateral (select pg_temp.put_row('card_payment_removal_sources',
                                           (select to_jsonb(s) || v.change from public.card_payment_removal_sources s where s.decision_id = pg_temp.written('a', 'record'))) as got) x;
rollback;
select th.assert((select count(*) = 2 and bool_and(t.tgenabled = 'O') from pg_trigger t
                  where t.tgname in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard') and not t.tgisinternal),
  'both guards are enabled again');
set role service_role;

-- ==== 5. Two users whose fixtures look alike; what the client-facing results expose =======================================
select pg_temp.run_removal(pg_temp.aa(), '4');
select pg_temp.run_removal(pg_temp.bb(), '2');
select th.assert(pg_temp.sources_of('harness-item-a4') = pg_temp.sources_of('harness-item-a4', true) and pg_temp.sources_of('harness-item-b') = pg_temp.sources_of('harness-item-b', true)
                 and pg_temp.sources_of('harness-item-a4') like 'hold_removed_card(y-h2/k-h2@2026-09-11)<=a27-x2:x2-h2[candidate] ; %'
                 and pg_temp.sources_of('harness-item-b') like 'hold_removed_card(by-h/b-h@2026-09-11)<=a27-bx:bx-h[candidate] ; %',
  'R2 and RB, really run, write the provenance their dry runs wrote');
select th.assert(pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded:ins_a, 3:harness-item-a4:recorded:ins_b'
                 and pg_temp.generations(pg_temp.bb()) = '1:harness-item-b:recorded:ins_bb' and pg_temp.generations(pg_temp.cc()) = 'none'
                 and (select count(*) from public.card_payment_removal_generations) = 4,
  'each user''s generations are numbered on their own: aa''s third, bb''s first');
select th.assert(pg_temp.described('harness-item-a', 'a27-x1')
                 = 'confirmed_counterpart|row|credit/credit card/1111|false|null|2026-09-11|-21000|USD ; removed_candidate|row|credit/credit card/1111|false|null|2026-09-11|-14000|USD ; '
                   || 'automatic_partner|row|credit/credit card/1111|false|null|2026-09-11|-13000|USD'
                 and pg_temp.described('harness-item-b', 'a27-bx') = pg_temp.described('harness-item-a', 'a27-x1'),
  'isolation: the sources of aa''s Bank A card and of bb''s card are described identically — relation, type, subtype, mask, date, amount');
select th.assert((select count(*) = 11
                         and bool_and(s.user_id = d.user_id and s.user_id = g.user_id and s.user_id = r.user_id and s.user_id = ia.user_id
                                      and (d.b_account_id is null or s.user_id = ib.user_id))
                  from public.card_payment_removal_sources s
                  join public.card_payment_decisions d on d.id = s.decision_id
                  join public.card_payment_removal_generations g on g.removal_id = s.removal_id
                  join public.plaid_item_removals r on r.id = g.removal_id
                  join public.accounts xa on xa.id = d.a_account_id join public.plaid_items ia on ia.id = xa.item_id
                  left join public.accounts xb on xb.id = d.b_account_id left join public.plaid_items ib on ib.id = xb.item_id),
  'isolation: every provenance row, its decision, its generation, its ledger row and the items of the accounts its decision names belong to ONE user');
select th.assert((select string_agg(q.x, ', ' order by q.x collate "C")
                  from (select distinct s.user_id::text || ' ' || r.plaid_item_id || ' ' || s.source_plaid_account_id as x
                        from public.card_payment_removal_sources s join public.plaid_item_removals r on r.id = s.removal_id) q)
                 = '00000000-0000-0000-0000-0000000000aa harness-item-a a27-ra, 00000000-0000-0000-0000-0000000000aa harness-item-a a27-x1, '
                   || '00000000-0000-0000-0000-0000000000aa harness-item-a4 a27-rb, 00000000-0000-0000-0000-0000000000aa harness-item-a4 a27-x2, '
                   || '00000000-0000-0000-0000-0000000000bb harness-item-b a27-bx'
                 and (select string_agg(g.user_id::text || ' ' || r.user_id::text || ' ' || r.plaid_item_id, ', ' order by r.plaid_item_id collate "C")
                      from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id)
                     = '00000000-0000-0000-0000-0000000000aa 00000000-0000-0000-0000-0000000000aa harness-item-a, '
                       || '00000000-0000-0000-0000-0000000000aa 00000000-0000-0000-0000-0000000000aa harness-item-a4, '
                       || '00000000-0000-0000-0000-0000000000aa 00000000-0000-0000-0000-0000000000aa harness-item-a7, '
                       || '00000000-0000-0000-0000-0000000000bb 00000000-0000-0000-0000-0000000000bb harness-item-b',
  'isolation: aa''s rows name aa''s removals and aa''s removed accounts, bb''s rows bb''s — and there is no other row');
select th.assert(pg_temp.srep('k-r') = 'untracked/removed_card/-13000' and pg_temp.srep('b-r', pg_temp.bb()) = 'untracked/removed_card/-13000'
                 and pg_temp.srep('k-h') = 'unresolved/ambiguous/null' and pg_temp.srep('b-h', pg_temp.bb()) = 'unresolved/ambiguous/null',
  'isolation: both users read their own payments alike, each from its own decisions');

-- What the backend passes on. No result has a key that 20261006120000's did not have, and none carries a value of the
-- provenance. (The key lists are 20261006120000's; this migration replaces one function body and no result.)
insert into pg_temp.rpc values ('harness-item-a4', 'replay', public.remove_plaid_item_local(pg_temp.aa(), pg_temp.u('4')));
insert into pg_temp.rpc values ('harness-item-a4', 'existing', public.begin_plaid_item_removal(pg_temp.aa(), pg_temp.u('4'), 'any digest'));
insert into pg_temp.rpc values ('harness-item-a6', 'preview', public.preview_plaid_item_removal(pg_temp.aa(), pg_temp.u('6')));
insert into pg_temp.rpc values ('aa', 'states', public.get_card_payment_states(pg_temp.aa()));
insert into pg_temp.rpc values ('aa', 'snapshot', public.get_financial_read_snapshot(pg_temp.aa(), '2026-09-01', null, false, false, true));
select th.assert((select pg_temp.keys(result) from rpc where plaid_item = 'aa' and step = 'states')
                 = 'asOf, decisions, evaluatedVersion, evaluatorContract, fresh, inputVersion, legs, reviews, supersededTransactionIds',
  'exposure: get_card_payment_states returns the keys it returned before, and the two that 20261009120000 adds: evaluatorContract (which evaluator published the states) and reviews (the legs under review)');
select th.assert((select pg_temp.element_keys(result->'legs') from rpc where plaid_item = 'aa' and step = 'states')
                 = 'accountId, accountIncluded, amountCents, candidates, cardExcessCents, cashExcessCents, date, decisionId, detail, direction, effectCents, '
                   || 'highCents, lowCents, partnerTransactionId, pending, reason, recent, side, state, transactionId',
  'exposure: a leg has the keys it had before');
select th.assert((select pg_temp.element_keys(result->'decisions') from rpc where plaid_item = 'aa' and step = 'states') = 'decisionId, detail, kind, status'
                 and (select pg_temp.element_keys((select jsonb_agg(c) from jsonb_array_elements(result->'legs') l cross join lateral jsonb_array_elements(l->'candidates') c))
                      from rpc where plaid_item = 'aa' and step = 'states') = 'contradictsDecision, differenceCents, distanceDays, kind, transactionId',
  'exposure: a decision and a candidate have the keys they had before');
select th.assert((select result->'cardPayments' = (select s.result from rpc s where s.plaid_item = 'aa' and s.step = 'states')
                         and pg_temp.keys(result) = 'budgetCategories, cardPayments, maxSplits, maxTransactions, splitCount, splits, tooLarge, transactionCount, transactions'
                  from rpc where plaid_item = 'aa' and step = 'snapshot'),
  'exposure: the read snapshot carries exactly that reader''s result, beside the keys it had before');
select th.assert((select pg_temp.keys(result) from rpc where plaid_item = 'harness-item-a4' and step = 'begin') = 'outcome, removal'
                 and (select pg_temp.keys(result) from rpc where plaid_item = 'harness-item-a4' and step = 'existing') = 'outcome, removal'
                 and (select count(*) = 3 and bool_and(pg_temp.keys(x.r) = 'attempts, cleaned_at, deleted_counts, id, institution_name, item_id, last_attempt_at, last_error_code, last_outcome, '
                                                                          || 'loan_adjustments, plaid_item_id, plaid_outcome, plaid_removed_at, preview_digest, reconciled_at, requested_at, '
                                                                          || 'status, status_before, user_id')
                      from (select case when step = 'record' then result else result->'removal' end as r from rpc
                            where plaid_item = 'harness-item-a4' and step in ('begin', 'record', 'existing')) x),
  'exposure: beginning, confirming and re-opening a removal return the ledger row with the columns it had before');
select th.assert((select count(*) = 2 and bool_and(pg_temp.keys(result) = 'deleted_counts, loan_adjustments, replayed'
                                                   and pg_temp.keys(result->'deleted_counts') = 'accounts, liabilities, linked_transactions, recurring_streams, splits, transactions'
                                                   and result->'loan_adjustments' = '[]'::jsonb)
                  from rpc where plaid_item = 'harness-item-a4' and step in ('remove', 'replay'))
                 and (select (r.result - 'replayed') = (p.result - 'replayed') and r.result->>'replayed' = 'false' and p.result->>'replayed' = 'true'
                      from rpc r, rpc p where r.plaid_item = 'harness-item-a4' and r.step = 'remove' and p.plaid_item = 'harness-item-a4' and p.step = 'replay'),
  'exposure: the removal and its replay return the three keys they returned before, and the same counts');
select th.assert((select pg_temp.keys(result) from rpc where plaid_item = 'harness-item-a6' and step = 'preview')
                 = 'accounts, blocker, counts, digest, institution_name, item_id, loan_restorations, ownership_mismatch_links, status, unrestorable_links',
  'exposure: the preview returns the keys it returned before');
select th.assert(not exists (select 1 from rpc x
                             where x.result::text ~ '(source_|sources_recorded|ordinal|a27-x[12u]|a27-r[ab]|"x[12u]-|"r[ab]-)'),
  'exposure: no result carries a provenance column, a removed account''s Plaid id or a removed transaction''s Plaid id');
select th.assert(not exists (select 1 from rpc x cross join public.card_payment_removal_generations g
                             where x.step in ('states', 'snapshot') and position(g.removal_id::text in x.result::text) > 0),
  'exposure: the states name no removal');

-- ==== 6. Immutability and redaction =============================================================================================
-- As the tables' owner, the only role that can UPDATE at all. What identifies a row is never changed.
reset role;
select th.assert(x.got = v.want, format('immutable, a provenance row''s %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('decision (to another hold of the user)', format('decision_id = %L', pg_temp.written('a', 'hold_cash')), '42501: card_payment_removal_provenance_immutable'),
  ('user (the decision is not that user''s)', format('user_id = %L', pg_temp.bb()),                         '42501: card_payment_removal_provenance_foreign_decision'),
  ('removal (to another generation of the user)', format('removal_id = %L', pg_temp.rid('harness-item-a4')), '42501: card_payment_removal_provenance_immutable'),
  ('relation',                              $q$source_relation = 'automatic_partner'$q$,                    '42501: card_payment_removal_provenance_immutable'),
  ('resolution',                            $q$source_resolution = 'gone'$q$,                               '42501: card_payment_removal_provenance_immutable'),
  ('account id',                            $q$source_plaid_account_id = 'a27-ra'$q$,                       '42501: card_payment_removal_provenance_immutable'),
  ('transaction id',                        $q$source_plaid_transaction_id = 'x1-other'$q$,                 '42501: card_payment_removal_provenance_immutable'),
  ('transaction id, to none',               'source_plaid_transaction_id = null',                           '42501: card_payment_removal_provenance_immutable')
) v(what, change, want)
cross join lateral (select pg_temp.attempt(format('update public.card_payment_removal_sources set %s where decision_id = %L', v.change, pg_temp.written('a', 'hold_card'))) as got) x;
select th.assert(x.got = v.want, format('immutable, a generation''s %s: %s (got %s)', v.what, v.want, x.got))
from (values
  ('ordinal',                                         'ordinal = 9',                                          '42501: card_payment_removal_provenance_immutable'),
  ('recorded flag',                                   'sources_recorded = false',                             '42501: card_payment_removal_provenance_immutable'),
  ('removal (to another removal of the user)',        format('removal_id = %L', pg_temp.rid('harness-item-a6')), '42501: card_payment_removal_provenance_immutable'),
  ('user (the removal is not that user''s)',          format('user_id = %L', pg_temp.bb()),                   '42501: card_payment_removal_provenance_foreign_removal')
) v(what, change, want)
cross join lateral (select pg_temp.attempt(format('update public.card_payment_removal_generations set %s where removal_id = %L', v.change, pg_temp.rid('harness-item-a'))) as got) x;
select th.assert(pg_temp.attempt(format('update public.card_payment_removal_generations set ordinal = 9 where removal_id = %L', pg_temp.rid('harness-item-a7')))
                 = '42501: card_payment_removal_provenance_immutable',
  'immutable: a marker''s ordinal — its place in the user''s order');

-- RETENTION. The user undoes the pair R1 preserved: the decision is superseded, not deleted, and keeps its provenance.
set role service_role;
insert into pg_temp.rpc values ('aa', 'undo', public.undo_card_payment_decision(pg_temp.aa(), pg_temp.written('a', 'pair'), pg_temp.iv(pg_temp.aa())));
select th.assert((select result->>'status' = 'undone' and pg_temp.keys(result) = 'decisionId, evaluatedVersion, inputVersion, legs, matching, reason, status, supersededDecisionIds'
                         and pg_temp.element_keys(result->'legs') = (select pg_temp.element_keys(s.result->'legs') from rpc s where s.plaid_item = 'aa' and s.step = 'states')
                  from rpc where plaid_item = 'aa' and step = 'undo'),
  'retention: the user undoes the preserved pair; the result has the keys a decision result had before');
select th.assert((select d.superseded_by = d.id from public.card_payment_decisions d where d.id = pg_temp.written('a', 'pair'))
                 and pg_temp.sources_of('harness-item-a') like '% ; pair_counterpart_removed(k-p/x1-p)<=a27-x1:x1-p[confirmed] ; %'
                 and (select count(*) from public.card_payment_removal_sources) = 11,
  'retention: the undone decision is superseded, not deleted, and its provenance row stays with it');

-- REDACTION. The descriptive columns of R1's rows — one of them on the superseded decision — and of its generation
-- are set to NULL by the owner. Nothing else changes: no other column, no other row, no decision, no version.
reset role;
create temporary table before_redaction as
  select (select jsonb_agg(to_jsonb(s) - 'source_account_type' - 'source_account_subtype' - 'source_account_mask' order by s.decision_id)
          from public.card_payment_removal_sources s where s.removal_id = pg_temp.rid('harness-item-a')) as redacted_sources,
         (select jsonb_agg(to_jsonb(s) order by s.decision_id) from public.card_payment_removal_sources s where s.removal_id <> pg_temp.rid('harness-item-a')) as other_sources,
         (select to_jsonb(g) - 'institution_id' from public.card_payment_removal_generations g where g.removal_id = pg_temp.rid('harness-item-a')) as redacted_generation,
         (select jsonb_agg(to_jsonb(g) order by g.removal_id) from public.card_payment_removal_generations g where g.removal_id <> pg_temp.rid('harness-item-a')) as other_generations,
         (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d) as decisions,
         pg_temp.iv(pg_temp.aa()) as iv_aa, pg_temp.iv(pg_temp.bb()) as iv_bb, public.get_card_payment_states(pg_temp.aa()) as states_aa;
select th.assert((select count(*) = 4 and bool_and(s.source_account_type is not null and s.source_account_subtype is not null and s.source_account_mask is not null)
                  from public.card_payment_removal_sources s where s.removal_id = pg_temp.rid('harness-item-a'))
                 and (select g.institution_id = 'ins_a' from public.card_payment_removal_generations g where g.removal_id = pg_temp.rid('harness-item-a')),
  'redaction, before: R1''s four rows describe their accounts, and its generation names the institution');
update public.card_payment_removal_sources set source_account_type = null, source_account_subtype = null, source_account_mask = null
where removal_id = pg_temp.rid('harness-item-a');
update public.card_payment_removal_generations set institution_id = null where removal_id = pg_temp.rid('harness-item-a');
select th.assert((select count(*) = 4 and bool_and(s.source_account_type is null and s.source_account_subtype is null and s.source_account_mask is null)
                  from public.card_payment_removal_sources s where s.removal_id = pg_temp.rid('harness-item-a'))
                 and (select g.institution_id is null from public.card_payment_removal_generations g where g.removal_id = pg_temp.rid('harness-item-a')),
  'redaction: the owner sets the descriptive columns to NULL — the account''s type, subtype and mask; the generation''s institution id');
select th.assert((select b.redacted_sources = (select jsonb_agg(to_jsonb(s) - 'source_account_type' - 'source_account_subtype' - 'source_account_mask' order by s.decision_id)
                                               from public.card_payment_removal_sources s where s.removal_id = pg_temp.rid('harness-item-a'))
                         and b.other_sources = (select jsonb_agg(to_jsonb(s) order by s.decision_id) from public.card_payment_removal_sources s
                                                where s.removal_id <> pg_temp.rid('harness-item-a'))
                         and b.redacted_generation = (select to_jsonb(g) - 'institution_id' from public.card_payment_removal_generations g
                                                      where g.removal_id = pg_temp.rid('harness-item-a'))
                         and b.other_generations = (select jsonb_agg(to_jsonb(g) order by g.removal_id) from public.card_payment_removal_generations g
                                                    where g.removal_id <> pg_temp.rid('harness-item-a'))
                         and b.decisions = (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d)
                         and b.iv_aa = pg_temp.iv(pg_temp.aa()) and b.iv_bb = pg_temp.iv(pg_temp.bb()) and b.states_aa = public.get_card_payment_states(pg_temp.aa())
                  from before_redaction b),
  'redaction changes nothing else: every other column of those rows, every other row of both tables, every decision, both users'' input versions and the states are as they were');
select th.assert(pg_temp.described('harness-item-a', 'a27-x1')
                 = 'confirmed_counterpart|row|null/null/null|false|null|2026-09-11|-21000|USD ; removed_candidate|row|null/null/null|false|null|2026-09-11|-14000|USD ; '
                   || 'automatic_partner|row|null/null/null|false|null|2026-09-11|-13000|USD'
                 and pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded, 3:harness-item-a4:recorded:ins_b',
  'redaction: what identifies each source and what the evaluator read of it are still there');
set role service_role;

-- ==== 7. Deletion ===================================================================================================================
-- With its DECISION: the service role may delete a decision, as before, and the provenance row goes with it —
-- although the service role cannot delete the provenance row itself.
select th.assert(pg_temp.attempt(format('delete from public.card_payment_removal_sources where decision_id = %L', pg_temp.written('a', 'record')))
                 = '42501: permission denied for table card_payment_removal_sources',
  'deletion: the service role cannot delete a provenance row');
create temporary table gone as select pg_temp.written('a', 'record') as record_of_r1;
delete from public.card_payment_decisions where id = (select record_of_r1 from gone);
select th.assert(not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = (select record_of_r1 from gone))
                 and pg_temp.sources_of('harness-item-a') = 'hold_removed_card(y-h/k-h@2026-09-11)<=a27-x1:x1-h[candidate] ; '
                   || 'hold_removed_cash_account(y-g/k-g@2026-09-11)<=a27-ra:ra-g[partner] ; pair_counterpart_removed(k-p/x1-p)<=a27-x1:x1-p[confirmed]'
                 and (select count(*) from public.card_payment_removal_sources) = 10
                 and pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded, 3:harness-item-a4:recorded:ins_b',
  'deletion: deleting R1''s record takes its provenance row and nothing else');
-- With the SURVIVING ACCOUNT of a protected leg: the kept card Y. The four holds name it, and the dismissal.
delete from public.accounts where id = pg_temp.u('27c2');
select th.assert(not exists (select 1 from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' and d.user_id = pg_temp.aa())
                 and pg_temp.sources_of('harness-item-a') = 'pair_counterpart_removed(k-p/x1-p)<=a27-x1:x1-p[confirmed]'
                 and pg_temp.sources_of('harness-item-a4') = 'pair_counterpart_removed(k-p2/x2-p2-pend)<=a27-x2:x2-p2[confirmed] ; record(k-r2)<=a27-x2:x2-r2[partner]'
                 and (select count(*) from public.card_payment_removal_sources where user_id = pg_temp.aa()) = 3
                 and not exists (select 1 from public.card_payment_removal_sources s
                                 where not exists (select 1 from public.card_payment_decisions d where d.id = s.decision_id))
                 and pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded, 3:harness-item-a4:recorded:ins_b',
  'deletion: deleting the kept card''s account takes the four holds that name it and their provenance rows; the rows on the kept checking account and the generations stay');
-- With its GENERATION, which only the owner can delete: R2's. The decisions stay, unattributed.
select th.assert(pg_temp.attempt(format('delete from public.card_payment_removal_generations where removal_id = %L', pg_temp.rid('harness-item-a4')))
                 = '42501: permission denied for table card_payment_removal_generations',
  'deletion: the service role cannot delete a generation');
reset role;
delete from public.card_payment_removal_generations where removal_id = pg_temp.rid('harness-item-a4');
select th.assert(pg_temp.sources_of('harness-item-a4') = 'none' and pg_temp.generations(pg_temp.aa()) = '1:harness-item-a7:marker, 2:harness-item-a:recorded'
                 and (select string_agg(d.kind || '(' || d.a_plaid_transaction_id || ')', ', ' order by d.kind) from public.card_payment_decisions d
                      where d.user_id = pg_temp.aa() and d.a_plaid_transaction_id in ('k-p2', 'k-r2') and d.superseded_by is null)
                     = 'destination_removed_card(k-r2), pair_counterpart_removed(k-p2)'
                 and pg_temp.sources_of('harness-item-a') = 'pair_counterpart_removed(k-p/x1-p)<=a27-x1:x1-p[confirmed]',
  'deletion: deleting R2''s generation takes its provenance rows and leaves its decisions; R1''s are untouched');
-- With its LEDGER ROW: R1's. The generation goes, and its provenance row with it; the decision stays.
delete from public.plaid_item_removals where plaid_item_id = 'harness-item-a';
select th.assert((select count(*) = 1 and bool_and(not g.sources_recorded and g.ordinal = 1 and g.removal_id = pg_temp.rid('harness-item-a7'))
                  from public.card_payment_removal_generations g where g.user_id = pg_temp.aa())
                 and not exists (select 1 from public.card_payment_removal_sources s where s.user_id = pg_temp.aa())
                 and (select count(*) = 1 from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = 'k-p'),
  'deletion: deleting R1''s ledger row takes its generation and the provenance under it; the decision stays');
select th.assert(pg_temp.sources_of('harness-item-b') = 'hold_removed_card(by-h/b-h@2026-09-11)<=a27-bx:bx-h[candidate] ; '
                   || 'pair_counterpart_removed(b-p/bx-p)<=a27-bx:bx-p[confirmed] ; record(b-r)<=a27-bx:bx-r[partner]'
                 and pg_temp.generations(pg_temp.bb()) = '1:harness-item-b:recorded:ins_bb'
                 and (select count(*) from public.card_payment_removal_sources) = 3 and (select count(*) from public.card_payment_removal_generations) = 2,
  'deletion: none of it touched the other user''s rows');
set role service_role;

-- ==== 8. The removal's scratch table ================================================================================================
-- pg_temp.rpp_plan is created by the first removal of a transaction and dropped at its commit. Two removals in ONE
-- transaction share it; the second must start from an empty plan.
select pg_temp.begin_removal(pg_temp.cc(), 'c1'), pg_temp.confirm_removal(pg_temp.cc(), 'c1'), pg_temp.begin_removal(pg_temp.cc(), 'c2'), pg_temp.confirm_removal(pg_temp.cc(), 'c2'),
       pg_temp.begin_removal(pg_temp.cc(), 'c3'), pg_temp.confirm_removal(pg_temp.cc(), 'c3'), pg_temp.begin_removal(pg_temp.cc(), 'c4'), pg_temp.confirm_removal(pg_temp.cc(), 'c4');
select th.assert(to_regclass('pg_temp.rpp_plan') is null, 'scratch table: none before the transaction');
begin;
select pg_temp.run_removal(pg_temp.cc(), 'c1');
select th.assert((select string_agg(p.step || ':' || p.kind || ':' || p.source_plaid, ', ' order by p.step) from pg_temp.rpp_plan p)
                 = 'b:destination_removed_card:t1x, c:ambiguity_hold_removed_card:t1x',
  'scratch table, one transaction: after the first removal it holds that removal''s plan — a record and a hold');
select pg_temp.run_removal(pg_temp.cc(), 'c2');
select th.assert((select string_agg(p.step || ':' || p.kind || ':' || p.source_plaid, ', ' order by p.step) from pg_temp.rpp_plan p)
                 = 'c:ambiguity_hold_removed_card:t2x',
  'scratch table, one transaction: after the second removal it holds the second plan only');
commit;
select th.assert(to_regclass('pg_temp.rpp_plan') is null, 'scratch table: dropped at the commit');
select th.assert(pg_temp.sources_of('harness-item-c1') = 'hold_removed_card(cy1/m1@2026-09-10)<=a27-t1:t1x[partner] ; record(m1)<=a27-t1:t1x[partner]'
                 and pg_temp.sources_of('harness-item-c2') = 'hold_removed_card(cy2/m2@2026-09-11)<=a27-t2:t2x[candidate]'
                 and pg_temp.generations(pg_temp.cc()) = '1:harness-item-c1:recorded:ins_t1, 2:harness-item-c2:recorded:ins_t2'
                 and (select count(*) from public.card_payment_removal_sources where user_id = pg_temp.cc()) = 3
                 and (select count(*) from public.card_payment_decisions where user_id = pg_temp.cc()) = 3,
  'two removals in ONE transaction: each wrote exactly its own decisions and its own provenance — two for the first, one for the second');
-- Two removals in consecutive transactions of this session: the table is made again each time.
select pg_temp.run_removal(pg_temp.cc(), 'c3');
select th.assert(to_regclass('pg_temp.rpp_plan') is null, 'scratch table: dropped again between two transactions');
select pg_temp.run_removal(pg_temp.cc(), 'c4');
select th.assert(pg_temp.sources_of('harness-item-c3') = 'hold_removed_card(cy3/m3@2026-09-10)<=a27-t3:t3x[partner] ; record(m3)<=a27-t3:t3x[partner]'
                 and pg_temp.sources_of('harness-item-c4') = 'hold_removed_card(cy4/m4@2026-09-11)<=a27-t4:t4x[candidate]'
                 and pg_temp.sources_of('harness-item-c1') = 'hold_removed_card(cy1/m1@2026-09-10)<=a27-t1:t1x[partner] ; record(m1)<=a27-t1:t1x[partner]'
                 and pg_temp.sources_of('harness-item-c2') = 'hold_removed_card(cy2/m2@2026-09-11)<=a27-t2:t2x[candidate]'
                 and pg_temp.generations(pg_temp.cc()) = '1:harness-item-c1:recorded:ins_t1, 2:harness-item-c2:recorded:ins_t2, 3:harness-item-c3:recorded:ins_t3, 4:harness-item-c4:recorded:ins_t4'
                 and (select count(*) from public.card_payment_removal_sources where user_id = pg_temp.cc()) = 6
                 and (select count(*) from public.card_payment_decisions where user_id = pg_temp.cc()) = 6,
  'two removals in CONSECUTIVE transactions: each wrote exactly its own; the earlier removals'' rows are as they were');
select th.assert(not exists (select 1 from public.card_payment_decisions d
                             where d.user_id = pg_temp.cc() and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = d.id))
                 and (select count(*) = 6 and count(distinct s.decision_id) = 6 from public.card_payment_removal_sources s where s.user_id = pg_temp.cc()),
  'and every decision of the four removals has exactly one provenance row');

-- ==== 9. A source whose Plaid ids are empty strings ==================================================================================
-- accounts.plaid_account_id and transactions.plaid_transaction_id are NOT NULL and unique, and nothing else: the
-- empty string is a value the schema allows. No constraint of the provenance tables judges the content of an id the
-- provider supplied, so a removal with such a source is not refused: it runs, and records the id as it was.
-- Bank E (item c5) is linked for it: card E1 has the empty Plaid account id, and the leg on card E2 the empty
-- Plaid transaction id.
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_id, institution_name) values
  (pg_temp.u('c5'), pg_temp.cc(), 'harness-item-c5', 'placeholder-token-c5', 'ins_e', 'Bank E');
insert into public.accounts (id, item_id, plaid_account_id, name, type, subtype, mask) values
  (pg_temp.u('27e7'), pg_temp.u('c5'), '', 'E Card 1', 'credit', 'credit card', '1111'),
  (pg_temp.u('27e8'), pg_temp.u('c5'), 'a27-e2', 'E Card 2', 'credit', 'credit card', '1111');
select pg_temp.cardleg('m5', '27e1', 450, '2026-09-10'), pg_temp.cardleg('e1x', '27e7', -450, '2026-09-11'),
       pg_temp.cardleg('m6', '27e1', 460, '2026-09-10'), pg_temp.cardleg('', '27e8', -460, '2026-09-11');
select public.evaluate_card_payments(pg_temp.cc());
select th.assert(pg_temp.srep('m5', pg_temp.cc()) = 'tracked/auto_pair/0' and pg_temp.srep('m6', pg_temp.cc()) = 'tracked/auto_pair/0'
                 and (select count(*) = 1 from public.accounts a where a.plaid_account_id = '' and a.id = pg_temp.u('27e7'))
                 and (select count(*) = 1 from public.transactions t where t.plaid_transaction_id = '' and t.account_id = pg_temp.u('27e8')),
  'empty ids, fixture: two payments are matched automatically — one to a leg on the account whose Plaid id is empty, one to the leg whose Plaid id is empty');
select pg_temp.remove(pg_temp.cc(), 'c5');
select th.assert((select r.status = 'cleaned' from public.plaid_item_removals r where r.plaid_item_id = 'harness-item-c5')
                 and not exists (select 1 from public.accounts a where a.item_id = pg_temp.u('c5'))
                 and pg_temp.generations(pg_temp.cc()) = '1:harness-item-c1:recorded:ins_t1, 2:harness-item-c2:recorded:ins_t2, 3:harness-item-c3:recorded:ins_t3, '
                                                         || '4:harness-item-c4:recorded:ins_t4, 5:harness-item-c5:recorded:ins_e',
  'empty ids: the removal is not refused — Bank E is removed, as the user''s fifth generation');
select th.assert(pg_temp.sources_of('harness-item-c5') = 'record(m5)<=:e1x[partner] ; record(m6)<=a27-e2:[partner]'
                 and (select count(*) = 2
                             and count(*) filter (where d.a_plaid_transaction_id = 'm5' and s.source_plaid_account_id = '' and s.source_plaid_transaction_id = 'e1x'
                                                        and s.source_cents = -45000) = 1
                             and count(*) filter (where d.a_plaid_transaction_id = 'm6' and s.source_plaid_account_id = 'a27-e2' and s.source_plaid_transaction_id = ''
                                                        and s.source_cents = -46000) = 1
                             and bool_and(s.source_relation = 'automatic_partner' and s.source_resolution = 'row' and s.source_date = '2026-09-11')
                      from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id
                      where s.removal_id = pg_temp.rid('harness-item-c5'))
                 and (select count(*) from public.card_payment_removal_sources where user_id = pg_temp.cc()) = 8,
  'empty ids: each of its two records has its source, with the id as it was — the empty account id of card E1, the empty transaction id of the leg on card E2 — a value, not NULL');
select th.assert(pg_temp.srep('m5', pg_temp.cc()) = 'untracked/removed_card/-45000' and pg_temp.srep('m6', pg_temp.cc()) = 'untracked/removed_card/-46000',
  'empty ids: and both payments read as removed-card payments');

-- ==== 10. The deletion of a user =========================================================================================================
-- A user who still has an institution cannot be deleted at all (plaid_items references auth.users without a cascade,
-- as it always has). So the kept institution goes first: with its accounts go the decisions on them and their
-- provenance rows. What is left of the provenance — the generations, which live as long as the ledger — goes with
-- the user. (No provenance row can outlive the last item, so its own key to the user never fires on its own.)
reset role;
select th.assert(pg_temp.attempt(format('delete from auth.users where id = %L', pg_temp.cc()))
                 = '23503: update or delete on table "users" violates foreign key constraint "plaid_items_user_id_fkey" on table "plaid_items"',
  'user deletion: refused while the user has an institution');
delete from public.plaid_items where id = pg_temp.u('c0');
select th.assert(not exists (select 1 from public.card_payment_removal_sources s where s.user_id = pg_temp.cc())
                 and not exists (select 1 from public.card_payment_decisions d where d.user_id = pg_temp.cc())
                 and (select count(*) from public.card_payment_removal_generations g where g.user_id = pg_temp.cc()) = 5,
  'user deletion: removing the kept institution takes the decisions and their provenance rows; the five generations remain');
delete from auth.users where id = pg_temp.cc();
select th.assert(not exists (select 1 from public.card_payment_removal_generations g where g.user_id = pg_temp.cc())
                 and not exists (select 1 from public.card_payment_removal_sources s where s.user_id = pg_temp.cc())
                 and not exists (select 1 from public.plaid_item_removals r where r.user_id = pg_temp.cc())
                 and not exists (select 1 from auth.users u where u.id = pg_temp.cc()),
  'user deletion: no row of the user is left in either provenance table, nor in the ledger');
select th.assert(not exists (select 1 from public.card_payment_removal_sources s
                             where not exists (select 1 from public.card_payment_decisions d where d.id = s.decision_id and d.user_id = s.user_id)
                                or not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = s.removal_id and g.user_id = s.user_id)
                                or not exists (select 1 from auth.users u where u.id = s.user_id))
                 and not exists (select 1 from public.card_payment_removal_generations g
                                 where not exists (select 1 from public.plaid_item_removals r where r.id = g.removal_id and r.user_id = g.user_id)
                                    or not exists (select 1 from auth.users u where u.id = g.user_id))
                 and (select count(*) from public.card_payment_removal_sources) = 3 and (select count(*) from public.card_payment_removal_generations) = 2,
  'user deletion: no orphan — every remaining provenance row has its decision, its generation and its user; every generation its ledger row and its user');

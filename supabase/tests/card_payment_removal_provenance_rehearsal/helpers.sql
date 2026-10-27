-- Helpers of the removal-provenance rehearsal. Loaded once into the baseline database, before it is populated;
-- the twin database is a copy of that database and so has them too. Nothing here belongs to one step.
create schema rehearsal;

-- A digest of every row of every table of the application (schema public) and of auth.users, under a label.
create table rehearsal.snap (label text, tbl text, digest text not null, n bigint not null, primary key (label, tbl));
-- Every definition in schema public that a migration or a rollback script could change, under a label:
-- functions (body, signature, security, settings, grants), tables (row security, grants), columns,
-- constraints, indexes, triggers, policies.
create table rehearsal.catalog (label text, object text, definition text not null, primary key (label, object));
-- Values kept at one step and required at a later one (a decision's id; a function's source).
create table rehearsal.kept (name text primary key, value text not null);
-- The decisions that existed at a moment, each with its key (rehearsal.decision_key).
create table rehearsal.decisions_at (moment text, id uuid, usr uuid not null, key text not null, primary key (moment, id));
-- What the reader gives for a user at a moment, normalised (rehearsal.normalised), and how many decisions it
-- listed before that. twin_readings holds the rows the twin database kept, copied into this one.
create table rehearsal.readings (moment text, usr text, listed integer not null, doc jsonb not null, primary key (moment, usr));
create table rehearsal.twin_readings (moment text, usr text, listed integer not null, doc jsonb not null, primary key (moment, usr));

create function rehearsal.aa() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function rehearsal.bb() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;

-- An exact comparison that says what it found.
create function rehearsal.eq(p_actual text, p_expected text, p_what text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception E'ASSERTION FAILED: %\n  expected: %\n  actual:   %', p_what, coalesce(p_expected, '(null)'), coalesce(p_actual, '(null)');
  end if;
end $$;
-- The same for a list, compared as a multiset: every element, as often as it occurs, in no particular order.
create function rehearsal.eq_list(p_actual text[], p_expected text[], p_what text) returns void language plpgsql as $$
declare
  v_actual text[] := array(select x from unnest(p_actual) x order by x collate "C");
  v_expected text[] := array(select x from unnest(p_expected) x order by x collate "C");
begin
  if p_actual is null or v_actual is distinct from v_expected then
    raise exception E'ASSERTION FAILED: %\n  expected (%):\n    %\n  actual (%):\n    %', p_what,
      cardinality(v_expected), array_to_string(v_expected, E'\n    '), coalesce(cardinality(v_actual), 0), array_to_string(v_actual, E'\n    ');
  end if;
end $$;

create function rehearsal.take(p_label text) returns void language plpgsql as $$
declare
  r record;
  v_digest text;
  v_n bigint;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))
           order by n.nspname, c.relname loop
    execute format('select md5(coalesce(string_agg(x, ''|'' order by x collate "C"), '''')), count(*) from (select to_jsonb(t)::text as x from %I.%I t) q',
                   r.nspname, r.relname)
      into v_digest, v_n;
    insert into rehearsal.snap values (p_label, r.nspname || '.' || r.relname, v_digest, v_n);
  end loop;
end $$;
-- What differs between two snapshots, one line per table: '{}' when no table was added or dropped and no row
-- of any table was added, deleted or changed.
create function rehearsal.diff(p_a text, p_b text) returns text[] language plpgsql as $$
begin
  if not exists (select 1 from rehearsal.snap where label = p_a) or not exists (select 1 from rehearsal.snap where label = p_b) then
    raise exception 'ASSERTION FAILED: no snapshot is labelled % or %', p_a, p_b;
  end if;
  return (
    select coalesce(array_agg(q.x order by q.x collate "C"), '{}')
    from (select coalesce(a.tbl, b.tbl) || case when a.tbl is null then ' added (' || b.n || ' rows)'
                                                when b.tbl is null then ' dropped (' || a.n || ' rows)'
                                                else ' changed (' || a.n || ' -> ' || b.n || ' rows)' end as x
          from (select * from rehearsal.snap where label = p_a) a
          full join (select * from rehearsal.snap where label = p_b) b on b.tbl = a.tbl
          where a.tbl is null or b.tbl is null or a.digest <> b.digest or a.n <> b.n) q);
end $$;

create function rehearsal.acl(p_acl aclitem[]) returns text language sql as $$
  select coalesce((select string_agg(x::text, ',' order by x::text collate "C") from unnest(p_acl) x), '') $$;
create function rehearsal.take_catalog(p_label text) returns void language sql as $$
  insert into rehearsal.catalog (label, object, definition)
  select p_label, 'function public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'body ' || md5(replace(p.prosrc, E'\r', '')) || ' ' || l.lanname || ' returns ' || coalesce(pg_get_function_result(p.oid), '')
         || ' definer=' || p.prosecdef || ' volatility=' || p.provolatile::text || ' config=' || coalesce(p.proconfig::text, '')
         || ' acl=' || rehearsal.acl(p.proacl) || ' owner=' || pg_get_userbyid(p.proowner)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
  union all
  select p_label, 'table public.' || c.relname,
         'row security=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity || ' acl=' || rehearsal.acl(c.relacl) || ' owner=' || pg_get_userbyid(c.relowner)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  union all
  select p_label, 'column public.' || c.relname || '.' || a.attname,
         a.attnum || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') || ' acl=' || rehearsal.acl(a.attacl)
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  union all
  select p_label, 'constraint public.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid) || ' validated=' || k.convalidated
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
  union all
  select p_label, 'index public.' || i.indexname, i.indexdef from pg_indexes i where i.schemaname = 'public'
  union all
  select p_label, 'trigger public.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
  union all
  select p_label, 'policy public.' || p.tablename || '.' || p.policyname,
         p.permissive || ' ' || p.cmd || ' to ' || p.roles::text || ' using ' || coalesce(p.qual, '') || ' check ' || coalesce(p.with_check, '')
  from pg_policies p where p.schemaname = 'public' $$;
-- What differs between two catalog snapshots, one line per object: '<object> added', '<object> dropped' or
-- '<object> changed'. p_like restricts the comparison to the objects whose name matches it.
create function rehearsal.catalog_diff(p_a text, p_b text, p_like text default '%') returns text[] language plpgsql as $$
begin
  if not exists (select 1 from rehearsal.catalog where label = p_a) or not exists (select 1 from rehearsal.catalog where label = p_b) then
    raise exception 'ASSERTION FAILED: no catalog snapshot is labelled % or %', p_a, p_b;
  end if;
  return (
    select coalesce(array_agg(q.x order by q.x collate "C"), '{}')
    from (select coalesce(a.object, b.object) || case when a.object is null then ' added' when b.object is null then ' dropped' else ' changed' end as x
          from (select * from rehearsal.catalog where label = p_a and object like p_like) a
          full join (select * from rehearsal.catalog where label = p_b and object like p_like) b on b.object = a.object
          where a.object is null or b.object is null or a.definition <> b.definition) q);
end $$;

create function rehearsal.body_md5() returns text language sql as $$
  select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure $$;
create function rehearsal.body_source() returns text language sql as $$
  select replace(prosrc, E'\r', '') from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure $$;
create function rehearsal.fn_md5(p_signature text) returns text language sql as $$
  select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = to_regprocedure(p_signature) $$;
create function rehearsal.keep(p_name text, p_value text) returns void language sql as $$
  insert into rehearsal.kept values (p_name, p_value) $$;
create function rehearsal.recall(p_name text) returns text language sql as $$
  select value from rehearsal.kept where name = p_name $$;
create function rehearsal.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
create function rehearsal.iv(p_user uuid default rehearsal.aa()) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
-- An institution that is linked, by Plaid's item id; and the ledger row of one that is being or was removed.
create function rehearsal.item(p_plaid_item_id text) returns uuid language sql as $$
  select id from public.plaid_items where plaid_item_id = p_plaid_item_id $$;
create function rehearsal.removal(p_plaid_item_id text) returns public.plaid_item_removals language sql as $$
  select r from public.plaid_item_removals r where r.plaid_item_id = p_plaid_item_id $$;

-- The reader's answer for a user. Raises when it is not fresh, so that no check passes on a stale read.
create function rehearsal.states(p_user uuid default rehearsal.aa()) returns jsonb language plpgsql as $$
declare
  v jsonb := public.get_card_payment_states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: the card-payment states of % are not fresh', p_user;
  end if;
  return v;
end $$;
-- A decision without its id: kind(first leg[/second leg][@removed candidate's date]), the legs by their Plaid
-- ids, which are unique in this fixture. Rows with one key are of one kind, on the same legs, with the same
-- date; only their ids, and what a removal recorded of their sources, tell them apart.
create function rehearsal.decision_key(p_id uuid) returns text language sql as $$
  select coalesce((select d.kind || '(' || d.a_plaid_transaction_id || coalesce('/' || d.b_plaid_transaction_id, '')
                          || coalesce('@' || d.counterpart_date, '') || ')'
                   from public.card_payment_decisions d where d.id = p_id), 'no decision ' || p_id) $$;
-- Everything the reader gives for one leg, as one line:
--   state/reason/effect partner=<leg> range=<low>..<high> decision=<key> detail=<detail> candidates=<leg:kind,…>
create function rehearsal.reading(p_plaid text, p_user uuid default rehearsal.aa()) returns text language sql as $$
  select (l->>'state') || '/' || coalesce(l->>'reason', '-') || '/' || coalesce(l->>'effectCents', 'null')
         || ' partner=' || coalesce((select t.plaid_transaction_id from public.transactions t where t.id = (l->>'partnerTransactionId')::uuid), '-')
         || ' range=' || (l->>'lowCents') || '..' || (l->>'highCents')
         || ' decision=' || case when l->>'decisionId' is null then '-' else rehearsal.decision_key((l->>'decisionId')::uuid) end
         || ' detail=' || coalesce(l->>'detail', '-')
         || ' candidates=' || coalesce((select string_agg(t.plaid_transaction_id || ':' || replace(c->>'kind', 'tier1_competitor', 'tier1'), ','
                                                          order by t.plaid_transaction_id collate "C")
                                        from jsonb_array_elements(l->'candidates') c
                                        join public.transactions t on t.id = (c->>'transactionId')::uuid), '-')
  from jsonb_array_elements(rehearsal.states(p_user)->'legs') l
  where (l->>'transactionId')::uuid = (select t.id from public.transactions t where t.plaid_transaction_id = p_plaid) $$;
create function rehearsal.legs(p_user uuid default rehearsal.aa()) returns bigint language sql as $$
  select jsonb_array_length(rehearsal.states(p_user)->'legs') $$;
-- The reader's decisions list for a user, one line per entry: key: status[/detail].
create function rehearsal.statuses(p_user uuid default rehearsal.aa()) returns text[] language sql as $$
  select coalesce(array_agg(q.x order by q.x collate "C"), '{}')
  from (select rehearsal.decision_key((d->>'decisionId')::uuid) || ': ' || (d->>'status') || coalesce('/' || (d->>'detail'), '') as x
        from jsonb_array_elements(rehearsal.states(p_user)->'decisions') d) q $$;
-- The reader's whole answer with the two things a removal's own bookkeeping changes replaced by what they say:
--   * a leg's decisionId, a generated id, by the key of the decision it names;
--   * the decisions list, one entry per decision row with its generated id, by the SET of distinct
--     {key, kind, status, detail}: how many rows say one thing is not a reading.
-- Every other member is kept as the reader gave it.
create function rehearsal.normalised(p_user uuid) returns jsonb language sql as $$
  select jsonb_set(
           jsonb_set(q.s, '{legs}',
             (select coalesce(jsonb_agg(case when x.l->>'decisionId' is null then x.l
                                             else jsonb_set(x.l, '{decisionId}', to_jsonb(rehearsal.decision_key((x.l->>'decisionId')::uuid))) end
                                        order by x.n), '[]'::jsonb)
              from jsonb_array_elements(q.s->'legs') with ordinality as x(l, n))),
           '{decisions}',
           (select coalesce(jsonb_agg(distinct jsonb_build_object('decision', rehearsal.decision_key((d->>'decisionId')::uuid),
                                                                  'kind', d->'kind', 'status', d->'status', 'detail', d->'detail')), '[]'::jsonb)
            from jsonb_array_elements(q.s->'decisions') d))
  from (select rehearsal.states(p_user) as s) q $$;
create function rehearsal.keep_readings(p_moment text) returns void language sql as $$
  insert into rehearsal.readings (moment, usr, listed, doc)
  select p_moment, u.usr, jsonb_array_length(rehearsal.states(u.id)->'decisions'), rehearsal.normalised(u.id)
  from (values ('aa', rehearsal.aa()), ('bb', rehearsal.bb())) u(usr, id) $$;
-- Where a reading kept here differs from the reading the twin kept for the same user at the same moment, one
-- line per difference; '{}' when they are equal. p_without names top-level members left out of both.
create function rehearsal.reading_diff(p_moment text, p_usr text, p_without text[] default '{}') returns text[] language sql as $$
  with here as (select r.doc - p_without as doc from rehearsal.readings r where r.moment = p_moment and r.usr = p_usr),
       twin as (select r.doc - p_without as doc from rehearsal.twin_readings r where r.moment = p_moment and r.usr = p_usr)
  select coalesce(array_agg(q.x order by q.x collate "C"), '{}')
  from (select 'a reading is missing' as x where not exists (select 1 from here) or not exists (select 1 from twin)
        union all
        select 'member ' || coalesce(a.key, b.key) || ': ' || coalesce(a.value::text, '(absent)') || ' here, ' || coalesce(b.value::text, '(absent)') || ' in the twin'
        from (select e.key, e.value from here, jsonb_each(here.doc) e where e.key not in ('legs', 'decisions')) a
        full join (select e.key, e.value from twin, jsonb_each(twin.doc) e where e.key not in ('legs', 'decisions')) b on b.key = a.key
        where a.value is distinct from b.value
        union all
        select 'leg ' || coalesce(a.l->>'transactionId', b.l->>'transactionId') || ': ' || coalesce(a.l::text, '(absent)') || ' here, '
               || coalesce(b.l::text, '(absent)') || ' in the twin'
        from (select x.l, x.n from here, jsonb_array_elements(here.doc->'legs') with ordinality as x(l, n)) a
        full join (select x.l, x.n from twin, jsonb_array_elements(twin.doc->'legs') with ordinality as x(l, n)) b on b.n = a.n
        where a.l is distinct from b.l
        union all
        select 'decision ' || coalesce(a.d, b.d)::text || case when a.d is null then ': in the twin only' else ': here only' end
        from (select d from here, jsonb_array_elements(here.doc->'decisions') d) a
        full join (select d from twin, jsonb_array_elements(twin.doc->'decisions') d) b on b.d = a.d
        where a.d is null or b.d is null) q $$;

-- The live decisions of the kinds a removal writes, of one user, as keys (a key is listed as often as rows have it).
create function rehearsal.rows(p_user uuid default rehearsal.aa()) returns text[] language sql as $$
  select coalesce(array_agg(rehearsal.decision_key(d.id) order by rehearsal.decision_key(d.id) collate "C"), '{}')
  from public.card_payment_decisions d
  where d.user_id = p_user and d.superseded_by is null
    and d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') $$;
-- The ids of the live decisions with a key, least first.
create function rehearsal.ids(p_key text, p_user uuid default rehearsal.aa()) returns text[] language sql as $$
  select coalesce(array_agg(d.id::text order by d.id), '{}')
  from public.card_payment_decisions d
  where d.user_id = p_user and d.superseded_by is null and rehearsal.decision_key(d.id) = p_key $$;
create function rehearsal.keep_decisions(p_moment text) returns void language sql as $$
  insert into rehearsal.decisions_at (moment, id, usr, key)
  select p_moment, d.id, d.user_id, rehearsal.decision_key(d.id) from public.card_payment_decisions d $$;
-- The keys of the decisions a user has now and did not have at a moment, and of those the user had then and
-- has no more (a decision row goes only with an account it names).
create function rehearsal.written_since(p_moment text, p_user uuid default rehearsal.aa()) returns text[] language sql as $$
  select coalesce(array_agg(rehearsal.decision_key(d.id) order by rehearsal.decision_key(d.id) collate "C"), '{}')
  from public.card_payment_decisions d
  where d.user_id = p_user and not exists (select 1 from rehearsal.decisions_at k where k.moment = p_moment and k.id = d.id) $$;
create function rehearsal.gone_since(p_moment text, p_user uuid default rehearsal.aa()) returns text[] language sql as $$
  select coalesce(array_agg(k.key order by k.key collate "C"), '{}')
  from rehearsal.decisions_at k
  where k.moment = p_moment and k.usr = p_user and not exists (select 1 from public.card_payment_decisions d where d.id = k.id) $$;

-- An institution removal, as the backend runs it: begun, confirmed at Plaid, cleaned up locally.
create function rehearsal.remove(p_user uuid, p_item uuid) returns void language plpgsql as $$
begin
  perform th.assert(public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item))->>'outcome' = 'started',
                    'the removal begins');
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
  perform th.assert((public.remove_plaid_item_local(p_user, p_item)->>'replayed')::boolean = false, 'the removal runs');
end $$;

-- ---- Provenance (20261008120000). PL/pgSQL, so that these can be created before the two tables exist. ----
-- The live decisions of the kinds a removal writes, of one user, each with its source:
--   key <= removed item:removed account:removed transaction[relation]      or      key <= NO SOURCE
create function rehearsal.deps(p_user uuid default rehearsal.aa()) returns text[] language plpgsql as $$
begin
  return (
    select coalesce(array_agg(q.x order by q.x collate "C"), '{}')
    from (select rehearsal.decision_key(d.id) || ' <= '
                 || coalesce(r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || coalesce(s.source_plaid_transaction_id, '-')
                             || '[' || s.source_relation || ']', 'NO SOURCE') as x
          from public.card_payment_decisions d
          left join public.card_payment_removal_sources s on s.decision_id = d.id
          left join public.plaid_item_removals r on r.id = s.removal_id
          where d.user_id = p_user and d.superseded_by is null
            and d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')) q);
end $$;
-- What is recorded of each source of one user, one line per distinct description, with the number of rows
-- that carry it (rows that share a source and describe it alike are one line):
--   removed item|institution id|removed account|type/subtype/mask|resolution:transaction|pending=…|of=…|date|cents|currency xN
create function rehearsal.sources(p_user uuid default rehearsal.aa()) returns text[] language plpgsql as $$
begin
  return (
    select coalesce(array_agg(q.x || ' x' || q.n order by q.x collate "C"), '{}')
    from (select r.plaid_item_id || '|' || coalesce(g.institution_id, 'null') || '|' || s.source_plaid_account_id || '|'
                 || coalesce(s.source_account_type, 'null') || '/' || coalesce(s.source_account_subtype, 'null') || '/'
                 || coalesce(s.source_account_mask, 'null')
                 || '|' || s.source_resolution || ':' || coalesce(s.source_plaid_transaction_id, '-')
                 || '|pending=' || coalesce(s.source_pending::text, 'null')
                 || '|of=' || coalesce(s.source_pending_transaction_id, 'null') || '|' || coalesce(s.source_date::text, 'null')
                 || '|' || coalesce(s.source_cents::text, 'null') || '|' || coalesce(s.source_iso_currency_code, 'null') as x,
                 count(*) as n
          from public.card_payment_removal_sources s
          join public.card_payment_removal_generations g on g.removal_id = s.removal_id
          join public.plaid_item_removals r on r.id = s.removal_id
          where s.user_id = p_user
          group by 1) q);
end $$;
-- A user's generations in their order: ordinal:removed item:recorded|marker(institution id).
create function rehearsal.generations(p_user uuid default rehearsal.aa()) returns text[] language plpgsql as $$
begin
  return (
    select coalesce(array_agg(g.ordinal || ':' || r.plaid_item_id || ':' || case when g.sources_recorded then 'recorded' else 'marker' end
                              || '(' || coalesce(g.institution_id, 'null') || ')' order by g.ordinal), '{}')
    from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
    where g.user_id = p_user);
end $$;
-- THE RULE of 20261008120000's header, as a query over every live system row that has a provenance row: "a
-- system row written by generation G is known to depend on its recorded source ALONE only if the user has no
-- marker with a greater ordinal than G and no cleaned removal without a generation row." One line per row:
--   user G<ordinal> key <= removed item:removed account:removed transaction[relation] -> verdict
create function rehearsal.rule() returns text[] language plpgsql as $$
begin
  return (
    select coalesce(array_agg(q.x order by q.x collate "C"), '{}')
    from (select case d.user_id when rehearsal.aa() then 'aa' when rehearsal.bb() then 'bb' else d.user_id::text end
                 || ' G' || g.ordinal || ' ' || rehearsal.decision_key(d.id) || ' <= '
                 || r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || s.source_plaid_transaction_id || '[' || s.source_relation || '] -> '
                 || case when v.later_marker and v.unmarked then 'NOT alone: a later marker, and a cleaned removal without a generation row'
                         when v.later_marker then 'NOT alone: a later marker'
                         when v.unmarked then 'NOT alone: a cleaned removal without a generation row'
                         else 'its source alone' end as x
          from public.card_payment_removal_sources s
          join public.card_payment_decisions d on d.id = s.decision_id
          join public.card_payment_removal_generations g on g.removal_id = s.removal_id
          join public.plaid_item_removals r on r.id = s.removal_id
          cross join lateral (
            select exists (select 1 from public.card_payment_removal_generations m
                           where m.user_id = g.user_id and not m.sources_recorded and m.ordinal > g.ordinal) as later_marker,
                   exists (select 1 from public.plaid_item_removals c
                           where c.user_id = g.user_id and c.status = 'cleaned'
                             and not exists (select 1 from public.card_payment_removal_generations x where x.removal_id = c.id)) as unmarked) v
          where d.superseded_by is null and s.source_relation <> 'confirmed_counterpart') q);
end $$;

grant usage on schema rehearsal to service_role;
grant select, insert on all tables in schema rehearsal to service_role;
grant execute on all functions in schema rehearsal to service_role;

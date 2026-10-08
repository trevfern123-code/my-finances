-- Client table privilege hardening (S1). Removes write and administrative privileges that the client roles
-- inherited from the original schema dump (20260825195130_remote_schema.sql). No supported application
-- path uses them: the frontend uses Supabase only for auth, and every write goes through the backend's
-- service-role client (S1_CLIENT_TABLE_PRIVILEGE_HARDENING.md has the route and role evidence).
--
-- WHY. RLS (enabled, with no write policy) already reduced client DML on these tables to zero rows or a
-- refusal. But TRUNCATE is not subject to RLS. In a disposable database, `authenticated` could TRUNCATE
-- public.transaction_splits, including other users' rows. TRIGGER, REFERENCES and MAINTAIN are also
-- unneeded by any client.
--
-- EXACT SCOPE
--   * Tables, and ONLY these:
--       public.transactions, public.accounts, public.transaction_splits, public.manual_loans,
--       public.budget_categories.
--   * Roles: anon, authenticated, and PUBLIC. PUBLIC held nothing here at 1aab2d8; including it
--     guards against drift.
--   * Revoked: INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN.
--     None of the five has column-level grants, so there is nothing to revoke per column.
--   * Kept:
--       - SELECT for anon and authenticated: reads stay gated by RLS exactly as before, i.e. owner-only
--         policies on budget_categories and manual_loans, and no rows on the other three;
--       - every service_role privilege;
--       - RLS enablement and all policies;
--       - ownership.
--   * Default privileges: ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public revokes the same
--     seven privileges on future TABLES from anon, authenticated and PUBLIC.
--       - It affects only tables that postgres, the migration owner, creates in public from now on.
--         Their SELECT for anon/authenticated and all service_role defaults are kept.
--       - It does NOT revoke anything on other existing tables.
--       - It does not touch other owners' defaults (e.g. supabase_admin's in public), other schemas,
--         sequences, functions or global defaults.
--       - The postcondition refuses to finish if postgres has a GLOBAL table default granting a client
--         write, because a schema-scoped revoke cannot cancel one.
--
-- NOT CHANGED: no other table, function, sequence, schema privilege, role membership, policy, RLS flag,
-- function body (C1 included) or row. Uses neither CASCADE nor REVOKE … ON ALL TABLES.
--
-- RECOVERY. Nothing in the application needs these privileges, so an application rollback needs no
-- grant. Do not re-grant them wholesale. If a future feature genuinely needs a client write, add a narrow,
-- reviewed grant with an RLS write policy in its own migration.

revoke insert, update, delete, truncate, trigger, references, maintain
  on table public.transactions, public.accounts, public.transaction_splits, public.manual_loans, public.budget_categories
  from anon, authenticated, public;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, trigger, references, maintain on tables from anon, authenticated, public;

-- ---- Postconditions: EFFECTIVE privileges, not only the statements above ----------------------------------------------
do $$
declare
  v_bad text;
begin
  -- No client role (or PUBLIC) holds a targeted privilege on a target, at table or column level.
  select string_agg(format('%s %s %s', t, r, p), '; ' order by t, r, p) into v_bad
  from unnest(array['public.transactions', 'public.accounts', 'public.transaction_splits', 'public.manual_loans',
                    'public.budget_categories']) t
  cross join unnest(array['anon', 'authenticated', 'public']) r
  cross join unnest(array['insert', 'update', 'delete', 'truncate', 'trigger', 'references', 'maintain']) p
  where has_table_privilege(r, t::regclass, p)
     or (p in ('insert', 'update', 'references') and has_any_column_privilege(r, t::regclass, p));
  if v_bad is not null then
    raise exception 'client roles still hold targeted privileges: %', v_bad;
  end if;

  -- Intended reads and the backend's access remain.
  select string_agg(format('%s %s %s', t, r, p), '; ' order by t, r, p) into v_bad
  from unnest(array['public.transactions', 'public.accounts', 'public.transaction_splits', 'public.manual_loans',
                    'public.budget_categories']) t
  cross join (values ('anon', 'select'), ('authenticated', 'select'),
                     ('service_role', 'select'), ('service_role', 'insert'), ('service_role', 'update'), ('service_role', 'delete'),
                     ('service_role', 'truncate'), ('service_role', 'trigger'), ('service_role', 'references'),
                     ('service_role', 'maintain')) k(r, p)
  where not has_table_privilege(r, t::regclass, p);
  if v_bad is not null then
    raise exception 'an intended privilege was lost: %', v_bad;
  end if;

  -- RLS and the existing policies are untouched.
  if exists (select 1 from pg_class where oid in ('public.transactions'::regclass, 'public.accounts'::regclass,
               'public.transaction_splits'::regclass, 'public.manual_loans'::regclass, 'public.budget_categories'::regclass)
             and not relrowsecurity)
     or (select count(*) from pg_policy where polrelid = 'public.budget_categories'::regclass
           and polname = 'Users can only see their own budget_categories' and polcmd = 'r') <> 1
     or (select count(*) from pg_policy where polrelid = 'public.manual_loans'::regclass
           and polname = 'Users can only see their own manual_loans' and polcmd = 'r') <> 1
     or exists (select 1 from pg_policy where polrelid in ('public.transactions'::regclass, 'public.accounts'::regclass,
                  'public.transaction_splits'::regclass)) then
    raise exception 'RLS enablement or policies changed on a target table';
  end if;

  -- Future tables created by postgres in public: no client write default, schema-scoped or global.
  select string_agg(format('%s %s %s', coalesce(n.nspname, '<global>'), coalesce(r.rolname, 'PUBLIC'), a.privilege_type), '; ') into v_bad
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
  left join pg_roles r on r.oid = a.grantee
  where d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'r'
    and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
    and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
  if v_bad is not null then
    raise exception 'default table privileges for postgres still grant client writes: %', v_bad;
  end if;
end
$$;

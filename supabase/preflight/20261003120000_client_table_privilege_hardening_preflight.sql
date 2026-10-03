-- READ-ONLY preflight / postflight for 20261003120000_client_table_privilege_hardening.sql. For a later,
-- separately approved hosted rollout: run before applying (preflight), and again after (postflight). Every
-- statement is a SELECT. Nothing here changes data, privileges or settings. NOT run against any hosted
-- project as part of S1.
--
-- Expected results:
--   PREFLIGHT, the state the migration was written for (matches the 1aab2d8 disposable database):
--     * Q1: anon and authenticated show Y for all eight privileges on the five tables; PUBLIC shows none;
--     * Q2: 0 column-level ACLs;
--     * Q4: a (postgres, public, r) default granting anon/authenticated, and no <global> table default for
--       postgres.
--     Stop and review if instead:
--     * PUBLIC holds a targeted privilege (removing it is in scope, but it would be unexpected);
--     * column-level grants exist (the table-level revoke also removes matching column privileges, but
--       their presence means the state differs from the one reviewed);
--     * a <global> postgres table default grants a client role (out of scope: the postcondition aborts);
--     * the policies (Q3) differ from: owner-only SELECT on budget_categories and manual_loans; none on
--       transactions, accounts, transaction_splits.
--   POSTFLIGHT:
--     * Q1: anon and authenticated show only select=Y, PUBLIC shows nothing, and service_role keeps all eight;
--     * Q2 and Q3 unchanged;
--     * Q4: the (postgres, public, r) default keeps anon/authenticated SELECT only, and service_role keeps
--       all privileges.

-- Q1. Effective table privileges on the five targets.
select t as table_name, r as role,
       string_agg(p || '=' || case when has_table_privilege(r, ('public.' || t)::regclass, p) then 'Y' else 'n' end, ',' order by p) as privileges
from unnest(array['transactions', 'accounts', 'transaction_splits', 'manual_loans', 'budget_categories']) t
cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) r
cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'trigger', 'references', 'maintain']) p
group by t, r order by t, r;

-- Q2. Column-level ACLs on the five targets (expected: none).
select c.relname, a.attname, a.attacl
from pg_attribute a join pg_class c on c.oid = a.attrelid
where c.oid in ('public.transactions'::regclass, 'public.accounts'::regclass, 'public.transaction_splits'::regclass,
                'public.manual_loans'::regclass, 'public.budget_categories'::regclass)
  and a.attnum > 0 and a.attacl is not null;

-- Q3. RLS and policies on the five targets.
select c.relname, c.relrowsecurity, c.relforcerowsecurity, pol.polname, pol.polcmd, pol.polroles::regrole[]::text,
       pg_get_expr(pol.polqual, pol.polrelid) as using_expr, pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
from pg_class c left join pg_policy pol on pol.polrelid = c.oid
where c.oid in ('public.transactions'::regclass, 'public.accounts'::regclass, 'public.transaction_splits'::regclass,
                'public.manual_loans'::regclass, 'public.budget_categories'::regclass)
order by c.relname, pol.polname;

-- Q4. Default TABLE privileges relevant to future postgres-owned tables in public (schema-scoped and global).
select pg_get_userbyid(d.defaclrole) as owner, coalesce(n.nspname, '<global>') as schema_name, d.defaclobjtype,
       coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') as grantee, string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a
where d.defaclobjtype = 'r' and (d.defaclnamespace = 0 or n.nspname = 'public')
group by 1, 2, 3, 4 order by 1, 2, 4;

-- Q5. Who owns the application tables, and client role memberships (expected: postgres owns them; anon and
-- authenticated are members of no role that holds table privileges).
select tableowner, count(*) from pg_tables where schemaname = 'public' group by 1;
select pg_get_userbyid(m.member) as member, pg_get_userbyid(m.roleid) as member_of
from pg_auth_members m where m.member in ('anon'::regrole, 'authenticated'::regrole);

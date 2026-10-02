# S1: client table privilege hardening

**Status:** a development candidate stacked on the C1 checkpoint (`1aab2d8`), on branch `feature/client-table-privilege-hardening`.
- Local only: not pushed and not released.
- It does not change PR #12, the C1 functions, any financial calculation or any application behaviour.
- It is not hosted-security verification.

## 1. Background

**The C1 compatibility finding is resolved for the tested states.**
- The PR #12 client-write audit found no supported-path compatibility regression.
- The frontend uses Supabase only for auth, and every write goes through the backend's service-role client.
- In disposable databases at three revisions (pre-matching, `d55a9eb`, `1aab2d8`), direct client writes never reach the card-payment triggers.
- That conclusion covers the application paths and disposable states tested. It is not a statement about the hosted project.
- The audit is preserved as reported: `p3_audit` scratch evidence, summarised in the PR #12 audit report.

**The separate inherited issue.** `20260825195130_remote_schema.sql` granted `anon` and `authenticated` every table privilege (`arwdDxtm`) on the application tables.
- RLS, enabled with no write policy, already reduced client DML to zero rows or a refusal.
- TRUNCATE is not subject to RLS. At `1aab2d8`, in a disposable database, `authenticated` (as user bb) **truncated user aa's `transaction_splits`**. That was rolled back (`p3_audit`, state c1 part 2, case T1).
- TRIGGER, REFERENCES and MAINTAIN were also held, with no client use.
- PostgREST and GraphQL expose no TRUNCATE or DDL, so this was a SQL-level defense-in-depth gap rather than a proven API exposure.

## 2. The correction — `supabase/migrations/20261003120000_client_table_privilege_hardening.sql`

**Existing tables:**
```sql
revoke insert, update, delete, truncate, trigger, references, maintain
  on table public.transactions, public.accounts, public.transaction_splits, public.manual_loans, public.budget_categories
  from anon, authenticated, public;
```
- **PUBLIC** held nothing on these tables at `1aab2d8`. It is included to guard against drift.
- **Column-level grants:** none existed (0), so no per-column revoke is needed.
- **Unchanged:**
  - **SELECT** for `anon` and `authenticated`, so reads remain RLS-gated exactly as before;
  - **`service_role`**: all eight privileges;
  - **RLS and policies**;
  - **ownership**.
- **Not used:** CASCADE and `ON ALL TABLES`.

**Defaults for future tables:**
```sql
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, trigger, references, maintain on tables from anon, authenticated, public;
```
- **Affected:** this affects only tables that `postgres`, the verified migration owner (it owns all 22 public tables), creates in `public` from now on. Their SELECT defaults for clients and all `service_role` defaults are kept.
- **Not affected:** it revokes nothing on other existing tables. It does not touch other owners' defaults, other schemas, sequences, functions, or global defaults.
- **Global defaults:** `postgres` has no global table default. The postcondition aborts if one granting a client write ever appears, because a schema-scoped revoke cannot cancel it.

**Postconditions** check effective state: table and column privileges for `anon`, `authenticated` and PUBLIC; SELECT and `service_role` preserved; RLS and the exact policies unchanged; and the `postgres` default ACL, both schema-scoped and global.

**The migration changes no rows**: proven by the preservation check in §4.

## 3. Privilege matrix (disposable databases, pinned image)

| Target | Role | Before (`1aab2d8`) | After |
|---|---|---|---|
| all five | `anon` | select, insert, update, delete, truncate, trigger, references, maintain | **select** |
| all five | `authenticated` | the same eight | **select** |
| all five | PUBLIC | none | none |
| all five | `service_role` | all eight | all eight (unchanged) |
| column level | any role | none | none |
| RLS | — | enabled on all five. Policies: `budget_categories` and `manual_loans` have owner-only SELECT (`auth.uid() = user_id`); the other three have none | unchanged |
| default (`postgres`, `public`, tables) | `anon` / `authenticated` | all eight | **SELECT** |
| default (`postgres`, `public`, tables) | `service_role` | all eight | all eight |

**Supported application path for every write to these five tables:** backend `supabaseAdmin` (service role). See the PR #12 audit for the route matrix: category, approval and splits RPCs; loan link, edit and unlink RPCs; the sync batch RPC; direct `accounts` updates for customization; manual-loan RPCs. No supported client-write dependency exists.

## 4. Tests

**New durable CI test: `supabase/tests/access_control/sql/a16_client_table_privileges.sql`**, run by the existing `database-harness` job. It checks:
- **Catalog:** no targeted privilege, table- or column-level, for `anon`, `authenticated` or PUBLIC on the five targets. SELECT is kept, `service_role` holds all eight, and RLS and policies are unchanged.
- **Negative control:** `grant truncate … to authenticated` inside a rolled-back transaction makes the check report exactly `public.transaction_splits authenticated truncate`. It is clean again after rollback.
- **Refusals:** for **both `anon` and `authenticated`**, TRUNCATE on each of the five tables fails with **`permission denied for table …`**, not a foreign-key error or a zero-row result. INSERT, UPDATE (input and non-input columns) and DELETE are refused the same way for `authenticated`.
- **Reads:** `authenticated` reads only its own `budget_categories` and `manual_loans` rows, and none of the three policy-less tables. `anon` reads nothing. The other user's split is intact.
- **Supported writes (`service_role`):** each is verified by a readback in a separate statement:
  - category set and approval;
  - splits replaced;
  - loan link (`linked`), principal edit (30) and unlink;
  - sync insert;
  - cash-flow inclusion via a direct `accounts` update;
  - the carry-over sweep.
- **Ownership negatives:** the category, approval, splits, link and sync calls each refuse when made as the other user.
- **Defaults:** a probe table created by `postgres` in `public` gets no client write privilege. It keeps SELECT for clients and all `service_role` privileges, and is then dropped.

**Scratch evidence** (outside the repository):
- **A, the baseline TRUNCATE reproduction:** the PR #12 audit at `1aab2d8` (`p3_audit/raw_results_all_states.txt`, state c1 part 2): `ok`, aa's splits went to 0, then rolled back.
- **G, preservation** (`p4_s1/zz_s1_preserve.sql`): a `1aab2d8` database with data and an evaluation is snapshotted, the real migration file is applied in one transaction, and it is snapshotted again. **17 of 17 items are unchanged:**
  - rows of the five targets, plus carry-overs, versions, leg states and decisions;
  - all policies and RLS flags;
  - every public function body, including both C1 bodies;
  - other tables', functions', sequences' and the schema's ACLs.
- **Postflight in a disposable database** (`p4_s1/postflight_disposable.log`): the read-only preflight/postflight queries run cleanly and show the "after" column above.

**Regression:** see the handoff for the final suite results.

## 5. Recovery

- **No automatic restore.** The application does not use these privileges, so an application or C1 rollback needs no grant. The C1 rollback script does not touch grants.
- **No wholesale re-grant.** Re-granting them would reopen the TRUNCATE gap.
- **If a future feature needs a client write:** add a narrow grant together with an RLS write policy, in its own reviewed migration.
- **A rollback would be a reviewed exception:** the exact inverse is a `grant` of the seven privileges to `anon` and `authenticated`, plus the matching `alter default privileges … grant`. It is recorded here only for completeness and should not be run unless a supported dependency is found.

## 6. Limitations and follow-ups (not done here)

- **Hosted drift:** not verified, because there was no hosted access. Run `supabase/preflight/20261003120000_client_table_privilege_hardening_preflight.sql` (read-only) before and after any approved rollout.
- **GraphQL (`graphql_public`):** not exercised directly. It enforces the same grants and RLS.
- **Other existing tables with the same inherited client grants (not revoked by S1):** `category_mappings`, `loans`, `manual_loan_payments`, `net_worth_snapshots`, `recurring_streams` (from `remote_schema`). Tables that later migrations created as `postgres` received the old default (all eight privileges) unless their own migration revoked them. Several did (`plaid_items`, `transaction_carryovers`, the card-payment tables, the link/removal tables), but a full catalog sweep was not done.
- **Other owners' defaults:** `supabase_admin` holds public-schema table defaults that grant clients all eight privileges. They are out of scope (a different owner and platform-managed), and the S1 postcondition does not cover them.
- **Behaviour change at the SQL level only:** a direct client DML statement on these tables now fails with `permission denied` instead of affecting zero rows. No supported path issues one.

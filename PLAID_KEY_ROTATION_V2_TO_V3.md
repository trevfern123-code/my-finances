# Plaid token key rotation: `RAILWAY_PROD_V2` → `RENDER_PROD_V3`

**Status: preparation only. Nothing here has been executed, deployed, or configured.** No production data, schema,
key, or platform setting was read or changed while preparing this branch. Running any of it in production needs a
separate review and approval (§10).

Builds on `PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md` (the encryption design, §22's rotation addendum, §23's V1 → V2
record). Code: `backend/src/scripts/rotatePlaidTokenKeyV2ToV3.ts`; tests:
`rotatePlaidTokenKeyV2ToV3.test.ts` and `backend/src/services/tokenKeyRotationV3.compat.test.ts`.

**Revision 2 (2026-10-23)** answers the first independent review of PR #20. Changes: the Hosted Link cleanup step
(§4.3, finding 1); a platform-sequencing decision (§5, finding 2); what this rotation does not remediate (§6,
finding 3); CI evidence (§8, finding 4); merge-as-deploy gating (§4.1, finding 5); and a final recount in every mode
(§3.2, finding 6).

## 1. Starting state

Reported by Trevor and **not re-verified on this branch**, because verifying it would mean reading production:

- Render backend deployed and healthy, reaching Supabase with a new secret API key.
- Render decrypts all 4 existing Plaid Sandbox access tokens, and Plaid accepted all 4 under the new Sandbox secret.
- All 4 `plaid_items` rows reference `RAILWAY_PROD_V2`. 3 keep a plaintext `access_token` copy; 1 is
  encrypted-only.
- Item statuses: 3 `login_required`, 1 `credential_error`.
- Railway is the active backend. Render must not get production traffic yet.

The script's preflight re-checks every one of these data facts (§3.3) before it writes anything.

## 2. Audit findings (what the code actually does)

1. **"V3" is a key id, not a new format.**
   - The key ring (`tokenEncryption.ts`) is built only from the environment. Each `PLAID_TOKEN_KEY_<ID>` becomes
     key `<ID>`, and `PLAID_TOKEN_CURRENT_KEY_ID` picks which key new encryptions use.
   - `ENC_VERSION` stays `1`, and the AAD (`…:v1:<row id>`) does not include the key id.
   - So no application code or schema change is needed. V2 stays readable for as long as
     `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` is configured.
2. **Plaintext copies are never a fallback.** `dataService.resolveAccessToken` decrypts whenever all five encrypted
   columns are present, and never falls back to `access_token`. If V2 were removed too early, the 3 rows with
   plaintext copies would fail (`UnknownKeyIdError`, then `credential_error`) just like the encrypted-only one. A
   compat test pins this.
3. **No application path rewrites a stored access token.**
   - `insertPlaidItem` and `store_plaid_link_item` only insert, with a fresh random row id.
   - Status, cursor and removal updates never touch the token columns.
   - Only this script moves a row off V2, which is what the concurrency argument in §3.4 rests on.
4. **Hosted Link tokens** (`plaid_link_attempts.link_token_*`) share the key ring under their own AAD context.
   - A token exists only while an attempt is `pending`/`claimed` (a table check enforces this). Attempts expire 30
     minutes after creation, and the app's state machine erases the token on exchange or failure.
   - **Expired rows are not removed on a timer.** `purge_expired_plaid_link_attempts(100)` runs only inside
     `create_plaid_link_attempt` and inside a *successful* `claim_plaid_link_attempt` (migration
     `20260922130000`, lines ~208 and ~275). It deletes only rows that expired more than an hour ago. With no Link
     traffic, expired V2 rows stay forever.
   - `readPlaidLinkAttempt` still decrypts the token of an expired pending row that has not been purged. So expired
     V2 rows block V2 retirement, and they need the explicit cleanup step in §4.3.
   - *(Revision 1 wrongly said these rows age out by themselves. Finding 1.)*
5. **`plaid_item_removals` stores no token.** A migration-time check refuses any `%token%` column. No other table
   holds key-ring ciphertext.
6. **Plaid webhooks are addressed by URL, chosen at link time.** `plaidService` registers
   `${BACKEND_PUBLIC_URL}/api/webhooks/plaid` when a link token is created, so existing items still point at the
   Railway domain. Any cutover that stops Railway must deal with this (§5).
7. **Existing scripts are left untouched and will refuse after the switch.** `backfillTokenEncryption.ts` requires
   current = `RAILWAY_PROD_V2` and has nothing left to do. `rotateTartanTokenKey.ts` also requires current =
   `RAILWAY_PROD_V2` and is finished. Both refuse once V3 is current.
8. **Constraints relied on.**
   - `plaid_items_encrypted_token_complete` and `plaid_items_token_present` (Phase 1).
   - The `plaid_link_attempts` check that ties token presence to status.
   - The script cannot inspect `pg_constraint` through PostgREST, so the operator attests to them
     (`--constraints-confirmed`) after running the query in §7.

## 3. Design

### 3.1 Two modes, both read-only by default

| Mode | Writes | Purpose |
|---|---|---|
| `--mode rotate` (dry run) | never | Full per-row verification including a local V3 round trip, then a whole-table recount |
| `--mode rotate --apply --confirm ROTATE_PLAID_KEY_V2_TO_V3` | only the five `access_token_*` encryption columns of V2 rows | The migration |
| `--mode verify-retirement` | never (`--apply` refused) | The gate before V2 can be removed anywhere |

The key ids are fixed constants. **`RENDER_PROD_V3` is a proposed name.** To change it, edit one constant and the
test fixtures before review.

### 3.2 Per-row flow (`rotate`: id order, halts on the first anomaly)

1. **Fresh reread.** A missing row, or any state other than complete V2 or complete V3 at version 1, halts with its
   own reason code.
2. **Already V3 (resume path).** No write. The stored value is decrypted with a **V3-only key ring** and compared
   with the plaintext copy, if there is one.
3. **V2.** Decrypt with the full ring.
   - If there is a plaintext copy, it must equal the decrypted token. A mismatch halts the run, and neither value
     is treated as authoritative.
   - The encrypted-only row has no second copy, so its V2 decryption is the source, checked by every round trip
     after it.
4. **Encrypt** under the current key. Require `keyId = RENDER_PROD_V3` and version 1, then decrypt locally with the
   V3-only ring and get the same token back.
5. **Dry run** stops here for this row.
6. **Guarded update** (§3.4) of the five encrypted columns only.
7. **Reread and verify the stored value.**
   - Classify the row again.
   - Require the plaintext copy to be unchanged: same presence, same value.
   - Decrypt the **stored** value with the V3-only ring. The local copy of the ciphertext is never what gets
     verified.

**Final recount (every mode, before any success line; finding 6).** `finalRecheck` reads the whole table again and
requires:

- the same row-id set as at preflight (a delete plus an insert keeps the total but is still caught);
- the attested total and plaintext-copy count;
- no anomalous rows, and distinct nonces;
- the V2/V3 split unchanged (dry run), or zero V2 rows and every row on V3 (apply, retirement);
- **no growth in V2 link tokens** (any growth means some writer still encrypts under V2);
- no link token on an unknown key or version;
- for retirement, zero V2 link tokens.

`dry_run_complete`, `rotation_complete` and `v2_retirement_gate_passed` are logged only after `final_check: passed`.

### 3.3 Strict record counts (operator attestations, compared exactly)

| Flag | Value today |
|---|---|
| `--expected-total` | 4 |
| `--expected-plaintext-copies` | 3 |
| `--expected-remaining-v2` (`rotate` only) | 4 on the first run; the current count after an interruption |
| `--expected-plaid-env` | `sandbox` |
| `--expected-supabase-host` | `<project-ref>.supabase.co` |
| `--constraints-confirmed` | `PLAID_PHASE1_CONSTRAINTS_VERIFIED` |

The host is compared with `SUPABASE_URL` **before any read** and is never logged.

Preflight refuses the whole run on any of these:

- a plaintext-only, partial, missing, unknown-key or unexpected-version row;
- nonce reuse;
- a truncated read (exact `count` ≠ rows returned);
- a link token on an unknown key or version;
- V2 missing (rotate only), V3 missing, V3 not current, or V2 and V3 with identical key bytes.

Count flags must be canonical integers, and a stray `--confirm` without `--apply` is refused.

### 3.4 Concurrency and the update guard

The update matches:

- the exact `id`;
- `access_token_key_id = RAILWAY_PROD_V2` and `access_token_enc_version = 1`;
- the plaintext copy's **presence** as read.

It deliberately compares no ciphertext, nonce, tag or plaintext **value**: PostgREST filters travel in the URL, and
the design forbids logging nonces and token material. That is safe because of finding 3 in §2: only this script
moves a row off V2, and every run of it encrypts the same decrypted token.

| Race | Outcome |
|---|---|
| Two runs of this script on the same row | The loser matches zero rows, rereads, and verifies the winner's stored value (`concurrent_rotation_verified`) |
| Plaintext presence changes in between | The guard matches nothing: `update_not_applied` |
| Plaintext value changes in between | `plaintext_copy_changed` |

### 3.5 What the script never does (tests assert each)

- It never writes or clears `access_token`.
- It never writes `status`, `transactions_cursor` or any other column, and never writes any `plaid_link_attempts`
  row. It **deletes nothing**: Hosted Link cleanup is a separate, human-run step (§4.3).
- It never calls Plaid. `plaidService` is not imported, so there is no sync, exchange or invalidation.
- It never logs or prints a token, ciphertext, nonce, tag, key bytes, the Supabase URL or host, or a raw error.
  Every log line is `{ts, id?, stage, outcome, counts?}`.
- It never runs on import (`require.main === module`), and nothing in the server's module graph reaches it.

### 3.6 Hosted Link tokens: not rewritten, explicitly cleaned up

Re-encrypting `pending`/`claimed` link tokens would race the claim/exchange state machine to save at most 30
minutes, so the script only counts them.

- Once the writers' current key is V3, every new link token is V3.
- `rotate` allows existing V2 link tokens, but fails if their number **grows** during a run.
- `verify-retirement` fails while **any** V2 link token exists, expired or not.
- Expired V2 rows do not disappear without Link traffic (finding 4 in §2). They are removed by the separately
  approved, exact-count step in §4.3, never by the CLI.

### 3.7 `verify-retirement`

This mode does not need V2 in its key ring, and is meant to be run both before and after V2 is removed. It checks:

- every row is on V3 and decrypts with a **V3-only ring**, so a row labelled V3 but holding V2 bytes fails;
- plaintext copies agree;
- zero V2 link tokens exist, both at preflight and at the final recount;
- the row-id set is unchanged across the pass.

## 4. Operator runbook

**Every step needs Trevor's explicit authorization when it is taken.**

The steps below follow **option B** from §5, which is recommended but **not yet approved**. Where option A differs,
that is noted in §5.

Run the script **inside** the deployment that holds the keys (a Render shell or one-off job). Never run it locally
with production keys (precedent: design review §22, "Execution environment"). Arguments common to every command:

```
COMMON="--expected-total 4 --expected-plaintext-copies 3 --expected-plaid-env sandbox \
  --expected-supabase-host <project-ref>.supabase.co --constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED"
```

### 4.1 Before anything else

1. **Decide §5 (platform sequencing)** and record the decision and its rollback scope in this document.
2. **Merging this PR is a deploy event (finding 5).**
   - The PR changes `backend/**`. The reviewer reports Railway's watch path is `/backend/**`. That is set in the
     Railway dashboard, not in this repo's `railway.json`, so I could not check it.
   - Merging into `main` should therefore be expected to redeploy the Railway backend and start Vercel's `main`
     pipeline. The CLI is inert (nothing imports it), but the redeploy still restarts the live service.
   - So the merge needs its own **release approval**, scheduled for when a backend restart is acceptable, after
     the staging rehearsal below.
   - Under option B the script must also reach the Render deployment that will run it, and how Render deploys
     from `main` is not recorded in this repo.
3. **Staging rehearsal, before the merge.** Run both modes against a non-production database: a scratch local
   Supabase stack seeded with fixture rows encrypted under throwaway keys, or a non-production Supabase project
   with its own keys. The local tests use a filter-faithful fake, not real PostgREST.
4. **Re-run the CI database jobs** once the Docker registry limit clears (§8).
5. **Read-only checks:**
   - Run the §7 queries and confirm the counts match §1 and both constraints exist.
   - Confirm Supabase backups or point-in-time recovery cover the window.
   - Find out *why* one item is `credential_error` while Render decrypts all four, so a new failure is not
     mistaken for that old one.

### 4.2 Rotation (option B)

1. **Cut production traffic over to Render, with Render on V2 only** (current = `RAILWAY_PROD_V2`). This is a
   separate, separately approved cutover plan. It must cover:
   - Plaid webhooks of existing items, which point at the Railway domain (finding 6 in §2);
   - the frontend's API base URL;
   - Railway being **stopped from serving and writing**. The code has no "freeze Link" switch, so freezing means
     Railway serves no traffic at all.

   Confirm from Railway's logs that it has made no writes since the cutover.
2. **Generate the V3 key** offline (`randomBytes(32).toString('base64')`) and store a secure backup outside every
   platform, **before** configuring it.
3. **Add `PLAID_TOKEN_KEY_RENDER_PROD_V3` to Render only.** Keep current = V2 and redeploy. Startup validation
   must pass.
4. **Set `PLAID_TOKEN_CURRENT_KEY_ID=RENDER_PROD_V3` on Render** and redeploy. New items and link tokens are now
   V3; V2 rows still read.
5. **Dry run:**
   `node dist/scripts/rotatePlaidTokenKeyV2ToV3.js --mode rotate --expected-remaining-v2 4 $COMMON`
   Expect 4 × `dry_run_verified`, `final_check: passed`, then `dry_run_complete`.
6. **Apply:** the same command plus `--apply --confirm ROTATE_PLAID_KEY_V2_TO_V3`. Expect 4 × `rotated`,
   `final_check: passed`, then `rotation_complete`.
7. **Re-run the §7 queries:**
   - `v2_items = 0`, `v3_items = 4`, `plaintext_copies = 3`, `distinct_encrypted_nonces = 4`;
   - every anomaly count 0;
   - only V2 link tokens that predate step 4 remain.
8. **Soak** with both keys still configured on Render. Watch for `UnknownKeyIdError` or `PlaidCredentialError`
   outcomes, and for new `credential_error` statuses. Any refresh or sync during the soak is Trevor's call; this
   tooling triggers none.

### 4.3 Hosted Link cleanup (separately approved, exact count, bounded; finding 1)

Wait at least 90 minutes after step 4 of §4.2. That is 30 minutes of link expiry plus the 1-hour purge threshold,
after which no V2 token can still be usable. Then:

1. **Read-only count**, using the database's clock:

   ```sql
   select count(*)                                                          as v2_link_tokens,
          count(*) filter (where expires_at <= now() - interval '1 hour')   as purgeable,
          count(*) filter (where expires_at >  now() - interval '1 hour')   as not_yet_purgeable
     from public.plaid_link_attempts
    where link_token_key_id = 'RAILWAY_PROD_V2';
   ```

   If `v2_link_tokens = 0`, skip to step 3. If `not_yet_purgeable > 0`, wait and count again.
2. **Delete exactly `purgeable` rows.** This is the one write in §4.3, and it needs its own approval with the
   number stated.

   ```sql
   do $$
   declare
     v_expected constant integer := <purgeable from step 1>;
     v_deleted integer;
   begin
     if v_expected < 1 or v_expected > 100 then
       raise exception 'expected count out of bounds';
     end if;
     if exists (select 1 from public.plaid_link_attempts
                 where link_token_key_id = 'RAILWAY_PROD_V2'
                   and expires_at > now() - interval '1 hour') then
       raise exception 'V2 link tokens newer than the purge threshold exist; wait and recount';
     end if;
     delete from public.plaid_link_attempts
      where link_token_key_id = 'RAILWAY_PROD_V2'
        and status in ('pending', 'claimed')
        and expires_at <= now() - interval '1 hour';
     get diagnostics v_deleted = row_count;
     if v_deleted <> v_expected then
       raise exception 'deleted % rows, expected %: rolled back', v_deleted, v_expected;
     end if;
   end $$;
   ```

   Any exception aborts the statement, so the delete rolls back. A concurrent app purge that removes some of the
   same rows first makes `v_deleted` smaller, which rolls back too: count again and retry.

   **Why this instead of `purge_expired_plaid_link_attempts(n)`.**
   - It deletes a strict subset of what the app's own purge would delete: the same 1-hour threshold, restricted to
     V2-keyed rows.
   - The app's purge also deletes every old `completed`/`failed`/`exchange_unknown` attempt. Those rows hold no
     token, but they are the record of possibly orphaned Plaid items, and they should not be lost as a side effect
     of key retirement.
   - The rows deleted here are dead: a claim requires an unexpired attempt, and the 1-hour margin leaves no live
     exchange.
   - If the reviewer prefers the existing function: `select public.purge_expired_plaid_link_attempts(n)` with `n`
     taken from a count of *all* attempts that expired over an hour ago. Check that the return value equals `n`.
     It returns 0 when another sweep holds its lock.
3. **Count again read-only:** expect `v2_link_tokens = 0`.
4. **Run the retirement gate:** `--mode verify-retirement $COMMON`. Expect `v2_retirement_gate_passed`.

### 4.4 Retire V2

After the soak:

1. Confirm the offline V2 backup exists.
2. Run `verify-retirement` again.
3. Remove `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` from Render and redeploy.
4. Run `verify-retirement` once more, inside the environment that no longer has V2.
5. Railway's own V2 variable goes with Railway's decommissioning, a separate step.

## 5. Platform sequencing (decision required before any V3 key exists; finding 2)

The review notes that Railway is the platform involved in the reported secret exposure. This repo does not record
that; the V1 exposure on record was a screenshot during setup. Either way, the fresh key should not be assumed safe
to place on Railway.

| | **A: dual writer, V3 on Railway and Render** | **B: Render becomes sole writer first, V3 only on Render** (recommended) |
|---|---|---|
| Where V3 exists | Railway and Render, for as long as V3 is the key | Render only. V3 never touches Railway |
| Writers during rotation | Two. A missed writer keeps creating V2 rows (detected by the final recount, not prevented) | One. The missed-writer case cannot occur once Railway is stopped |
| Prerequisite | None beyond adding the key | The production cutover to Render (currently "not yet") must come first, with webhooks and the frontend URL handled |
| Downtime | None | Whatever the cutover itself needs. The rotation adds none |
| Webhooks of existing items | Keep reaching Railway | Point at the Railway domain: must be moved (domain or Plaid `/item/webhook/update`, a separately approved Plaid change) or accepted as lost until refresh |
| Rollback scope | Back to Railway at any time; both platforms hold both keys | **Back to Railway only before step 4 of §4.2** (Railway has V2 only). After V3 is current, any V3 row is unreadable on Railway, so rollback means "flip Render's current back to V2", not "return to Railway". Returning to Railway after that would require putting V3 on Railway, which this option exists to avoid |
| Script changes | None | None. The CLI is identical; only the runbook order differs |

**Recommendation: B.** The goal is to leave Railway, and B keeps the new key off it at the cost of making the
cutover a prerequisite. **This needs Trevor's recorded approval.**

If A is chosen anyway, §4.2 becomes:

1. Add V3 to Railway and Render.
2. Flip current to V3 on **both**, then redeploy both.
3. Rotate.
4. Cut over later.

## 6. What this rotation does NOT remediate (finding 3)

Re-encrypting under V3 changes **only which key protects the stored ciphertext**.

- **The four Plaid access tokens are unchanged and stay valid at Plaid.** Anyone who already obtained a token
  value, or the V2 key together with a copy of the ciphertext, can still use it.
- **The three plaintext `access_token` copies are not touched.** This rotation does not remediate exposed token
  bytes or database plaintext.

That needs two **separate, separately designed and approved packets**, not this script.

**1. Access-token rotation via Plaid `/item/access_token/invalidate`.** Plaid documents that this returns a new
access token and invalidates the old one immediately. The irreversible failure to design against: Plaid succeeds
but the new token is lost before it is durably stored, which leaves the item unusable until the user re-links. The
packet must at least:

- run one item at a time, recording a durable intent before the call;
- store the new token, encrypted under the current key, in the same flow, with bounded retries and an operator stop
  on an unknown outcome;
- never retry `invalidate` for an item whose previous outcome is unknown;
- make its storage step handle the plaintext copy explicitly. After invalidation that copy is a dead token, and
  this tool's plaintext/ciphertext equality checks would rightly fail on it;
- plan for `login_required` and `credential_error` items, whose behaviour under invalidate must be verified
  against Plaid's documentation first.

**2. Plaintext retirement:** clearing `access_token` for the three legacy rows (design review §7, Phase 6). This is
best done after packet 1, or together with it, under its own approval. After it, run this tool's
`verify-retirement` with `--expected-plaintext-copies 0`.

Neither packet is started on this branch.

## 7. Read-only verification queries

These return counts only and never token values. Run them in the Supabase SQL editor.

```sql
select count(*)                                                                    as total_items,
       count(*) filter (where access_token_key_id = 'RAILWAY_PROD_V2')             as v2_items,
       count(*) filter (where access_token_key_id = 'RENDER_PROD_V3')              as v3_items,
       count(*) filter (where access_token_key_id is not null
                          and access_token_key_id not in ('RAILWAY_PROD_V2', 'RENDER_PROD_V3'))
                                                                                   as unexpected_key_id_items,
       count(*) filter (where access_token is not null)                            as plaintext_copies,
       count(*) filter (where access_token_ciphertext is null)                     as not_encrypted_items,
       count(*) filter (where num_nonnulls(access_token_ciphertext, access_token_nonce, access_token_auth_tag,
                                           access_token_key_id, access_token_enc_version) between 1 and 4)
                                                                                   as partial_encrypted_items,
       count(*) filter (where access_token_enc_version is not null
                          and access_token_enc_version <> 1)                       as unexpected_version_items,
       count(distinct access_token_nonce)                                          as distinct_encrypted_nonces
  from public.plaid_items;

select link_token_key_id, count(*) as attempts, count(*) filter (where expires_at > now()) as unexpired
  from public.plaid_link_attempts
 where link_token_key_id is not null
 group by link_token_key_id;

select conname from pg_constraint
 where conrelid = 'public.plaid_items'::regclass
   and conname in ('plaid_items_token_present', 'plaid_items_encrypted_token_complete');
```

## 8. Tests and CI evidence

**Script tests** (`rotatePlaidTokenKeyV2ToV3.test.ts`) run against a fake Supabase that evaluates filters the way
PostgREST does. They cover:

- argument parsing;
- classification of every storage state;
- each preflight refusal, including the host guard (which reads nothing);
- a dry run with zero writes;
- apply: only five columns written, the exact guard filters, other columns unchanged, stored values verified with a
  V3-only ring, Plaid never called;
- idempotent reruns;
- interrupt and resume;
- every concurrency race in §3.4;
- corrupted stored values;
- rows deleted, inserted or replaced mid-run;
- a failed write;
- no secrets in any log line;
- the retirement gate;
- *(revision 2)* the final recount: a passing recount logged before `dry_run_complete`, plus a dry run that fails on
  an inserted item, a replaced item (same total), a cleared plaintext copy, or a V2 link token created mid-run
  (dry run and apply). V3 link tokens created mid-run are accepted, and the V2-link-token gate refuses at
  preflight, before any per-row work.

**Compat tests** (`tokenKeyRotationV3.compat.test.ts`) run the real `dataService` under the transition key rings.

**Mutation check.** Each of 22 safety-relevant lines was removed or inverted one at a time and the script tests
re-run. 21 were caught. The survivor is equivalent: post-write decryption with the full ring instead of the V3-only
ring, where the stored key-id label already selects V3.

**CI (finding 4).** Run `40002500366` on head `a4705ca`:

- `build-and-test` passed;
- `migration-replay` and `database-harness` failed while pulling Docker images (`toomanyrequests: Data limit
  exceeded`), before any migration ran.

This PR adds no migration or SQL file. Those jobs must still be re-run green once the registry limit clears (§4.1),
and each push's run is recorded in the PR description. An earlier statement that the PR had no CI checks was wrong:
the app's status cache was read before Actions had started.

## 9. Risks and open questions

- **Platform sequencing (§5)** is undecided. B makes the cutover, including webhook handling, a prerequisite.
- **Missed writer (option A only):** detected by the final recount and by `verify-retirement`, not prevented.
- **Old access tokens stay valid, and plaintext copies remain (§6).** These are out of scope here and need their
  own packets.
- **The key id** `RENDER_PROD_V3` is a proposal.
- **`credential_error` item:** its cause is not established. The rotation leaves its status alone.
- **Supabase API logs** record the update filters (`id`, key id, version, plaintext presence), but no token
  material.
- **No rehearsal against real PostgREST/Postgres yet** (§4.1 step 3), and the CI database jobs are not yet green
  (§8).
- **Attested constraints:** `--constraints-confirmed` is trusted. The operator must run the §7 query first.

## 10. Steps that require human authorization (none performed)

1. The §5 decision.
2. The release approval to merge (a deploy event), after the staging rehearsal and green CI.
3. The production cutover plan (option B), including webhooks and the frontend URL.
4. Generating and backing up the V3 key.
5. Adding it to Render (and to Railway only under option A).
6. Flipping `PLAID_TOKEN_CURRENT_KEY_ID` and redeploying.
7. The dry run and the apply.
8. The §4.3 Hosted Link cleanup delete, approved with its exact count.
9. Removing V2.
10. The separate packets in §6.

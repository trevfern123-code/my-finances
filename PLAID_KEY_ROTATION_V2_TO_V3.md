# Plaid token key rotation: `RAILWAY_PROD_V2` → `RENDER_PROD_V3`

**Status: preparation only. Nothing here has been executed, deployed, or configured.** No production data, schema,
key, or platform setting was read or changed while preparing this branch. Running any of it in production needs a
separate review and approval (see §9).

Builds on `PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md` (the encryption design, §22's rotation addendum and §23's V1 → V2
record). Code: `backend/src/scripts/rotatePlaidTokenKeyV2ToV3.ts`, with regression tests in
`rotatePlaidTokenKeyV2ToV3.test.ts` and `backend/src/services/tokenKeyRotationV3.compat.test.ts`.

## 1. Starting state

Reported by Trevor; **not re-verified on this branch**, because checking it would mean reading production:

- Render backend deployed and healthy; reaches Supabase with a new secret API key; decrypts all 4 existing Plaid
  Sandbox access tokens; Plaid accepted all 4 under the new Sandbox secret.
- All 4 `plaid_items` rows reference `RAILWAY_PROD_V2`. 3 keep a plaintext `access_token` copy, 1 is encrypted-only.
- Item statuses: 3 `login_required`, 1 `credential_error`.
- Railway is still the active backend. Render must not get production traffic yet.

The script's preflight re-checks every one of these data facts (§3.3) before it writes anything.

## 2. Audit findings (what the code actually does)

1. **"V3" is a key id, not a new format.** The key ring (`tokenEncryption.ts`) is built only from the environment:
   every `PLAID_TOKEN_KEY_<ID>` variable becomes key `<ID>`, and `PLAID_TOKEN_CURRENT_KEY_ID` picks which key new
   encryptions use. `ENC_VERSION` stays `1`, and the AAD (`…:v1:<row id>`) does not include the key id. Rotating
   means re-encrypting under a different key id at the same version. **No application code or schema change is
   needed.** V2 stays readable for exactly as long as `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` is configured.
2. **Plaintext copies are never a fallback.** `dataService.resolveAccessToken` decrypts whenever all five encrypted
   columns are present, and it never falls back to `access_token` when decryption fails. So if V2 were removed too
   early, the 3 rows with plaintext copies would fail (`UnknownKeyIdError` → `credential_error`) just like the
   encrypted-only one. A compat test pins this behaviour.
3. **No application path rewrites a stored access token.** `insertPlaidItem` and `store_plaid_link_item` only
   insert, with a fresh random row id. `transitionItemStatus`, the cursor updates and removal never touch the token
   columns. The only thing that can move a row off V2 is this script, which is what makes the concurrency argument
   in §3.4 work.
4. **Hosted Link tokens** (`plaid_link_attempts.link_token_*`) use the same key ring under their own AAD context.
   They exist only while an attempt is `pending`/`claimed` (a table check enforces this), attempts expire 30 minutes
   after creation, the app's own state machine erases them on exchange or failure, and
   `purge_expired_plaid_link_attempts` deletes rows that expired more than an hour ago. However,
   `readPlaidLinkAttempt` still decrypts the token of an *expired* pending row that has not been purged yet. That
   gives an unreadable error, not a security problem, but it means expired V2 rows also block V2 retirement.
5. **`plaid_item_removals` stores no token.** A migration-time check refuses any `%token%` column. No other table
   holds key-ring ciphertext.
6. **Existing scripts are left as they are and will refuse to run after the switch.** `backfillTokenEncryption.ts`
   requires current = `RAILWAY_PROD_V2` and has nothing to do anyway (no plaintext-only rows remain).
   `rotateTartanTokenKey.ts` requires current = `RAILWAY_PROD_V2` and is finished. Once `PLAID_TOKEN_CURRENT_KEY_ID`
   becomes `RENDER_PROD_V3`, both refuse at preflight, which is the safe outcome.
7. **Schema constraints the script relies on:** `plaid_items_encrypted_token_complete` and
   `plaid_items_token_present` (Phase 1 migration), and the `plaid_link_attempts` check tying token presence to
   status. The script cannot inspect `pg_constraint` through PostgREST, so an operator attests to them
   (`--constraints-confirmed`) after running the query in §6.

## 3. Design

### 3.1 Two modes, both read-only by default

| Mode | Writes | Purpose |
|---|---|---|
| `--mode rotate` (dry run) | never | Full per-row verification, including a local V3 round trip |
| `--mode rotate --apply --confirm ROTATE_PLAID_KEY_V2_TO_V3` | only the five `access_token_*` encryption columns of V2 rows | The migration |
| `--mode verify-retirement` | never (`--apply` is refused) | The gate before V2 can be removed anywhere |

The key ids are fixed constants (`OLD_KEY_ID`, `NEW_KEY_ID`). **`RENDER_PROD_V3` is a proposed name.** If a
different id is chosen, change the constant and the test fixtures before review. The id becomes the env-var
suffix, `PLAID_TOKEN_KEY_RENDER_PROD_V3`.

### 3.2 Per-row flow (`rotate`, rows in id order, halting on the first anomaly)

1. Fresh reread. A missing row, or any state other than complete-V2 or complete-V3 at version 1, halts with its
   own reason code.
2. **Already V3** (resume path): no re-encryption and no write. The stored value is decrypted with a **V3-only key
   ring** and compared with the plaintext copy when there is one.
3. **V2:** decrypt with the full ring. When a plaintext copy exists, it must equal the decrypted token, and a
   disagreement halts the run (neither side is picked as authoritative). The encrypted-only row has no second copy,
   so its V2 decryption is the source, checked by every round trip after it.
4. Encrypt under the current key, then require `keyId = RENDER_PROD_V3` and version 1, and decrypt locally with the
   V3-only ring to get the same token back.
5. Dry run stops here.
6. Guarded update (§3.4) of the five encrypted columns only.
7. Reread. Classify the stored row again; require the plaintext copy to be unchanged (present or absent, same
   value); decrypt the **stored** value with the V3-only ring and compare it to the token and to the plaintext
   copy. The local ciphertext object is never what gets verified.

After an apply run, a whole-table check requires: total equal to the attested count, plaintext-copy count
unchanged, zero V2 rows, every row on V3, and distinct nonces.

### 3.3 Strict record counts (operator attestations, compared exactly)

The operator must supply each of these, and preflight compares them exactly against the database:

- `--expected-total` (4 today)
- `--expected-plaintext-copies` (3 today)
- `rotate` only: `--expected-remaining-v2` (4 on the first run; whatever is left after an interruption)
- `--expected-plaid-env sandbox`
- `--expected-supabase-host <project-ref>.supabase.co`. This is compared with `SUPABASE_URL` **before any read**,
  so a process pointed at the wrong project reads nothing. The host is never logged.
- `--constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED`

Preflight refuses the whole run on any of these:

- plaintext-only, partial, missing, unknown-key or unexpected-version rows;
- reused nonces;
- a truncated read (exact `count` ≠ rows returned);
- link tokens on an unknown key or version;
- a key-ring problem: V2 missing (rotate only), V3 missing, V3 not current, or V2 and V3 with identical bytes.

Count flags must be canonical integers (no `04`, `1e1`, signs or whitespace). A stray `--confirm` without `--apply`
is refused.

### 3.4 Concurrency and the update guard

The update matches the exact `id`, `access_token_key_id = RAILWAY_PROD_V2`, `access_token_enc_version = 1`, and
the plaintext-copy **presence** that was read (`is null` / `not is null`).

It deliberately does **not** compare a ciphertext, nonce, tag or plaintext **value**. PostgREST filters travel in
the request URL, and the design forbids logging nonces and token material (§11 of the design review). Leaving the
value out is safe because of finding 3: nothing but this script moves a row off V2, and every run of this script
encrypts the same decrypted token. If two runs race, the loser matches zero rows, rereads, and verifies the
winner's stored V3 value (`concurrent_rotation_verified`). If a row's plaintext presence changes in between, the
guard matches nothing and the run halts with `update_not_applied`. If the plaintext value changes, the post-write
check halts with `plaintext_copy_changed`.

### 3.5 What the script never does

These hold by construction, and tests assert them:

- It never writes or clears `access_token`, and never writes `status`, `transactions_cursor`, any other column, or
  any `plaid_link_attempts` row. The 3 `login_required` items and the 1 `credential_error` item keep their status.
- It never calls Plaid: `plaidService` is not imported. The V1 → V2 tool checked tokens with a live Plaid call
  because V1 had been exposed. Here the round trips prove the same bytes went back in, so no network check is
  needed, and no sync, token exchange or invalidation is triggered.
- It never logs or prints a token, ciphertext, nonce, tag, key bytes, the Supabase URL/host, or a raw error. Each
  log line is `{ts, id?, stage, outcome, counts?}`, built from fixed codes and aggregate numbers only.
- It never runs on import (`require.main === module`), and nothing the server's module graph imports reaches it.

### 3.6 Hosted Link tokens: drained, not rewritten

Re-encrypting `pending`/`claimed` link tokens would race the claim/exchange state machine to save at most 30
minutes. Once the active backend's current key is V3, every new link token is V3 and the V2 ones age out on their
own. The script therefore only counts them, by key and by expiry. `rotate` allows V2 link tokens.
`verify-retirement` fails while **any** link token, expired or not, still references V2 (see finding 4). Expired
leftovers clear through the app's existing purge, or simply by waiting until nothing V2 remains.

### 3.7 `verify-retirement`

This mode does not need V2 in its key ring, and is meant to be run both before and after V2 is removed. It checks:

- every row is on V3;
- every row decrypts with a **V3-only ring** (so a row labelled V3 but encrypted with V2 bytes fails);
- plaintext copies agree, and the plaintext-copy count matches;
- zero V2 link tokens remain;
- the whole-table check is re-run after the per-row pass, so a V2 row inserted during the pass is caught.

## 4. Operator runbook

Each step needs Trevor's explicit authorization when it happens.

Run the script **inside** the deployment whose environment holds both keys (for example a Render shell or one-off
job, or `railway ssh` into the Railway container). Never run it locally with production keys (precedent: §22,
"Execution environment"). A one-off job or shell does not route HTTP traffic to Render.

Arguments common to every command below:

```
COMMON="--expected-total 4 --expected-plaintext-copies 3 --expected-plaid-env sandbox \
  --expected-supabase-host <project-ref>.supabase.co --constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED"
```

0. **Before anything else:**
   - Review and merge this PR (a separate approval).
   - Run the §6 read-only queries and confirm the counts match §1 and both constraints exist.
   - Confirm Supabase backups / point-in-time recovery cover the window.
   - Find out *why* one item is `credential_error` while Render decrypts all four. If it predates this work it is
     unrelated, but write it down, so a new decryption failure after the switch is not mistaken for that old one.
1. **Generate the V3 key** offline (`randomBytes(32).toString('base64')`, the same as for V1/V2) and store a secure
   backup outside every platform **before** configuring it. Sealed or secret variables cannot be read back.
2. **Add `PLAID_TOKEN_KEY_RENDER_PROD_V3`** to Railway (active) and Render, leaving `PLAID_TOKEN_CURRENT_KEY_ID`
   unchanged (`RAILWAY_PROD_V2`). Redeploy both. Startup validation must pass. Nothing changes functionally yet.
3. **Flip `PLAID_TOKEN_CURRENT_KEY_ID=RENDER_PROD_V3`** on **every** backend that can write (Railway and Render) and
   redeploy. From now on new items and link tokens are written under V3, and V2 rows still read. If any writer is
   missed, it keeps creating V2 rows. The script's final check and `verify-retirement` both catch this
   (`total_changed`, `v2_rows_remaining`).
4. **Dry run:** `node dist/scripts/rotatePlaidTokenKeyV2ToV3.js --mode rotate --expected-remaining-v2 4 $COMMON`
   Expect 4 × `dry_run_verified` and `dry_run_complete`.
5. **Apply:** the same command plus `--apply --confirm ROTATE_PLAID_KEY_V2_TO_V3`. Expect 4 × `rotated` and
   `rotation_complete`.
6. **Re-run the §6 queries:** `v2_items = 0`, `v3_items = 4`, `plaintext_copies = 3`,
   `distinct_encrypted_nonces = 4`, every anomaly count 0.
7. **Soak** with both keys still configured. Watch the logs for `UnknownKeyIdError` or other `PlaidCredentialError`
   outcomes, and watch for status changes to `credential_error`. Any refresh or sync during the soak is Trevor's
   decision; this tooling triggers none.
8. **Wait at least 90 minutes after step 3** (30-minute link expiry plus the 1-hour purge threshold), then run
   `--mode verify-retirement $COMMON` and expect `v2_retirement_gate_passed`.
9. **Traffic cutover to Render:** a separate plan, outside this PR. Rotation does not depend on it, but every
   backend that is live at any point must have both keys until step 10.
10. **Retire V2** after the soak. Confirm the offline V2 backup exists, run `verify-retirement` again, then remove
    `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` from Render (and from Railway when it is decommissioned). Redeploy, then run
    `verify-retirement` once more inside the environment that no longer has V2.

## 5. Recovery

| Situation | What to do |
|---|---|
| Interrupted run (Ctrl+C, SIGTERM, lost shell) | The table is a valid mix of V2 and V3 rows, and both keys read it. Run the §6 query, dry-run again with `--expected-remaining-v2` set to the current V2 count, then apply. Rows already on V3 are reverified with zero writes. |
| `halted:db_error:write` (write outcome unknown) | Rerun the same way. The initial reread finds the real state: V3 → verified, V2 → rotated again. |
| `halted:<reason>` on a row | Rows before it are V3 and the rest are untouched V2, which is fully functional. **Never hand-edit token columns.** Diagnose the reason code (`v2_plaintext_mismatch`, `crypto_mismatch`, `partial`, …) and treat it as a separate, reviewed problem. |
| Preflight count mismatch | Stop. Something changed (a new link, a removal, a different database). Re-establish the facts read-only before attesting new counts. |
| Need to undo the key switch | While both keys are configured, flipping `PLAID_TOKEN_CURRENT_KEY_ID` back to `RAILWAY_PROD_V2` is safe: V3 rows keep reading. **Never remove the V3 key once any row or link token uses it.** |
| V2 removed too early (`UnknownKeyIdError`) | Re-add `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` from the offline backup and redeploy. No data changes are needed. Items marked `credential_error` meanwhile recover through the normal `synced` transition after a successful Plaid call. |
| V3 key lost after rotation | V3 rows become unreadable. The 3 rows with plaintext copies could be recovered only by a new, separately reviewed procedure. The encrypted-only item would need re-linking. This is why step 1's backup comes first. |
| Reverse data rotation (V3 → V2) | Not implemented, deliberately. No foreseen scenario needs it, because a mixed table is valid. It would need its own reviewed script. |

## 6. Read-only verification queries

These return counts only, never token values. Run them in the Supabase SQL editor.

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

## 7. Tests

**Script tests** (`rotatePlaidTokenKeyV2ToV3.test.ts`) use a fake Supabase that evaluates filters the way PostgREST
does. They cover:

- argument parsing: every refusal, canonical counts, the confirm token, and mode-specific flags;
- classification of every storage state;
- preflight: each count mismatch, the host guard (no read at all), Plaid env, each key-ring failure, each table
  anomaly, nonce reuse, truncated reads, and link-token keys;
- dry run: zero writes, and the table byte-for-byte unchanged;
- apply: exactly five columns written; guard filters as specified; plaintext, status, cursor and user unchanged;
  stored values decrypt with a V3-only ring; Plaid never called;
- idempotent rerun with zero writes;
- interruption right after a write (no write outcome logged), then resume with re-attested counts;
- a concurrent run having already rotated a row;
- plaintext vanished or changed between the read and the write;
- a corrupted stored value after the write, and a row labelled V3 that holds V2 bytes;
- a row deleted mid-run, a new V2 row inserted mid-run, and a failed write;
- no secrets in any log line;
- `verify-retirement`: passes with V2 absent from the ring; fails on a V2 row, on a V2 link token (expired too), on
  a plaintext mismatch, and on rows added or changed during the pass.

**Compat tests** (`tokenKeyRotationV3.compat.test.ts`) exercise the real `dataService` under the transition key
rings. They show that:

- V2 rows (with and without a plaintext copy) and V2 link tokens still read with both keys configured, whichever
  key is current;
- new inserts and Hosted Link stores are written under V3;
- a V3-only ring fails closed on V2 rows (even with a plaintext copy) and on expired, unpurged V2 link tokens.

**Mutation check:** each of 18 safety-relevant lines was removed or inverted one at a time and the script test file
re-run. 17 were caught. The one survivor is equivalent: post-write decryption with the full ring instead of the
V3-only ring makes no difference, because the stored key-id label already selects the V3 key and classification
requires that label to be V3. The V3-only ring is kept as defense in depth.

Results from the local run are recorded in the PR description.

## 8. Risks and open questions

- **Missed writer at step 3.** A backend still on current = V2 keeps creating V2 rows. This is detected (final
  check, `verify-retirement`), not prevented: the script cannot see the servers' configuration.
- **The key id name** `RENDER_PROD_V3` is a proposal (§3.1).
- **`credential_error` item.** Its cause is not established on this branch (§4 step 0). The rotation leaves its
  status alone. After the switch, only a successful Plaid call clears it.
- **Supabase API logs** record the update's filters (`id`, key id, version, plaintext presence), but no token
  material.
- **Not yet exercised against a real PostgREST/Postgres.** The tests use a faithful fake. A rehearsal against a
  scratch local Supabase stack (as for earlier packets) would add confidence before production.
- **Attested constraints.** The script trusts `--constraints-confirmed`. The operator must actually run the §6
  query first.
- **Item row deleted during a run** (a user removing an institution) halts the run with `row_missing`. Re-attest
  the counts and rerun.

## 9. Steps that require human authorization

Everything in §4 from step 0 onward. Specifically:

- merging this PR;
- generating and backing up the V3 key;
- adding it to Railway/Render;
- flipping `PLAID_TOKEN_CURRENT_KEY_ID` and redeploying;
- running the dry run and the apply in production;
- the traffic cutover;
- removing V2.

None of these were performed while preparing this branch.

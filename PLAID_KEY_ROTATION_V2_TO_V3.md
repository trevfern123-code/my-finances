# Plaid token key rotation: `RAILWAY_PROD_V2` → `RENDER_PROD_V3`

**Status: preparation only. Nothing here has been executed, deployed, or configured.** No production data, schema,
key, platform setting or Plaid setting was read or changed while preparing this branch. Every production step needs
its own explicit approval (§10).

Builds on `PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md` (the encryption design, §22's rotation addendum, §23's V1 → V2
record).

| Path | What it is |
|---|---|
| `backend/src/scripts/rotatePlaidTokenKeyV2ToV3.ts` (+ `.test.ts`) | The rotation CLI |
| `backend/src/scripts/updatePlaidItemWebhooks.ts` (+ `.test.ts`) | The existing-Item webhook migration CLI |
| `backend/ops/config-parity.sh` | The read-only configuration parity report |
| `backend/src/services/tokenKeyRotationV3.compat.test.ts` | Application compatibility tests |
| `supabase/tests/key_rotation_v3/` | The local PostgREST rehearsal and the runbook's SQL, as files |

**Revision history**

- **Revision 2** answered review 1: Hosted Link cleanup, platform decision, out-of-scope remediation, CI, merge
  gating, and the final recount.
- **Revision 3 (2026-10-23)** answers review 2, with **option B** (Render becomes the sole backend while on V2,
  then V3 on Render only) as the working plan:
  - repo-root commands, with an artifact and smoke check in the same shell (§4.0);
  - the parity matrix and report (§5.2);
  - the webhook migration plan and tool (§5.3);
  - per-stage rollback, including the point of no return (§5.4);
  - an explicit STOP/GO cutover gate (§4.2);
  - precise `finalRecheck` wording, plus a per-row fingerprint check (§3.2);
  - a local PostgREST rehearsal, now actually run (§8).
- **Revision 4 (2026-10-23)** answers review 3:
  - **Webhook tool, binding:** each decrypted credential is bound to its stored Plaid `item_id` before and after
    every change.
  - **Webhook tool, URLs:** rollback goes only to an exact, approved previous URL; this backend's own URL is
    required in both directions.
  - **Webhook tool, sources:** every Item's current webhook is classified before any change. Unexpected
    destinations stop the run, the number of Items without a webhook must be attested exactly, and those Items
    can be restored exactly on rollback.
  - **Webhook tool, postflight:** every Item is re-read at Plaid before the success line.
  - **Runbook:** counts are re-attested before every command, because the G2 test Item changes them (§4.0
    step 3), and the CORS check now sends the frontend's real headers (G1).

## 1. Starting state

Reported by Trevor and **not re-verified on this branch** (verifying it would mean reading production):

- Render is deployed and healthy, reaching Supabase with a new secret API key.
- Render decrypts all 4 Plaid Sandbox access tokens, and Plaid accepted all 4 under the new Sandbox secret.
- All 4 `plaid_items` rows reference `RAILWAY_PROD_V2`. 3 keep a plaintext copy; 1 is encrypted-only.
- Item statuses: 3 `login_required`, 1 `credential_error`.
- Railway is the active backend. Render serves no production traffic.

From review 2, the last confirmed Render variable inventory is: `FRONTEND_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, the V2 key and current-key id, and
`NODE_VERSION`. **It lacks `BACKEND_PUBLIC_URL` and an explicit `PLAID_PRODUCTS`**, which Railway sets. Render's
`rootDir` is the repository root.

## 2. Audit findings

1. **"V3" is a key id, not a format change.** The key ring is built only from the environment
   (`PLAID_TOKEN_KEY_<ID>`, `PLAID_TOKEN_CURRENT_KEY_ID`), and `ENC_VERSION` stays `1`. No application code or
   schema change is needed. V2 stays readable for as long as its key is configured.
2. **Plaintext copies are never a fallback.** `resolveAccessToken` never falls back to `access_token` once the
   encrypted columns exist. Removing V2 early breaks all 4 rows. A compat test pins this.
3. **No application path rewrites a stored access token.** Rows are only inserted. The rotation's update guard
   relies on this (§3.4).
4. **Hosted Link tokens share the key ring and are not purged on a timer.**
   `purge_expired_plaid_link_attempts(100)` runs only inside `create_plaid_link_attempt` and a successful claim.
   `readPlaidLinkAttempt` still decrypts expired, unpurged rows. So expired V2 rows block retirement until the §4.4
   cleanup removes them.
5. **`plaid_item_removals` stores no token.**
6. **Webhooks are addressed by URL, fixed at link time.** `plaidService` registers
   `${BACKEND_PUBLIC_URL}/api/webhooks/plaid` on each new link token, or **no webhook at all** if that variable is
   unset. Existing Items keep the URL they were created with, the Railway domain, until Plaid
   `/item/webhook/update` changes it (§5.3).
7. **CORS allows exactly one origin.** `app.ts` uses `cors({ origin: FRONTEND_URL })`. A Vercel preview
   deployment therefore cannot be used to test Render; the switch is tested with a read-only CORS preflight
   instead (§4.2, G1).
8. **The frontend API base is a build-time variable.** `VITE_API_BASE_URL` is compiled into the bundle, so
   switching it needs a Vercel rebuild, and rolling it back is a Vercel *Instant Rollback* to the previous
   production deployment.
9. **Existing scripts refuse to run once V3 is current:** `backfillTokenEncryption.ts` and
   `rotateTartanTokenKey.ts`.
10. **Constraints relied on.** `plaid_items_encrypted_token_complete`, `plaid_items_token_present`, and the
    `plaid_link_attempts` token/status check. The operator attests to them after running the §7 query.

## 3. Rotation CLI design

### 3.1 Modes

| Mode | Writes | Purpose |
|---|---|---|
| `--mode rotate` (dry run) | never | Full per-row verification, then the final recount |
| `--mode rotate --apply --confirm ROTATE_PLAID_KEY_V2_TO_V3` | only the five `access_token_*` encryption columns of V2 rows | The migration |
| `--mode verify-retirement` | never | The gate before V2 can be removed |

The key ids are fixed constants. `RENDER_PROD_V3` is a proposed name.

### 3.2 Per-row flow and final recount

**Rotate** goes through the rows in id order and halts on the first anomaly. For each row:

1. Reread it.
2. A V3 row is the resume path: it is verified with the V3-only key ring and nothing is written.
3. A V2 row is decrypted. If it has a plaintext copy, the copy must match the decrypted token.
4. The token is encrypted under V3 and round-tripped locally.
5. A dry run stops here for this row.
6. Apply only: the guarded update of the five encrypted columns.
7. Reread, and decrypt the **stored** value with a V3-only key ring.

**Verify-retirement** rereads each row and verifies it with the V3-only ring.

**Final recount.** `finalRecheck` runs in every mode before any success line. It reads the table again and requires
all of the following:

- the same set of row ids as at preflight;
- the attested total and plaintext-copy count;
- no anomalous rows, and distinct nonces;
- the V2/V3 split unchanged (dry run), or zero V2 rows and every row on V3 (apply, retirement);
- no growth in V2 link tokens (growth means some writer still encrypts under V2);
- no link token on an unknown key or version;
- for retirement, zero V2 link tokens;
- **every row byte-identical to the state the per-row pass verified.**

That last check (revision 3, review 2 finding 4) uses each row's SHA-256 fingerprint over the id, the plaintext copy
and the five encrypted columns. The fingerprint is taken when the row is verified and compared in memory at the
recount; it is never logged or stored.

Precisely, then: the recount detects any change to a row's plaintext copy, ciphertext, nonce, auth tag, key id or
version made after that row was verified, plus any insert, delete or replacement in the table. It does **not** cover
other `plaid_items` columns (status, cursor, institution), which this tool neither reads for decisions nor writes.
It also cannot see a change that happens after the recount itself has read the table.

### 3.3 Strict record counts

| Flag | Value today |
|---|---|
| `--expected-total` | 4 |
| `--expected-plaintext-copies` | 3 |
| `--expected-remaining-v2` (`rotate` only) | current V2 count |
| `--expected-plaid-env` | `sandbox` |
| `--expected-supabase-host` | `<project-ref>.supabase.co`, compared before any read and never logged |
| `--constraints-confirmed` | `PLAID_PHASE1_CONSTRAINTS_VERIFIED` |

Preflight also refuses on:

- a plaintext-only, partial, missing, unknown-key or unexpected-version row;
- nonce reuse;
- a truncated read;
- a link token on an unknown key or version;
- any key-ring problem (missing keys, V3 not current, identical V2/V3 bytes).

### 3.4 Concurrency and the update guard

The update matches the exact `id`, `access_token_key_id = RAILWAY_PROD_V2`, `access_token_enc_version = 1`, and
the plaintext copy's *presence* as read. It compares no ciphertext, nonce or plaintext value, because PostgREST
filters travel in the request URL.

| Race | Outcome |
|---|---|
| Two runs of this script on the same row | The second converges and verifies the first's stored value (`concurrent_rotation_verified`) |
| Plaintext presence changes in between | `update_not_applied` |
| Plaintext value changes in between | `plaintext_copy_changed` |

### 3.5 Never

- It never writes `access_token`, `status` or any other column.
- It never writes or deletes a link-attempt row.
- It never calls Plaid.
- It never logs a token, ciphertext, nonce, tag, key, URL or host. Log lines are `{ts, id?, stage, outcome,
  counts?}`.
- It never runs on import.

## 4. Operator runbook (option B)

**Every step needs Trevor's explicit approval when it is taken.** This runbook only describes the steps; none has
been done.

### 4.0 Running the tools on Render (command corrections, review 2 finding 1)

Render's service root is the **repository root**, so every command below starts from there and names the compiled
file by its full path. Never run a tool locally with production keys.

1. Open a Render Shell for the backend service and confirm the deployment:

   ```sh
   pwd                                      # the repository root of the deployed build
   sh backend/ops/config-parity.sh          # §5.2 report; its last lines must say "present:" for all three files
   ```

   If any `backend/dist/...` line says `MISSING`, stop. Render's build command must include
   `npm run build --workspace backend`, and the deployed commit must contain this branch's scripts (§4.1 step 4).
2. Run a smoke check in **the same shell**. It reads no table:

   ```sh
   node backend/dist/scripts/rotatePlaidTokenKeyV2ToV3.js --mode rotate --expected-total 4 \
     --expected-remaining-v2 4 --expected-plaintext-copies 3 --expected-plaid-env sandbox \
     --expected-supabase-host smoke-check.invalid --constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED
   ```

   Expect exit 1, with `failed:unexpected_supabase_host` and no `inventory` line. Before V3 exists, expect
   `failed:v3_key_missing` and `failed:v3_not_current` as well. This proves the compiled file runs, the
   environment and key ring load, and the host guard stops before any read.
3. **Attest the counts afresh before every rotation command (review 3).** Never reuse numbers from an earlier step.
   1. Run the §7 query immediately before the command.
   2. Take `N_TOTAL` = `total_items`, `N_V2` = `v2_items` and `N_PLAIN` = `plaintext_copies` from its output.
   3. Compare them with the only states this runbook allows. **If the query shows anything else, stop**: something
      outside the plan happened.

   | Situation | `N_TOTAL` | `N_V2` before the apply | `N_PLAIN` |
   |---|---|---|---|
   | No test Item linked (G2 criterion (c) satisfied by removing it first, see §5.3) | 4 | 4 | 3 |
   | One Sandbox test Item linked on Render during G2 and kept. It is created while Render is still on V2, so it is a V2 row with no plaintext copy | 5 | 5 | 3 |

   Then define:

   ```sh
   COMMON="--expected-total $N_TOTAL --expected-plaintext-copies $N_PLAIN --expected-plaid-env sandbox \
     --expected-supabase-host <project-ref>.supabase.co --constraints-confirmed PLAID_PHASE1_CONSTRAINTS_VERIFIED"
   ```

   `<project-ref>` comes from `SUPABASE_URL`. Use `--expected-remaining-v2 $N_V2` for `rotate`. The webhook tool's
   `--expected-total` and `--expected-no-webhook` come from the same fresh attestation and from its own dry run
   (§5.3).

   The equivalent npm form is `npm run rotate:plaid-key-v2-to-v3 --workspace backend -- <args>`. npm runs it from
   `backend/`, and the script path in `package.json` is relative to that directory.

### 4.1 Before anything else

1. **Record the option B approval** and its rollback scope (§5.1, §5.4) in this document.
2. **CI green:** every job must be green on the commit to be merged. Each of the three jobs has now passed at least once on this branch, but never all on the same commit: `database-harness` failed last on Docker Hub's limit (§8).
3. **Rehearsal:** re-run `supabase/tests/key_rotation_v3/rehearse.sh` (§8) on the exact commit to be merged.
4. **The merge is a deploy event and needs its own release approval.**
   - Railway auto-deploys `backend/**` (reported by review 1; set in Railway's dashboard, not `railway.json`).
     Vercel builds `main`. Render's deploy trigger is not recorded in this repo.
   - **Merge before the cutover.** The CLIs must already be in Render's build (§4.0), and while Railway is still
     primary its restart onto inert code is an ordinary deploy.
   - After Railway is stopped (G3), a later merge must not revive it. Disable Railway's auto-deploy, or delete its
     trigger, at that point (a Railway setting, separately approved).
5. **Read-only checks:**
   - the §7 queries (counts match §1, both constraints present);
   - Supabase backups or point-in-time recovery cover the window;
   - the cause of the existing `credential_error` item is identified.

### 4.2 Cutover to Render on V2 — STOP/GO gates (review 2 finding 3)

Each gate must pass before the next begins. A failure means **stop and roll back that stage (§5.4)**, never
improvise. Throughout this section **both backends run V2 only and no V3 key exists anywhere**, so every stage is
fully reversible.

- **G0 Parity.**
  - Run `config-parity.sh` in a Railway shell and a Render shell, and fill in the §5.2 matrix.
  - Close every gap on Render: at least `BACKEND_PUBLIC_URL` = Render's public origin, and `PLAID_PRODUCTS` =
    Railway's value. Redeploy Render and re-run the report.
  - Confirm with Trevor that the Plaid Dashboard allows the effective Hosted Link redirect URI. It is derived from
    `FRONTEND_URL`, which does not change.
  - **GO** when every "must match" row matches and every "differs by design" row is as expected.
- **G1 API switch readiness.** These checks are read-only and use no Vercel preview (finding 7 in §2):
  - `curl -s -o /dev/null -w '%{http_code}\n' https://<render-origin>/health` → `200`.
  - A CORS preflight with **the headers the real frontend sends** (`frontend/src/lib/api.ts`: `Authorization`,
    `X-Client-Api-Level`, `Content-Type`; manual-loan creates also send `Idempotency-Key`):

    ```sh
    curl -si -X OPTIONS https://<render-origin>/api/plaid/items -H 'Origin: <FRONTEND_URL>' \
      -H 'Access-Control-Request-Method: GET' \
      -H 'Access-Control-Request-Headers: authorization,x-client-api-level,content-type,idempotency-key'
    ```

    Expect a 2xx response. `access-control-allow-origin` must equal `FRONTEND_URL`, and
    `access-control-allow-headers` must list all four requested headers (`app.ts` allows `Content-Type`,
    `Authorization`, `Idempotency-Key` and `X-Client-Api-Level`).
  - An unauthenticated GET with the same `Origin` and an `X-Client-Api-Level` header:

    ```sh
    curl -si https://<render-origin>/api/plaid/items -H 'Origin: <FRONTEND_URL>' -H 'X-Client-Api-Level: <current level>'
    ```

    Expect it to be refused (no session), and the response to still carry `access-control-allow-origin` equal to
    `FRONTEND_URL` and `access-control-expose-headers` including `X-Api-Level` and `X-Min-Client-Api-Level`.
    Without those, the browser could not read the refusal. These checks are read-only and send no credential.
  - **GO**, then switch: set Vercel Production `VITE_API_BASE_URL` to Render's origin and redeploy. Note the
    previous production deployment's id; it is the rollback.
  - Signed-in smoke test: the dashboard loads and items list. **Railway keeps running** for a grace period, so
    stale tabs still work.
- **G2 Webhooks.** Run the §5.3 procedure. **GO** only when all three of its completion criteria hold.
- **G3 Railway stopped.**
  - Stop Railway serving: remove its deployment or scale it to zero, but **keep the service and its variables**
    for rollback.
  - Proof that Railway is no longer writing:
    1. its `/health` no longer returns 200;
    2. Railway shows no running deployment and no log lines after the stop time;
    3. the webhook tool's dry run still reports `on_target` = total and `to_update` = 0;
    4. two `--mode rotate` dry runs (with V3 still absent, both are refused at preflight by the key-ring checks,
       but each logs its `inventory` counts) taken some minutes apart show unchanged counts. Alternatively, run
       the §7 query twice.
  - If Supabase's API logs can be filtered by API key (Railway uses the legacy service-role key, Render the new
    secret key), confirm that the legacy key has no requests after the stop. This is optional: revoking the legacy
    key would be a separate credential change.
- **G4 Rollback drill. Required before any V3 step.**
  1. Exercise the G1 and G2 rollbacks once, with Railway restarted:
     - Vercel Instant Rollback to the Railway build;
     - the webhook rollback exactly as in §5.4, including `--restore-no-webhook-ids` when G2 moved Items that had
       no webhook.
  2. Confirm the app works on Railway again, and that a webhook-tool dry run shows every Item back on its
     pre-G2 state.
  3. Roll forward again, through G1–G3.

  The drill is what proves Railway rollback actually works while it is still possible.
- **STOP/GO for V3:** Trevor's explicit go-ahead, recorded here. **From step 3 of §4.3 onward (V3 current),
  Railway rollback is no longer possible** (§5.4, the point of no return).

### 4.3 V3 on Render only

1. Generate the V3 key offline (`randomBytes(32).toString('base64')`) and keep a secure backup outside every
   platform **before** configuring it.
2. Add `PLAID_TOKEN_KEY_RENDER_PROD_V3` to Render, keeping current = V2, and redeploy. Run §4.0 steps 1–2: the
   parity report must list key ids `RAILWAY_PROD_V2` and `RENDER_PROD_V3`.
3. Set `PLAID_TOKEN_CURRENT_KEY_ID=RENDER_PROD_V3` on Render and redeploy. New Items and link tokens are now V3.
   **Point of no return for Railway rollback.**
4. **Attest the counts afresh** (§4.0 step 3) and define `COMMON`. Then dry run:
   `node backend/dist/scripts/rotatePlaidTokenKeyV2ToV3.js --mode rotate --expected-remaining-v2 $N_V2 $COMMON`.
   Expect `$N_V2` × `dry_run_verified`, `final_check: passed`, `dry_run_complete`.
5. Apply: the same command, with the **same** attested numbers, plus
   `--apply --confirm ROTATE_PLAID_KEY_V2_TO_V3`. Expect `$N_V2` × `rotated`, `final_check: passed`,
   `rotation_complete`.

   If anything was linked or removed since step 4, preflight refuses the stale numbers. Re-attest from a fresh §7
   query and dry-run again; never edit the numbers to make a refusal go away.
6. Run the §7 queries. Expect `v2_items = 0`, `v3_items = $N_TOTAL`, `plaintext_copies = $N_PLAIN`,
   `distinct_encrypted_nonces = $N_TOTAL`, and every anomaly count 0. That is 4/3/4, or 5/3/5 with the kept test
   Item.
7. Soak with both keys on Render. Watch for `UnknownKeyIdError` / `PlaidCredentialError` outcomes and new
   `credential_error` statuses.

**No test Item may be linked between steps 4 and 6.** Every later `verify-retirement` uses the same fresh
attestation (`$N_TOTAL`, `$N_PLAIN`).

### 4.4 Hosted Link cleanup (separately approved, exact count, bounded)

At least 90 minutes after step 3 of §4.3, using the SQL files exactly as committed:

1. `supabase/tests/key_rotation_v3/link_token_count.sql` (read-only). If `v2_link_tokens = 0`, skip to step 3. If
   `not_yet_purgeable > 0`, wait and count again.
2. `link_token_cleanup.sql`, with `<purgeable from step 1>` replaced by the exact number. This is the one write,
   approved with that number. It is bounded to at most 100 rows, limited to V2-keyed `pending`/`claimed` rows that
   expired over an hour ago, and **any mismatch rolls the whole statement back**. It is a strict subset of the
   app's own purge and keeps finished-attempt history.
3. Recount: expect `0 0 0`.
4. Run `node backend/dist/scripts/rotatePlaidTokenKeyV2ToV3.js --mode verify-retirement $COMMON` and expect
   `v2_retirement_gate_passed`.

The rehearsal (§8) exercised every one of these outcomes.

### 4.5 Retire V2

After the soak:

1. Confirm the offline V2 backup exists.
2. Run `verify-retirement`.
3. Remove `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` from Render and redeploy.
4. Run `verify-retirement` again, with V3 alone in the ring.

Railway's own variables go when Railway is decommissioned, a separate decision.

## 5. Platform decision, parity, webhooks, rollback

### 5.1 Option A vs option B

| | A: V3 on Railway and Render | **B: Render sole writer first, V3 only on Render** (working plan) |
|---|---|---|
| V3 exposure | Railway and Render | Render only |
| Writers during the rotation | Two (missed-writer risk, detected but not prevented) | One |
| Prerequisite | none | the §4.2 cutover with webhooks and the frontend URL |
| Railway rollback | always available | only until step 3 of §4.3 (**material limitation**, §5.4) |
| CLI changes | none | none |

Trevor is leaning toward B. **The formal approval is still to be recorded (§4.1).**

### 5.2 Configuration parity matrix (review 2 finding 2)

`backend/ops/config-parity.sh` prints non-secret values, effective values after the backend's own defaults, the
webhook URL new Link tokens will register, secrets as `<set>`/`<unset>` only (never a value, length or hash), the
key-ring ids, the Node version, and whether the compiled CLIs are present.

Run it in both shells. **Railway values are to be read from that report, not copied from the dashboard.**

| Variable | Used by | Secret | Railway (fill in from the report) | Render (last known) | Rule before cutover |
|---|---|---|---|---|---|
| `FRONTEND_URL` | CORS origin; default Hosted Link redirect | no | | present | **must match** (the Vercel production origin, same trailing-slash form) |
| `BACKEND_PUBLIC_URL` | webhook on new Link tokens | no | set (Railway origin) | **missing** | **must be set on Render** to Render's public `https://` origin, no path or trailing slash. Differs by design |
| `PLAID_PRODUCTS` | Link products | no | set explicitly | **missing → default `transactions,auth`** | **must match** Railway's effective value exactly |
| `PLAID_COUNTRY_CODES` | Link country codes | no | | (default `US`) | effective values must match |
| `PLAID_HOSTED_LINK_COMPLETION_REDIRECT_URI` | Hosted Link redirect | no | | (derived from `FRONTEND_URL`) | effective values must match, and be allowed in the Plaid Dashboard |
| `PLAID_ENV` | Plaid base URL | no | `sandbox` | `sandbox` | must match |
| `SUPABASE_URL` | database | no | | present | must match (same project) |
| `PLAID_TOKEN_CURRENT_KEY_ID` | key ring | no | `RAILWAY_PROD_V2` | `RAILWAY_PROD_V2` | must match until §4.3 |
| key ids (`PLAID_TOKEN_KEY_*`) | key ring | ids no / values yes | `RAILWAY_PROD_V2` | `RAILWAY_PROD_V2` | same id set until §4.3. Value equality is already proven: Render decrypts all 4 rows |
| `SUPABASE_SERVICE_ROLE_KEY` | database | **yes** | `<set>` | `<set>` (new secret API key) | present. Differs by design |
| `PLAID_CLIENT_ID` | Plaid | **yes** (treated as one) | `<set>` | `<set>` | present. Sameness is already proven: Plaid accepted Render's calls with the existing access tokens, which are bound to their client |
| `PLAID_SECRET` | Plaid | **yes** | `<set>` | `<set>` (new Sandbox secret) | present. Differs by design |
| `NODE_VERSION` / `node` | runtime (`engines >= 22`) | no | | present | ≥ 22 on both |
| `PORT` | listener | no | platform | platform | platform-provided |
| health check | platform | — | `/health` (`railway.json`) | | Render's health check path must be `/health` |
| build command | platform | — | `npm install && npm run build --workspace backend` | | must build `backend` (the report's `present:` lines) |
| Vercel `VITE_API_BASE_URL` | frontend | no | → Railway origin | | switched at G1. `VITE_SUPABASE_*` unchanged |
| **Approved webhook URLs** (review 3) | webhook tool | no | **PREVIOUS** = the Railway report's `webhook registered on NEW Link tokens=` value, exactly | **OWN** = the Render report's same line, after G0 | Both must be canonical `https://<host>/api/webhooks/plaid` and must differ. Record both here, exactly. PREVIOUS becomes the tool's `--approved-previous-webhook-url`, and is the **only** destination a rollback may use |

### 5.3 Webhook migration plan

**New Items.** Once Render has `BACKEND_PUBLIC_URL` (G0), every link token Render creates registers
`https://<render-origin>/api/webhooks/plaid`. A Link started on Railway *before* G1 registers Railway's URL. That
is why step 2 below runs only after G1.

**Existing Items** are moved with `backend/dist/scripts/updatePlaidItemWebhooks.js` (Plaid `/item/webhook/update`),
run in the Render shell. Revision 4 tightened it as follows (review 3).

**Exactly two approved URLs exist**, both canonical `https://<host>/api/webhooks/plaid` (no credentials, query,
fragment or trailing slash):

- **OWN** is derived from this process's `BACKEND_PUBLIC_URL`. It is **required in both directions**: an unset value,
  or one that would not be canonical (for example a trailing slash), refuses the run.
- **PREVIOUS** is `--approved-previous-webhook-url`, the exact Railway value recorded in the §5.2 matrix. It must
  differ from OWN.

**Roles:**

- `--target-role this-backend` moves Items PREVIOUS → OWN.
- `--target-role other-backend` is the rollback, OWN → PREVIOUS.
- `--target-webhook-url` must restate the role's target exactly, so a typo'd or arbitrary host is refused in either
  direction.

**Phase 1: classify every Item, read-only, before anything changes.**

- The tool decrypts each token, with no plaintext fallback, and calls `/item/get`.
- **Identity binding.** The returned `item_id` must equal the row's stored `plaid_item_id`. A stale or
  misassociated credential can therefore never move some other Item's webhook.
- **Source classification.** Each current webhook must be the target, the other approved URL, or none.
- **Any third-party URL, any id mismatch, or a no-webhook count different from `--expected-no-webhook` halts the run
  with no update made.**
- Neither id, and no URL, is ever logged. The dry run logs each Item's class by internal row id (`source:none`,
  …).

**Phase 2: apply** (`--apply --confirm UPDATE_PLAID_ITEM_WEBHOOKS`).

- For each Item that still needs it, the tool calls `/item/webhook/update`.
- Each update is followed by a fresh `/item/get` that re-checks both the `item_id` and the webhook.
- The run halts on the first refusal, logging only Plaid's documented error code. Interrupt checkpoints sit
  between every call.

**Phase 3: postflight at Plaid.**

- Every Item is re-read again, with the id re-checked, after the last update.
- Each must still have its expected final webhook, and the database Item set must be unchanged.
- Only then is `webhooks_on_target` logged. An earlier Item that changed while a later one was updated fails here
  (`webhook_changed_after_update`).

**It never writes the database.**

**Items with no webhook.**

- **Forward move:** they are updated to OWN only when their number equals `--expected-no-webhook`, which is 0 unless
  the dry run showed otherwise. **Record their internal row ids** from the dry run's `source:none` lines in this
  document.
- **Rollback:** passing those ids as `--restore-no-webhook-ids` restores exactly those Items to "no webhook" (Plaid
  documents `webhook: null` as removal). Without the list they move to PREVIOUS like every other Item on OWN. A
  listed id that is on PREVIOUS, or that is unknown, is refused. Re-running a completed rollback is a no-op.

**Procedure (G2).** Use counts from a fresh attestation (§4.0 step 3), so `N_TOTAL` is 4 at this point.

1. **Dry run:**
   `node backend/dist/scripts/updatePlaidItemWebhooks.js --target-role this-backend --target-webhook-url <OWN> --approved-previous-webhook-url <PREVIOUS> --expected-total 4 --expected-no-webhook 0 --expected-plaid-env sandbox --expected-supabase-host <project-ref>.supabase.co`.
   Expect `classify: passed` with `on_source` = 4 and `to_update` = 4.

   If the dry run halts with `unexpected_no_webhook_count`:
   - Read `counts.none` and the `source:none` ids.
   - Record them.
   - Re-run with `--expected-no-webhook <that number>`, but only after Trevor approves moving those Items as well.
2. **Apply:** the same command plus `--apply --confirm UPDATE_PLAID_ITEM_WEBHOOKS`. Expect `updated` = 4,
   `postflight: passed`, then `webhooks_on_target`.
3. **Standalone check, immediately after** (still the same arguments, without `--apply`). Expect `on_target` = 4,
   `to_update` = 0.

**Completion criteria. Do not call the webhook migration complete until all three hold:**

- **(a)** Step 2 reached `webhooks_on_target`, and step 3, run immediately afterwards, reports `on_target` = total.
- **(b)** Render's logs show a verified Plaid webhook delivery for the moved Items. Plaid sends
  `WEBHOOK_UPDATE_ACKNOWLEDGED` to the new URL, which the handler accepts and ignores. If none arrives, use a
  separately approved Sandbox test webhook (the app's `sandbox-fire-webhook` route). It can start a Sandbox
  transaction sync, so it needs its own approval.
- **(c)** A **new** Item linked on Render (a separately approved Sandbox test link) is `on_target` in a further dry
  run, re-attested with `--expected-total 5`. **Then choose one, and record it:**
  - **Keep the test Item.** Every later count is then the 5/5/3 row of §4.0 step 3. The test Item is a V2 row with
    no plaintext copy, because Render is still on V2 at G2.
  - **Remove it** through the app's normal institution-removal flow, which calls Plaid `/item/remove` and deletes
    its data. This is separately approved. Every later count is then 4/4/3.

  Either way, the next command re-attests from a fresh §7 query. Nothing proceeds on stale numbers.

  A Hosted Link attempt for the test link that was abandoned before completion leaves a V2 link token. §4.4 counts
  and cleans it up like any other.

This is a Plaid-side change. Like everything here it was not executed.

### 5.4 Rollback procedure, per stage

| Stage | Roll back by | Railway rollback possible? |
|---|---|---|
| G0 Render variables | Revert the variables and redeploy (Render serves no traffic yet) | yes |
| Merge / deploy (inert CLIs) | Revert the merge commit, or redeploy the previous deployment on each platform | yes |
| G1 Vercel switched | Vercel **Instant Rollback** to the noted previous production deployment (built with Railway's URL); no rebuild | yes |
| G2 webhooks moved | On Render: `node backend/dist/scripts/updatePlaidItemWebhooks.js --target-role other-backend --target-webhook-url <PREVIOUS> --approved-previous-webhook-url <PREVIOUS> --expected-total $N_TOTAL --expected-no-webhook <freshly attested> [--restore-no-webhook-ids <ids recorded at G2>] … --apply --confirm UPDATE_PLAID_ITEM_WEBHOOKS`. `<PREVIOUS>` is exactly the §5.2 value, and no other destination is accepted. Then run a dry run, which should show every Item `on_target` (PREVIOUS), or none for the restored ids | yes |
| G3 Railway stopped | Redeploy Railway's last deployment (variables untouched), check `/health`, then roll back G2 and G1 | yes |
| §4.3 step 2: V3 key on Render, still not current | Remove the variable and redeploy; nothing has used V3 | yes |
| **§4.3 step 3: V3 current on Render** | Set `PLAID_TOKEN_CURRENT_KEY_ID` back to `RAILWAY_PROD_V2` **on Render**, keeping both keys. V3 rows keep reading | **no.** Any V3 row (a new Item, a new link token, a rotated row) is unreadable on Railway, which has only V2 |
| §4.3 steps 4–7: rotated | No data rollback is needed: a mixed or fully V3 table is valid while both keys stay on Render. **Never remove the V3 key** | no |
| §4.4–4.5: cleanup, V2 retired | Re-add V2 from the offline backup if needed. Deleted link attempts were dead | no |

**Material limitation:** after §4.3 step 3, returning to Railway would mean putting V3 on Railway, which option B
exists to avoid, or a reverse V3 → V2 rotation, which is not implemented. G4's drill is the last point at which
Railway rollback is proven.

## 6. What this rotation does NOT remediate

Re-encryption changes only which key protects the stored ciphertext. **The four Plaid access tokens stay valid at
Plaid, and the three plaintext copies stay in the database.** Moving webhooks doesn't change either.

The incident is **not fully remediated** until two further packets are designed, approved and applied:

1. **Access-token rotation via `/item/access_token/invalidate`.** It must:
   - run one Item at a time, recording a durable intent first;
   - store the replacement token in the same flow;
   - never retry an unknown outcome;
   - handle the stale plaintext copy explicitly;
   - check how `login_required` and `credential_error` Items behave.
2. **Plaintext retirement:** clearing `access_token` on the three legacy rows. Afterwards, run
   `verify-retirement --expected-plaintext-copies 0`.

Neither is started.

## 7. Read-only verification queries

These are in `supabase/tests/key_rotation_v3/integrity.sql`, the same file the rehearsal runs. They return counts
only.

1. **`plaid_items`:**
   - totals by key id: V2, V3, unexpected;
   - plaintext copies, non-encrypted rows, partial and unexpected-version rows;
   - distinct nonces.
2. **`plaid_link_attempts`:** counts per key id, with the number unexpired.
3. **The two constraint names.**

## 8. Tests, rehearsal and CI

**Unit tests:**

| File | Tests | Covers |
|---|---|---|
| `rotatePlaidTokenKeyV2ToV3.test.ts` | 75 | Everything in §3, including the final recount. Revision 3 adds 5 fingerprint cases: a V2 ciphertext replaced by another valid V2 encryption, a changed plaintext value and a swapped nonce in a dry run, a rotated row changed after its post-write verification, and a row re-encrypted after `verify-retirement` checked it |
| `updatePlaidItemWebhooks.test.ts` | 31 | URL canonicalisation and every argument refusal. Preflight: own URL missing or non-canonical refuses both directions; a rollback-host typo; a forward target that is not this backend; previous = own; host guard (no read, no Plaid); count and `removing` refusals. *(Revision 4)* Classification runs before any change: a credential answering for a different Item halts with **zero updates**, as does an unexpected third-party source (both directions) or an unattested no-webhook Item. The postflight catches an earlier Item changed during a later update, and an Item id changed after the updates. Exact restore-to-none rollback, and its idempotent rerun; a rollback without the list; restore ids on PREVIOUS or unknown refused. Interruption; halt on a Plaid refusal (error code only); unapplied update; no plaintext fallback; Item linked mid-run; no token, item id, URL or host in any log |
| `tokenKeyRotationV3.compat.test.ts` | 12 | The real `dataService` under the transition key rings |

**Mutation check.** Safety-relevant lines were removed or inverted one at a time, and the tool's tests re-run each
time.

- **Rotation CLI:** 23 of 24 caught, including dropping the fingerprint check and leaving the plaintext copy out of
  the fingerprint. The survivor is equivalent: the V3-only ring vs. the full ring when verifying.
- **Webhook CLI** *(revision 4)*: 24 of 24 caught. These included:
  - dropping the item-id binding, the exact-target check, the own-URL requirement or its canonicalisation, the
    previous = own check, the unexpected-source halt, the no-webhook count, the restore-state or restore-id checks,
    the postflight (removed, or made to ignore changes) or the per-update verify;
  - interleaving updates into the classification phase;
  - letting a dry run write;
  - accepting a non-canonical URL;
  - falling back to plaintext;
  - dropping the post-update interrupt checkpoint;
  - logging Plaid's raw message.

**Parity report:** run with a Render-like fake environment (the review's gaps). It reported
`BACKEND_PUBLIC_URL=<unset>`, the "no webhook" line and `PLAID_PRODUCTS` falling back to `transactions,auth`. None
of the fake secret values appeared in its output.

**Local PostgREST rehearsal** (`supabase/tests/key_rotation_v3/rehearse.sh`, review 2's "staging rehearsal"):
**30/30 checks passed** on commit `531725a`, and again on `7b90d35` (revision 4).

- **Stack:** a scratch local Supabase stack from CLI 2.117.0 (Postgres 17.6.1.155, PostgREST v16.2, Kong 2.8.1,
  GoTrue v2.196.0) with all 17 checkout migrations applied.
- **Code under test:** the backend compiled from the checkout, run from an empty working directory.
- **Data and keys:** throwaway keys and fake tokens in the production shape (4 V2 items, 3 plaintext copies,
  3 `login_required` and 1 `credential_error`) plus 3 link attempts.

| Area | What was checked |
|---|---|
| Preflight on real PostgREST | A wrong Supabase host is refused with no inventory read. A wrong `--expected-total` is refused against the real exact `count`. A key ring with V2 current is refused |
| Dry run | Exit 0, 4 × `dry_run_verified`, `final_check: passed`. The full-table digest is unchanged |
| Apply | 4 × `rotated`, every row on `RENDER_PROD_V3`, 4 distinct nonces. A digest of every non-encryption column (plaintext, status, cursor, user, timestamps) is unchanged. The encrypted-only row is still without plaintext, which exercised the real `is null` guard |
| Idempotent rerun | 4 × `already_v3_verified`, with row versions (`xmin`) unchanged |
| Resume from an interrupted state | With A and B on V3 and C and D back on V2, a stale `--expected-remaining-v2 4` is refused; with `2`, A and B are already verified, C and D are rotated, and the non-encryption digest is still unchanged |
| Retirement gate | Refused at preflight while V2 link tokens exist |
| §4.4 cleanup, using the committed SQL files | Count `2 1 1`. Cleanup is refused while a token is newer than the threshold. After the token is aged, the count is `2 2 0`; a wrong expected count rolls back, and `0` is refused as out of bounds. The exact count deletes exactly 2 rows and keeps the tokenless history row. The recount is `0 0 0` |
| Retirement gate after cleanup | `verify-retirement` with **only the V3 key configured** passes, and writes nothing |
| Missed writer | A V2 item written after the rotation is refused by the gate, and then picked up by a re-attested dry run |
| Secrets | No throwaway key, local service key or fixture token appears in any CLI output |
| Teardown | The stack is removed; 0 containers remain |

Run it with `REHEARSAL_SCRATCH=<empty dir> bash supabase/tests/key_rotation_v3/rehearse.sh` (Git Bash on Windows,
Docker running, the pinned CLI at `SUPABASE_CLI`).

The webhook CLI is not part of the rehearsal, because it needs Plaid. It is covered by its unit tests only.

**CI:**

| Run | Head | `build-and-test` | `database-harness` | `migration-replay` |
|---|---|---|---|---|
| `40002500366` | `a4705ca` | pass | fail | fail |
| `40004715483` | `f83ff04` | pass | **pass** | fail (Docker Hub `toomanyrequests` before any migration ran) |
| `40008522706` | `5488c2b` | pass | fail (Docker Hub `toomanyrequests` during image pull) | **pass** |

No run has had all three green yet. The red job each time was an image pull refused by Docker Hub, not a test failure. A run with all three green on the commit to be merged is still required (§4.1).

## 9. Risks and open questions

- **Option B approval** is still to be recorded, and the cutover (§4.2) is a substantial operation in its own
  right.
- **Loss of Railway rollback after §4.3 step 3** (material limitation, §5.4).
- **Webhook migration** depends on Plaid accepting `/item/webhook/update` for `login_required` and
  `credential_error` Items. If Plaid refuses, the tool halts with the error code, and those Items need a decision.
- **Old access tokens stay valid, and plaintext copies remain (§6).**
- **`credential_error` item:** its cause is not yet established.
- **CI:** there is no single all-green run yet (registry limit; §8).
- **Supabase API logs** record the rotation's update filters (`id`, key id, version, plaintext presence), but no
  token material.
- **The key id** `RENDER_PROD_V3` is a proposal.

## 10. Steps that require human authorization (none performed)

1. Recording option B and its rollback scope.
2. CI green and the rehearsal re-run on the merge commit.
3. The release approval to merge (a deploy event on Railway and Vercel, and possibly Render).
4. G0: Render variable changes.
5. G1: the Vercel production variable change and redeploy.
6. G2: the webhook moves, the optional Sandbox test webhook, and the Sandbox test link.
7. G3: stopping Railway, and disabling its auto-deploy.
8. G4: the rollback drill.
9. The V3 go-ahead.
10. Generating and backing up the V3 key.
11. Adding it to Render, and making it current.
12. The rotation dry run and apply.
13. The §4.4 cleanup, approved with its exact count.
14. `verify-retirement`.
15. Removing V2.
16. The §6 packets.

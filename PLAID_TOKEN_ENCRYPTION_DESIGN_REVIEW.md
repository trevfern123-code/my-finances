# Plaid Access-Token Encryption — Design Review

**Status**: design review only. No code, schema, or migration-history changes were made while producing this document.
**Scope of investigation**: the actual repository at `C:\Users\Trevor\OneDrive\Documents\My finances`, as it exists today. Every factual claim about the codebase below was checked by reading the real source file, not recalled from memory. Where I could not verify something against the repo (primarily: what Railway's dashboard currently offers for this specific project), I say so explicitly rather than assume.

---

## 0. Overall assessment

The proposed design is sound and unusually thorough — AES-256-GCM with a fresh 12-byte nonce per operation, AAD binding ciphertext to its row, a versioned logical key ring, and a strict expand→migrate→contract rollout with fail-closed error handling are all the right calls, and match how this kind of migration should be done in a production system. I have no disagreements with the cryptographic primitives or the phase structure.

Where this review adds value beyond the proposal is mostly in **how much simpler this specific application's Plaid-token lifecycle is than the proposal assumes**, which changes some of the migration mechanics (in the "less work, not more" direction), and in a few concrete, previously-undocumented risks I found by reading the actual code:

1. **Plaid access tokens in this app are write-once, read-many.** There is exactly one place that ever writes a new `access_token` (`insertPlaidItem`, called only from the public-token exchange at initial Link). Plaid's own Update Mode/reconnect flow — already implemented in this app — does **not** issue a new token (confirmed by an existing code comment). Nothing in the codebase ever `UPDATE`s `plaid_items.access_token`. This means the proposal's concern about "dual-write" and "stale overwrite races" mostly doesn't apply the way it would in a system that frequently rotates or replaces credentials — see §6.2 for what this actually simplifies.
2. **The generic error handler currently returns raw `Error.message` text straight to the frontend as JSON** (`res.status(500).json({ error: message })`, verified in `middleware/errorHandler.ts`). This is a real, pre-existing fact independent of encryption, but it means any new error class's `.message` must be a hand-picked, deliberately generic string by construction — there is no other sanitization layer to catch a mistake.
3. **The webhook path is fire-and-forget relative to the HTTP request.** `handlePlaidWebhook` sends its 200 response *before* `processWebhook()` (which reads `access_token` and calls Plaid) runs, catching failures only into `console.error`. Any decryption failure here is invisible to any human unless someone is watching logs — this needs its own explicit design decision (§7.4), not just "webhooks must be encryption-aware."
4. **`isReauthRequiredError` already inspects `err.response.data.error_code`, including `'INVALID_ACCESS_TOKEN'`**, to decide whether an item should be flagged `login_required`. A thrown decryption error will not accidentally match this shape (a plain `Error` has no `.response.data.error_code`), so today's code is *accidentally* safe from this specific collision — but any new custom error class must be built carefully so it stays that way, not by accident.
5. **Zero existing automated tests touch any Plaid-item persistence function** (`insertPlaidItem`, `getPlaidItemsForUser`, `getPlaidItemForUser`, `getPlaidItemByPlaidItemId` — confirmed via search of `dataService.test.ts`). This is the single best opportunity in this whole project to add real coverage for exactly the code this migration touches most, and I've scoped tests accordingly.
6. **"Investments" is a red herring as its own Plaid API call path.** `PLAID_PRODUCTS` includes `investments` (verified in `.env.example`), but no code anywhere calls `investmentsHoldingsGet`/`investmentsTransactionsGet`. Investment *account balances* surface only through the ordinary `accountsGet` call already covered by the general "balance refresh" path. There is no separate investments code path that needs its own encryption-awareness verification step.
7. **I cannot verify Railway's currently-available secret-management features for this specific project** — I have no access to the Railway dashboard, and the repository contains no Railway API tokens or exported project configuration I could inspect. §5.4 states plainly what I know generally about Railway's platform and what Trevor needs to confirm himself before this design is finalized.

None of the above changes the recommended cryptography or the phase-based migration philosophy. They do change some mechanics (§6), and they surface three risks (§7, §9) the original proposal didn't have visibility into because they require reading this specific codebase, not general Plaid-integration knowledge.

---

## 0.1 Addendum (2026-08-26) — four points resolved after independent review

Trevor reviewed this document with an independent reviewer and asked for four specific details to be resolved before implementation. All four are now resolved; the sections below have been rewritten in place to reflect the final recommendation (not left as a separate patch note), and this addendum summarizes what changed and why.

**1. The Phase 1/Phase 2 `NOT NULL` contradiction (was real, now fixed).** The original document was self-contradictory exactly as Trevor identified: it said `access_token` stays `NOT NULL` through Phase 4 while also describing encrypted-only writes with plaintext left null starting in Phase 2. **Resolved**: Phase 1 now drops the `NOT NULL` constraint (a safe, additive, fully-reversible schema change on its own). Phase 2 is now split into **2a** (brief, explicitly time-boxed dual-write, kept only for the initial verification window) and **2b** (encrypted-only writes, once 2a is confirmed stable) — closest to the proposal's first option, but scoped to the verification window rather than the whole migration, which avoids writing plaintext for the entire multi-day/week backfill period. The rollback guarantee is now stated explicitly and is asymmetric: fully safe up through 2a; **not** safe to roll back to pre-encryption code once 2b has produced even one row, without breaking that specific item. See the rewritten §6.2 and §7 Phase 2.
**2. `bytea` via Supabase JS — verified, and the assumption was wrong.** I checked this repo's exact installed `@supabase/postgrest-js` (v2.112.3) source directly: its request body is built with `JSON.stringify(this.body, ...)` with no special handling for `Buffer`/`Uint8Array`. A local (no-network, no-database) check confirms a raw Node `Buffer` serializes via `JSON.stringify` as `{"type":"Buffer","data":[...]}` — not a valid `bytea` literal. Rather than switch to relying on Postgres's `\x`-hex `bytea` text representation (which would still be an *assumption* about this specific instance's `bytea_output` behavior through PostgREST, exactly what Trevor asked me not to do), **the encrypted fields are now `text` columns holding explicit, application-controlled Base64** — zero reliance on implicit DB-layer type coercion, verified losslessly round-tripping with plain Node `Buffer` methods. See the rewritten §2, §3, §5.1–5.2.
**3. Phase 4 verification corrected.** Plaid never returns an access token back for comparison — my original "verify by comparing against a value fetched from Plaid" language was imprecise in exactly the way Trevor caught. Verification is now explicitly three steps per row: decrypt → compare the decrypted string against the still-present plaintext column (both values held only in memory, a boolean match result is all that's ever logged) → independently call `itemGet` (Plaid's cheapest, side-effect-free item-metadata endpoint, already wrapped by this codebase's existing `getItemInstitution` helper) using the decrypted token, to confirm it's still a live, Plaid-accepted credential, not just byte-identical to what was stored. See the rewritten §7 Phase 4 and §16.
**4. Railway Sealed Variables.** Per Trevor's own independent confirmation against Railway's current documentation, Sealed Variables exist and are the preferred mechanism for `PLAID_TOKEN_KEY_*`/`PLAID_TOKEN_CURRENT_KEY_ID` in staging and production, if available in the actual project dashboard (still Trevor's to confirm, per-project — I still cannot check this myself). See the rewritten §5.4, which also adds an operational consequence worth flagging: because a sealed variable can never be viewed again once set, Trevor must independently retain a secure backup of each key's value *before* sealing it in Railway — Railway itself will refuse to ever show it again, which is precisely the point of the feature, but it means Railway is no longer a fallback copy for §12's "missing/unknown key" recovery scenario.

**Nothing else in the design changed.** The cryptographic primitives (§5.1–5.2's actual `crypto` calls), the AAD format (§4), the versioned key ring concept (§6), Phases 3 and 5–7, the error classification (§9), user-facing behavior (§10), logging rules (§11), and key rotation (§13) are all unaffected by these four resolutions and stand as originally reviewed.

---

## 1. Every code path that currently accesses Plaid tokens (verified)

### 1.1 Where a token is created
- **`backend/src/controllers/plaidController.ts`, `exchangePublicToken`** (Plaid Link's public-token exchange) is the **only** place a new `access_token` comes into existence. It calls `plaidService.exchangePublicToken(publicToken)` → Plaid returns `{ access_token, item_id }` → `dataService.insertPlaidItem({ ..., accessToken, ... })` writes it. This is a one-time event per linked institution.

### 1.2 Where a token is stored
- **`backend/src/services/dataService.ts`, `insertPlaidItem`** — the sole `INSERT` into `plaid_items.access_token`. There is **no** `UPDATE` of this column anywhere in the codebase (confirmed by a full-repo search).
- **Schema** (verified against the real, `supabase db pull`-sourced migration `supabase/migrations/20260825195130_remote_schema.sql`): `plaid_items.access_token` is `text not null`. RLS is enabled on the table but has **no policy** — access is gated entirely by the backend's exclusive use of the Supabase service-role key (RLS-bypassing), not by RLS itself.

### 1.3 Every place a token is read
All four read functions live in `dataService.ts`, all `SELECT ... access_token ... FROM plaid_items`:
- `getPlaidItemsForUser(userId)` — returns all items for a user, used by manual "refresh accounts" and manual "sync transactions."
- `getPlaidItemForUser(itemId, userId)` — a single, ownership-checked item, used by reauth-link-token creation, sandbox reset-login, sandbox fire-webhook, and reauth completion.
- `getPlaidItemByPlaidItemId(plaidItemId)` — looked up by *Plaid's* item id (not our row id), used **only** by the webhook receiver, which has no authenticated user context to check ownership against.
- (`insertPlaidItem`'s own `.select().single()` return also carries it back, but that return value is only used to read `.id`/`.institution_id`/`.institution_name` in the caller — the token itself isn't re-read from that response.)

### 1.4 Every Plaid API call that depends on a token — all in `backend/src/services/plaidService.ts` (one thin wrapper module, verified in full)
| Function | Plaid endpoint | Called from |
|---|---|---|
| `getItemInstitution` | `itemGet` + `institutionsGetById` | `exchangePublicToken` (initial link only) |
| `createReauthLinkToken` | `linkTokenCreate` (Update Mode) | `createReauthLinkToken` controller |
| `updateItemWebhook` | `itemWebhookUpdate` | `refreshAccounts` (best-effort backfill) |
| `sandboxResetLogin` | `sandboxItemResetLogin` | `sandboxResetLogin` controller, sandbox-only |
| `sandboxFireWebhook` | `sandboxItemFireWebhook` | `sandboxFireWebhook` controller, sandbox-only |
| `getAccounts` | `accountsGet` | `exchangePublicToken`, `refreshAccounts`, `completeReauth` |
| `syncTransactions` | `transactionsSync` (paginated loop) | `syncService.syncItemTransactions` — the one function shared by the manual-sync endpoint **and** the webhook receiver |
| `getLiabilities` | `liabilitiesGet` | `loans.refreshLoansForItem`, called from `exchangePublicToken` and `refreshAccounts` |
| `getRecurringStreams` | `transactionsRecurringGet` | `syncService.syncItemTransactions` (same shared function as above) |

There is **no** dedicated Investments-product call anywhere (`investmentsHoldingsGet`/`investmentsTransactionsGet` do not appear in the codebase) — investment account balances come through the same `getAccounts` call as every other account type.

### 1.5 Plaid Link / public-token exchange
Covered above (§1.1). One HTTP round trip, synchronous within a single Express request — no async/detached path here.

### 1.6 Transaction sync (manual)
`POST` → `plaidController.syncTransactions` → loops `dataService.getPlaidItemsForUser(userId)` → `syncService.syncItemTransactions(item)` per item, synchronous within the request.

### 1.7 Balance/account refresh
`plaidController.refreshAccounts` → same item loop → `plaidService.getAccounts(item.access_token)`, `plaidService.updateItemWebhook(item.access_token)` (best-effort), `refreshLoansForItem(item.id, item.access_token, ...)` (best-effort) — all synchronous within the request, each item's failure independently caught (a re-auth-required error on one item doesn't fail the whole refresh; any *other* thrown error, including a would-be decryption error, currently propagates and fails the whole request — see §7).

### 1.8 Liabilities / investments / recurring requests
Liabilities: `refreshLoansForItem`, called at link time and at every manual refresh, wrapped in its own try/catch that only logs on failure (never throws to the caller). Recurring: inside `syncItemTransactions`, also wrapped in its own try/catch, log-only on failure. Investments: no dedicated call exists (§1.4).

### 1.9 Webhook-triggered synchronization
`routes/webhooks.ts` → `webhookController.handlePlaidWebhook` → verifies the Plaid JWT signature over the raw body (`services/webhookVerification.ts`, using `jose`) → **responds `200` immediately** → `processWebhook(payload)` runs afterward, uncaught rejections routed only to `console.error`. `processWebhook` calls `dataService.getPlaidItemByPlaidItemId` then `syncService.syncItemTransactions(item)`. **This is the one path in the whole app where a credential failure has no HTTP response to carry it and no authenticated request context to attribute it to** — it must be designed for explicitly (§7.4), not assumed to behave like the request-synchronous paths.

### 1.10 Reconnect/update mode
`createReauthLinkToken` controller passes the *existing* `access_token` into `plaidService.createReauthLinkToken` (Plaid's Link `Update Mode`). `completeReauth` re-validates the existing token by calling `getAccounts` with it and only then clears `login_required`. **Plaid does not issue a new token in this flow** (verified by an existing code comment: "Update Mode doesn't issue a new access token"). Reconnect in this app is entirely a "prove the existing stored token works again" flow, never a "replace the stored token" flow.

### 1.11 Sandbox/test helpers
`sandboxResetLogin` and `sandboxFireWebhook` controllers, both gated behind `env.plaidEnv === 'sandbox'` (404 otherwise), both read a single item via `getPlaidItemForUser` and pass its token straight to the corresponding sandbox-only Plaid endpoint. No special encryption consideration beyond "these are two more read call sites."

### 1.12 Existing tests
- `syncService.test.ts` mocks `plaidService`/`dataService`/`loans` entirely and constructs a plain literal `{ id, user_id, access_token: 'access-token-1', transactions_cursor }` object — it never touches real encryption/decryption and would be unaffected by wrapping/unwrapping happening one layer below, in `dataService.ts`, **provided the encryption boundary is placed exactly there** (see §6.1 — this is the architectural recommendation this review adds).
- `dataService.test.ts` has **zero** tests for any Plaid-item function today (verified by search) — there is nothing to break, and everything to gain.
- No controller-level tests exist for any Plaid controller function (confirmed: no test file exists under `controllers/`).

### 1.13 Environment-variable loading/validation
`backend/src/config/env.ts`: a `required(name)` helper throws at import time if a named env var is missing, used for `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `FRONTEND_URL`. This is the exact existing pattern the new encryption-key config should extend — a new `requiredEncryptionKeys()`-style check that throws before the server starts listening, not a check that happens lazily on first use.

### 1.14 Railway deployment assumptions
`railway.json` (verified): Nixpacks builder, `npm run start --workspace backend` → `node dist/index.js`, healthcheck at `/health`, **`restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 10`**. This matters directly for the "fail startup on bad key config" requirement: if the encryption key env var is ever missing/malformed in production, the app will crash on boot, Railway will restart it up to 10 times (each restart re-throwing the same startup error), and then stop — this is the *correct* failure mode for a misconfigured secret (loud and bounded, not silent), but it does mean a bad deploy could flap 10 times before anyone's paged, which is worth knowing going in.

### 1.15 Supabase schema/migrations
Covered throughout. The authoritative baseline is `supabase/migrations/20260825195130_remote_schema.sql` (a real `supabase db pull`, not hand-written). This project's established, working process — verified by 7 subsequent migrations applied the same way — is: write a migration file, hand the exact SQL to Trevor, he pastes it into Supabase directly, only then does schema-dependent code get exercised. `supabase db push` is explicitly **not** used yet, because the remote migration-history bookkeeping table was never reconciled after the initial baseline pull (a known, previously-flagged, deliberately-untouched gap — see §15 for whether this encryption work should be the trigger to fix that).

### 1.16 Logging/error handling
- `index.ts` uses `morgan('dev')` (method/URL/status/response-time only — does not log request/response bodies or the `Authorization` header by default) plus two process-level handlers that `console.error` on unhandled rejections/exceptions (the process also `exit(1)`s on uncaught exceptions).
- `middleware/errorHandler.ts` is the single most important finding for the "logging and redaction" section: **it takes whatever `Error` reaches it and sends `err.message` verbatim to the client** as `{ error: message }` with a 500 status. This is not new risk introduced by encryption — it's a pre-existing pattern this design must respect: any new error type must have a deliberately generic `.message`, because nothing downstream will sanitize it.
- `services/plaidErrors.ts`'s `isReauthRequiredError` inspects `err.response.data.error_code`. A new custom encryption-error class must **not** accidentally expose a same-shaped `.response.data.error_code` field, or it risks being misclassified as "user needs to reconnect their bank" when the real problem is local key/ciphertext corruption.

### 1.17 Asynchronous paths that could read or write Plaid credentials
Two, both already identified above: the webhook receiver's detached `processWebhook(payload).catch(...)` (§1.9), and the per-item `for` loop inside `refreshAccounts`/`syncTransactions`, which is sequential-`await`, not `Promise.all` — so a decryption failure on one item, if left to propagate, would currently abort the loop and fail the whole request for every remaining item unless individually caught (today only `isReauthRequiredError` results are caught per-item; anything else, including a would-be decryption error, is not).

---

## 2. Proposed database schema (Phase 1 — expand only)

```sql
alter table public.plaid_items
  alter column access_token drop not null,
  add column access_token_ciphertext text,
  add column access_token_nonce      text,
  add column access_token_auth_tag   text,
  add column access_token_key_id     text,
  add column access_token_enc_version smallint;

-- Defense in depth: a row should never carry a partial encrypted representation.
alter table public.plaid_items
  add constraint plaid_items_encrypted_token_complete
    check (
      (access_token_ciphertext is null
       and access_token_nonce is null
       and access_token_auth_tag is null
       and access_token_key_id is null
       and access_token_enc_version is null)
      or
      (access_token_ciphertext is not null
       and access_token_nonce is not null
       and access_token_auth_tag is not null
       and access_token_key_id is not null
       and access_token_enc_version is not null)
    );

-- Defense in depth: a row must always have at least one usable representation
-- (this is what actually replaces the NOT NULL that access_token gave up above).
alter table public.plaid_items
  add constraint plaid_items_token_present
    check (access_token is not null or access_token_ciphertext is not null);
```

**Column type recommendation, revised after empirical verification: `text` holding explicit Base64, not `bytea`.** The original recommendation was `bytea`, reasoning that GCM ciphertext/nonce/auth-tag are raw binary and Postgres has a real binary type for that. Point 2 of Trevor's follow-up asked this to be verified rather than assumed against this repo's actual Supabase client — doing so changed the recommendation:

I read this repo's exact installed `@supabase/postgrest-js` (`node_modules/@supabase/postgrest-js`, confirmed version **2.112.3**, matching the `@supabase/supabase-js` version in lockstep) directly. Its `PostgrestBuilder.ts` builds every request body with:
```ts
body: JSON.stringify(this.body, (_, value) => typeof value === 'bigint' ? value.toString() : value)
```
— a plain `JSON.stringify` with a replacer that only special-cases `bigint`. There is **no** `Buffer`/`Uint8Array` handling anywhere in it. I confirmed the consequence locally (no network, no database touched): `JSON.stringify({ ciphertext: someBuffer })` produces `{"ciphertext":{"type":"Buffer","data":[0,1,2,...]}}` — Node's own default `Buffer.prototype.toJSON()` — which is not a valid `bytea` literal by any Postgres input format. **A raw `Buffer` passed straight to `.insert()`/`.update()` would not work as the original document assumed.**

The alternative that preserves a real `bytea` column would be to hand-encode as Postgres's hex text representation (`\x` followed by hex digits) on write and parse the same `\x...` string on read — but that reintroduces exactly the kind of assumption Trevor asked me not to make: it depends on this specific Supabase/Postgres instance's `bytea_output` setting and on trusting PostgREST's implicit text↔bytea cast behavior for this project, none of which I verified against the live database (and won't, without either violating this project's standing "never run Supabase DDL directly" rule to create a scratch table, or writing test rows into the real `plaid_items` table, neither of which I'm willing to do for a design review).

**Recommendation: make all five byte-bearing values `text` columns holding explicit, application-controlled Base64** (`buffer.toString('base64')` on write, `Buffer.from(text, 'base64')` on read). This needs zero assumptions about the database layer at all — the encode/decode step is ordinary, well-documented Node `Buffer` behavior, verified losslessly round-tripping in the same local check above (`Buffer.from(buf.toString('base64'), 'base64').equals(buf)` → `true`), and it's trivially unit-testable without any network or database dependency (§16). `access_token_key_id` stays `text` (a short logical identifier, e.g. `railway-prod-v1`), and `access_token_enc_version` stays a small integer (`smallint`) identifying the *encryption scheme* (AES-256-GCM v1, in case the cipher or AAD format itself ever needs to change, distinct from `key_id` which only identifies *which key*).

`access_token` **no longer stays `NOT NULL` through Phase 4** — that was the actual contradiction Trevor flagged in the original document, and it's fixed here: the constraint is dropped in this same Phase 1 migration (a safe, additive, fully-reversible change on its own — dropping `NOT NULL` doesn't touch any existing row's data, and re-adding it later would only fail if a `NULL` already existed by then, which is exactly the state we're deliberately building toward). See §6.2 and §7 Phase 2 for exactly when rows actually start having a `NULL` `access_token` in practice, and the rollback guarantees that go with each stage.

Existing `updated_at`/`created_at` columns already exist on `plaid_items` and need no change — a backfill write should still bump `updated_at` normally.

---

## 3. Proposed encrypted-payload representation

**Revised after point 2 of Trevor's follow-up** — see §2 for the full justification (postgrest-js's `JSON.stringify`-based body serialization has no `Buffer`/`Uint8Array` handling, confirmed by reading the actual installed source and reproducing the failure locally). The application-layer representation now carries plain Base64 strings, not `Buffer`s, at the boundary that touches Supabase:

```ts
interface EncryptedAccessToken {
  ciphertextBase64: string; // GCM ciphertext, base64-encoded
  nonceBase64: string;      // 12 raw bytes, base64-encoded
  authTagBase64: string;    // 16 raw bytes (AES-GCM's standard tag length), base64-encoded
  keyId: string;            // logical key identifier, e.g. "railway-prod-v1"
  encVersion: 1;             // literal 1 for the scheme described here; bump only if the scheme itself changes
}
```

Each string field maps 1:1 to a `text` column from §2. The encrypt/decrypt functions themselves (§5.1–5.2) still operate on `Buffer`s internally — `.toString('base64')` is the very last step before a value leaves the encryption module on the way to a Supabase `.insert()`/`.update()` call, and `Buffer.from(str, 'base64')` is the very first step after a value comes back from a Supabase `.select()`, so nothing outside that one narrow module ever needs to think about encoding at all.

**Malformed-value detection before attempting decryption** — required, not optional, because AES-GCM's own authentication only fires *after* you've already handed it a well-formed nonce/tag/ciphertext. This now includes validating the Base64 itself decodes to the expected byte length, not just checking a `Buffer.length` that was already trusted:
- `nonceBase64` does not decode to exactly 12 bytes → reject immediately as `MalformedNonceError`, never call into `crypto`.
- `authTagBase64` does not decode to exactly 16 bytes → reject immediately as `MalformedAuthTagError`.
- `ciphertextBase64` decodes to zero bytes, or fails to decode as valid Base64 at all → reject immediately as `MalformedCiphertextError` (an empty or non-decodable Plaid access token is never valid).
- `keyId` not present in the configured key ring → reject immediately as `UnknownKeyIdError`, again without calling into `crypto` at all (there is no key to even attempt decryption with).

Only once all four of the above pass does the code proceed to `decipher.setAuthTag(authTag)` / `decipher.update()` / `decipher.final()`, where a **GCM authentication failure** (tampered ciphertext, tampered tag, wrong key, or wrong AAD) throws from `decipher.final()` itself — that specific throw is what becomes `GcmAuthenticationError` (§9).

---

## 4. Proposed AAD format

Recommended, incorporating exactly what the proposal asked for:

```
my-finances:plaid-access-token:v1:<plaid_items.id>
```

Concretely: `` `my-finances:plaid-access-token:v${encVersion}:${plaidItemRowId}` ``, encoded as UTF-8 bytes before being passed to `cipher.setAAD()`/`decipher.setAAD()`.

Why each component: the app/context identifier (`my-finances:plaid-access-token`) prevents a ciphertext from this table ever being silently accepted if it were somehow copied into an unrelated encrypted column in the future (defense in depth, not a threat this app faces today with only one encrypted field). The version component (`v${encVersion}`) ties the AAD itself to the scheme version, so a deliberate future scheme change (e.g. a different AAD shape) can't be decrypted under the old AAD by accident — the encryption-version check and the AAD check reinforce each other rather than being redundant. The row id (`plaid_items.id`, the UUID primary key, immutable for the row's lifetime) is the actual security-relevant binding: it makes ciphertext non-transferable between rows — copying item A's ciphertext into item B's row (accidentally, or via a bug, or via a compromised-but-limited SQL access path) fails decryption because the AAD won't match, exactly as the proposal specified and exactly why this matters — `plaid_items.id` is never reused (a `uuid` primary key with `gen_random_uuid()` default) and never changes after insert, so it's a safe, permanent binding value.

I recommend against including `user_id` in the AAD: it adds no additional real protection (an attacker who could substitute one row's ciphertext for another's already needs row-level write access, at which point they could just as easily read/copy the correct `user_id` alongside it), and it would force AAD recomputation if a row's `user_id` ever needed to change for any operational reason (unlikely, but there's no reason to couple the two).

---

## 5. Key management

### 5.1 Node.js crypto sequence (encrypt)

```ts
import { randomBytes, createCipheriv } from 'node:crypto';

function encryptAccessToken(plaintext: string, key: Buffer, aad: Buffer): EncryptedAccessToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Base64-encode only at this last step (§2/§3) — everything above operates on raw Buffers.
  return {
    ciphertextBase64: ciphertext.toString('base64'),
    nonceBase64: nonce.toString('base64'),
    authTagBase64: authTag.toString('base64'),
    keyId: /* current key id */ '',
    encVersion: 1,
  };
}
```

### 5.2 Node.js crypto sequence (decrypt)

```ts
import { createDecipheriv } from 'node:crypto';

function decryptAccessToken(enc: EncryptedAccessToken, key: Buffer, aad: Buffer): string {
  const nonce = Buffer.from(enc.nonceBase64, 'base64');
  const authTag = Buffer.from(enc.authTagBase64, 'base64');
  const ciphertext = Buffer.from(enc.ciphertextBase64, 'base64');

  if (nonce.length !== 12) throw new MalformedNonceError();
  if (authTag.length !== 16) throw new MalformedAuthTagError();
  if (ciphertext.length === 0) throw new MalformedCiphertextError();

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new GcmAuthenticationError(); // final() is where GCM tag verification actually happens
  }
}
```

This is exactly the sequence the proposal specified (`randomBytes(12)` / AES-256-GCM / `setAAD` on both sides / `getAuthTag` after encrypt / `setAuthTag` before decrypt / `final()` on both). No custom cryptographic primitive is used anywhere — every operation is a direct call into Node's built-in `crypto` module; Base64 encode/decode (§2/§3) is the only addition beyond the proposal's original sequence, and it sits entirely outside the cryptographic operations themselves.

### 5.3 Environment/key encoding
- Each key is a raw 32-byte (256-bit) value, stored in its environment variable as **base64** (not hex, to keep the env-var value shorter; not raw bytes, since env vars are text). Decoded once at startup via `Buffer.from(value, 'base64')`, and the decoded length is checked to be exactly 32 — a wrong-length key (e.g. someone pastes a hex string into a base64-expecting var, or truncates a value) fails **startup**, not the first request that happens to need decryption.
- Naming, extending the existing `env.ts` `required()` pattern:
  - `PLAID_TOKEN_KEY_<ID>` — one env var per key ring entry the current environment needs available for decryption (e.g. `PLAID_TOKEN_KEY_RAILWAY_PROD_V1`).
  - `PLAID_TOKEN_CURRENT_KEY_ID` — a plain string naming which of the above is used for *new* encryption (e.g. `railway-prod-v1`).
  - The mapping from a `key_id` string to its actual key bytes is built once at startup into an in-memory `Map<string, Buffer>`, exactly analogous to the existing `keyCache` pattern already used for Plaid webhook verification keys (`services/webhookVerification.ts`) — this codebase already has a precedent for "look up a key by string id, cache it, never log it," worth reusing the shape of rather than inventing a new one.
- **Never log**: the raw env var value, the decoded key `Buffer`, or even its length in a context that could be confused with key material. Only the `key_id` string itself is safe to log.

### 5.4 Railway configuration — Sealed Variables (updated per point 4 of Trevor's follow-up)
I still have no direct access to the Railway dashboard for this project, and the repository contains no exported Railway configuration beyond `railway.json` (build/deploy commands and healthcheck settings only — no environment-variable definitions live in the repo, which is correct and expected). Trevor independently checked Railway's current official documentation and confirmed **Sealed Variables** exist today as a real, documented Railway feature: a value is supplied to deployments at runtime exactly like any other environment variable, but once set, it can never again be viewed or retrieved through the dashboard or the API — not by Trevor, not by anyone with dashboard access, not through any export/backup mechanism Railway itself offers.

**Design updated to treat Sealed Variables as the preferred mechanism** for `PLAID_TOKEN_KEY_*` and `PLAID_TOKEN_CURRENT_KEY_ID` in both staging and production, *if* available in the actual project dashboard — that per-project availability check is still Trevor's to do, not something I can confirm myself. It directly satisfies "Supabase must never contain the raw encryption key" and goes further than an ordinary Railway variable by ensuring no human can casually view the key value again either, which is a meaningfully stronger posture than what an unsealed variable provides.

**One operational consequence of sealing, worth stating plainly before Trevor commits to it**: because a sealed variable can never be retrieved again once set, **Railway itself stops being any kind of backup or fallback copy of the key** the moment it's sealed. This directly matters for §12's "missing/unknown key" recovery scenario, which already recommends a documented, secure backup of every key ever placed in the ring — with sealed variables, that backup is not just good practice, it is the *only* place the value will ever exist again after sealing, including for Trevor's own future use (e.g., standing up a new environment that needs the same key, or simply re-confirming what's currently configured during an incident). **Concretely: generate the key value, save it to Trevor's own secure secret storage first, and only then paste it into Railway and seal it — never seal a value whose only other copy was Railway's own (about-to-be-inaccessible) UI.** If Sealed Variables turn out not to be available on this project's current plan/dashboard, the fallback is an ordinary Railway environment variable, restricted the same way `SUPABASE_SERVICE_ROLE_KEY`/`PLAID_SECRET` already are today (server-side only, never referenced by the frontend build) — still functionally correct, just without the extra can't-be-viewed-again guarantee.

**Action item for Trevor, not something I can complete in this review**: open the Railway dashboard for both the staging and production services (I found no evidence in the repo of a staging Railway service/environment existing today — only production configuration in `railway.json` — so confirm whether a staging target exists at all before assuming this applies to two separate services) and confirm Sealed Variables are actually offered there, then follow the backup-before-sealing sequence above for each of the two key-related variables.

### 5.5 Startup validation sequence
1. Read `PLAID_TOKEN_CURRENT_KEY_ID` — required, throw if missing (extends the existing `required()` helper).
2. Enumerate every `PLAID_TOKEN_KEY_*` variable actually present in `process.env` (not a fixed hardcoded list of expected ids — this lets the key ring grow without a code change each time, see §11).
3. For each, base64-decode; throw a descriptive (but key-value-free) error if decoding fails or the decoded length isn't exactly 32 bytes.
4. Confirm `PLAID_TOKEN_CURRENT_KEY_ID`'s value actually corresponds to one of the keys found in step 2 — throw if not (a current-key-id pointing at a key that was never configured is exactly the kind of typo this check exists to catch before any request is served).
5. Build the in-memory `Map<string, Buffer>` and freeze it (no further env reads after startup).
6. Never log any key value, encoded or decoded, at any point in this sequence — only `key_id` strings and pass/fail outcomes.

---

## 6. Versioned key ring

Confirmed design direction: a **logical key ring**, keyed by an arbitrary string id chosen by whoever configures the environment (`local-dev-v1`, `railway-staging-v1`, `railway-prod-v1`, later `kms-prod-v1`), never an infrastructure-specific value baked into application code. The persisted `plaid_items.access_token_key_id` column stores exactly this string. `PLAID_TOKEN_CURRENT_KEY_ID` selects which entry new encryptions use; every other configured entry remains available for decrypting rows still tagged with an older id, for exactly as long as such rows exist.

### 6.1 Where the encryption boundary belongs (architectural recommendation this review adds)
Every current consumer of a Plaid access token (`plaidService.ts`, `syncService.ts`, `loans.ts`, every controller) receives a **plain decrypted string** today, via a plain object field (`item.access_token`) or a plain function parameter (`accessToken: string`). None of them need to become "encryption-aware" in the sense of importing crypto code or handling `EncryptedAccessToken` shapes directly. The correct, narrowest-possible boundary is **inside `dataService.ts`'s four Plaid-item functions only**:
- `insertPlaidItem` encrypts before writing, using the current key.
- `getPlaidItemsForUser` / `getPlaidItemForUser` / `getPlaidItemByPlaidItemId` decrypt after reading (preferring the encrypted columns when present, falling back to plaintext only per the phase rules in §7), before returning the same `{ ..., access_token: string, ... }` shape every caller already expects.

This means **zero changes** are needed to `plaidService.ts`, `syncService.ts`, `loans.ts`, or any controller's Plaid-calling logic — they keep working with a plain string exactly as today, and every existing test that mocks `dataService`'s return shape (e.g. `syncService.test.ts`'s literal `{ access_token: 'access-token-1', ... }`) continues to pass unmodified. This directly satisfies "keep changes narrowly related to credential security" (§ Controller/API considerations in the original proposal) about as literally as possible — the blast radius of this entire project is four functions in one file, plus the new encryption module itself.

### 6.2 Dual-write — is it actually necessary for this app? (Revised per point 1 of Trevor's follow-up)
**Not in the general, structural sense the proposal was guarding against — but a brief, explicitly time-boxed version of it is worth adopting anyway, for a reason unrelated to format compatibility: rollback safety during the riskiest moment of the rollout.** These are two different questions, and the original document conflated them; separated out:

**Is ongoing dual-write needed to reconcile two application versions writing different formats?** No, because of the write-once/read-many fact established in §1.2. `access_token` is written exactly once, at Link time, and never written again for the lifetime of that row (reconnect/Update Mode re-validates, never rewrites). Any row inserted by the new, encryption-aware code will only ever be read by that same or a later encryption-aware version — there is no old-format reader to protect against for genuinely new rows, so a long-running dual-write phase spanning the whole migration would just mean writing plaintext for longer than necessary, undermining the point of the project.

**Is *some* dual-write useful anyway?** Yes — for a narrower reason. The moment `insertPlaidItem` starts writing encrypted-only, that decision becomes effectively irreversible for every row created from then on (§7 Phase 2 below spells out exactly why). Newly-deployed cryptographic code is exactly the kind of change worth being able to cleanly walk back from if something's subtly wrong with it, and "clean rollback" and "encrypted-only from the first row" are in direct tension. The resolution: split Phase 2 into a **2a** (brief, dual-write, kept only long enough to verify the new code is correct) and **2b** (encrypted-only, once 2a is confirmed stable) — see §7 for the exact trigger to move from one to the other and the exact rollback guarantee at each stage. This is closest to the proposal's first option, deliberately scoped much narrower than "the whole migration window."

---

## 7. Migration strategy (adapted to this app's actual token lifecycle)

The proposal's 7-phase shape is correct and adopted as-is, with the §6.2 refinement folded in (Phase 2 split into a brief 2a dual-write verification stage and a 2b encrypted-only stage, rather than either a long-running dual-write or an immediately-irreversible encrypted-only cutover) and app-specific detail added to each phase.

### Phase 1 — Expand schema
Exactly §2's `alter table`, which now also **drops `access_token`'s `NOT NULL` constraint** in the same migration (this is the fix for the contradiction Trevor flagged — see §2 for the full reasoning) and adds the `plaid_items_token_present` check constraint that replaces it (a row must always have *either* a plaintext or an encrypted representation, never neither). Additive, no data touched, fully reversible by simply not using the new columns yet. **Rollback**: `alter table public.plaid_items drop column ...` for all five new columns, `alter table public.plaid_items alter column access_token set not null` (safe — every existing row still has a plaintext value at this point, since nothing has written to the new columns yet), drop the two new constraints. All trivially safe, because nothing depends on any of this yet.

### Phase 2 — Deploy encryption-aware code (now two sub-stages, per Trevor's follow-up)

`dataService.ts`'s four functions (§6.1) become dual-read in both sub-stages below, unchanged throughout: on read, prefer the encrypted columns if `access_token_key_id is not null`, decrypt using the key ring; otherwise fall back to the plaintext `access_token` column (§9's fail-closed rule governs exactly when that fallback is and isn't allowed — it never changes based on which write sub-stage is active). What changes between 2a and 2b is **only** what `insertPlaidItem` writes for a brand-new row.

**Phase 2a — brief dual-write, kept only for initial verification.** `insertPlaidItem` writes **both** the plaintext `access_token` column and the full encrypted representation for every new row. This is deliberately temporary — measured in however long it takes to link one or two real test items and run the Phase 4 verification steps against them (realistically hours, not days), gated by that verification passing, not by a calendar date. Every consumer downstream (`plaidService.ts`, `syncService.ts`, `loans.ts`, every controller, the webhook receiver) needs **zero code changes** in either sub-stage, because they all continue to receive a plain decrypted string exactly as before.

**Phase 2b — encrypted-only writes.** Once 2a's verification has passed for at least one freshly-linked item, flip `insertPlaidItem` to write the encrypted columns only, leaving the (now-nullable) `access_token` column `null` for every row inserted from this point forward — per §6.2, no ongoing dual-write is needed once the new code path is trusted.

**Rollback guarantees, stated explicitly and asymmetrically, exactly as Trevor asked:**
- **Rolling back any deploy up through and including Phase 2a is fully safe, with zero data loss.** Every row — old ones from before this migration and any new one linked during 2a — still has a valid plaintext `access_token` the pre-migration code can read directly, because 2a never stops writing it.
- **Rolling back to pre-Phase-2 (pre-encryption-aware) code after Phase 2b has begun is *not* safe** for any row created (in 2b) or backfilled (Phase 3) since encrypted-only writing began. The reverted code has no idea the encrypted columns exist and would read that row's `access_token` as `NULL`, then fail — loudly, not silently: a plain-string operation on `null` (or the Plaid SDK rejecting a missing credential outright) breaks obviously for that specific item's syncs/refreshes rather than corrupting data quietly. **This is an accepted, deliberate tradeoff from Phase 2b onward**, not an oversight — it's the same category of tradeoff Phases 3–7 already accept (once you're far enough into the migration, going back to "plaintext is primary" stops being free), just moved earlier than the original document implied. The mitigation is procedural, not technical: don't roll back to pre-2b code once 2b is live; roll *forward* (fix and redeploy) instead, exactly as the Phase-2a verification gate is meant to make unnecessary in the first place by catching problems before 2b ever starts.
- Rolling back during/after Phase 6 (dual-read removed) or Phase 7 (column dropped) is categorically unsafe, exactly as the original document already said, unchanged by this revision.

### Phase 3 — Backfill existing plaintext credentials
A one-off script (not part of the request-serving code path), run against production data:
```sql
select id, access_token from public.plaid_items
where access_token_key_id is null
order by created_at
limit :batch_size;
```
For each row: encrypt using the current key and that row's own `id` in the AAD, then:
```sql
update public.plaid_items
set access_token_ciphertext = :ciphertext,
    access_token_nonce = :nonce,
    access_token_auth_tag = :auth_tag,
    access_token_key_id = :key_id,
    access_token_enc_version = 1,
    updated_at = now()
where id = :id
  and access_token_key_id is null; -- the exact concurrency guard the proposal asked for
```
The trailing `and access_token_key_id is null` is what makes this safe to run concurrently with live traffic and safe to re-run after an interruption: if the live app (or a second, accidentally-overlapping backfill run) already encrypted this row between the `select` and this `update`, the `where` clause matches zero rows and this write silently no-ops instead of clobbering newer data with a redundant re-encryption. **Batching**: given this app's actual scale (a single-user personal-finance tool today, per the project's own status notes — not a multi-tenant production system with thousands of items), a batch size of 50–100 rows per iteration with a short pause between batches is more than sufficient; there is no evidence in this codebase of a `plaid_items` table anywhere near a size where batching performance is a real concern. Run it as a plain Node script invoked manually (`ts-node` or compiled + `node`), not as a scheduled job — this is a one-time operation. **Never modify or delete plaintext during this phase.** **Rollback**: simply stop running the script; already-backfilled rows are harmless to leave encrypted (Phase 2's dual-read already handles them), and any row it hasn't reached yet is untouched.

### Phase 4 — Verification (corrected per point 3 of Trevor's follow-up)
Before touching plaintext at all, confirm every path in §1 still works with encrypted rows: initial Link (new row, encrypted-only from Phase 2b onward), manual sync, manual balance refresh, webhook-triggered sync (**test this one specifically and separately** — it's the async path, §1.9), liabilities refresh, recurring-streams refresh, reconnect/Update Mode, both sandbox helpers, and a full server restart (to prove the key-ring loads correctly from environment on a cold start, not just that it happened to already be in memory from before the migration began).

**Per-row verification, corrected**: my original wording ("compare against a value fetched from Plaid") was imprecise in exactly the way Trevor flagged — Plaid never returns an access token back to us for comparison; it's an opaque, write-only-to-us credential from the moment `itemPublicTokenExchange` first issues it. The actual verification, for every row touched by Phase 3 (and, during Phase 2a, for the handful of rows created by the initial dual-write test): three steps, in order, none of which ever logs either the plaintext or the decrypted value —
1. **Decrypt** the row's encrypted representation using the key ring.
2. **Compare** the decrypted string against that same row's still-present plaintext `access_token` column, in memory, with a plain `===` check — this is possible only because Phase 3/2a haven't removed the plaintext column yet, which is exactly why this check has to happen *before* Phase 5/6, not after. Only a boolean (`match: true/false`) and the row's own id are ever recorded anywhere (console output, a verification report, whatever Trevor is watching during the rollout) — never the two strings being compared.
3. **Independently confirm the decrypted value is still a live, Plaid-accepted credential** by calling `itemGet` with it (Plaid's `/item/get` endpoint) — this is what actually proves the decrypted string is a *working* access token, as distinct from step 2's proof that it's merely byte-identical to what was stored. **Recommended endpoint: `itemGet`**, already wrapped by this codebase's existing `plaidService.getItemInstitution` helper (`plaidClient.itemGet({ access_token })`) — it's the cheapest, side-effect-free, read-only way to confirm Plaid still honors a token: it returns item/institution metadata and any item-level error state, touches no transaction or balance data, and has no side effects worth worrying about from calling it an extra time outside the normal sync flow. I recommend against using `accountsGet` for this (heavier, returns full balance data unnecessarily just to prove liveness) and strongly against `transactionsSync` (it advances the item's cursor and is not safe to call outside the real sync flow — an out-of-band verification call would either duplicate work or desynchronize the cursor).

### Phase 5 — Stop plaintext writes
This already happened in Phase 2 for this app (§6.2) — there is no separate "stop writing plaintext" step needed here, because plaintext was never written again after the encryption-aware deploy. What Phase 5 *does* mean concretely for this app: confirm (via a query, `select count(*) from plaid_items where access_token_key_id is null`) that the backfill from Phase 3 is complete — zero remaining plaintext-only rows — before proceeding to Phase 6.

### Phase 6 — Stop plaintext reads
Remove the dual-read fallback from `dataService.ts`'s four functions — from this point forward, a row with `access_token_key_id is null` is treated as a genuine error (`MissingEncryptedRepresentationError`, §9), not silently read from the plaintext column. This is the moment the encrypted representation becomes authoritative. A hit of this new error path after Phase 5 confirmed zero remaining plaintext rows would indicate either a bug in that count query or a new row somehow inserted by unmigrated code — either way, something worth paging on, not silently tolerating.

### Phase 7 — Contract schema
Only after a deliberate soak period post-Phase-6 (the proposal says "later, separate migration" — I'd suggest on the order of a couple of weeks of clean production operation with zero `MissingEncryptedRepresentationError` occurrences, given this app's low traffic volume means "a week of quiet" is a much weaker signal here than it would be for a high-traffic system): `alter table public.plaid_items drop column access_token;` plus removing the now-dead dual-read code path entirely from `dataService.ts`.

---

## 8. Critical failure-handling rule (adopted exactly as specified, with this app's exact enforcement point)

**Plaintext fallback is permitted only when `access_token_key_id is null`** (Phase 2–5's transitional state). The moment `access_token_key_id is not null`, decryption is attempted, and **any** failure — unknown key id, malformed nonce/tag/ciphertext, or a GCM authentication failure from `decipher.final()` — must throw a specific typed error and **must not** fall through to reading the plaintext column, even though that column may still physically contain a value during the transitional phases. This is a single `if` in the dual-read logic (`if (row.access_token_key_id) { return decrypt(...); /* no catch that falls through */ } else { return row.access_token; }`) — the important discipline is that the `decrypt` branch has **no** `catch` that returns the plaintext column as a fallback; any thrown error from that branch propagates up as a hard failure.

---

## 9. Error classification

Recommended internal error classes (all extending a common `PlaidCredentialError` base so callers can `instanceof`-check the whole family at once, e.g. to decide "this item needs an operator to look at it" vs. "this item needs the user to reconnect"):

| Class | Meaning | Distinct from Plaid's own errors? |
|---|---|---|
| `MissingEncryptedRepresentationError` | Row has no encrypted token and (post-Phase-5) plaintext fallback is no longer permitted | Yes — purely a migration-state bug, never a Plaid-side condition |
| `UnknownKeyIdError` | Row's `access_token_key_id` doesn't match any key currently configured in the running app's key ring | Yes |
| `InvalidKeyConfigurationError` | Thrown at **startup**, not per-request — a configured key fails length/decoding validation | Yes |
| `MalformedNonceError` / `MalformedAuthTagError` / `MalformedCiphertextError` | Stored value's byte length doesn't match what AES-256-GCM requires, detected before calling into `crypto` at all | Yes |
| `GcmAuthenticationError` | `decipher.final()` itself threw — tampered ciphertext, tampered tag, wrong key, or wrong/mismatched AAD (these four causes are indistinguishable from the ciphertext alone, by GCM's design — that's a security feature, not a limitation to work around) | Yes |
| *(existing, unchanged)* `isReauthRequiredError` / Plaid `ITEM_LOGIN_REQUIRED` / `ITEM_NOT_FOUND` / `INVALID_ACCESS_TOKEN` | Plaid itself rejected the (correctly-decrypted) token | This is the boundary that must never blur — see below |
| *(existing, unchanged)* ordinary Plaid API/network errors | Timeouts, rate limits, Plaid outages | Unaffected by any of the above |

**Why these stay distinct in practice, not just in principle**: `isReauthRequiredError` inspects `err.response.data.error_code` (§1.16). None of the new `PlaidCredentialError` subclasses should ever be given a `.response.data.error_code` field — they are plain custom errors thrown entirely on the application side, before any Plaid API call is even made (decryption happens before the token is handed to `plaidService`). As long as that stays true, `isReauthRequiredError(cryptoError)` naturally returns `false` for every one of them without needing a special exclusion check — but this should be locked in with an explicit unit test (§13) asserting exactly that, so a future refactor can't accidentally reshape one of these classes to look like a Plaid error.

**Where each is caught, concretely**: in every controller that currently does
```ts
if (plaidService.isReauthRequiredError(err)) {
  await dataService.setItemStatus(item.id, 'login_required');
} else {
  throw err;
}
```
(`refreshAccounts`, `syncTransactions`, `completeReauth`), add a preceding check:
```ts
if (err instanceof PlaidCredentialError) {
  // never set login_required — this is not a bank-reconnect situation (§10)
  console.error(`Plaid credential error for item ${item.id}:`, err.name);
  // per-item: log and continue to the next item, same resilience the loop already has for reauth errors
  continue; // (or equivalent for the specific loop shape)
} else if (plaidService.isReauthRequiredError(err)) {
  ...
```
This is a small, additive change to logic that already exists in exactly this shape in three places — not a controller rewrite.

---

## 10. User-facing failure behavior

Recommendation: **do not silently swallow a `PlaidCredentialError` into "everything's fine."** The existing `status` column on `plaid_items` (`'active' | 'login_required'`) is the wrong place to record this — setting `login_required` would trigger the app's existing "reconnect your bank" UI (Plaid Link in Update Mode), which would not fix anything (the stored token itself may be perfectly valid to Plaid; the application simply failed to read it) and would actively mislead the user into thinking *their bank* is the problem when the actual fault is this application's own key/ciphertext state.

I recommend a **third status value**, e.g. `'credential_error'`, distinct from both `'active'` and `'login_required'`. Frontend behavior for that status: a plainly-worded message (something like *"We're having trouble accessing this account's connection right now. This isn't something you need to fix — we've been notified."*) with **no** "reconnect" button (since reconnecting wouldn't help and would burn a real Plaid Link session for nothing), and no cryptographic detail, ciphertext, or key id ever rendered. This is a small, additive UI change (one more branch alongside the existing `login_required` handling), not a redesign.

Server-side, on hitting any `PlaidCredentialError` for an item, the app should log enough for a human to investigate (`item.id`, the specific error class name, `key_id` if known, a timestamp) and set that item's status to `'credential_error'` — never `'login_required'`, and never leave `status` unchanged in a way that would make the failure invisible to the next person looking at the Accounts tab.

---

## 11. Logging and redaction

Extending the allowed/forbidden lists exactly as specified, with the one concrete pre-existing gap this review found:

**Must fix regardless of encryption, surfaced by this review**: `middleware/errorHandler.ts` currently does `res.status(500).json({ error: err.message })` for *any* uncaught error, encryption-related or not. Recommendation: every new `PlaidCredentialError` subclass should set its own `.message` to a fixed, hand-written, non-sensitive string at construction time (e.g. `GcmAuthenticationError`'s message is literally the string `"Unable to verify stored credential."`, never anything derived from the actual ciphertext/tag/key), so that even though `errorHandler` forwards `.message` to the client unchanged, there is nothing sensitive in it to forward. This is a narrow, mechanical requirement on the new error classes, not a rewrite of `errorHandler.ts` itself (which the "controller/API considerations" instruction says to avoid turning into a broader refactor) — though I'd flag to Trevor that fixing `errorHandler.ts` itself to stop forwarding arbitrary `.message` text to clients is a good idea *independent of this project*, worth its own small follow-up ticket.

**Never log** (as specified): plaintext token, any key material (encoded or decoded), ciphertext bytes, auth tags, nonces (no strong reason exists in this app to log them, so: never), `Authorization` headers, full request/response bodies for credential-touching routes.

**Safe to log**: `plaid_items.id`, the Plaid-side `item_id` (already logged today in existing `console.error` calls, e.g. `Failed to refresh loans for item ${itemRowId}`), the error class name (`err.constructor.name` or `err.name`), `key_id` (a logical string, never the key itself), timestamps, and — for the webhook path specifically — the `webhook_code`/`webhook_type` from the payload (already logged today: `console.error('Failed to process Plaid webhook:', payload.webhook_code, err)`).

**Audit of existing logging paths, done for this review**: no existing `console.error`/`console.log` call anywhere in the Plaid-related code paths logs the raw `access_token` value itself (verified by reading every call site in §1). The closest thing to a risk is the generic `console.error(err)` inside `errorHandler.ts` and the process-level `unhandledRejection`/`uncaughtException` handlers in `index.ts` — if a future crypto error's `.message` or a stack trace happened to include buffer contents (Node's `crypto` module does not do this in its own thrown errors, but a bug in this project's *own* error-wrapping code could), it would end up in server logs. Recommendation: any `catch` block that wraps a crypto operation should construct a fresh, deliberately-minimal error rather than re-throwing or wrapping the original `crypto`-thrown error object directly, specifically to guarantee nothing exotic ever reaches a log line.

---

## 12. Recovery procedures

**Missing/unknown key** (an old key removed from Railway before every row referencing it was rotated): this is a `UnknownKeyIdError` at read time for every affected row. Recovery is entirely operational, not a code path: restore the missing key value to the environment (from wherever it was backed up — see the note below) and redeploy; there is no in-app self-healing possible once a key is gone, by design (that's what makes the encryption meaningful). **This makes a documented, secure backup of every key ever placed in `PLAID_TOKEN_CURRENT_KEY_ID`'s ring a hard operational requirement, not optional** — losing a key with no backup means every row still tagged with that `key_id` becomes permanently unreadable, and the only recovery for the affected users is asking them to reconnect their bank from scratch (a real, if rare, data-loss scenario worth Trevor explicitly acknowledging and planning a key-backup process for before this ships, since the design as specified doesn't otherwise have an answer for "we lost the key").

**Corrupted/tampered ciphertext** (`GcmAuthenticationError` on a row whose `key_id` *is* correctly configured): given this app's threat model (a single-operator system, no evidence of external write access to the database beyond the backend's own service-role key), the far more likely cause is an application bug (e.g. an AAD mismatch from a code error, not an actual attack) than genuine tampering — but the correct response is the same either way: **do not attempt automatic recovery**. Reconnecting the institution (a fresh Plaid Link, producing a brand-new access token, replacing the row's encrypted fields entirely) is a legitimate and sufficient recovery path for the *user's* data access, but I'd recommend it only be offered after a human (Trevor, for now — there's no separate ops team) has looked at why the corruption happened, precisely because "just have them reconnect" would silently paper over an application bug that could then recur for the next row too. Treat the first occurrence of this error as an investigation trigger, not a routine "click reconnect" prompt.

**Plaid access token legitimately invalidated**: unchanged from today — this is exactly what `isReauthRequiredError`/`ITEM_LOGIN_REQUIRED` already handles, and stays entirely separate from the two recovery paths above (§9).

---

## 13. Key rotation

Adopted as specified — controlled batch rotation, not lazy/background rotation, for the same reason batch backfill was chosen in Phase 3 (this app's actual scale doesn't need the complexity of lazy rotation, and controlled batch rotation is far easier to reason about and verify):

1. Add the new key to the environment's key ring (`PLAID_TOKEN_KEY_<NEW_ID>`), deploy — at this point both old and new keys are available for decryption, but `PLAID_TOKEN_CURRENT_KEY_ID` still points at the old one, so nothing changes yet.
2. Flip `PLAID_TOKEN_CURRENT_KEY_ID` to the new id, deploy — from this moment, every `insertPlaidItem` (new Link) encrypts with the new key; every existing row still decrypts fine under the old key, which remains configured.
3. Run a batch re-encryption script structurally identical to the Phase 3 backfill script, except its `select` targets `where access_token_key_id = :old_key_id` instead of `is null`, and its conditional `update` guard is `where access_token_key_id = :old_key_id` (so a row already rotated by a concurrent run, or already re-encrypted for some other reason, is correctly skipped rather than double-processed).
4. Verify zero rows remain with `access_token_key_id = :old_key_id`.
5. Only then remove the old key from the environment's key ring and redeploy.

Same concurrency-safe conditional-update pattern as Phase 3 throughout, satisfying "rotation must also use conditional/concurrency-safe updates."

---

## 14. Future KMS / envelope encryption compatibility

Nothing in this design blocks a later move to a managed KMS. The key ring abstraction recommended here (§6: a `Map<string, Buffer>` built at startup, looked up by `key_id`) is already exactly the shape a KMS-backed provider would need to slot into: today, `getKeyForId(keyId)` returns a `Buffer` synchronously from an in-memory map populated from env vars; a KMS-backed version of the same function would instead call out to the KMS to unwrap a data-encryption key (DEK) — the call sites in `dataService.ts` (`encryptAccessToken`/`decryptAccessToken`) would not need to change at all, only the implementation of `getKeyForId` itself, provided it's kept behind one narrow interface from the start (which this design already recommends, not as a KMS-specific accommodation, but simply as good separation of concerns).

For the eventual KMS move itself (explicitly not being done now): the Express backend's IAM/service identity should be granted encrypt/decrypt (and unwrap, if using envelope encryption) permissions only — never key-administration permissions (create/delete/rotate keys), which should belong to whatever deployment/ops process manages the KMS keys directly. If envelope encryption is used (a KMS-managed master key wrapping a per-row or per-batch DEK, rather than every row's AAD-bound ciphertext being decrypted directly by a KMS call), a short-lived, strictly-bounded in-memory DEK cache (with a TTL well under any reasonable "key compromised, revoke now" response time, and a hard cap on how many DEKs are held in memory at once) avoids a KMS round trip on every single Plaid API call this app already makes somewhat frequently (transaction sync, balance refresh) — this is a real, worthwhile performance consideration for that future work, but designing the exact TTL/cache-size numbers now would be premature; the important thing today is only that the `getKeyForId`-shaped boundary exists so this can be added later without touching `dataService.ts`'s encryption call sites at all.

---

## 15. Remote migration-history reconciliation — should it happen before this?

**Recommendation: keep using manual reviewed SQL for this rollout; do not use this project as the trigger to reconcile Supabase's remote migration-history table.** Two independent reasons: first, the standing project instruction (verified in this session's own memory) is explicit that migration-history reconciliation must not happen as a side effect of unrelated feature work — it needs its own dedicated, careful pass, and a security-sensitive encryption rollout is exactly the wrong moment to also be experimenting with `supabase migration repair` for the first time. Second, and more specific to this design: the phase-based rollout in §7 already depends on Trevor manually applying each migration file and confirming it before the next phase proceeds — that is precisely the same manual, reviewed-SQL discipline this project has used successfully for every one of its 8 migrations to date. There is no part of this design that actually needs `supabase db push` to work; needing it would be a reason to reconcile history first, and this design doesn't need it.

---

## 16. Required tests

Mapped onto this app's actual test conventions (Vitest, `vi.mock`/`vi.hoisted` for mocking, a shared `createQueryBuilder` Supabase-chain mock in `backend/src/testUtils/supabaseMock.ts` already used across every `dataService.test.ts` suite):

### Cryptographic unit tests (new file, e.g. `backend/src/services/tokenEncryption.test.ts`)
- Encrypt → decrypt round trip returns the original plaintext, asserted through the full `EncryptedAccessToken` shape (i.e. through the Base64 encode/decode step too, not just the raw `Buffer`-level `crypto` calls in isolation) — the regression test for point 2 of Trevor's follow-up, since this is exactly the boundary that turned out not to work with raw `Buffer`s.
- Two encryptions of the identical plaintext (same key, same AAD) produce different ciphertext and different nonces.
- A `ciphertextBase64`/`nonceBase64`/`authTagBase64` value that isn't valid Base64 at all (not just wrong-length) is rejected as a `Malformed*Error`, not passed through to `crypto` and left to throw something less specific.
- Nonce is always exactly 12 bytes, across many repeated calls (a loop asserting this, not just one sample).
- Tampering with one byte of ciphertext, the auth tag, or the nonce each independently causes decryption to throw `GcmAuthenticationError` (three separate tests).
- Decrypting with the AAD for a *different* `plaid_items.id` than the one it was encrypted for throws (proves the AAD binding actually does what §4 claims).
- Decrypting with the wrong key throws.
- Decrypting with an unconfigured `key_id` throws `UnknownKeyIdError` before any `crypto` call is attempted.
- Malformed (wrong-length) nonce/tag/ciphertext each throw the specific corresponding `Malformed*Error` — and a spy/assertion confirms `crypto`'s decrypt path was never invoked for these (they're caught by the length checks in §3, not by GCM itself).
- A configured key of the wrong decoded length fails at the startup-validation function, not lazily on first use.
- For every thrown error class: assert `.message` does not contain the plaintext token, key bytes, or raw ciphertext (a mechanical test that just checks the string doesn't include the fixture's known secret value) — the concrete regression test for §11's redaction requirement.

### Migration-compatibility tests (extend `dataService.test.ts`, following its existing `createQueryBuilder` mock pattern)
- A row with `access_token_key_id: null` and a plaintext `access_token` is still read correctly (Phase 2–5 fallback).
- A row with encrypted columns populated is decrypted and preferred, even if a stale plaintext value also happens to still be present in the row.
- Simulating a `GcmAuthenticationError` on a row that *has* `access_token_key_id` set must throw, not fall back to that row's plaintext column — the direct regression test for §8's fail-closed rule.
- `insertPlaidItem` in **2a mode** writes both the plaintext `access_token` and all five encrypted fields (asserting the mock's `.insert()` call includes both); `insertPlaidItem` in **2b mode** writes only the encrypted fields with `access_token` `null`/omitted — two separate tests, confirming §6.2/§7's split is actually what's implemented, not just one or the other.
- The backfill's conditional update (`where access_token_key_id is null`) is asserted to be part of the query the backfill script issues — a concurrency-safety regression test, not just a round-trip test.
- Running the backfill logic twice on the same already-encrypted row is a no-op the second time (idempotency).

### Plaid-path regression tests (extend the existing mocked-`plaidService`/mocked-`dataService` pattern already used in `syncService.test.ts`)
- `syncService.syncItemTransactions` receives a plain `access_token` string regardless of whether the underlying row was encrypted or plaintext — since the encryption boundary is entirely inside `dataService.ts` (§6.1), this test mostly just needs to confirm the *existing* `syncService.test.ts` suite continues to pass completely unmodified after the migration, which is itself the regression test.
- One new test specifically for the webhook path (§1.9/§7.4): simulate `dataService.getPlaidItemByPlaidItemId` throwing a `PlaidCredentialError`, and assert `processWebhook` catches it into the item's `'credential_error'` status (§10) rather than letting it propagate as an unhandled rejection with no record anywhere.
- One new test confirming `refreshAccounts`'/`syncTransactions`' per-item loop treats a `PlaidCredentialError` on one item the same way it already treats a re-auth error on one item today: logged, that item marked, the loop continues to the next item rather than aborting the whole request.
- Reconnect/Update Mode: confirm `createReauthLinkToken`/`completeReauth` correctly decrypt the stored token before handing it to `plaidService` — since Plaid never issues a new token here (§1.10), this is purely a read-path test, no new write-path behavior to verify.
- Both sandbox helpers (`sandboxResetLogin`, `sandboxFireWebhook`): same read-path assertion, one test each, given they're currently completely untested (§1.12) — this migration is a natural opportunity to add their first coverage at the same time.
- **The Phase 4 verification helper itself** (§7 Phase 4): with `plaidService.getItemInstitution`/`itemGet` mocked, confirm the three-step check (decrypt, compare against a fixture plaintext, call `itemGet`) reports a pass when all three agree, and reports a specific, identifiable failure when the decrypted value doesn't match the fixture plaintext versus when `itemGet` itself rejects — these are different failure modes (a local bug vs. Plaid no longer accepting the credential) and the verification output should make that distinguishable, not collapse both into one generic "verification failed."

### Logging tests
- For each new error class, a test asserting `JSON.stringify(err)`/`err.toString()`/`err.message` contains none of a fixture's known secret values (plaintext token, key bytes) — mechanical, cheap, and directly enforces §11.

---

## 17. Controller/API considerations

The four Plaid-item functions in `dataService.ts` are the only place any of this touches, per §6.1 — no controller's request-handling logic changes except the small, additive `instanceof PlaidCredentialError` branch (§9) inside the three places that already do reauth-error handling, and the one new `'credential_error'` status value threaded through wherever `'login_required'` already flows to the frontend today. This is a good, narrow opportunity to finally add the first tests for four previously-completely-untested `dataService.ts` functions (§1.12, §16) — that's in-scope, since it's testing the exact code this migration adds behavior to, not a general test-coverage sweep. I found no other controller code that would benefit from being touched as part of this specific project, and recommend not touching anything else, per the explicit instruction to keep this narrowly scoped.

---

## 18. Answers to the 24 numbered questions

1. **Overall assessment**: sound design, no disagreement with the cryptography or phase philosophy. See §0. (Updated 2026-08-26: four specific mechanical details were corrected after independent review — §0.1.)
2. **Anything I disagree with**: nothing structural. The mechanical refinements are §6.2/§7 (a brief 2a dual-write verification stage is worth keeping, narrower than the proposal's full-migration-window framing but not zero, per the corrected rollback analysis) and §2/§3 (`text`+Base64, not `bytea`, once actually checked against this repo's installed client).
3. **Anything missed**: the `errorHandler.ts` message-forwarding behavior (§1.16/§11), the webhook path's fire-and-forget detachment from the HTTP response (§1.9/§7 Phase 4), the existing `isReauthRequiredError`/`INVALID_ACCESS_TOKEN` collision risk (§1.16/§9), zero existing tests on the four functions this migration touches most (§1.12/§16), the "Investments" product-vs-API-call distinction (§0/§1.4/§1.8), the `NOT NULL`/encrypted-only contradiction in my own first draft (§0.1, caught by Trevor's independent review, not by me), and the `Buffer`-via-`JSON.stringify` serialization gap in `postgrest-js` (§0.1/§2, also flagged by Trevor's review rather than found by me unprompted) — a mix of findings from reading the actual code and corrections from independent review, all now resolved.
4. **Every code path that accesses Plaid tokens**: §1, in full.
5. **Exact schema**: §2 (revised: `text` columns holding Base64, `access_token`'s `NOT NULL` dropped in Phase 1).
6. **Exact encrypted payload representation**: §3 (revised: Base64-encoded strings at the Supabase boundary, raw `Buffer`s only inside the encryption module itself).
7. **Exact AAD format**: §4 (unchanged by this update).
8. **Exact key-ring/environment configuration**: §5, §6 (§5.4 revised: Sealed Variables confirmed to exist by Trevor's own check of Railway's documentation, now the preferred mechanism if available in the actual project dashboard, with the key-backup-before-sealing consequence made explicit).
9. **Whether dual-write is necessary for Railway**: refined, not a flat no — see §6.2/§7. Ongoing/structural dual-write is not necessary (a fact about the app's write-once token lifecycle, unrelated to Railway specifically); a brief, explicitly-gated dual-write sub-stage (Phase 2a) is recommended anyway, purely for rollback safety during initial verification, not for format-compatibility reasons.
10. **Exact read precedence during migration**: encrypted columns preferred whenever `access_token_key_id is not null`; plaintext column read only when it is `null`, and only before Phase 6 (§7, §8) — unchanged by this update.
11. **Exact backfill algorithm**: §7 Phase 3, with the exact SQL and concurrency guard shown (unchanged by this update; the values being written are now Base64 text rather than raw bytea, per §2/§3).
12. **How concurrency will be controlled**: conditional `WHERE access_token_key_id IS NULL` (backfill) / `WHERE access_token_key_id = :old_id` (rotation) on every batch update — §7 Phase 3, §13 (unchanged by this update).
13. **Rollback strategy for every phase**: stated inline within each phase in §7, now with an explicit, asymmetric guarantee for Phase 2 specifically (safe through 2a, not safe once 2b has produced a row) — this is the corrected version of a claim my first draft got wrong, per point 1 of Trevor's follow-up.
14. **How webhooks behave during migration**: §1.9, §7 Phase 4, §9 — treated as its own explicit case throughout, not assumed to behave like the synchronous paths.
15. **Error-classification design**: §9.
16. **User-facing decryption-failure behavior**: §10.
17. **Logging/redaction design**: §11.
18. **Recovery procedure**: §12.
19. **Key-rotation procedure**: §13.
20. **KMS migration compatibility**: §14.
21. **Full required test plan**: §16.
22. **Manual actions Trevor would need to perform**: (a) confirm Sealed Variables are actually available on this specific Railway project/dashboard, for both staging (if it exists — unconfirmed, see (e)) and production, and configure the two key env vars that way if so (§5.4) — this is the one item I still cannot complete myself; (b) generate the actual key values for local-dev/staging/production, each independently, and **save each one to a secure backup location before ever pasting it into Railway** — if using Sealed Variables, this order matters and is not reversible (§5.4/§12: once sealed, Railway itself can never show the value again); (c) apply each schema migration by hand, exactly as done for all 8 prior migrations this project has shipped; (d) manually trigger the Phase 2a→2b transition once its verification passes, then later the Phase 3 backfill script and Phase 4's full verification pass; (e) decide whether/when a separate staging environment actually exists to test this rollout against before production — I found no evidence in the repo of a staging Railway service today, only production configuration.
23. **Recommended deployment sequence**: Phase 1 (schema: add columns, drop `access_token`'s `NOT NULL`) → Phase 2a (encryption-aware code, brief dual-write) → verify on 1–2 real new links via the Phase 4 three-step check → Phase 2b (flip to encrypted-only writes) → Phase 3 (backfill existing rows) → Phase 4 (full verification across every path in §1) → Phase 5 (confirm zero remaining plaintext-only rows) → Phase 6 (remove dual-read fallback, redeploy) → soak (§7's suggested couple of weeks, appropriate to this app's low traffic) → Phase 7 (drop the plaintext column, separate migration).
24. **Soak/verification points before each irreversible step**: **before Phase 2b** (the earliest irreversible-in-practice step, per point 1 of Trevor's follow-up — this wasn't called out as its own gate in my first draft, and should have been) — the full three-step Phase 4 check (decrypt, compare to plaintext, `itemGet`) passing on at least one real freshly-linked item, plus a clean server restart with the new code, before flipping `insertPlaidItem` to encrypted-only. Before Phase 6 (removing the read fallback is the point after which an unmigrated row becomes a hard error rather than a graceful fallback) — confirm the zero-plaintext-rows count from Phase 5 with a direct query, not just "the backfill script said it finished." Before Phase 7 (the only truly destructive, hard-to-reverse schema step — dropping a column) — the soak period with zero `MissingEncryptedRepresentationError` occurrences in production logs, plus a final manual confirmation that no code path anywhere still references the plaintext `access_token` column (a repo-wide search, the same kind of search this review already performed for the current state).

**Required for the first secure rollout**: §2 (schema, including the `NOT NULL` drop), §3–§5 (crypto + key management, Base64 at the Supabase boundary), §6.1's encryption-boundary placement, §7 Phases 1–2a–2b–3–4–5–6 with the explicit rollback-safety gate before 2b, §8 (fail-closed rule), §9 (error classes), §16's cryptographic and migration-compatibility tests.

**Recommended hardening, not blocking the first rollout**: §10's dedicated `'credential_error'` status and frontend messaging (the app functions without it, but silently — I'd still push to include this in the same rollout rather than defer it, since a credential failure with no user-visible signal at all is a worse outcome than the small added scope), §11's error-message-hygiene fix to `errorHandler.ts` itself (the new error classes are safe regardless; fixing the handler is a good idea independent of this project), §16's Plaid-path regression tests for the two previously-untested sandbox helpers (valuable, not migration-critical).

**Future KMS/production-scale work, explicitly not now**: §14 in full — the KMS-backed `getKeyForId` implementation, envelope encryption, DEK caching/TTL design.

---

## 19. Implementation Readiness — Final Verdict

**The design is ready for implementation, with exactly one item still outside my ability to resolve and requiring Trevor's own action before (or during) the first deploy, not his approval of a design choice:**

**Confirm Sealed Variables are actually available and configured in the real Railway dashboard, for whichever of staging/production actually exist as separate services (§5.4).** This isn't a decision for Trevor to weigh in on — the design already states the preference and the fallback — it's a fact about his Railway project I have no way to check myself. If Sealed Variables turn out not to be available, nothing else in this design needs to change; the fallback (an ordinary Railway variable, handled the same way `PLAID_SECRET` already is) is already specified.

**Every other point raised in this round is resolved, not merely discussed:**
- The `NOT NULL`/encrypted-only contradiction has one concrete resolution (drop `NOT NULL` in Phase 1; split Phase 2 into 2a/2b) with the rollback guarantee stated as an explicit, asymmetric fact, not a hope.
- The `bytea` assumption has been checked against this repo's actual installed `@supabase/postgrest-js` source and empirically reproduced locally, not left as an assumption — the schema and payload representation now reflect what was actually verified (`text` + Base64).
- Phase 4 verification is now a concrete three-step procedure naming an exact Plaid endpoint (`itemGet`), not a vague "confirm it's decryptable."
- Railway's Sealed Variables are incorporated as the preferred mechanism, with the one remaining unknown being availability-in-Trevor's-actual-dashboard, not whether the feature exists at all.

**No open design question remains that needs Trevor to choose between alternatives before implementation can start.** The one remaining item above is a verification/configuration step, not a decision — it doesn't block writing code, only blocks how the two key-related environment variables actually get set when it's time to deploy to staging/production (local development can proceed today with an ordinary `.env` value, exactly as the original design already specified).

---

## 20. Implementation status (2026-08-26)

Trevor approved this design and asked for implementation to begin, scoped to whatever is safely implementable and testable locally. Phase 1 (schema) and Phase 2a (dual-write, encryption-aware code) are now built and fully tested — see the README's "Plaid access-token encryption" section for the user-facing summary. Concretely:

- `backend/src/services/tokenEncryption.ts` (new) — the crypto module exactly as specified in §3/§5/§9, plus 22 unit tests.
- `backend/src/services/dataService.ts` — the four Plaid-item functions updated for dual-read/Phase 2a dual-write exactly as §6.1/§7 describe, plus 11 new tests.
- `backend/src/controllers/plaidController.ts`, `backend/src/controllers/webhookController.ts` — the `PlaidCredentialError` branch added to all three named catch sites (§9) plus the webhook path (§7 Phase 4's "test this one specifically" instruction), plus a new `webhookController.test.ts` (4 tests).
- `frontend`: the `'credential_error'` status and its plain, reconnect-button-free message (§10) — implemented now rather than deferred, per this document's own recommendation not to ship a silent failure mode.
- `supabase/migrations/20260826050000_plaid_token_encryption_phase1.sql` — written, committed, **not applied**.
- `backend/.env.example` — documents the two new env vars and the exact command to generate a local dev key; the real `backend/.env` was left untouched (Trevor's own file).

**One real implementation-time finding beyond the four points already resolved above**: `getPlaidItemsForUser` returns a whole user's items in one batch, and both its callers (`refreshAccounts`, `syncTransactions`) loop over the result with a per-item `try/catch` that's meant to isolate one item's failure from the rest — exactly the same resilience already used for an item needing re-auth today. Resolving every token eagerly inside that one batch call would have meant a single undecryptable row aborting the whole batch before the per-item loop even started, silently defeating that isolation for every other item. Fixed by making `access_token` a lazy, memoized getter — decryption is deferred to the point something actually reads that specific item's token, which is always inside the existing per-item catch. Covered by dedicated tests in `dataService.test.ts`.

**Deliberately not done in this pass** (per Trevor's explicit instruction not to cross a production boundary autonomously): applying the Phase 1 migration, generating/storing real staging/production keys, any Railway configuration, Phase 2a's live verification against a real deployment, flipping to Phase 2b, and everything from Phase 3 onward. `backend/src/middleware/errorHandler.ts`'s message-forwarding hygiene fix (§11, explicitly marked "recommended hardening, not blocking") was also left untouched, staying narrowly scoped to credential security as §17 asks.

All of the above: typecheck clean, full test suite green (backend 204/204, frontend 158/158), both builds clean — verified together, not just each piece in isolation.

---

## 21. Phase 2a production deployment and verification (2026-08-28)

Phase 2a (§7 Phase 2a) is **live in production and verified**, following the independent Codex read-only audit (three blockers, all fixed — see `feature/phase2a-encryption-reapply` commit `2a1b9a8`) and Trevor's own startup-validation and strict-Base64 corrections (§20).

**Deployment history, for the full honest record**: the first production deploy of this exact commit failed *safely* — Railway logs showed `Refusing to start: Plaid access-token encryption key configuration is invalid. No PLAID_TOKEN_KEY_* environment variables are configured.`, i.e. the startup fail-closed behavior added in §20 worked exactly as designed, and the previous (pre-encryption) backend deployment stayed active and healthy throughout. Diagnosis reproduced `loadKeyRing()` against the actual compiled `dist/services/tokenEncryption.js` with the exact documented env var names and a synthetic test key, and it succeeded — ruling out a code defect (see the diagnosis: `dotenv/config` doesn't override platform-provided vars, `npm run start --workspace backend` doesn't filter the child process's environment, and the compiled build behaves identically to source). Root cause was narrowed to `PLAID_TOKEN_KEY_RAILWAY_PROD_V1` not actually being present in `process.env` for that specific container despite showing configured/sealed in the Railway dashboard — a Railway-side variable scoping/propagation issue, not a design or code problem. Trevor resolved it on the Railway side and redeployed.

**Production verification, confirmed by Trevor directly against the live system**:
- Phase 2a backend deployment Active, `/health` returns 200.
- Pre-existing plaintext-only items: Refresh balances and Sync transactions both still work unchanged.
- A newly linked Plaid Sandbox item (Tartan Bank) was dual-written with plaintext `access_token` **and** all 5 encrypted columns (`access_token_ciphertext`, `access_token_nonce`, `access_token_auth_tag`, `access_token_key_id = RAILWAY_PROD_V1`, `access_token_enc_version = 1`).
- Refresh balances and transaction sync both succeeded against the new encrypted item.
- Sandbox webhook processing succeeded for both an older plaintext item and the new encrypted item — the one path (§7 Phase 4) called out for separate testing, since it's async/fire-and-forget relative to the HTTP response.
- Production logs showed sanitized Plaid/Axios error summaries (§20's error-sanitizer fix) with no credential material.
- Final production integrity query: `total_items = 3`, `encrypted_items = 1`, `plaintext_only_items = 2`, `plaintext_missing_items = 0`, `partial_encrypted_items = 0`, `unexpected_key_id_items = 0`, `unexpected_version_items = 0`, `distinct_encrypted_nonces = 1`. Zero anomalies of any kind.

This confirms every §7 Phase 4 check for the currently-live rows, matches the shape §7 Phase 2a described (dual-write, dual-read, zero downstream code changes for existing plaintext items), and gives a concrete, current count for what Phase 3 (backfill) is actually working against: **exactly 2 plaintext-only rows**, not a hypothetical or estimated number.

Phase 2b, backfill, and everything after remain **not started** — no plaintext writes have stopped, no plaintext reads have stopped, no plaintext has been touched.

## 22. Phase 2b / backfill proposal — for review, not yet approved or implemented

This refines §7's Phases 3–7 with the concrete state confirmed in §21, rather than replacing it. Nothing in this section has been implemented; it is a plan to review.

**1. How the two existing plaintext-only items will be encrypted safely**

A one-off Node script (`backend/scripts/backfillTokenEncryption.ts` or similar — not part of the request-serving path, not a scheduled job), run manually by Trevor against production with real production credentials in scope, following §7 Phase 3 exactly: select rows where `access_token_key_id is null`, and for each, call the existing `encryptAccessToken(plaintext, getKeyRing(), row.id)` — the same function and same key ring already proven correct in production — then write the 5 encrypted columns with the concurrency guard below. Given the current count (2 rows), this runs as a single small batch, not a multi-batch job; §7's batching guidance for a larger table isn't operationally relevant here but the script would still use it as written, for correctness under any future growth in item count.

**2. Idempotent/concurrency-safe backfill behavior**

Exactly §7 Phase 3's guard, unchanged: every `update` carries `where id = :id and access_token_key_id is null`. If a row was already encrypted between the script's `select` and its `update` — by a concurrent run of the same script, or by ordinary live traffic re-inserting/updating that row — the `where` clause matches zero rows and the write silently no-ops rather than overwriting a newer encrypted value with a stale re-encryption. Safe to interrupt and re-run from the start at any point: already-encrypted rows are simply skipped on the next pass (they no longer match `access_token_key_id is null`).

**3. How each backfilled item will be verified before anything plaintext-related is retired**

Exactly §7 Phase 4's three-step per-row verification, run immediately after that row's `update` commits, before the script moves to the next row: (1) decrypt the just-written encrypted representation using the key ring; (2) compare the decrypted string against that same row's still-present plaintext `access_token` column in memory (`===`), logging only `{ id, match: true/false }` — never either string; (3) call `plaidService.getItemInstitution` (wraps Plaid's `itemGet`) with the decrypted value to confirm it's still a live, Plaid-accepted credential, not just byte-identical to what was stored. Any row failing step 2 or step 3 is left as-is (not retried automatically, not silently skipped from the report) and the script halts rather than continuing past a first verification failure — a failure here means something is wrong with encryption itself, not with one unlucky row, and continuing to encrypt more rows under that condition would be unsafe.

**4. Rollback boundaries**

Unchanged from §7's explicit, asymmetric statement: rolling back to pre-Phase-2 code stays fully safe through the entire backfill (Phase 3) and through Phase 5, because every row still carries its plaintext `access_token` until Phase 6 removes the dual-read fallback and Phase 7 (much later) drops the column. The backfill script itself never deletes or blanks plaintext — §7 Phase 3's "never modify or delete plaintext during this phase" holds exactly as written. The only phase in this proposal where rollback safety changes is Phase 6 (see point 7 below), and that boundary is deliberately not being crossed as part of this proposal — it would need its own separate approval after a soak period.

**5. What Trevor must perform as live checks**

Before running the script: confirm the integrity query still shows `plaintext_only_items = 2` (or whatever the current count is at that moment) and `partial_encrypted_items = 0`, so the starting state matches expectations. After the script completes: re-run the same integrity query and confirm `plaintext_only_items = 0`, `partial_encrypted_items = 0`, `unexpected_key_id_items = 0`, `unexpected_version_items = 0`, and `distinct_encrypted_nonces` equal to the new total encrypted-item count (proving no nonce reuse across the newly-encrypted rows); spot-check Refresh balances and Sync transactions on the two now-encrypted (previously plaintext-only) items specifically, since those are the only two rows this backfill actually changes the read path for; confirm production logs show no raw credential material during the run (same sanitized-error check as §21).

**6. When plaintext writes stop**

Already true today — per §7 Phase 2b (not yet entered) is when new-row plaintext writes would stop; Phase 3 (this proposal) never writes plaintext for existing rows either, only encrypts alongside what's already there. Concretely: plaintext writes for **new** items stop the moment `insertPlaidItem` flips to Phase 2b (a small, separate code change from this backfill), not as part of running the backfill script itself. This proposal recommends Phase 2b be entered *before* running the backfill, so no new plaintext-only rows can appear mid-backfill — otherwise the backfill's "select where `access_token_key_id is null`" could chase a moving target if new items are linked during the run.

**7. When plaintext reads stop**

Per §7 Phase 6, only after Phase 5 confirms zero remaining plaintext-only rows (this backfill is what gets that count to zero) — this proposal does **not** include Phase 6. Removing the dual-read fallback is a separate, later change requiring its own approval, since it's the first point where rolling back to pre-encryption code becomes unsafe for any row.

**8. When the plaintext column could eventually be removed**

Unchanged from §7 Phase 7: only after a deliberate soak period following Phase 6 — on the order of a couple of weeks of clean production operation with zero `MissingEncryptedRepresentationError` occurrences, given this app's low traffic volume. Not part of this proposal; explicitly a future, separately-approved migration.

**9. What Codex should independently review before execution**

- The backfill script itself, read-only against the actual file once written: the concurrency guard (`and access_token_key_id is null` on every update), that it never writes or clears the plaintext column, and that per-row verification (point 3) halts the whole run on first failure rather than continuing or silently skipping.
- That the script reuses the existing `encryptAccessToken`/`getKeyRing`/`plaidService.getItemInstitution` functions rather than reimplementing any crypto or Plaid-call logic.
- That the Phase 2b code change (flipping `insertPlaidItem` to stop writing plaintext for new rows) lands and is verified *before* the backfill script runs, per point 6 above — sequencing, not just the diff content.
- That nothing in the script or its invocation logs plaintext, decrypted values, or key material — the same sanitized-logging standard already enforced elsewhere in this codebase (§11, §20's error sanitizer).
- The rollback-safety boundary statement in point 4 above, checked against the actual state of `dataService.ts` at the time of execution (not just against this document), since code can drift between this proposal being written and being executed.

---

## Files this review is grounded in (all read in full or in relevant part while producing this document)

`backend/src/services/plaidService.ts`, `backend/src/services/dataService.ts` (Plaid-item section), `backend/src/services/syncService.ts`, `backend/src/services/loans.ts`, `backend/src/controllers/plaidController.ts` (in full), `backend/src/controllers/webhookController.ts`, `backend/src/services/webhookVerification.ts`, `backend/src/services/plaidErrors.ts`, `backend/src/middleware/auth.ts`, `backend/src/middleware/errorHandler.ts`, `backend/src/index.ts`, `backend/src/config/env.ts`, `backend/src/config/plaid.ts`, `backend/src/config/supabase.ts`, `backend/src/types/index.ts`, `backend/src/services/syncService.test.ts`, `backend/.env.example`, `backend/package.json`, `railway.json`, `supabase/migrations/20260825195130_remote_schema.sql` (the `plaid_items` table definition and its RLS status specifically), and a full-repo search confirming no frontend file ever references a Plaid `access_token`.

**Added for this update (2026-08-26)**: `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts` (the exact request-body serialization code, confirmed version 2.112.3 via `node_modules/@supabase/postgrest-js/package.json` and `node_modules/@supabase/supabase-js/package.json`), plus a local, network-free Node snippet reproducing `JSON.stringify` on a `Buffer` and confirming lossless Base64/hex round-tripping — no database was touched, no schema was created or modified, no application code or data was altered.

**No code was modified in producing this review or this update. Awaiting Trevor's confirmation of Railway Sealed Variable availability before implementation begins — see §19.**

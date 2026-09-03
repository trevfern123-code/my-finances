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
- **Corrected 2026-08-30, see §22's "Rollback boundaries" for the full three-point analysis**: rolling back is not one cliff at Phase 2b. **Phase 2a remains a fully valid rollback target all the way through Phase 6** (dual-read removed from the *then-current* code) — Phase 6 changes application code, not the schema, and Phase 2a's own dual-read already knows how to handle an encrypted-only row. Only **Phase 7** (`access_token` column physically dropped) makes every earlier version of the code — including Phase 2a — unable to run against the schema at all. The earlier wording here ("Phase 6 ... or Phase 7 ... is categorically unsafe") incorrectly lumped Phase 6 in with Phase 7; it wasn't.

### Phase 3 — Backfill existing plaintext credentials
**Superseded by §22's detailed, corrected design (revised 2026-08-30 after an independent Codex review of the original backfill plan) — read §22 before implementing anything, this section is kept only for original context.** High-level shape, still accurate:
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

### Phase 4 — Verification (corrected per point 3 of Trevor's follow-up; superseded again by §22)
**§22's "Verification model" section is now the authoritative per-row verification design** — it corrects a real gap in the per-row verification described just below (treating "encrypted" as proof of "verified" isn't safe across a crash/resume). Kept here for original context. Before touching plaintext at all, confirm every path in §1 still works with encrypted rows: initial Link (new row, encrypted-only from Phase 2b onward), manual sync, manual balance refresh, webhook-triggered sync (**test this one specifically and separately** — it's the async path, §1.9), liabilities refresh, recurring-streams refresh, reconnect/Update Mode, both sandbox helpers, and a full server restart (to prove the key-ring loads correctly from environment on a cold start, not just that it happened to already be in memory from before the migration began).

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

**The backfill script's own test plan is superseded by §22's "Required test plan"** (revised 2026-08-30 after Codex's review) — this section's cryptographic/migration/controller test coverage below is unaffected and still accurate for the already-shipped Phase 1/2a code.

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

## 22. Phase 2b / backfill proposal — revised 2026-08-30 (second revision, after Codex's design/execution review), for review, not yet approved or implemented

This refines §7's Phases 3–7 with the concrete state confirmed in §21, rather than replacing it. Nothing in this section has been implemented; it is a plan to review.

**Revision history**: the 2026-08-29 revision fixed the sequencing (backfill before Phase 2b, not after) and the rollback-boundary analysis, per Trevor's own review. Trevor then had Codex independently review that revised design and Codex returned **NOT READY**, with real findings — not stylistic ones. This revision incorporates all of them, exactly, before anything is implemented:

1. **The verification design conflated "encrypted" with "verified."** The original design treated a non-null `access_token_key_id` as proof a row had been through verification. It isn't — it only proves a write happened. A crash between the `update` committing and the three-step verification completing (process killed, `itemGet` times out, etc.) would leave a row encrypted but never actually confirmed, and a naive resume (`select where access_token_key_id is null`) would skip it forever, silently treating an unverified row as done.
2. **The execution plan used `railway run`, which runs locally.** Codex confirmed `railway run` injects that service's environment variables into a *locally-spawned* process — exactly the local secret exposure Trevor explicitly ruled out, not an honest caveat to route around.
3. **The reused Plaid verification helper (`getItemInstitution`) does more than verify the credential.** Checked directly against `backend/src/services/plaidService.ts:39-56`: it calls `itemGet` **and then** `institutionsGetById`. An institution-lookup failure (a real, distinct Plaid failure mode, unrelated to whether the credential itself is valid) would be indistinguishable from a genuine credential problem — exactly the false-positive Codex flagged.
4. Several other gaps: no dry-run-by-default, no explicit confirmation gate on writes, no distinction between "transient, retry-safe" and "non-transient, must-halt" Plaid failures, no defined signal-handling behavior, and logging discipline wasn't pinned down as an explicit allow-list.

None of these were cosmetic — each one is a real crash-safety, credential-exposure, or false-positive/false-negative risk. All are corrected below.

### Three distinct concepts, kept separate throughout the design (point 2)

Codex's core finding was really this one, underlying most of the others: this design must never collapse **"is this row encrypted"** into **"has this row been verified."** Concretely, three separate concepts, computed independently every run:

- **Target identity** — the internal `plaid_items.id`. Fixed, supplied explicitly via `--target-ids`, never discovered by a broad query at apply time (point 4 below).
- **Storage state** — read fresh from the database *this run*, never assumed or cached from a prior run or from this run's own in-memory copy of what it just wrote: `plaintext_only` (`access_token_key_id is null`), `encrypted` (`access_token_key_id is not null`, all 5 encrypted columns populated per the `plaid_items_encrypted_token_complete` constraint), or an anomaly (`partial` — shouldn't be possible given that constraint, but checked for explicitly rather than assumed impossible).
- **Verification result** — computed fresh *every run*, for *every* target, regardless of storage state. A row already showing `encrypted` storage state is **not** treated as verified — it is re-decrypted from what's actually stored, re-compared, and re-checked against Plaid, exactly as if this were the first time. There is no "skip verification, it's already encrypted" branch anywhere in this design.

### Verification model — resumable, always re-derived from the database (points 1, 6)

Every target, on every invocation (dry-run or apply, first run or resumed), goes through the same sequence — nothing is inferred from a prior run's outcome:

1. **Reread** the target row from the database right now (not a value held in memory from earlier in this process, and never a value held in memory from a *previous* process invocation).
2. If storage state is `plaintext_only`: (apply mode only) perform the guarded update below, then **reread again** — the row that verification checks is always the one just confirmed present in the database, never the locally-built ciphertext object the script computed before the write.
3. If the guarded update affected **zero rows** (another process's write won the race — see below): reread and verify **that** row, the actual database winner. The local ciphertext this run computed and lost the race with is discarded outright and never fed into verification.
4. Regardless of how storage state became `encrypted` (this run's own write, a resumed run finding it already encrypted from a prior interrupted attempt, or the lost-race path above): **decrypt the ciphertext actually stored in the database right now**, compare it against the plaintext held in memory from this run's own initial reread (`===`), then call the dedicated `itemGet`-only verifier (below) with the decrypted value.
5. Only a fully-passed three-step check is ever reported as `verified`. There is no partial-credit state.

**Concurrency guard, restated precisely** (point 1's crash scenario, point 6):
```sql
update public.plaid_items
set access_token_ciphertext = :ciphertext,
    access_token_nonce = :nonce,
    access_token_auth_tag = :auth_tag,
    access_token_key_id = :key_id,
    access_token_enc_version = 1,
    updated_at = now()
where id = :id
  and access_token_key_id is null;
```
`access_token` never appears in the `set` list — the script is structurally incapable of writing or clearing plaintext, not merely instructed not to. A zero-row result means someone else's write already landed; the correct response is to reread and verify *their* result, never to treat zero-rows-affected as "nothing to do" or to fall back to verifying this run's own discarded computation.

### Dedicated Plaid verifier (point 7)

New, thin function — reused by the script, not reimplemented by it — that calls **only** `itemGet`:
```ts
// backend/src/services/plaidService.ts — new export, additive, no existing export changed
export async function verifyAccessTokenLive(accessToken: string): Promise<void> {
  await plaidClient.itemGet({ access_token: accessToken });
  // Success = Plaid accepted the credential. We deliberately discard the response body —
  // this function exists only to answer "is this credential still valid," never to fetch
  // institution/account data, so a later, unrelated Plaid call can never be mistaken for a
  // credential failure (see the getItemInstitution gap this replaces, §22 revision history).
}
```
The existing `getItemInstitution` (`itemGet` + `institutionsGetById`) stays exactly as-is for its current callers — nothing about it changes; the backfill script simply never calls it.

### Retry policy (point 8)

Only the `itemGet` call in step 4 above can experience a transient failure — steps 1–3 (reread, local decrypt, `===` compare) are pure local computation with no network dependency and therefore no transient-failure category at all.

- **Retried, bounded** (e.g. 3 attempts, short exponential backoff): request timeout / network-level transient error, HTTP 429, HTTP/Plaid 5xx.
- **Never retried, always a hard failure**: GCM authentication failure, unknown key id, unexpected `access_token_enc_version`, malformed database state (e.g. a `partial` row — see "three concepts" above), a plaintext/decrypted mismatch, or Plaid legitimately rejecting the credential (e.g. `ITEM_LOGIN_REQUIRED`, `INVALID_ACCESS_TOKEN`) — none of these become correct by waiting and asking again.
- **Any verification failure — retry-exhausted or immediately non-transient — halts the entire run**, consistent with the existing halt-on-first-failure principle: it doesn't skip to the next target, and it exits nonzero. The two cases are logged with a distinguishable reason (`transient_retry_exhausted` vs. e.g. `crypto_mismatch`) so Trevor knows whether "just try again later" or "stop and investigate" is the right next step — but both leave the encrypted representation exactly as committed, never rolled back, since undoing a write is itself a risk and a future rerun re-verifies it fresh regardless (per the resumable model above).

### Interruption behavior (point 9)

On SIGINT/SIGTERM: stop picking up any new target, let an already-issued single-statement database write finish naturally (Postgres commits it atomically; there is no safe way to "abort" it mid-flight that's worth the added complexity), then exit nonzero with an explicit message that the run was interrupted — **never** a success/completion message under any interrupt path. The design deliberately assumes the in-flight write may have already committed by the time the signal is handled; this requires no special interrupt-recovery logic of its own precisely because the verification model above already rereads and re-verifies every target from scratch on every run, interrupted or not.

### Command-line interface (points 3, 4)

Dry-run is the default — no flag needed to get it, only to leave it:
```
node dist/scripts/backfillTokenEncryption.js --target-ids <uuid-1>,<uuid-2> --expected-total 3 --expected-plaid-env sandbox
```
Confirms, all read-only, and prints a report: exact total `plaid_items` count matches `--expected-total`; the two supplied target ids currently exist and their storage state (should be `plaintext_only` for both, today); zero rows anywhere in the table are in a `partial` state; `PLAID_ENV` matches `--expected-plaid-env`; the key ring's current key id is `RAILWAY_PROD_V1` and would encrypt at `enc_version = 1`; plaintext is present on both targets; **no row in the whole table currently has `access_token_key_id is not null and access_token is null`** — this is the concrete, checkable proxy for "Phase 2a dual-write is still active, Phase 2b hasn't silently begun," since the script can't inspect the deployed server's source directly, only infer it from data; and both `plaid_items_token_present` and `plaid_items_encrypted_token_complete` (the exact Phase 1 constraint names, `supabase/migrations/20260826050000_plaid_token_encryption_phase1.sql`) still exist on the table. Any check failing exits nonzero with a specific reason; nothing is written in this mode, ever. Running with no `--target-ids` at all is also supported and stays read-only — it just lists current `plaintext_only` candidates, so Trevor can discover/confirm the two ids before ever writing anything.

Apply requires every one of these together — any one missing or wrong refuses to run:
```
node dist/scripts/backfillTokenEncryption.js \
  --apply \
  --confirm BACKFILL_PLAID_TOKENS \
  --target-ids <uuid-1>,<uuid-2> \
  --expected-total 3 \
  --expected-plaid-env sandbox
```
`--apply` and `--confirm BACKFILL_PLAID_TOKENS` (exact string, case-sensitive) are both required — either alone does nothing. `--target-ids` must name the exact rows to touch; there is no "encrypt everything matching a query" mode, in apply or anywhere else in this script. `--expected-total` and `--expected-plaid-env` are required and checked identically to dry-run, so apply mode runs the full dry-run check first, internally, before writing anything — apply is dry-run-plus-writes, not a separate, less-checked path.

### Rollback boundaries — unchanged from the 2026-08-29 revision, restated for completeness (point 12)

- **Point A** — rollback to pre-encryption code stops being universally safe the moment Phase 2b is deployed and creates its first encrypted-only new row. Not at the backfill: the backfill only ever adds encrypted columns alongside plaintext that's already there, so every row stays readable by pre-encryption code through the backfill, its verification, and the soak.
- **Point B** — rollback to **Phase 2a** remains safe from Point A onward, through Phase 2b, Phase 5, and Phase 6, because Phase 2a's existing dual-read logic already handles an encrypted-only row correctly with zero further code change.
- **Point C** — guarantees change again only at **Phase 7** (the `access_token` column physically dropped) — the first point even Phase 2a can't run against the schema at all.

§7 Phase 2's rollback bullets and §22's own earlier point 7 both contained stale language implying Phase 6 was as unsafe as Phase 7 for rollback purposes — both corrected in place (see §7 Phase 2 and "When plaintext reads stop" below).

### Corrected end-to-end sequence

1. **Now**: Phase 2a stays deployed, unchanged. No code change in this step.
2. Write the backfill script on a **new branch cut from current `main`** (point 11 — not a reuse of the already-merged `feature/phase2a-encryption-reapply`), get it reviewed (see the Codex checklist below).
3. Deploy it as an ordinary part of the next regular backend deploy. It is inert from the running server's perspective (see "Execution environment" below) — this step changes nothing about what the live service does.
4. Trevor runs a **remote dry-run** (Execution environment, below) against the two known plaintext-only rows — read-only, confirms every invariant, writes nothing.
5. Trevor runs a **remote apply** with `--apply --confirm BACKFILL_PLAID_TOKENS` against exactly those two target ids. The script encrypts, concurrency-guards, and re-verifies each target per the verification model above, halting immediately on any failure.
6. Trevor performs the live checks below (integrity query, log check).
7. Trevor manually tests balance refresh, transaction sync, and webhook processing on each of the two now-backfilled items specifically.
8. **Soak/checkpoint period, still on Phase 2a** — length at Trevor's discretion (a few days is reasonable given this app's low traffic). Rollback to pre-encryption code remains fully safe throughout (Point A hasn't been reached yet).
9. **Only after that soak passes cleanly**: a separate, later Phase 2b deployment flips `insertPlaidItem` to stop writing plaintext for brand-new items — its own change, its own approval, not bundled with the backfill.
10. *(Future, separate, not part of this proposal)* Phase 5 → Phase 6 → Phase 7, each already described in §7, rollback guarantees shifting exactly per Points A/B/C above.

**1. How the two existing plaintext-only items will be encrypted safely** — see "Verification model" and "Command-line interface" above; the underlying encryption call is unchanged, `encryptAccessToken(plaintext, getKeyRing(), row.id)`, the same function and key ring already proven correct in production.

**2. Idempotent/concurrency-safe backfill behavior** — see "Verification model" above (the guarded `update`, and the explicit "reread the database winner, never verify discarded local state" rule).

**3. How each backfilled item will be verified before anything plaintext-related is retired** — see "Verification model," "Dedicated Plaid verifier," and "Retry policy" above.

**4. Rollback boundaries** — see the dedicated section above.

**5. What Trevor must perform as live checks**

Before applying: run the dry-run above and read its report. After applying: re-run the integrity query and confirm `plaintext_only_items = 0`, `partial_encrypted_items = 0`, `unexpected_key_id_items = 0`, `unexpected_version_items = 0`, and `distinct_encrypted_nonces` equal to the new total encrypted-item count; manually test Refresh balances, Sync transactions, and (via Plaid's sandbox webhook trigger) webhook processing on each of the two newly-encrypted items specifically (step 7 of the corrected sequence); confirm production logs from the run contain only allow-listed fields (Logging, below). During the soak: periodically confirm those same two items keep syncing/refreshing normally under ordinary use.

**6. When plaintext writes stop** — unchanged: only at the separate, later Phase 2b deployment (step 9 of the corrected sequence), never as part of the backfill itself.

**7. When plaintext reads stop — corrected**

Per §7 Phase 6, only after Phase 5 confirms zero remaining plaintext-only rows — this proposal does **not** include Phase 6. **Corrected**: removing the dual-read fallback at Phase 6 does *not* by itself make Phase 2a stop being a valid rollback target — that was the stale claim in the prior revision, and it's wrong for the same reason §7 Phase 2's bullet was wrong (Point C above is Phase 7, not Phase 6). Phase 6 is still its own separately-approved change; the reason it needs one is that it changes the currently-deployed code's own failure behavior (treating a stray plaintext-only row as a hard error), not because it collapses the rollback story.

**8. When the plaintext column could eventually be removed** — unchanged from §7 Phase 7: a further multi-week soak after Phase 6, zero `MissingEncryptedRepresentationError` occurrences, its own separate migration.

### Execution environment — remote Railway execution, no local secret exposure (point 5)

Trevor confirmed via Codex that `railway run` executes **locally**, injecting that service's variables into the local process — exactly what he ruled out. Corrected to Railway's remote single-command execution instead:

- **Where the script lives, and how it deploys**: unchanged from the prior revision — `backend/src/scripts/backfillTokenEncryption.ts`, part of the normal backend source tree, compiled by the same `tsc -p tsconfig.build.json` build as every regular deploy, **never imported by `index.ts`** or anything in the request-serving module graph (inert on deploy), with its own entrypoint guard refusing to run unless launched directly. `railway.json`'s `deploy.startCommand` stays exactly `npm run start --workspace backend`, untouched; the backfill is a separate `npm` script the deployed service never runs on its own.
- **How it's invoked — remote, inside Railway, not local**:
  ```
  railway ssh --project <PROJECT_ID> --service <BACKEND_SERVICE> --environment production --deployment-instance <INSTANCE_ID> -- \
    node dist/scripts/backfillTokenEncryption.js --target-ids <uuid-1>,<uuid-2> --expected-total 3 --expected-plaid-env sandbox
  ```
  and, for apply, the same with `--apply --confirm BACKFILL_PLAID_TOKENS` appended. This runs the command inside the running production container over SSH, using the variables already injected into that container's own environment — nothing is copied to, or ever present in, Trevor's local process. **Honest caveat, flagged rather than glossed over**: I have not independently verified the exact current flag surface of `railway ssh` (project/service/environment/deployment-instance naming) against Railway's live CLI, the same kind of platform-specific fact I couldn't verify for Sealed Variables in §5.4 or for `railway run`'s behavior before Codex checked it. Trevor should confirm the exact flags via `railway ssh --help` (or the current docs) before first use — the property that matters for this design (execution happens inside the container, not locally) is what to insist on, not the exact spelling of the flags.
- **Which credentials/variables it needs**: exactly what's already configured for the backend service today — `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, `PLAID_TOKEN_KEY_RAILWAY_PROD_V1` / `PLAID_TOKEN_CURRENT_KEY_ID`, `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV`. Nothing new is created, copied, or displayed to Trevor at any point.
- **How we avoid printing secrets**: see "Logging," below.
- **How Trevor manually triggers it**: the one explicit `railway ssh ... -- node dist/scripts/backfillTokenEncryption.js ...` command (dry-run first, then apply) — never wired to a deploy hook, cron, or the server's own startup path.
- **How to stop/abort it**: Ctrl+C on the local `railway ssh` session sends the interrupt through to the remote process (standard SSH behavior); the remote process's own SIGINT/SIGTERM handling (above) governs what happens next — no success message, safe to rerun.
- **Whether deploying the script changes application behavior**: no — inert until invoked as its own process, exactly as the prior revision established.
- **How we ensure it cannot run automatically on deploy/startup**: unchanged three-part guarantee — never imported by the server's module graph, `startCommand` never references it, and the script's own entrypoint guard refuses indirect invocation.

### Logging (point 10)

Structured, allow-listed fields only — every log line is built from an explicit small set of safe fields, never from spreading/serializing a row or error object wholesale:
- **Always allowed**: the internal `plaid_items.id`, the current stage (`storage_check` / `encrypt` / `verify_decrypt` / `verify_compare` / `verify_plaid` / `done`), and a safe outcome (`verified` / `failed:<reason>` / `skipped_dry_run` / `interrupted`).
- **Never logged, under any code path in this script**: the plaintext token, the decrypted token, ciphertext, nonce, auth tag, any key material, the *external* Plaid `item_id` (stricter than this codebase's existing webhook logging, which does log it — a deliberate, narrower rule for this specific script, not a change to any other file), raw Axios/Plaid error objects (routed through the existing `summarizeErrorSafely()`, §20, same as every other Plaid-facing call site), or environment contents.

### Implementation branch (point 11)

When implementation is approved: a **new branch cut from current `main`**, not a reuse of `feature/phase2a-encryption-reapply` (already merged and gone as an active line of work).

### What Codex should independently review before execution (expanded)

- That storage state and verification result are genuinely never conflated anywhere in the script — specifically, that there is no code path that treats a non-null `access_token_key_id` as sufficient to skip the three-step verification.
- The concurrency guard (`and access_token_key_id is null`, `access_token` absent from every `set` list) and that a zero-row update result triggers a reread-and-verify-the-winner path, never a verify-the-discarded-local-object path.
- That `verifyAccessTokenLive` calls only `itemGet` — no institution lookup, no other Plaid call — and that the script never calls `getItemInstitution` instead.
- The retry policy: exactly which failure categories are retried (transient network/429/5xx) vs. never retried (crypto/key/version/state/comparison/legitimate-rejection), and that any exhausted-retry or non-transient failure halts the whole run and exits nonzero.
- SIGINT/SIGTERM handling: no success message on any interrupted path, and that the next run's behavior is correct without any special interrupt-recovery code (because it re-verifies everything unconditionally).
- The CLI surface: dry-run is truly the default (no flags produce a write), `--apply` alone doesn't write without `--confirm BACKFILL_PLAID_TOKENS`, `--target-ids` is required and exact (no broad-match mode exists anywhere), and `--expected-total`/`--expected-plaid-env` are enforced, not merely logged.
- Logging: every log call site against the allow-list above, including error paths (not just the happy path).
- That the script is genuinely unreachable from the running server's startup path — not imported by `index.ts`'s module graph, `startCommand` unchanged, entrypoint guard present.
- The rollback-boundary statement (Points A/B/C) checked against the actual state of `dataService.ts` at execution time, since code can drift between this proposal and its execution.
- That the implementation branch was cut from current `main`, not reused from the old Phase 2a branch.

### Required test plan (point 13)

- Dry-run performs zero writes (assert no `update` is ever issued in dry-run mode, across every check outcome).
- Apply refused with `--apply` missing.
- Apply refused with `--confirm` missing or set to the wrong string.
- Apply refused when `--expected-total` doesn't match the live count.
- Apply refused when a supplied target id doesn't exist, or doesn't currently have `plaintext_only` storage state.
- A target already `encrypted` (from a prior run) is still fully re-verified, not skipped — this is the core point-1 regression test.
- Simulated crash: update commits, then the process is interrupted before verification runs; the *next* invocation re-verifies that target from a fresh reread rather than treating it as done.
- A guarded update that affects zero rows (simulated concurrent winner) causes a reread of the actual stored row and verification of that reread value, never of the run's own discarded local ciphertext.
- A row in a `partial` encrypted state (simulated, shouldn't occur given the constraint) is detected and refused rather than guessed at.
- An unexpected `access_token_key_id` (not in the configured key ring) or unexpected `access_token_enc_version` fails verification as a non-transient, non-retried error.
- A plaintext/decrypted mismatch fails verification as a non-transient, non-retried error.
- Verification decrypts and compares the value actually reread from the database, not a value held from earlier in the same run (a regression test specifically for point 6 — e.g. simulate the database row changing between the write and the verification read, and assert the newer value is what's checked).
- A transient Plaid failure (simulated timeout/429/5xx) is retried up to the bound and can still succeed within it.
- A transient Plaid failure that exhausts all retries halts the run, exits nonzero, and is logged with a distinguishable `transient_retry_exhausted` reason.
- A non-transient Plaid failure (e.g. simulated `ITEM_LOGIN_REQUIRED`) is never retried and halts immediately.
- SIGINT/SIGTERM mid-run exits nonzero and never emits a success/completion message.
- Logging sentinel tests (same pattern as `errorSanitizer.test.ts`, §20): construct fixtures containing sentinel plaintext/ciphertext/key/Plaid-item-id values and assert none ever appear in any logged output, across every code path including error paths.

---

## 23. V1 → V2 key rotation and backfill — fully complete, V1 removed from production

**Trigger**: the production `RAILWAY_PROD_V1` encryption key was accidentally visible in a screenshot during earlier setup. Treated as compromised the moment this was discovered — not because of any observed misuse, but because "accidentally exposed" and "still safe to rely on" are mutually exclusive for a symmetric key by design.

**Tooling**: two Codex-audited, purpose-built scripts (design in §22's rotation addendum, referenced from `backend/src/scripts/`) — `rotateTartanTokenKey.ts` (a fixed-purpose, one-row V1→V2 rotation for the Tartan Sandbox item) and the existing reviewed `backfillTokenEncryption.ts` retargeted from `RAILWAY_PROD_V1` to `RAILWAY_PROD_V2` as its approved current key. Both went through multiple Codex audit rounds — including a real bug caught on re-audit (the already-V2 fast path's mandatory fresh reread wasn't independently reclassified before verification, so a stale classification could in principle have produced a false `verified`; fixed at commit `9c1f135`) — before being merged to `main` at `c272c42`. Neither script is reachable from the running server; both are manual, one-off, `require.main === module`-guarded CLIs.

**Production sequence executed**: `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` added to Railway alongside the still-present V1 key → redeploy → `PLAID_TOKEN_CURRENT_KEY_ID` flipped to `RAILWAY_PROD_V2` → redeploy → Tartan rotation (dry-run, then apply) → the two-row backfill, now targeting V2 directly (dry-run, then apply) → global verification.

**Verified production state, confirmed by Trevor directly**:
- `PLAID_TOKEN_CURRENT_KEY_ID=RAILWAY_PROD_V2`; both `RAILWAY_PROD_V1` and `RAILWAY_PROD_V2` remain configured in Railway (V1 deliberately retained — see below).
- All 3 `plaid_items` rows now encrypted under `RAILWAY_PROD_V2`: `v1_items = 0`, `v2_items = 3`.
- Plaintext `access_token` still present on all 3 rows — Phase 2a's dual-write is still the active behavior; **Phase 2b has not started**, and nothing in this rotation touched that.
- Zero partial encrypted representations, zero unexpected key ids, zero unexpected versions.
- 3 distinct nonces (no nonce reuse across the rotated/backfilled rows).
- Functional verification passed: Refresh balances, account sync, transaction sync, and Sandbox webhook processing all succeeded across the affected items.
- Zero crypto/decryption/key-configuration errors observed in production logs.
- A pre-existing `ADDITIONAL_CONSENT_REQUIRED` error on one loan is confirmed **unrelated** to encryption — a separate, already-known Plaid consent-scope condition, noted here explicitly so it is never mistaken for a rotation regression in a future review.

**§25's post-soak checklist has now been completed — V1 fully removed.** Final confirmed production state: `PLAID_TOKEN_CURRENT_KEY_ID=RAILWAY_PROD_V2`; `PLAID_TOKEN_KEY_RAILWAY_PROD_V1` removed from Railway entirely; `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` remains configured; the backend redeployed successfully running on V2 only (`validateKeyRingOrExit()` passed with no V1 present, proving nothing live still depended on it); all 3 items refresh/sync successfully; Sandbox webhook tests succeeded for all 3; zero `UnknownKeyIdError`, decrypt failures, or `credential_error` observed; the pre-existing `ADDITIONAL_CONSENT_REQUIRED` loan error remains confirmed unrelated. Final Supabase integrity: `total_items = 3`, `encrypted_items = 3`, `plaintext_only_items = 0`, `plaintext_missing_items = 0`, `partial_encrypted_items = 0`, `v1_items = 0`, `v2_items = 3`, `unexpected_version_items = 0`, `distinct_encrypted_nonces = 3` — every metric clean. The V1 → V2 rotation is complete end to end: no code, schema, or application behavior remains dependent on the exposed key, and the key itself no longer exists anywhere this application can reach.

## 24. Phase 2b proposal (revised for the post-rotation state) — design only, not yet approved or implemented

Phase 2b is the one piece of the original 7-phase design (§7 Phase 2, §6.2) still not done: **stop writing the plaintext `access_token` column for newly-linked items.** It is entirely independent of the V1→V2 rotation — rotation is about *which key* encrypts a row; Phase 2b is about *whether plaintext is written at all* — but the rotation does mean any new row Phase 2b creates will automatically encrypt under whatever is current, which today is `RAILWAY_PROD_V2`, with no extra work required for that to be true.

**Recommended sequencing**: do not implement Phase 2b until *after* §25's V1-removal checklist has fully completed. Nothing about Phase 2b technically requires V1 to be gone first, but this project's whole approach has been one verified change at a time — keeping the current soak scoped to "did the rotation work" rather than layering a second, unrelated change on top of it. This is a recommendation, not a hard dependency; Codex should confirm whichever sequencing is actually followed at implementation time (see §26).

**The code change itself** — small and precisely scoped: in `dataService.ts`'s `insertPlaidItem`, stop passing `access_token: params.accessToken` in the insert payload for new rows (leave it unset, i.e. `null`, matching the now-nullable column from Phase 1). Nothing else about `insertPlaidItem` changes: `id` is still generated client-side via `randomUUID()` before the insert (still needed for the AAD), and the 5 encrypted columns are still always populated via `encryptAccessToken(accessToken, getKeyRing(), id)` exactly as today — this already always uses whatever key is current, so this is genuinely a one-line removal, not a rewrite.

**What does *not* need to change**: `resolveAccessToken`'s existing dual-read logic already branches on `access_token_key_id !== null` and decrypts, falling back to plaintext only when that's null (§6.1, §8's fail-closed rule) — a Phase-2b row (`access_token_key_id` non-null, `access_token` null) already resolves correctly through the *existing* decrypt branch. This was true from the moment Phase 1's schema shipped; Phase 2b doesn't require touching `dataService.ts`'s read path at all. Implementation should still confirm (not just assume) the current test suite already exercises an encrypted-only row through every one of the four Plaid-item read functions, since code can drift between this proposal and its implementation.

**Verification plan, mirroring how every prior phase in this project was actually verified** (not just tested): link one new Sandbox test item after deploying Phase 2b; confirm via a direct integrity query that its `access_token IS NULL` and all 5 encrypted columns are populated under the current key; confirm Refresh balances, Sync transactions, and Sandbox webhook processing all succeed on it exactly as with every prior item; re-run the same global integrity query used throughout this project and confirm the 3 pre-existing rows are completely unaffected (Phase 2b never touches existing rows, only future inserts).

**Rollback boundary — restating §22's Points A/B/C, now grounded in the current (post-rotation) state**:
- **Point A** — rollback to pre-encryption code stops being universally safe the moment Phase 2b's first encrypted-only row is created. Not before: nothing up to this point (including the completed rotation) has removed plaintext from any existing row.
- **Point B** — rollback to Phase 2a remains safe from that point onward, for the same reason as always: Phase 2a's dual-read already handles an encrypted-only row correctly with zero further code change, regardless of *which* key that row happens to reference.
- **Point C** — unchanged: only Phase 7 (the `access_token` column physically dropped, not proposed here or anywhere near-term) breaks even Phase 2a as a rollback target.

One rotation-specific dependency worth naming explicitly: "rollback to Phase 2a" as a safe target has always implicitly assumed *whichever key(s) an existing row's `access_token_key_id` references are still configured in Railway*. Today that's moot for production data (the rotation already eliminated every V1-encrypted row), but it's the reason §25's post-removal verification matters before, not after, treating V1 as gone for good.

## 25. Post-soak checklist — removing `PLAID_TOKEN_KEY_RAILWAY_PROD_V1`

**✅ COMPLETE — all 6 steps executed and confirmed.** Final results recorded in §23 above. Kept here verbatim as the record of what was actually checked, not just planned.

**1. Final DB integrity verification** (immediately before touching Railway): re-run the standard integrity query and confirm zero rows reference V1 — gate on *zero V1-keyed rows*, not a hardcoded total count (the total may have grown past 3 if a new item was linked during the soak; since Phase 2b hasn't shipped, any such item already dual-writes under V2 today, so it shouldn't show up as V1 either way, but the query should check for that explicitly rather than assume it). Confirm: `unexpected_key_id_items` (anything not `RAILWAY_PROD_V2`) `= 0`, `partial_encrypted_items = 0`, `plaintext_missing_items = 0`, `unexpected_version_items = 0`, `distinct_encrypted_nonces` equal to the total encrypted-item count.

**2. Railway log verification**: review deploy/runtime logs across the *entire* soak window (not just the moment of rotation) for any `UnknownKeyIdError`, `key_ring_unavailable`, or other `PlaidCredentialError`-family outcome code, and for any occurrence of the string `RAILWAY_PROD_V1` in application logs (the key *id* is a safe, non-secret identifier to search for — confirms no code path unexpectedly still touches it, without needing to search for anything sensitive).

**3. Removing the key**: confirm Trevor has his own secure backup of the V1 key value saved *outside* Railway — this is the actual point of no return, since a Sealed Variable can never be retrieved again once removed (§5.4, §21). Then remove `PLAID_TOKEN_KEY_RAILWAY_PROD_V1` from Railway. Leave `PLAID_TOKEN_CURRENT_KEY_ID=RAILWAY_PROD_V2` and `PLAID_TOKEN_KEY_RAILWAY_PROD_V2` untouched.

**4. Redeployment**: trigger a fresh Railway deploy so `validateKeyRingOrExit()` re-validates at startup against the new, V1-less environment — this is what actually *proves* nothing live still depends on V1, not an assumption. Confirm the deploy log shows a clean `Backend listening on 0.0.0.0:<port>` with no `Refusing to start: Plaid access-token encryption key configuration is invalid` message.

**5. Post-removal functional verification**: `/health` returns 200; Refresh balances, Sync transactions, and Sandbox webhook processing succeed on all 3 (or however many by then) existing items; re-run the same integrity query one final time post-redeploy and confirm it's unchanged from step 1.

**6. Rollback if a hidden V1 dependency appears**:
- **If the redeploy in step 4 fails to start** (`validateKeyRingOrExit()` exits nonzero): Railway's own deployment mechanics mean the *previous* successful deployment keeps serving traffic — no live outage risk from a failed redeploy alone (confirmed behavior from the original Phase 2a deployment incident, §21). Diagnose from the exit reason before retrying.
- **If a latent V1-encrypted row is somehow discovered later** despite step 1's pre-removal check: re-add `PLAID_TOKEN_KEY_RAILWAY_PROD_V1` back to Railway from Trevor's own secure backup and redeploy. This instantly restores full V1 decrypt capability with zero code changes, since the key ring is purely environment-variable-driven — the entire reason removing a key is a low-risk, cheaply-reversible operation, unlike an irreversible action such as a schema column drop.

## 26. What Codex should review before Phase 2b implementation

- The `insertPlaidItem` change itself: confirm it removes exactly `access_token` from the insert payload and changes nothing else (id generation, the 5 encrypted columns, institution fields).
- Confirm `resolveAccessToken`'s dual-read logic requires zero changes for this — re-verified against the actual current code, not assumed from this proposal, since code can drift between now and implementation.
- New test coverage specifically asserting a Phase-2b-inserted row has `access_token IS NULL` alongside fully-populated encrypted columns under the current key.
- A full-repo check for any code path outside `resolveAccessToken`'s abstraction that reads `.access_token` directly off a `plaid_items` row and assumes it's always non-null — this proposal believes none exist, but implementation should prove it, not assume it.
- Re-derive the Points A/B/C rollback-boundary claims above against the actual code at implementation time.
- Confirm the verification plan (one new Sandbox item, integrity query, functional checks) is actually followed and its results documented before Phase 2b is considered complete — matching how every earlier phase in this project was verified live, not just tested.
- Confirm whichever sequencing is actually used (this proposal recommends waiting until after §25's V1 removal) — flag it if Phase 2b is requested before that, rather than silently assuming it's fine.

## 27. Phase 2b — revised design, incorporating Codex's 3 blockers (implemented on a feature branch, not yet merged or deployed)

**Implementation status**: Codex's re-review returned READY on this revised design; implementation proceeded on `feature/phase2b-stop-plaintext-writes` (cut from `main` at `a85066e`) exactly as specified below — `resolveAccessToken`'s explicit `classifyEncryptedFields` state machine, the `?? 1` coercion removed, `decryptAccessToken`'s version-support check, both new error classes, and the exhaustive 30-partial-subset test coverage all match this design as written. Not merged, not deployed, no production/Railway/Supabase change, no migration, no existing row touched. See the implementation commit for exact file-by-file detail. The one open item from "Remaining risks" below that got resolved during implementation: the `plaid_items.access_token` column has no DB-level default, confirmed by the insert code now omitting the key entirely rather than sending an explicit `null`.

**Revision history**: the first version of this section (design-only, superseded below) proposed a one-line change trusting the existing single-field (`access_token_key_id !== null`) classification and the existing `?? 1` version coercion as already-correct. Codex's independent design review returned **NOT READY**, confirming the overall architecture but finding three real gaps — all confirmed against actual current code before being incorporated, not taken on faith:

1. **`resolveAccessToken()` infers "encrypted" from one field** (`row.access_token_key_id !== null`, `dataService.ts:73`), relying entirely on the Phase 1 DB constraint to guarantee the other four fields follow. Correct today, but a code-level classification shouldn't depend solely on a schema constraint holding — this codebase's own established discipline elsewhere (every backfill/rotation script's row classification) already treats "check all five fields explicitly" as the standard, and `resolveAccessToken` should meet the same bar.
2. **`encVersion: row.access_token_enc_version ?? 1`** (`dataService.ts:79`) silently coerces a null version to 1 rather than treating a null version (alongside four non-null fields) as the partial/malformed state it actually is.
3. **`decryptAccessToken()` has no explicit supported-version check** (`tokenEncryption.ts:242-269`) — it builds the AAD from whatever `enc.encVersion` says and never asks "is this version even one we support." A genuinely self-consistent version-2 ciphertext (matching AAD, matching key) would decrypt successfully today, which is wrong: this app has only ever generated version 1, and accepting anything else is an unreviewed format change slipping in silently.

All confirmed points from §24 that remain valid, reconfirmed against current code (`main` at `e1f6f04`) rather than re-derived from memory: `insertPlaidItem()` is the only request-serving credential write path; removing `access_token: params.accessToken` stops normal plaintext persistence; `exchangePublicToken` (`plaidController.ts:210-264`) uses the in-memory `accessToken` local variable for `getAccounts`/`syncItemTransactions`/`refreshLoansForItem` and never reads `itemRow.access_token` — confirmed by direct inspection, not assumed; Update Mode/reconnect (`completeReauth`) never writes a new token; refresh/sync/webhook/loans/recurring all resolve through `dataService.ts`'s four functions; no frontend file references an access token; Phase 1's schema already permits and requires no further migration for an encrypted-only row.

### Exact fail-closed state machine (Blocker 1)

`resolveAccessToken` is redesigned around an explicit classification of all five encrypted columns together, never inferred from any single one:

```ts
type EncryptedFieldsState = 'none' | 'partial' | 'complete';

function classifyEncryptedFields(row: EncryptedTokenRow): EncryptedFieldsState {
  const fields = [
    row.access_token_ciphertext,
    row.access_token_nonce,
    row.access_token_auth_tag,
    row.access_token_key_id,
    row.access_token_enc_version,
  ];
  const present = fields.filter((f) => f !== null).length;
  if (present === 5) return 'complete';
  if (present === 0) return 'none';
  return 'partial';
}
```

Then the state machine, exactly as Codex specified:

| Encrypted fields | Plaintext | Behavior |
|---|---|---|
| 0 (`none`) | present | **Legacy plaintext-only fallback** — explicitly supported for backward compatibility with any row that predates encryption entirely. Returns the plaintext column directly. |
| 0 (`none`) | absent | `MissingEncryptedRepresentationError` — no usable representation at all. |
| 5 (`complete`) | either | **Resolve through the encrypted representation.** Never falls back to plaintext if decryption fails, regardless of whether plaintext happens to still be present (legacy dual-write) or is null (Phase 2b). This is the one branch where plaintext's presence is irrelevant to the *read* path — it only ever matters for backward-compat fallback in the `none` case above. |
| 1–4 (`partial`) | either | **Always fails closed** with a new, fixed, non-sensitive error — `PartialEncryptedRepresentationError` — regardless of which fields are present or which are missing, and regardless of plaintext. Never returns plaintext. This explicitly covers the case Codex named specifically: ciphertext/nonce/tag/version present but key id null (or any other 1-of-5-missing permutation) — the *count* is what's checked, not any individual field's presence. |

```ts
function resolveAccessToken(itemRowId: string, row: EncryptedTokenRow): string {
  const state = classifyEncryptedFields(row);

  if (state === 'partial') {
    throw new PartialEncryptedRepresentationError(itemRowId);
  }

  if (state === 'complete') {
    const enc: EncryptedAccessToken = {
      ciphertextBase64: row.access_token_ciphertext!,
      nonceBase64: row.access_token_nonce!,
      authTagBase64: row.access_token_auth_tag!,
      keyId: row.access_token_key_id!,
      encVersion: row.access_token_enc_version!, // non-null guaranteed by state === 'complete' — no coercion
    };
    return decryptAccessToken(enc, getKeyRing(), itemRowId); // no catch — never falls back to plaintext
  }

  // state === 'none'
  if (row.access_token === null) {
    throw new MissingEncryptedRepresentationError(itemRowId);
  }
  return row.access_token; // legacy plaintext-only fallback, explicit and intentional
}
```

Note what this closes automatically: because the `complete` branch reads `access_token_enc_version!` directly (never `?? 1`), a row with a null version and four other non-null fields is *structurally* a `partial` state (4 of 5 present) and fails closed via `PartialEncryptedRepresentationError` before ever reaching `decryptAccessToken` — Blocker 1's fix already eliminates the coercion Blocker 2 flagged for the *null*-version case. Blocker 2's own fix (below) is what's still needed for the *non-null-but-unsupported* version case (e.g. a hypothetical, structurally-complete version-2 row), which this state machine alone can't catch since "2" is a valid non-null value.

### Encryption-version policy (Blocker 2)

`decryptAccessToken` gains an explicit, first check — before the nonce/tag/ciphertext length checks, since "is this version supported at all" is a more fundamental question than "is this specific representation well-formed":

```ts
const SUPPORTED_ENC_VERSION = 1; // this app has only ever generated version 1

export function decryptAccessToken(enc: EncryptedAccessToken, keyRing: KeyRing, plaidItemId: string): string {
  if (enc.encVersion !== SUPPORTED_ENC_VERSION) {
    throw new UnsupportedEncryptionVersionError(plaidItemId);
  }
  // ... existing nonce/tag/ciphertext/key checks, unchanged ...
}
```

New error class, same family, same fixed-message discipline as every existing one in §9 — never includes the actual version number or any other dynamic value: `UnsupportedEncryptionVersionError extends PlaidCredentialError`, message `'Stored credential uses an unsupported encryption version.'`.

This is deliberately a **policy** check, distinct from and prior to GCM's own tamper detection: a version-2 ciphertext built with genuinely matching version-2 AAD and the correct key would authenticate successfully at the crypto layer — `GcmAuthenticationError` is specifically for *authentication failure* (tampering, wrong key, mismatched AAD), never for "this is a well-formed representation we've simply decided not to support." Confirmed behavior for every case Codex asked about:
- **Null version** → caught by Blocker 1's `partial` state, before `decryptAccessToken` is ever called.
- **Version 2, cryptographically self-consistent** → caught by this new check, `UnsupportedEncryptionVersionError`, *before* any `crypto` call — never reaches `decipher.final()`, so it's never at risk of being misclassified as a `GcmAuthenticationError`.
- **Unknown key id** → unchanged, existing `UnknownKeyIdError`.
- **Partial representation** → Blocker 1's `PartialEncryptedRepresentationError`.
- **Tampered ciphertext/tag/nonce, or wrong key** → unchanged, existing `GcmAuthenticationError` / `Malformed*Error` family.

None of these fall back to retained plaintext when any encrypted field is present — that remains true structurally, not by convention: the `complete` and `partial` branches above have no `catch` that reaches the plaintext column at all.

### Phase 2b monitoring semantics (Blocker 3)

`plaintext_missing_items` (as used throughout §21/§23/§25 for the rotation/backfill era, where every row *should* have retained plaintext) is retired as a Phase 2b health signal — a Phase-2b-created encrypted-only row is a **valid success state**, not an anomaly, and the old metric would flag every one of them. Replaced with explicit state classification via `num_nonnulls()` across the five encrypted columns, adopted from Codex's supplied query:

```sql
with item_state as (
  select *,
    num_nonnulls(
      access_token_ciphertext,
      access_token_nonce,
      access_token_auth_tag,
      access_token_key_id,
      access_token_enc_version
    ) as encrypted_parts
  from public.plaid_items
)
select
  count(*) as total_items,
  count(*) filter (where encrypted_parts = 5) as encrypted_complete_items,
  count(*) filter (where access_token is not null and encrypted_parts = 5) as legacy_dual_write_items,
  count(*) filter (where access_token is null and encrypted_parts = 5) as phase2b_encrypted_only_items,
  count(*) filter (where access_token is not null and encrypted_parts = 0) as plaintext_only_items,
  count(*) filter (where encrypted_parts between 1 and 4) as partial_encrypted_items,
  count(*) filter (where access_token is null and encrypted_parts = 0) as missing_both_items,
  count(*) filter (where encrypted_parts = 5 and access_token_key_id <> 'RAILWAY_PROD_V2') as unexpected_key_items,
  count(*) filter (where encrypted_parts = 5 and access_token_enc_version <> 1) as unexpected_version_items,
  count(*) filter (where access_token_key_id = 'RAILWAY_PROD_V1') as v1_items,
  count(distinct access_token_nonce) filter (where encrypted_parts = 5) as distinct_encrypted_nonces
from item_state;
```

**Valid production states, documented explicitly**:
- **Expected legacy state**: plaintext present + all 5 fields complete, `RAILWAY_PROD_V2`/version 1 — every pre-Phase-2b row.
- **Expected Phase 2b state**: plaintext `NULL` + all 5 fields complete, `RAILWAY_PROD_V2`/version 1 — every item linked after Phase 2b deploys.
- **Operationally unexpected but schema-allowed**: plaintext-only (0 encrypted fields, plaintext present) — the Phase-1-era shape; shouldn't occur post-backfill but the schema permits it.
- **Invalid / fail-closed**: partial encrypted representation (1-4 fields); missing both plaintext and encrypted representation; wrong key id; unsupported encryption version. **Wrong key/version are schema-allowed but operationally invalid** — the Phase 1 `plaid_items_encrypted_token_complete` constraint only enforces the null/non-null *pattern* across the five columns, never the *values* of `access_token_key_id` or `access_token_enc_version` — the database has no way to know which key ids or versions this application currently considers valid. That enforcement is exactly what Blocker 1's `resolveAccessToken` classification and Blocker 2's `decryptAccessToken` version check exist to provide at the application layer, and what `unexpected_key_items`/`unexpected_version_items` exist to surface at the monitoring layer.

**Expected result after linking exactly one new Phase 2b Sandbox item**, from the current confirmed 3-row baseline (all 3 legacy dual-write, V2, version 1, zero anomalies): `total_items = 4`, `encrypted_complete_items = 4`, `legacy_dual_write_items = 3`, `phase2b_encrypted_only_items = 1`, `plaintext_only_items = 0`, `partial_encrypted_items = 0`, `missing_both_items = 0`, `unexpected_key_items = 0`, `unexpected_version_items = 0`, `v1_items = 0`, `distinct_encrypted_nonces = 4`.

**This query proves structural integrity only** — that the right columns are populated in the right pattern. It does not prove the ciphertext actually decrypts, that the key ring can reach it, or that Plaid still accepts the credential. The row-specific boolean check and the live functional checks in the production verification plan below remain required; this query is necessary, not sufficient.

**Retired tooling, explicitly**: `backend/src/scripts/backfillTokenEncryption.ts`'s own postflight (`runPostflight`, §22) is **not valid for Phase 2b health monitoring** — it asserts `plaintext_only_items = 0` *and* that every encrypted row still has plaintext (`plaintext_missing_after_backfill` is a failure condition there), which is exactly backwards for a world where Phase 2b is deliberately creating encrypted-only rows. Both `backfillTokenEncryption.ts` and `rotateTartanTokenKey.ts` are kept in the repository for audit history and are not modified as part of this phase — but are documented here as **retired: do not run after Phase 2b** ships, since their own preflight/postflight invariants (fixed 3-row cohort, fixed expected-total, "every row already encrypted must have plaintext") no longer describe a healthy post-Phase-2b table and would refuse to run correctly (or worse, misreport) against one.

### Revised implementation scope

**`backend/src/services/dataService.ts`**:
- Remove `access_token: params.accessToken,` from `insertPlaidItem`'s insert payload (unchanged from the original proposal).
- Replace the single-field `resolveAccessToken` check with the explicit `classifyEncryptedFields` + 3-branch state machine above.
- Remove the `?? 1` version coercion entirely — the `complete` branch reads `access_token_enc_version!` directly, non-null by construction of the state check.

**`backend/src/services/tokenEncryption.ts`**:
- Add `UnsupportedEncryptionVersionError` and `PartialEncryptedRepresentationError` to the existing `PlaidCredentialError` family (§9), same fixed-message, `itemRowId`-carrying pattern as every other error class in this file.
- Add the explicit `enc.encVersion !== SUPPORTED_ENC_VERSION` check as the first thing `decryptAccessToken` does.

No schema/migration change (unchanged from the original proposal — Phase 1 already covers this). No type change beyond whatever the new error classes need (none — `PlaidItemRow` stays as-is).

### Files affected

- `backend/src/services/dataService.ts` — the insert-payload line, `resolveAccessToken`'s rewrite.
- `backend/src/services/dataService.test.ts` — updated + new tests, below.
- `backend/src/services/tokenEncryption.ts` — two new error classes, the version check.
- `backend/src/services/tokenEncryption.test.ts` — updated + new tests, below.
- `backend/src/controllers/plaidController.test.ts` — one new, narrowly-scoped test (see "resolver-boundary coverage" below); the mock factory needs `insertPlaidItem`/`upsertAccountsForItem` added to it, which it currently omits entirely (confirmed by inspection — `exchangePublicToken` has no existing test coverage in this file at all today).
- `PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md` and `README.md` — post-merge status update.

No change to `webhookController.ts`, `plaidService.ts`, `syncService.ts`, `loans.ts`, or their test files — confirmed unchanged; see "resolver-boundary coverage" below for why their *test* files don't need new mocking infrastructure either, despite the new test requirements Codex listed.

### Tests required

Grouped by where each requirement is actually satisfied, since several of Codex's items land in the same test:

**`dataService.test.ts` — insert behavior**:
- Rename/rewrite the existing test at line 63 (`'writes both the plaintext and the full encrypted representation together (Phase 2a dual-write)'`) — its `expect(inserted.access_token).toBe('access-sandbox-1')` assertion becomes false under Phase 2b. New assertions: `'access_token' in inserted` is `false` (the insert payload has no such key at all, not merely `null` — confirms the *code's* actual behavior, not an assumption about how Supabase treats an absent vs. explicit-null key); the plaintext value itself never appears anywhere in the serialized insert payload (a direct `JSON.stringify(inserted)` sentinel check); the row **returned** from the insert may have `access_token: null` (that's the DB's own default for the now-nullable column, distinct from what the *code sends*); exactly five encrypted fields written, all non-null; the ciphertext round-trips through `decryptAccessToken` using the generated row UUID as AAD (same proof pattern the existing test already does).

**`dataService.test.ts` — `resolveAccessToken`'s new state machine, exercised through all three read functions**:
- Every 1-of-5 through 4-of-5 partial permutation fails closed with `PartialEncryptedRepresentationError`, never returns plaintext — including specifically the case Codex named (ciphertext/nonce/tag/version present, key id null).
- Null version alongside four populated fields fails closed the same way (a specific instance of the above, worth its own named test given it's the literal Blocker 2 scenario).
- Unknown key id, wrong key id, and tampered representation all still fail as before (regression, not new).
- **Self-consistent unsupported version 2** fails explicitly with `UnsupportedEncryptionVersionError` — built the same way `rotateTartanTokenKey.test.ts`'s `rowWithVersion` helper already does (bypass `encryptAccessToken`, hand-build a genuinely matching version-2 AAD), proving this is rejected by policy, not because decryption happens to fail.
- Legacy dual-write (plaintext + complete encrypted fields) still prefers the decrypted value over stale plaintext — regression.
- **`getPlaidItemForUser()` specifically gets a new normal-success encrypted-only-row test** — confirmed by direct inspection that this is a real, existing gap: `getPlaidItemsForUser` and `getPlaidItemByPlaidItemId` both already have a "resolves an encrypted row correctly" test, `getPlaidItemForUser` currently does not (only a plaintext-only success test and a shared failure-path test exist for it).

**`tokenEncryption.test.ts`**:
- `UnsupportedEncryptionVersionError` thrown for version 2 (and any version other than 1), checked before any `crypto` call is attempted (spy/assert on `createDecipheriv` never being reached, same technique already used for the existing malformed-input checks).
- `PartialEncryptedRepresentationError`'s message is fixed and non-sensitive, same no-secret-in-message test pattern already applied to every other error class here.
- Logging-sentinel suites (already-existing pattern) re-run and stay green — nothing about these two new error classes changes what's safe to log.

**`plaidController.test.ts` — resolver-boundary coverage for the exchange flow**:
- New test proving `exchangePublicToken` uses the in-memory token, not the inserted row's plaintext: mock `insertPlaidItem` to return a row with `access_token: null` (the Phase 2b shape) and assert `getAccounts`/`syncItemTransactions`/`refreshLoansForItem` are all still called with the original in-memory access-token string. Confirmed by direct inspection that this is accurate to current code — `exchangePublicToken` (`plaidController.ts:210-264`) never reads `itemRow.access_token` anywhere in its body.
- `credential_error` vs. `login_required` behavior — already covered by the existing `completeReauth` tests in this file (from the earlier Codex-blocker rounds); reconfirm they still pass unchanged, no new coverage needed here specifically.

**Resolver-boundary coverage for refresh/sync/webhook — identified gap and narrow resolution**: `plaidController.test.ts` and `webhookController.test.ts` both mock `../services/dataService` wholesale (confirmed by inspection of both files' `vi.mock` calls) — neither currently exercises the real `resolveAccessToken` at all; both hand back pre-resolved fixture strings. Un-mocking `dataService.ts` in either large, established file to add "real resolver boundary" coverage there would be a much bigger, riskier change than Phase 2b's actual scope calls for. The narrower, already-architecturally-correct answer: `dataService.ts`'s four Plaid-item functions **are** the resolver boundary (§6.1 — the only encryption-aware layer in the codebase), and `refreshAccounts`/`syncTransactions`/webhook processing all call exactly those functions with no logic of their own in between. The `dataService.test.ts` coverage above (which does exercise the real functions against real crypto, per its established pattern) is both the correct and the sufficient place for this requirement — controller-level tests correctly continue to treat `dataService.ts` as an already-independently-verified dependency, exactly as they do today for every other encryption concern.

### Deployment sequence

1. Design approval (this document) — **then** a new branch off current `main`.
2. Implement the scope above.
3. Full local verification: backend + frontend test suites, both typechecks, both builds, `git diff --check`.
4. Codex implementation audit.
5. **Preserve/document the exact rollback artifact** (below) before merging — not after.
6. Merge to `main` and push — this repository auto-deploys `main` to Railway on every push, so the merge *is* the deploy.
7. Verify startup/health (`/health` 200, no `Refusing to start` in deploy logs).
8. Link exactly one fresh Sandbox item.
9. Run a row-specific boolean check on that new row: plaintext `NULL`, all 5 encrypted fields complete, key id `RAILWAY_PROD_V2`, version 1.
10. Run the aggregate state-classification query above — confirm it matches the expected post-link numbers.
11. Refresh balances / sync transactions on the new item.
12. Fire the Sandbox webhook test for the new item.
13. Exercise Update Mode/reconnect on the new item (confirms the already-confirmed "Update Mode never persists a new token" claim holds against a live encrypted-only row, not just by code inspection).
14. Inspect Railway logs across the verification window for any crypto/key/credential error code, and for any leakage (same discipline as every prior round — search for safe identifiers like error/reason codes, never anything that could be a secret).
15. Re-run the integrity query one more time.
16. Soak before any consideration of legacy plaintext cleanup (a future, separate, far-off phase — not part of this proposal or anywhere near it).

### Rollback boundary and artifact

Preserved and tightened, per Codex's request:
- **Until the first encrypted-only row is created**, older pre-encryption code remains technically able to read every row, because all existing rows still contain plaintext.
- **After the first encrypted-only row exists**, rolling back to pre-encryption code is unsafe for that row (and any created after it) — it would read `access_token` as `NULL` and fail loudly, not silently.
- **The safe rollback target is the last known-V2-capable Phase 2a commit** — concretely, the exact commit `main` is at immediately before the Phase 2b merge lands. As of this design (baseline confirmed by Codex: `main = e1f6f04517f15ab51c4cbe9dc3f687f5c4c97090`), that would be `e1f6f04` itself, **provided no other commit lands on `main` between now and the Phase 2b merge** — this must be re-confirmed at actual merge time, not assumed from this document. **Recommendation**: as step 5 of the deployment sequence above, create an annotated git tag (e.g. `pre-phase2b-v2-capable`) pointing at that exact pre-merge commit, so the rollback target is a durable, nameable artifact rather than something to be reconstructed from `git log` later.
- **Reverting Phase 2b** means redeploying that tagged commit — this simply resumes dual-write for future items; every encrypted-only row Phase 2b already created remains completely valid and continues to be read correctly by Phase 2a's dual-read (§6.1's `resolveAccessToken`, which has never required plaintext to be present for the `complete` branch, in either the original or this revised design).
- **No schema rollback, no restoration of `access_token NOT NULL`, no Phase 7 behavior** — none of those are part of this proposal, and reverting Phase 2b touches none of them.
- `RAILWAY_PROD_V2` must remain configured throughout — it already will be, since nothing in this proposal or its rollback touches Railway.

### What Codex should review

Everything in §26 remains current (the `insertPlaidItem` diff, the read-path re-verification, the full-repo grep for other direct `.access_token` reads, the rollback-boundary re-derivation, the production verification plan actually being followed) — **plus, specific to this revision**: the exact `classifyEncryptedFields`/state-machine implementation in `resolveAccessToken` (confirm all five fields are genuinely checked, not a subset); that `decryptAccessToken`'s version check runs before any `crypto` call, with a test proving `createDecipheriv` is never reached for an unsupported version; that neither new error class's message ever includes the actual version number, key id, or any other dynamic value; the new monitoring query's numbers against a real post-link production check, not just the arithmetic in this document; that the retired-tooling documentation is accurate and neither script was modified; and the specific new `plaidController.test.ts` test proving the exchange flow's in-memory-token behavior.

### Remaining risks / open questions

- The exact rollback-artifact commit can only be finalized at actual merge time — this document names `e1f6f04` as the current baseline, but implementation must re-confirm (and tag) whatever `main` actually is immediately before merging, not reuse this hash blindly if other work has landed in between.
- Whether the `plaid_items.access_token` column has any DB-level default value matters for one test assertion's precision (absent-key vs. explicit-null in the insert payload) — flagged as something to confirm during implementation, not assumed here.
- This proposal does not address a future, much later question: once enough time has passed and Phase 2b is fully soaked, should the *legacy* rows (still dual-write, still holding plaintext) eventually be re-encrypted-only too, closing the loop entirely? That's explicitly out of scope here — raised only so it isn't lost, not to be actioned now.

---

## Files this review is grounded in (all read in full or in relevant part while producing this document)

`backend/src/services/plaidService.ts`, `backend/src/services/dataService.ts` (Plaid-item section), `backend/src/services/syncService.ts`, `backend/src/services/loans.ts`, `backend/src/controllers/plaidController.ts` (in full), `backend/src/controllers/webhookController.ts`, `backend/src/services/webhookVerification.ts`, `backend/src/services/plaidErrors.ts`, `backend/src/middleware/auth.ts`, `backend/src/middleware/errorHandler.ts`, `backend/src/index.ts`, `backend/src/config/env.ts`, `backend/src/config/plaid.ts`, `backend/src/config/supabase.ts`, `backend/src/types/index.ts`, `backend/src/services/syncService.test.ts`, `backend/.env.example`, `backend/package.json`, `railway.json`, `supabase/migrations/20260825195130_remote_schema.sql` (the `plaid_items` table definition and its RLS status specifically), and a full-repo search confirming no frontend file ever references a Plaid `access_token`.

**Added for this update (2026-08-26)**: `node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts` (the exact request-body serialization code, confirmed version 2.112.3 via `node_modules/@supabase/postgrest-js/package.json` and `node_modules/@supabase/supabase-js/package.json`), plus a local, network-free Node snippet reproducing `JSON.stringify` on a `Buffer` and confirming lossless Base64/hex round-tripping — no database was touched, no schema was created or modified, no application code or data was altered.

**No code was modified in producing this review or this update. Awaiting Trevor's confirmation of Railway Sealed Variable availability before implementation begins — see §19.**

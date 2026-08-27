import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// See PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md for the full design this file implements —
// §2 (schema), §3 (payload representation), §4 (AAD format), §5 (crypto sequence + key
// management), §6 (key ring), §8 (fail-closed rule), §9 (error classes).

const AAD_CONTEXT = 'my-finances:plaid-access-token';
const ENC_VERSION = 1;
const KEY_ENV_PREFIX = 'PLAID_TOKEN_KEY_';
const CURRENT_KEY_ID_ENV = 'PLAID_TOKEN_CURRENT_KEY_ID';
const KEY_LENGTH_BYTES = 32; // AES-256
const NONCE_LENGTH_BYTES = 12; // GCM's recommended nonce length
const AUTH_TAG_LENGTH_BYTES = 16; // AES-GCM's standard tag length

// ---- Error classes (§9) -----------------------------------------------------------

/**
 * Common base for every credential-encryption failure, so callers can `instanceof`-check the
 * whole family at once (§9) — deliberately never given a `.response.data.error_code` shape, so
 * `plaidService.isReauthRequiredError` naturally returns false for all of these without any
 * special-case exclusion (see tokenEncryption.test.ts's "stays distinct from Plaid's own errors"
 * test). Every subclass's `.message` is a fixed, hand-written, non-sensitive string set at
 * construction — never anything derived from the actual plaintext/key/ciphertext (§11) — because
 * `middleware/errorHandler.ts` forwards `.message` to the client unchanged today.
 */
export class PlaidCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Thrown at startup (not per-request) when the configured key-ring environment variables are
 *  missing, malformed, or internally inconsistent (§5.5, §9). */
export class InvalidKeyConfigurationError extends PlaidCredentialError {}

/** A row's `access_token_key_id` doesn't match any key currently configured in this app's key
 *  ring (§9) — e.g. an old key was removed from the environment before every row referencing it
 *  was rotated (§12). */
export class UnknownKeyIdError extends PlaidCredentialError {
  constructor() {
    super('Stored credential references an unrecognized encryption key.');
  }
}

export class MalformedNonceError extends PlaidCredentialError {
  constructor() {
    super('Stored credential has a malformed nonce.');
  }
}

export class MalformedAuthTagError extends PlaidCredentialError {
  constructor() {
    super('Stored credential has a malformed authentication tag.');
  }
}

export class MalformedCiphertextError extends PlaidCredentialError {
  constructor() {
    super('Stored credential has malformed ciphertext.');
  }
}

/** `decipher.final()` itself threw — tampered ciphertext, tampered tag, wrong key, or a
 *  mismatched AAD are indistinguishable from the ciphertext alone, by GCM's design (§9). This is
 *  the exact error the fail-closed rule (§8) forbids falling back to plaintext from. */
export class GcmAuthenticationError extends PlaidCredentialError {
  constructor() {
    super('Unable to verify stored credential.');
  }
}

/** A row has no usable representation at all — reachable only after Phase 6 removes the
 *  plaintext-fallback branch (§7 Phase 6); the `plaid_items_token_present` check constraint
 *  (§2) makes this unreachable before then. Exported here because it's part of the same
 *  `PlaidCredentialError` family (§9), even though dataService.ts is what throws it. */
export class MissingEncryptedRepresentationError extends PlaidCredentialError {
  constructor() {
    super('Stored credential has no usable representation.');
  }
}

// ---- Payload shape (§3) -----------------------------------------------------------

export interface EncryptedAccessToken {
  ciphertextBase64: string;
  nonceBase64: string;
  authTagBase64: string;
  keyId: string;
  encVersion: number;
}

// ---- Key ring (§5.3, §5.5, §6) -----------------------------------------------------------

export interface KeyRing {
  currentKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Builds a key ring from a plain env-like object — a pure function taking an explicit source
 * (defaulting to `process.env`) rather than reading the environment implicitly, specifically so
 * it's trivially testable with hand-built fixtures and never needs a cache-reset hook (§16).
 *
 * Key ids are taken verbatim from each `PLAID_TOKEN_KEY_<ID>` env var's own suffix (e.g. the
 * env var `PLAID_TOKEN_KEY_RAILWAY_PROD_V1` produces the key id `RAILWAY_PROD_V1`) rather than
 * transformed into a different casing/format — the design doc's `railway-prod-v1`-style examples
 * were illustrative, not a mandated transform, and using the env var suffix directly avoids any
 * lossy or fragile name-conversion logic entirely.
 */
export function loadKeyRing(source: NodeJS.ProcessEnv = process.env): KeyRing {
  const currentKeyId = source[CURRENT_KEY_ID_ENV];
  if (!currentKeyId) {
    throw new InvalidKeyConfigurationError(
      `Missing required environment variable: ${CURRENT_KEY_ID_ENV}`
    );
  }

  const keys = new Map<string, Buffer>();
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith(KEY_ENV_PREFIX) || !value) continue;
    const keyId = name.slice(KEY_ENV_PREFIX.length);
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== KEY_LENGTH_BYTES) {
      throw new InvalidKeyConfigurationError(
        `Encryption key "${keyId}" must decode to exactly ${KEY_LENGTH_BYTES} bytes.`
      );
    }
    keys.set(keyId, decoded);
  }

  if (keys.size === 0) {
    throw new InvalidKeyConfigurationError(`No ${KEY_ENV_PREFIX}* environment variables are configured.`);
  }
  if (!keys.has(currentKeyId)) {
    throw new InvalidKeyConfigurationError(
      `${CURRENT_KEY_ID_ENV} does not match any configured key.`
    );
  }

  return { currentKeyId, keys };
}

let cachedKeyRing: KeyRing | null = null;

/** The application-code entry point (dataService.ts only, per §6.1) — loads once from the real
 *  environment and caches, so there are no further env reads after the first call (§5.5). Tests
 *  should call `loadKeyRing(fixture)` directly instead of this, to avoid any cross-test caching
 *  concern. */
export function getKeyRing(): KeyRing {
  if (!cachedKeyRing) cachedKeyRing = loadKeyRing();
  return cachedKeyRing;
}

// ---- AAD (§4) -----------------------------------------------------------

function buildAad(plaidItemId: string, encVersion: number): Buffer {
  return Buffer.from(`${AAD_CONTEXT}:v${encVersion}:${plaidItemId}`, 'utf8');
}

// ---- Encrypt / decrypt (§5.1, §5.2) -----------------------------------------------------------

/** Encrypts `plaintext` (a Plaid access token) under the key ring's *current* key, binding the
 *  ciphertext to `plaidItemId` via the AAD (§4) so it can never be decrypted under a different
 *  row's id. */
export function encryptAccessToken(
  plaintext: string,
  keyRing: KeyRing,
  plaidItemId: string
): EncryptedAccessToken {
  const keyId = keyRing.currentKeyId;
  const key = keyRing.keys.get(keyId);
  if (!key) {
    // Can only happen if a caller hand-builds an inconsistent KeyRing — loadKeyRing() itself
    // already guarantees currentKeyId is always present in keys.
    throw new InvalidKeyConfigurationError('Current key id is not present in the key ring.');
  }

  const nonce = randomBytes(NONCE_LENGTH_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(buildAad(plaidItemId, ENC_VERSION));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertextBase64: ciphertext.toString('base64'),
    nonceBase64: nonce.toString('base64'),
    authTagBase64: authTag.toString('base64'),
    keyId,
    encVersion: ENC_VERSION,
  };
}

/** Decrypts an `EncryptedAccessToken`, verifying it was encrypted for `plaidItemId` specifically
 *  (the AAD, §4) under a key still present in `keyRing`. Every malformed-input check (§3) runs
 *  before any `crypto` call is attempted; a GCM authentication failure — tampered ciphertext,
 *  tampered tag, wrong key, or mismatched AAD, indistinguishable from each other by design — is
 *  the only case that reaches `decipher.final()` before throwing. Callers must never catch the
 *  resulting error and fall back to a plaintext column (§8) — this function has no such
 *  fallback itself, by design. */
export function decryptAccessToken(
  enc: EncryptedAccessToken,
  keyRing: KeyRing,
  plaidItemId: string
): string {
  const nonce = Buffer.from(enc.nonceBase64, 'base64');
  const authTag = Buffer.from(enc.authTagBase64, 'base64');
  const ciphertext = Buffer.from(enc.ciphertextBase64, 'base64');

  if (nonce.length !== NONCE_LENGTH_BYTES) throw new MalformedNonceError();
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) throw new MalformedAuthTagError();
  if (ciphertext.length === 0) throw new MalformedCiphertextError();

  const key = keyRing.keys.get(enc.keyId);
  if (!key) throw new UnknownKeyIdError();

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(buildAad(plaidItemId, enc.encVersion));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately swallow crypto's own thrown error rather than rethrow/wrap it — it could in
    // principle carry buffer contents, and GcmAuthenticationError's fixed message is all that
    // should ever reach a log line or an HTTP response (§11).
    throw new GcmAuthenticationError();
  }
}

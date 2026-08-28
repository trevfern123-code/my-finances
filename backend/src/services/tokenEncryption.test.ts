import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { isReauthRequiredError } from './plaidErrors';
import {
  decryptAccessToken,
  encryptAccessToken,
  GcmAuthenticationError,
  InvalidKeyConfigurationError,
  loadKeyRing,
  MalformedAuthTagError,
  MalformedCiphertextError,
  MalformedNonceError,
  PlaidCredentialError,
  UnknownKeyIdError,
  validateKeyRingOrExit,
  type EncryptedAccessToken,
  type KeyRing,
} from './tokenEncryption';

const VALID_KEY_B64 = randomBytes(32).toString('base64');
const OTHER_KEY_B64 = randomBytes(32).toString('base64');

function fixtureEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PLAID_TOKEN_KEY_TEST_V1: VALID_KEY_B64,
    PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1',
    ...overrides,
  };
}

function fixtureKeyRing(): KeyRing {
  return loadKeyRing(fixtureEnv());
}

const ITEM_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const OTHER_ITEM_ID = 'a1b2c3d4-0000-0000-0000-000000000002';
const PLAINTEXT = 'access-sandbox-abc123';

describe('loadKeyRing', () => {
  it('builds a key ring from PLAID_TOKEN_KEY_* env vars, using the env var suffix verbatim as the key id', () => {
    const ring = loadKeyRing(fixtureEnv());
    expect(ring.currentKeyId).toBe('TEST_V1');
    expect(ring.keys.get('TEST_V1')).toEqual(Buffer.from(VALID_KEY_B64, 'base64'));
  });

  it('supports multiple configured keys simultaneously', () => {
    const ring = loadKeyRing(
      fixtureEnv({ PLAID_TOKEN_KEY_OLD_V1: OTHER_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1' })
    );
    expect(ring.keys.size).toBe(2);
    expect(ring.keys.has('OLD_V1')).toBe(true);
    expect(ring.keys.has('TEST_V1')).toBe(true);
  });

  it('throws InvalidKeyConfigurationError when PLAID_TOKEN_CURRENT_KEY_ID is missing', () => {
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_CURRENT_KEY_ID: undefined }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('throws InvalidKeyConfigurationError when no PLAID_TOKEN_KEY_* vars are present at all', () => {
    expect(() =>
      loadKeyRing({ PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1' })
    ).toThrow(InvalidKeyConfigurationError);
  });

  it('throws InvalidKeyConfigurationError when the current key id does not match any configured key', () => {
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_CURRENT_KEY_ID: 'NOT_CONFIGURED' }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('throws InvalidKeyConfigurationError when a configured key does not decode to exactly 32 bytes', () => {
    const tooShort = Buffer.from('too-short').toString('base64');
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: tooShort }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('ignores unrelated environment variables entirely', () => {
    const ring = loadKeyRing(fixtureEnv({ SUPABASE_URL: 'https://example.supabase.co', PORT: '4000' }));
    expect(ring.keys.size).toBe(1);
  });
});

describe('loadKeyRing — strict canonical Base64 validation (round-trip check)', () => {
  // Node's Buffer.from(str, 'base64') is permissive: it silently skips whitespace and any
  // character outside the base64 alphabet, and tolerates missing/extra padding, rather than
  // rejecting any of it. A decoded-length check alone can't distinguish a canonical, correctly-
  // formed value from one of those malformed-but-still-decodes cases — these tests exercise the
  // decoded.toString('base64') === value round-trip check that catches all of them.

  it('accepts a valid 32-byte canonical Base64 key exactly as randomBytes(32).toString("base64") produces it', () => {
    expect(() => loadKeyRing(fixtureEnv())).not.toThrow();
  });

  it('rejects a value containing characters outside the base64 alphabet', () => {
    const invalidChars = `${VALID_KEY_B64.slice(0, -1)}!`;
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: invalidChars }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('rejects a value with embedded whitespace, even though Node would otherwise decode around it', () => {
    const withWhitespace = `${VALID_KEY_B64.slice(0, 10)} ${VALID_KEY_B64.slice(10)}`;
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: withWhitespace }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('rejects truncated Base64 (missing trailing padding)', () => {
    // A 32-byte value's canonical encoding always ends in exactly one '=' pad character —
    // stripping it is a truncation Node's decoder would otherwise silently tolerate.
    expect(VALID_KEY_B64.endsWith('=')).toBe(true);
    const truncated = VALID_KEY_B64.slice(0, -1);
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: truncated }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('rejects a value with extra trailing characters beyond the correct encoded length', () => {
    const withExtra = `${VALID_KEY_B64}AB`;
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: withExtra }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('rejects valid, canonical Base64 that decodes to the wrong length (16 bytes, not 32)', () => {
    const sixteenByteKey = randomBytes(16).toString('base64');
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: sixteenByteKey }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('rejects a non-canonical (base64url-alphabet) representation of otherwise-valid bytes', () => {
    // Bytes chosen deterministically (not random) so the standard encoding is guaranteed to
    // contain '/' characters — 0xff 0xff 0xff encodes to "////" under standard base64, letting
    // this test reliably construct a base64url variant ('_' in place of '/') without depending
    // on chance.
    const knownBytes = Buffer.concat([Buffer.from([0xff, 0xff, 0xff]), Buffer.alloc(29, 0)]);
    const canonical = knownBytes.toString('base64');
    expect(canonical).toContain('/');
    const base64UrlVariant = canonical.replace(/\//g, '_');
    expect(() => loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: base64UrlVariant }))).toThrow(
      InvalidKeyConfigurationError
    );
  });

  it('never includes the key value itself in the thrown error message for any of the above', () => {
    const cases = [
      `${VALID_KEY_B64.slice(0, -1)}!`,
      `${VALID_KEY_B64.slice(0, 10)} ${VALID_KEY_B64.slice(10)}`,
      VALID_KEY_B64.slice(0, -1),
      `${VALID_KEY_B64}AB`,
    ];
    for (const badValue of cases) {
      try {
        loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: badValue }));
        throw new Error('expected loadKeyRing to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain(badValue);
      }
    }
  });
});

describe('encryptAccessToken / decryptAccessToken round trip', () => {
  it('decrypts back to the original plaintext, through the full Base64 EncryptedAccessToken shape', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    expect(typeof enc.ciphertextBase64).toBe('string');
    expect(typeof enc.nonceBase64).toBe('string');
    expect(typeof enc.authTagBase64).toBe('string');
    const decrypted = decryptAccessToken(enc, ring, ITEM_ID);
    expect(decrypted).toBe(PLAINTEXT);
  });

  it('records the current key id and encryption version on the encrypted payload', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    expect(enc.keyId).toBe('TEST_V1');
    expect(enc.encVersion).toBe(1);
  });

  it('produces different ciphertext and different nonces for two encryptions of the identical plaintext', () => {
    const ring = fixtureKeyRing();
    const a = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const b = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
    expect(a.nonceBase64).not.toBe(b.nonceBase64);
  });

  it('decrypts correctly using a configured historical (non-current) key — the key-rotation scenario (§13)', () => {
    const oldKeyB64 = randomBytes(32).toString('base64');
    const ringWithOldCurrent = loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_OLD_V1: oldKeyB64, PLAID_TOKEN_CURRENT_KEY_ID: 'OLD_V1' }));
    // Encrypt while OLD_V1 is current — mirrors a row written before a rotation.
    const enc = encryptAccessToken(PLAINTEXT, ringWithOldCurrent, ITEM_ID);
    expect(enc.keyId).toBe('OLD_V1');

    // Rotate: TEST_V1 becomes current, but OLD_V1 stays configured for decrypting old rows.
    const ringAfterRotation = loadKeyRing(
      fixtureEnv({ PLAID_TOKEN_KEY_OLD_V1: oldKeyB64, PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1' })
    );
    const decrypted = decryptAccessToken(enc, ringAfterRotation, ITEM_ID);
    expect(decrypted).toBe(PLAINTEXT);
  });

  it('fails GCM authentication if the encryption version is tampered with between encrypt and decrypt', () => {
    // encVersion feeds the AAD (§4) — a tampered version changes the AAD, which GCM correctly
    // treats the same as any other AAD mismatch: authentication failure, not a silent version
    // upgrade/downgrade.
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const tampered = { ...enc, encVersion: enc.encVersion + 1 };
    expect(() => decryptAccessToken(tampered, ring, ITEM_ID)).toThrow(GcmAuthenticationError);
  });

  it('nonce is always exactly 12 bytes, across many repeated calls', () => {
    const ring = fixtureKeyRing();
    for (let i = 0; i < 50; i++) {
      const enc = encryptAccessToken(`${PLAINTEXT}-${i}`, ring, ITEM_ID);
      expect(Buffer.from(enc.nonceBase64, 'base64').length).toBe(12);
    }
  });
});

describe('decryptAccessToken — tamper and mismatch detection', () => {
  it('throws GcmAuthenticationError when a byte of the ciphertext is tampered', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const bytes = Buffer.from(enc.ciphertextBase64, 'base64');
    bytes[0] ^= 0xff;
    const tampered: EncryptedAccessToken = { ...enc, ciphertextBase64: bytes.toString('base64') };
    expect(() => decryptAccessToken(tampered, ring, ITEM_ID)).toThrow(GcmAuthenticationError);
  });

  it('throws GcmAuthenticationError when a byte of the auth tag is tampered', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const bytes = Buffer.from(enc.authTagBase64, 'base64');
    bytes[0] ^= 0xff;
    const tampered: EncryptedAccessToken = { ...enc, authTagBase64: bytes.toString('base64') };
    expect(() => decryptAccessToken(tampered, ring, ITEM_ID)).toThrow(GcmAuthenticationError);
  });

  it('throws GcmAuthenticationError when a byte of the nonce is tampered', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const bytes = Buffer.from(enc.nonceBase64, 'base64');
    bytes[0] ^= 0xff;
    const tampered: EncryptedAccessToken = { ...enc, nonceBase64: bytes.toString('base64') };
    expect(() => decryptAccessToken(tampered, ring, ITEM_ID)).toThrow(GcmAuthenticationError);
  });

  it('throws when decrypting with the AAD for a different plaid_items.id than it was encrypted for', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    expect(() => decryptAccessToken(enc, ring, OTHER_ITEM_ID)).toThrow(GcmAuthenticationError);
  });

  it('throws when decrypting with the wrong key', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const wrongRing = loadKeyRing(fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: OTHER_KEY_B64 }));
    expect(() => decryptAccessToken(enc, wrongRing, ITEM_ID)).toThrow(GcmAuthenticationError);
  });

  it('throws UnknownKeyIdError, before any crypto call, when the key id is not in the ring', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const ringWithoutThatKey = loadKeyRing(
      fixtureEnv({ PLAID_TOKEN_KEY_TEST_V1: undefined, PLAID_TOKEN_KEY_OTHER: OTHER_KEY_B64, PLAID_TOKEN_CURRENT_KEY_ID: 'OTHER' })
    );
    expect(() => decryptAccessToken(enc, ringWithoutThatKey, ITEM_ID)).toThrow(UnknownKeyIdError);
  });

  it('rejects a wrong-length nonce as MalformedNonceError without decrypting', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const malformed: EncryptedAccessToken = { ...enc, nonceBase64: Buffer.from([1, 2, 3]).toString('base64') };
    expect(() => decryptAccessToken(malformed, ring, ITEM_ID)).toThrow(MalformedNonceError);
  });

  it('rejects a wrong-length auth tag as MalformedAuthTagError without decrypting', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const malformed: EncryptedAccessToken = { ...enc, authTagBase64: Buffer.from([1, 2, 3]).toString('base64') };
    expect(() => decryptAccessToken(malformed, ring, ITEM_ID)).toThrow(MalformedAuthTagError);
  });

  it('rejects empty ciphertext as MalformedCiphertextError without decrypting', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const malformed: EncryptedAccessToken = { ...enc, ciphertextBase64: '' };
    expect(() => decryptAccessToken(malformed, ring, ITEM_ID)).toThrow(MalformedCiphertextError);
  });
});

describe('PlaidCredentialError stays distinct from Plaid\'s own errors (§9)', () => {
  it('isReauthRequiredError returns false for every PlaidCredentialError subclass', () => {
    const ring = fixtureKeyRing();
    const errors = [
      new UnknownKeyIdError(),
      new MalformedNonceError(),
      new MalformedAuthTagError(),
      new MalformedCiphertextError(),
      new InvalidKeyConfigurationError('test'),
      (() => {
        try {
          decryptAccessToken({ ...encryptAccessToken(PLAINTEXT, ring, ITEM_ID), ciphertextBase64: 'AA==' }, ring, ITEM_ID);
        } catch (e) {
          return e;
        }
      })(),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(PlaidCredentialError);
      expect(isReauthRequiredError(err)).toBe(false);
    }
  });
});

describe('error message hygiene (§11)', () => {
  it('no thrown error\'s message contains the plaintext token, key material, or raw ciphertext', () => {
    const ring = fixtureKeyRing();
    const enc = encryptAccessToken(PLAINTEXT, ring, ITEM_ID);
    const secrets = [PLAINTEXT, VALID_KEY_B64, enc.ciphertextBase64];

    const attempts: (() => void)[] = [
      () => {
        throw new UnknownKeyIdError();
      },
      () => {
        throw new MalformedNonceError();
      },
      () => {
        throw new MalformedAuthTagError();
      },
      () => {
        throw new MalformedCiphertextError();
      },
      () => decryptAccessToken({ ...enc, ciphertextBase64: 'AAAAAAAAAAAAAAAAAAAAAA==' }, ring, ITEM_ID),
      () => loadKeyRing({ PLAID_TOKEN_CURRENT_KEY_ID: 'TEST_V1', PLAID_TOKEN_KEY_TEST_V1: 'not-32-bytes' }),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error('expected attempt to throw');
      } catch (err) {
        const message = (err as Error).message;
        for (const secret of secrets) {
          expect(message).not.toContain(secret);
        }
      }
    }
  });
});

describe('validateKeyRingOrExit — fail-closed at startup, before the server binds a port', () => {
  const ENV_KEYS = ['PLAID_TOKEN_CURRENT_KEY_ID', 'PLAID_TOKEN_KEY_STARTUP_TEST_V1'];
  const originalValues: Record<string, string | undefined> = {};
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
    // process.exit throws instead of actually terminating the test process — lets execution stop
    // at the same point it would in production (nothing after process.exit() in the real function
    // runs), without killing the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits with code 1 when PLAID_TOKEN_CURRENT_KEY_ID is missing entirely', () => {
    expect(() => validateKeyRingOrExit()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when the current key id does not match any configured key', () => {
    process.env.PLAID_TOKEN_KEY_STARTUP_TEST_V1 = randomBytes(32).toString('base64');
    process.env.PLAID_TOKEN_CURRENT_KEY_ID = 'SOME_OTHER_ID';

    expect(() => validateKeyRingOrExit()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when the configured key is not 32 bytes once decoded', () => {
    process.env.PLAID_TOKEN_KEY_STARTUP_TEST_V1 = Buffer.from('too-short').toString('base64');
    process.env.PLAID_TOKEN_CURRENT_KEY_ID = 'STARTUP_TEST_V1';

    expect(() => validateKeyRingOrExit()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('never logs the raw key value or the caught error object on failure — only a fixed, safe message', () => {
    process.env.PLAID_TOKEN_CURRENT_KEY_ID = 'MISSING';

    expect(() => validateKeyRingOrExit()).toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = errorSpy.mock.calls[0];
    for (const arg of loggedArgs) {
      // Nothing logged should ever be the raw Error object itself (which could, in principle,
      // carry a stack trace or other detail beyond the safe fixed message) — only strings.
      expect(typeof arg).toBe('string');
    }
  });
});

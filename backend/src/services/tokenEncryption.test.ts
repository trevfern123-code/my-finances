import { describe, expect, it } from 'vitest';
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

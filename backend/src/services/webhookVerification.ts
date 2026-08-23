import { createHash } from 'node:crypto';
import { importJWK, jwtVerify, type JWTPayload } from 'jose';
import { plaidClient } from '../config/plaid';

interface CachedKey {
  key: Awaited<ReturnType<typeof importJWK>>;
  expiresAt: number;
}

// Plaid rotates verification keys infrequently — cache them locally instead of round-tripping
// to /webhook_verification_key/get on every webhook delivery.
const keyCache = new Map<string, CachedKey>();
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getVerificationKey(keyId: string) {
  const cached = keyCache.get(keyId);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  const response = await plaidClient.webhookVerificationKeyGet({ key_id: keyId });
  const jwk = response.data.key;
  const key = await importJWK(jwk as unknown as Record<string, string>, 'ES256');
  keyCache.set(keyId, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
  return key;
}

function decodeHeader(signedJwt: string): { kid?: string } {
  const [headerB64] = signedJwt.split('.');
  return JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
}

/**
 * Verifies a Plaid webhook's `Plaid-Verification` JWT against the raw request body.
 * Returns the verified payload, or null if the signature/body-hash/age check fails.
 */
export async function verifyPlaidWebhook(
  signedJwt: string,
  rawBody: Buffer
): Promise<JWTPayload | null> {
  try {
    const { kid } = decodeHeader(signedJwt);
    if (!kid) return null;

    const key = await getVerificationKey(kid);
    const { payload } = await jwtVerify(signedJwt, key, { maxTokenAge: '5 min' });

    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    if (payload.request_body_sha256 !== bodyHash) return null;

    return payload;
  } catch {
    return null;
  }
}

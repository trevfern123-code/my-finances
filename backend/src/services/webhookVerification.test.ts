import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyPlaidWebhook } from './webhookVerification';

const mockWebhookVerificationKeyGet = vi.hoisted(() => vi.fn());
vi.mock('../config/plaid', () => ({
  plaidClient: { webhookVerificationKeyGet: mockWebhookVerificationKeyGet },
}));

async function makeSignedWebhook(
  kid: string,
  body: Buffer,
  opts: { issuedAtOffsetSeconds?: number; useWrongKeyToSign?: boolean } = {}
) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  mockWebhookVerificationKeyGet.mockResolvedValue({ data: { key: { ...publicJwk, kid, alg: 'ES256' } } });

  const signingKey = opts.useWrongKeyToSign ? (await generateKeyPair('ES256')).privateKey : privateKey;
  const bodyHash = createHash('sha256').update(body).digest('hex');

  const jwt = new SignJWT({ request_body_sha256: bodyHash }).setProtectedHeader({ alg: 'ES256', kid });

  if (opts.issuedAtOffsetSeconds !== undefined) {
    jwt.setIssuedAt(Math.floor(Date.now() / 1000) + opts.issuedAtOffsetSeconds);
  } else {
    jwt.setIssuedAt();
  }

  return jwt.sign(signingKey);
}

beforeEach(() => {
  mockWebhookVerificationKeyGet.mockReset();
});

describe('verifyPlaidWebhook', () => {
  it('verifies a correctly signed webhook and returns its payload', async () => {
    const body = Buffer.from(JSON.stringify({ webhook_type: 'TRANSACTIONS' }));
    const jwt = await makeSignedWebhook('kid-1', body);

    const payload = await verifyPlaidWebhook(jwt, body);

    expect(payload).not.toBeNull();
    expect(payload?.request_body_sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('rejects a webhook whose body was tampered with after signing', async () => {
    const originalBody = Buffer.from(JSON.stringify({ amount: 10 }));
    const tamperedBody = Buffer.from(JSON.stringify({ amount: 10000 }));
    const jwt = await makeSignedWebhook('kid-2', originalBody);

    const payload = await verifyPlaidWebhook(jwt, tamperedBody);

    expect(payload).toBeNull();
  });

  it('rejects a signature produced by a key other than the one on file with Plaid', async () => {
    const body = Buffer.from('{}');
    const jwt = await makeSignedWebhook('kid-3', body, { useWrongKeyToSign: true });

    const payload = await verifyPlaidWebhook(jwt, body);

    expect(payload).toBeNull();
  });

  it('rejects a token older than the 5-minute freshness window (replay protection)', async () => {
    const body = Buffer.from('{}');
    const jwt = await makeSignedWebhook('kid-4', body, { issuedAtOffsetSeconds: -600 });

    const payload = await verifyPlaidWebhook(jwt, body);

    expect(payload).toBeNull();
  });

  it('rejects a malformed token without attempting a key lookup', async () => {
    const payload = await verifyPlaidWebhook('not-a-jwt', Buffer.from('{}'));

    expect(payload).toBeNull();
    expect(mockWebhookVerificationKeyGet).not.toHaveBeenCalled();
  });

  it('caches the verification key instead of re-fetching it on every call', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const kid = 'kid-cache-test';
    mockWebhookVerificationKeyGet.mockResolvedValue({ data: { key: { ...publicJwk, kid, alg: 'ES256' } } });

    const body1 = Buffer.from('{"a":1}');
    const body2 = Buffer.from('{"a":2}');
    const sign = (body: Buffer) =>
      new SignJWT({ request_body_sha256: createHash('sha256').update(body).digest('hex') })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuedAt()
        .sign(privateKey);

    const payload1 = await verifyPlaidWebhook(await sign(body1), body1);
    const payload2 = await verifyPlaidWebhook(await sign(body2), body2);

    expect(payload1).not.toBeNull();
    expect(payload2).not.toBeNull();
    expect(mockWebhookVerificationKeyGet).toHaveBeenCalledTimes(1);
  });
});

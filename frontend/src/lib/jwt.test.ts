import { describe, expect, it } from 'vitest';
import { decodeSessionId } from './jwt';

/** Builds a fake (unsigned, not cryptographically valid — decodeSessionId never checks the
 *  signature) JWT string with the given payload, for testing the decode logic in isolation. */
function fakeJwt(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.fake-signature`;
}

describe('decodeSessionId', () => {
  it('extracts session_id from a well-formed token', () => {
    const token = fakeJwt({ sub: 'user-a', session_id: '11111111-1111-1111-1111-111111111111' });
    expect(decodeSessionId(token)).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('handles a payload requiring base64url padding correctly', () => {
    // Deliberately pick a payload whose base64 length isn't a multiple of 4, to exercise the
    // padding logic.
    const token = fakeJwt({ session_id: 'short-id' });
    expect(decodeSessionId(token)).toBe('short-id');
  });

  it('decodes non-ASCII claim values correctly (proves TextDecoder-based UTF-8 handling)', () => {
    const token = fakeJwt({ session_id: 'sid-1', user_metadata: { name: 'Trévoŕ 日本語' } });
    expect(decodeSessionId(token)).toBe('sid-1'); // decode succeeds despite non-ASCII bytes present
  });

  it('returns null when session_id is missing', () => {
    const token = fakeJwt({ sub: 'user-a' });
    expect(decodeSessionId(token)).toBeNull();
  });

  it('returns null when session_id is not a string', () => {
    const token = fakeJwt({ session_id: 12345 });
    expect(decodeSessionId(token)).toBeNull();
  });

  it('returns null for a token with too few segments', () => {
    expect(decodeSessionId('not-a-jwt')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeSessionId('')).toBeNull();
  });

  it('returns null for a payload segment that is not valid base64', () => {
    expect(decodeSessionId('header.###not-valid-base64###.signature')).toBeNull();
  });

  it('returns null for a payload segment that decodes but is not valid JSON', () => {
    const notJson = btoa('this is not json').replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeSessionId(`header.${notJson}.signature`)).toBeNull();
  });

  it('never throws, regardless of malformed input', () => {
    expect(() => decodeSessionId('...')).not.toThrow();
    expect(() => decodeSessionId('a.b')).not.toThrow();
    expect(() => decodeSessionId('a.b.c.d')).not.toThrow();
  });
});

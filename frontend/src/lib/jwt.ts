/**
 * Reads — never verifies — the `session_id` claim from a Supabase-issued JWT access token.
 *
 * This is a purely client-side bookkeeping read of a token our own app already trusts: it's the
 * exact token about to be sent as our own Bearer header, obtained directly from the Supabase SDK's
 * own session state, not from an untrusted external source. It is not, and must never be treated
 * as, a security check — no signature verification happens here. The backend remains the sole
 * security authority: every request is independently re-verified there (via Supabase's own token
 * validation) regardless of what this function decides. This function's only job is letting the
 * frontend tell "a request created under an earlier login" apart from "a request created under the
 * current one," including two logins by the same person — see lib/authGeneration.ts.
 *
 * Never logs or exposes the token itself, any other claim, or any part of the raw payload — only
 * the single `session_id` string (or null) is ever returned.
 */
export function decodeSessionId(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    // Standards-safe Base64URL -> bytes -> UTF-8 decode. Deliberately not
    // `decodeURIComponent(escape(atob(...)))` (deprecated, and `escape` mishandles non-Latin1
    // code points) — atob() gives us the raw byte string, and TextDecoder does the actual UTF-8
    // decoding correctly for any claim values outside the ASCII range.
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder('utf-8').decode(bytes);
    const claims: unknown = JSON.parse(json);
    if (
      typeof claims === 'object' &&
      claims !== null &&
      'session_id' in claims &&
      typeof (claims as { session_id: unknown }).session_id === 'string'
    ) {
      return (claims as { session_id: string }).session_id;
    }
    return null;
  } catch {
    // A malformed/unexpected token shape degrades to "no stable session id available," handled by
    // the caller as "treat this as a new lifecycle" (see App.tsx's crypto.randomUUID() fallback) —
    // never as "silently trust a guess."
    return null;
  }
}

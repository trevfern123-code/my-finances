import type { LinkTokenGetSessionsResponse } from 'plaid';

/**
 * What the Link sessions Plaid recorded for ONE stored Hosted Link token say (Wave 1):
 * - success    exactly one public token — the only case that may be exchanged
 * - ambiguous  more than one distinct public token: never guess which to store
 * - exited     every session explicitly exited, and none produced a public token
 * - pending    no session yet, or one still in progress, or finished without a result reported
 *              yet — "finished" alone is never read as failure, so a result Plaid has not yet
 *              attached can still complete on a later call
 *
 * The public tokens here come from Plaid's /link/token/get for a link token this backend created
 * and stored itself — never from a client.
 */
export type HostedLinkOutcome =
  | { kind: 'success'; publicToken: string }
  | { kind: 'ambiguous' }
  | { kind: 'exited' }
  | { kind: 'pending' };

export function interpretHostedLinkSessions(sessions: readonly LinkTokenGetSessionsResponse[]): HostedLinkOutcome {
  const publicTokens = new Set<string>();
  for (const session of sessions) {
    for (const result of session.results?.item_add_results ?? []) {
      if (typeof result.public_token === 'string' && result.public_token !== '') publicTokens.add(result.public_token);
    }
    // Deprecated by Plaid in favour of results.item_add_results, still populated for some sessions.
    const legacy = session.on_success?.public_token;
    if (typeof legacy === 'string' && legacy !== '') publicTokens.add(legacy);
  }

  if (publicTokens.size === 1) return { kind: 'success', publicToken: [...publicTokens][0] };
  if (publicTokens.size > 1) return { kind: 'ambiguous' };
  if (sessions.length > 0 && sessions.every((session) => Boolean(session.exit ?? session.on_exit))) {
    return { kind: 'exited' };
  }
  return { kind: 'pending' };
}

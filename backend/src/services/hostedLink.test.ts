import { describe, expect, it } from 'vitest';
import type { LinkTokenGetSessionsResponse } from 'plaid';
import { interpretHostedLinkSessions } from './hostedLink';

const session = (overrides: Record<string, unknown>) =>
  ({ link_session_id: 's', ...overrides }) as unknown as LinkTokenGetSessionsResponse;
const added = (publicToken: string) => ({ item_add_results: [{ public_token: publicToken, accounts: [], institution: null }] });

describe('interpretHostedLinkSessions', () => {
  it('no sessions yet: pending', () => {
    expect(interpretHostedLinkSessions([])).toEqual({ kind: 'pending' });
  });

  it('a session still in progress: pending', () => {
    expect(interpretHostedLinkSessions([session({ started_at: 't', finished_at: null })])).toEqual({ kind: 'pending' });
  });

  it('finished without a result or an exit (not reported yet): pending, never a failure', () => {
    expect(interpretHostedLinkSessions([session({ finished_at: 't', results: { item_add_results: [] } })])).toEqual({ kind: 'pending' });
  });

  it('one item added: success with that public token', () => {
    expect(interpretHostedLinkSessions([session({ finished_at: 't', results: added('public-1') })])).toEqual({
      kind: 'success',
      publicToken: 'public-1',
    });
  });

  it('the deprecated on_success shape is read too, and the same token reported both ways counts once', () => {
    expect(interpretHostedLinkSessions([session({ on_success: { public_token: 'public-1', metadata: null } })])).toEqual({
      kind: 'success',
      publicToken: 'public-1',
    });
    expect(
      interpretHostedLinkSessions([session({ results: added('public-1'), on_success: { public_token: 'public-1', metadata: null } })])
    ).toEqual({ kind: 'success', publicToken: 'public-1' });
  });

  it('an earlier exit followed by a successful session: success', () => {
    expect(
      interpretHostedLinkSessions([session({ exit: { error: null, metadata: null } }), session({ results: added('public-1') })])
    ).toEqual({ kind: 'success', publicToken: 'public-1' });
  });

  it('two different public tokens: ambiguous — never guess', () => {
    expect(
      interpretHostedLinkSessions([session({ results: added('public-1') }), session({ results: added('public-2') })])
    ).toEqual({ kind: 'ambiguous' });
  });

  it('every session exited with no public token: exited (deprecated on_exit shape too)', () => {
    expect(interpretHostedLinkSessions([session({ finished_at: 't', exit: { error: null, metadata: null } })])).toEqual({ kind: 'exited' });
    expect(interpretHostedLinkSessions([session({ on_exit: { error: null, metadata: null } })])).toEqual({ kind: 'exited' });
  });

  it('one exited session and one still in progress: pending', () => {
    expect(
      interpretHostedLinkSessions([session({ exit: { error: null, metadata: null } }), session({ finished_at: null })])
    ).toEqual({ kind: 'pending' });
  });

  it('blank or non-string public tokens are ignored', () => {
    expect(
      interpretHostedLinkSessions([session({ results: { item_add_results: [{ public_token: '' }, { public_token: 42 }] } })])
    ).toEqual({ kind: 'pending' });
  });
});

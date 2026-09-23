import type { Session } from '@supabase/supabase-js';
import { decodeSessionId } from './jwt';

/** Called by authedFetch with the exact session it is about to send with — immediately before the
 *  first send and again before any retry. The request is only sent if this returns true. */
export type OwnershipCheck = (session: Session) => boolean;

/**
 * The authenticated owner of ONE user-initiated operation (a save, a delete, a Plaid Link flow),
 * captured the moment it starts. Wave 1: every mutation request must carry one (see authedFetch).
 *
 * - `verify` is handed to the mutation's API call: it accepts a session only if it belongs to the
 *   same user AND the same Supabase login lifecycle (`session_id` claim) that started the
 *   operation, and that lifecycle is still the app's current one. A sign-out/sign-in — as another
 *   user, or as the same user again — while the operation waits on anything makes the send refuse.
 * - `isCurrent` lets a multi-step operation (Plaid Link: create token -> user completes Link ->
 *   exchange) stop between steps once the app has moved on to a different login.
 *
 * Both fail closed when nobody was signed in when the operation started.
 */
export interface SessionOwnership {
  verify: OwnershipCheck;
  isCurrent: () => boolean;
}

export function createSessionOwnership(
  ownerUserId: string | null,
  ownerSessionId: string | null,
  readCurrent: () => { userId: string | null; sessionId: string | null }
): SessionOwnership {
  const isCurrent = () => {
    if (ownerUserId === null || ownerSessionId === null) return false;
    const current = readCurrent();
    return current.userId === ownerUserId && current.sessionId === ownerSessionId;
  };
  return {
    isCurrent,
    verify: (session) =>
      isCurrent() && session.user.id === ownerUserId && decodeSessionId(session.access_token) === ownerSessionId,
  };
}

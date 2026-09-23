import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { createLinkToken, exchangePublicToken } from '../lib/api';
import type { SessionOwnership } from '../lib/sessionOwnership';

/** One server-issued Link attempt (Wave 1): the link token, the one-time attempt id the backend
 *  bound to this user and login session, and the owner that started it. */
interface LinkAttempt {
  linkToken: string;
  linkAttemptId: string;
  ownership: SessionOwnership;
}

/**
 * Links a bank account. Each click starts a NEW attempt: the link token and its one-time attempt id
 * are fetched on demand (not at mount), so an attempt is only ever as old as the Link flow using it,
 * and every attempt is spent or discarded when that flow ends — success, failure or exit.
 *
 * The owner is captured at the click. The public token is only exchanged if that same login is
 * still the current one when Link finishes, and the request itself refuses to send under any other
 * session (see SessionOwnership). App also keys this component by session, so a login change
 * unmounts it — which destroys an open Link — and the server independently rejects an attempt
 * presented by any other user or login session.
 */
export function PlaidLink({
  onLinked,
  captureOwnership,
}: {
  onLinked: () => void;
  captureOwnership: () => SessionOwnership;
}) {
  const [attempt, setAttempt] = useState<LinkAttempt | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read by Plaid's callbacks, which react-plaid-link captures when it creates each Link instance.
  const attemptRef = useRef<LinkAttempt | null>(null);

  function setCurrentAttempt(next: LinkAttempt | null) {
    attemptRef.current = next;
    setAttempt(next);
  }

  async function handleClick() {
    const ownership = captureOwnership();
    setPreparing(true);
    setError(null);
    try {
      const res = await createLinkToken(ownership.verify);
      // Signed out, or someone else signed in, while the token was being created: drop it.
      if (!ownership.isCurrent()) return;
      if (typeof res.link_attempt_id !== 'string' || res.link_attempt_id === '') {
        throw new Error('Could not start linking right now. Please try again in a moment.');
      }
      setCurrentAttempt({ linkToken: res.link_token, linkAttemptId: res.link_attempt_id, ownership });
    } catch (err) {
      if (ownership.isCurrent()) setError(err instanceof Error ? err.message : 'Failed to start linking');
    } finally {
      setPreparing(false);
    }
  }

  const handleSuccess: PlaidLinkOnSuccess = async (publicToken) => {
    const current = attemptRef.current;
    // The attempt is single-use: whatever happens next, the next click starts a fresh one.
    setCurrentAttempt(null);
    if (!current) return;
    // The login that started this Link flow is no longer the app's current one: never exchange.
    if (!current.ownership.isCurrent()) return;

    setExchanging(true);
    setError(null);
    try {
      await exchangePublicToken(publicToken, current.linkAttemptId, current.ownership.verify);
      if (current.ownership.isCurrent()) onLinked();
    } catch (err) {
      if (current.ownership.isCurrent()) setError(err instanceof Error ? err.message : 'Failed to link account');
    } finally {
      setExchanging(false);
    }
  };

  // Closing Link without finishing abandons the attempt; it simply expires on the server.
  const handleExit: PlaidLinkOnExit = () => setCurrentAttempt(null);
  const handleLoadError = useCallback(() => {
    setCurrentAttempt(null);
    setError('Could not open Plaid right now. Please try again.');
  }, []);

  const busy = preparing || exchanging || attempt !== null;
  return (
    <div>
      <button onClick={handleClick} disabled={busy}>
        {exchanging ? 'Linking...' : preparing ? 'Preparing...' : 'Link a bank account'}
      </button>
      {attempt && (
        <PlaidLinkSession
          key={attempt.linkAttemptId}
          linkToken={attempt.linkToken}
          onSuccess={handleSuccess}
          onExit={handleExit}
          onLoadError={handleLoadError}
        />
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * One Plaid Link instance for one attempt, opened as soon as it is ready. Mounted fresh per attempt
 * (keyed by attempt id) because usePlaidLink never resets its instance when its token changes: a
 * shared hook would briefly report `ready` with the previous, already-destroyed instance.
 * Unmounting destroys the instance.
 */
function PlaidLinkSession({
  linkToken,
  onSuccess,
  onExit,
  onLoadError,
}: {
  linkToken: string;
  onSuccess: PlaidLinkOnSuccess;
  onExit: PlaidLinkOnExit;
  onLoadError: () => void;
}) {
  const { open, ready, error } = usePlaidLink({ token: linkToken, onSuccess, onExit });
  const opened = useRef(false);
  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);
  useEffect(() => {
    if (error) onLoadError();
  }, [error, onLoadError]);
  return null;
}

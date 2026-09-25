import { useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { useUpdateGuard } from '../hooks/useAppUpdate';
import { completeReauth, createReauthLinkToken, type LinkedItem } from '../lib/api';
import type { SessionOwnership } from '../lib/sessionOwnership';

export function ReconnectButton({
  itemId,
  institutionName,
  createRefreshCommitter,
  captureOwnership,
}: {
  itemId: string;
  institutionName: string | null;
  // See LinkedAccounts's own prop of the same name — called at the start of THIS component's
  // own async reconnect operation, not derived from a parent render snapshot.
  createRefreshCommitter: () => (items: LinkedItem[]) => void;
  // Wave 1: the reconnect's owner, captured at the click and required by both of its requests.
  captureOwnership: () => SessionOwnership;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownershipRef = useRef<SessionOwnership | null>(null);
  // An app update must not reload this tab while a reconnect is being started, is open in Plaid
  // Link, or is being completed (lib/appUpdate.ts).
  useUpdateGuard('reconnect', busy);

  const onSuccess: PlaidLinkOnSuccess = async () => {
    const ownership = ownershipRef.current;
    // The login that started this reconnect is no longer current: finish nothing for it.
    if (!ownership || !ownership.isCurrent()) {
      setBusy(false);
      setLinkToken(null);
      return;
    }
    setBusy(true);
    setError(null);
    const commit = createRefreshCommitter();
    try {
      const res = await completeReauth(itemId, ownership.verify);
      commit(res.items);
    } catch (err) {
      if (ownership.isCurrent()) setError(err instanceof Error ? err.message : 'Reconnection failed');
    } finally {
      setBusy(false);
      setLinkToken(null);
    }
  };

  // Closing Link without finishing (or Link reporting an error) ends this reconnect. Without this the
  // button stayed "Reconnecting..." until the page was reloaded.
  const onExit: PlaidLinkOnExit = (err) => {
    setBusy(false);
    setLinkToken(null);
    if (err) setError(err.display_message || 'Reconnection did not finish. Please try again.');
  };

  const { open, ready } = usePlaidLink({ token: linkToken ?? '', onSuccess, onExit });

  // Update Mode's link token is fetched on demand (per institution) rather than up front —
  // open Link as soon as a fresh token is ready.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function handleClick() {
    const ownership = captureOwnership();
    ownershipRef.current = ownership;
    setBusy(true);
    setError(null);
    try {
      const res = await createReauthLinkToken(itemId, ownership.verify);
      if (!ownership.isCurrent()) {
        setBusy(false);
        return;
      }
      setLinkToken(res.link_token);
    } catch (err) {
      if (ownership.isCurrent()) setError(err instanceof Error ? err.message : 'Failed to start reconnection');
      setBusy(false);
    }
  }

  return (
    <div className="reconnect-banner">
      <span>{institutionName ?? 'This institution'} needs to be reconnected.</span>
      <button onClick={handleClick} disabled={busy}>
        {busy ? 'Reconnecting...' : 'Reconnect'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

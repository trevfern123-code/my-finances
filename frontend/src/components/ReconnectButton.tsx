import { useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { completeReauth, createReauthLinkToken, type LinkedItem } from '../lib/api';

export function ReconnectButton({
  itemId,
  institutionName,
  createRefreshCommitter,
}: {
  itemId: string;
  institutionName: string | null;
  // See LinkedAccounts's own prop of the same name — called at the start of THIS component's
  // own async reconnect operation, not derived from a parent render snapshot.
  createRefreshCommitter: () => (items: LinkedItem[]) => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSuccess: PlaidLinkOnSuccess = async () => {
    setBusy(true);
    setError(null);
    const commit = createRefreshCommitter();
    try {
      const res = await completeReauth(itemId);
      commit(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reconnection failed');
    } finally {
      setBusy(false);
      setLinkToken(null);
    }
  };

  const { open, ready } = usePlaidLink({ token: linkToken ?? '', onSuccess });

  // Update Mode's link token is fetched on demand (per institution) rather than up front —
  // open Link as soon as a fresh token is ready.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await createReauthLinkToken(itemId);
      setLinkToken(res.link_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start reconnection');
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

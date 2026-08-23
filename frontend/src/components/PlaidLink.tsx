import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { createLinkToken, exchangePublicToken } from '../lib/api';

export function PlaidLink({ onLinked }: { onLinked: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exchanging, setExchanging] = useState(false);

  useEffect(() => {
    createLinkToken()
      .then((res) => setLinkToken(res.link_token))
      .catch((err) => setError(err.message));
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken) => {
      setExchanging(true);
      setError(null);
      try {
        await exchangePublicToken(publicToken);
        onLinked();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to link account');
      } finally {
        setExchanging(false);
      }
    },
    [onLinked]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess,
  });

  return (
    <div>
      <button onClick={() => open()} disabled={!ready || !linkToken || exchanging}>
        {exchanging ? 'Linking...' : 'Link a bank account'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

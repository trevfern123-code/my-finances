import { useEffect, useRef, useState } from 'react';
import { useUpdateGuard } from '../hooks/useAppUpdate';
import { completeLinkAttempt, createHostedLinkAttempt } from '../lib/api';
import type { SessionOwnership } from '../lib/sessionOwnership';

/** How often a waiting attempt asks the server whether Hosted Link has finished. The completion
 *  page (public/plaid-link-complete.html), returning to this tab, and the attempt's expiry each also
 *  trigger an immediate check. */
export const PLAID_LINK_POLL_INTERVAL_MS = 4000;
/** Same-origin channel the completion page posts a bare "finished" on. It carries no data. */
export const PLAID_LINK_CHANNEL = 'my-finances-plaid-link';

interface WaitingAttempt {
  attemptId: string;
  hostedLinkUrl: string;
  expiresAt: number;
  ownership: SessionOwnership;
  tab: Window | null;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Links a bank account with Plaid HOSTED Link (Wave 1). The server creates and keeps the Plaid link
 * token; this component only gets a Hosted Link URL and an opaque attempt id. The user links their
 * bank on Plaid's own page in a new tab, and this tab asks the server to complete the attempt — the
 * server gets the result from Plaid itself. No Plaid token of any kind passes through here.
 *
 * The owner (user + login session) is captured at the click and required by every request. The
 * attempt is abandoned the moment that login is no longer current, and App keys this component by
 * session, so a sign-in change unmounts it and stops everything. The server independently refuses
 * to complete an attempt for anyone but its own user in its own login session.
 */
export function PlaidLink({
  onLinked,
  captureOwnership,
}: {
  onLinked: () => void;
  captureOwnership: () => SessionOwnership;
}) {
  const [attempt, setAttempt] = useState<WaitingAttempt | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Linked, but some follow-up step did not finish (the server says which): not an error.
  const [notice, setNotice] = useState<string | null>(null);
  // App's handler is recreated every render; the polling effect must not restart for that.
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;
  // An app update must not reload this tab while an attempt is being created or is waiting: the
  // reload would drop the attempt this tab is completing (lib/appUpdate.ts).
  useUpdateGuard('hosted_link', preparing || attempt !== null);

  async function handleClick() {
    const ownership = captureOwnership();
    // Opened synchronously inside the click so popup blockers allow it, then pointed at Plaid once
    // the server has created the attempt. Plaid's page gets no handle back to this window.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setPreparing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createHostedLinkAttempt(ownership.verify);
      // Signed out, or someone else signed in, while the attempt was being created: drop it.
      if (!ownership.isCurrent()) {
        tab?.close();
        return;
      }
      const url = typeof res.hosted_link_url === 'string' ? res.hosted_link_url : '';
      if (!url.startsWith('https://') || typeof res.link_attempt_id !== 'string' || res.link_attempt_id === '') {
        throw new Error('Could not start linking right now. Please try again in a moment.');
      }
      const expiresAt = Date.parse(res.expires_at);
      tab?.location.replace(url);
      setAttempt({
        attemptId: res.link_attempt_id,
        hostedLinkUrl: url,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 60 * 1000,
        ownership,
        tab,
      });
    } catch (err) {
      tab?.close();
      if (ownership.isCurrent()) setError(err instanceof Error ? err.message : 'Failed to start linking');
    } finally {
      setPreparing(false);
    }
  }

  function handleCancel() {
    attempt?.tab?.close();
    setAttempt(null);
  }

  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    let inFlight = false;
    const stop = (message: string | null, linked: boolean) => {
      stopped = true;
      setAttempt((current) => (current === attempt ? null : current));
      setError(message);
      if (linked) onLinkedRef.current();
    };

    const poll = async () => {
      if (stopped || inFlight) return;
      if (!attempt.ownership.isCurrent()) {
        stopped = true;
        return;
      }
      inFlight = true;
      try {
        const res = await completeLinkAttempt(attempt.attemptId, attempt.ownership.verify);
        if (stopped || !attempt.ownership.isCurrent()) return;
        if (res.status === 'completed') {
          stop(null, true);
          if (res.follow_up_incomplete && res.follow_up_incomplete.length > 0) {
            setNotice('Bank linked. Some details are still loading — use Refresh balances or Sync transactions if anything is missing.');
          }
        }
        // 'pending' / 'completing': ask again on the next trigger.
      } catch (err) {
        if (stopped || !attempt.ownership.isCurrent()) return;
        const code = errorCode(err);
        if (code === 'link_attempt_already_completed') stop(null, true);
        // A refusal the server explains is final for this attempt; anything else (a network blip, a
        // server error) is retried on the next trigger — the attempt itself is still safe.
        else if (code) stop(err instanceof Error ? err.message : 'Linking did not finish', false);
      } finally {
        inFlight = false;
      }
    };

    const interval = window.setInterval(() => void poll(), PLAID_LINK_POLL_INTERVAL_MS);
    const onFocus = () => void poll();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(PLAID_LINK_CHANNEL);
      channel.onmessage = () => void poll();
    } catch {
      channel = null; // Not supported: the interval and focus checks still cover it.
    }
    // One last check just after expiry gets the server's definitive answer instead of waiting forever.
    const expiry = window.setTimeout(() => void poll(), Math.max(0, attempt.expiresAt - Date.now()) + 1000);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.clearTimeout(expiry);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      channel?.close();
    };
  }, [attempt]);

  return (
    <div>
      <button onClick={handleClick} disabled={preparing || attempt !== null}>
        {preparing ? 'Preparing...' : attempt ? 'Linking...' : 'Link a bank account'}
      </button>
      {attempt && (
        <div className="hint plaid-link-waiting">
          <span>Finish linking in the Plaid tab. This page updates automatically.</span>{' '}
          <a href={attempt.hostedLinkUrl} target="_blank" rel="noopener noreferrer">
            {attempt.tab ? 'Reopen Plaid' : 'Open Plaid to link your bank'}
          </a>{' '}
          <button className="link-button" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}
      {notice && <p className="hint">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

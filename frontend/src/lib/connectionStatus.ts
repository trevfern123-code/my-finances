import type { ConnectionStatus, InstitutionRemoval } from './api';

/**
 * Linked Institution Management: what a connection's status means to the user, and which actions it
 * allows. Pure, so every status is directly testable; the Accounts page and Settings -> Connections
 * both render from this, so the two never disagree.
 *
 * - Reconnect (Plaid Update Mode) for a sign-in problem, an expiring consent, and revoked access
 *   (Update Mode may restore it; if it cannot, the user is told to remove the institution and link
 *   the bank again). Never for credential_error: that is this app failing to read its own stored
 *   credential, which a reconnect cannot fix.
 * - Remove for every status except credential_error (removal needs the credential to remove the
 *   connection at Plaid first) and removing (already under way — it is resumed, not restarted).
 */

export interface ConnectionStatusView {
  /** Short text label (never colour alone). */
  label: string;
  /** One-sentence explanation, or null when there is nothing to explain. */
  description: string | null;
  canReconnect: boolean;
  canRemove: boolean;
  /** Why Remove is unavailable, when it is. */
  removeUnavailableReason: string | null;
  /** Visual tone for the label (also conveyed by the label text itself). */
  tone: 'ok' | 'warn' | 'problem' | 'busy';
}

function formatExpiry(consentExpiresAt: string | null | undefined): string | null {
  if (!consentExpiresAt) return null;
  const ms = Date.parse(consentExpiresAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function describeConnectionStatus(
  status: ConnectionStatus | string,
  consentExpiresAt?: string | null
): ConnectionStatusView {
  switch (status) {
    case 'active':
      return { label: 'Connected', description: null, canReconnect: false, canRemove: true, removeUnavailableReason: null, tone: 'ok' };
    case 'login_required':
      return {
        label: 'Sign-in needed',
        description: 'Your bank needs you to sign in again before this connection can sync.',
        canReconnect: true,
        canRemove: true,
        removeUnavailableReason: null,
        tone: 'warn',
      };
    case 'pending_expiration': {
      const expiry = formatExpiry(consentExpiresAt);
      return {
        label: 'Reconnect soon',
        description: expiry
          ? `Access to this bank expires on ${expiry}. Reconnect to keep it syncing.`
          : 'This connection will stop syncing soon. Reconnect to keep it updated.',
        canReconnect: true,
        canRemove: true,
        removeUnavailableReason: null,
        tone: 'warn',
      };
    }
    case 'permission_revoked':
      return {
        label: 'Access revoked',
        description:
          'Access to this bank was revoked, so it has stopped syncing. Your imported data is still here. Reconnect to restore access, or remove the institution.',
        canReconnect: true,
        canRemove: true,
        removeUnavailableReason: null,
        tone: 'problem',
      };
    case 'credential_error':
      return {
        label: 'Needs attention',
        description:
          'We’re having trouble accessing this account’s connection right now. This isn’t something you need to fix — we’ve been notified.',
        canReconnect: false,
        canRemove: false,
        removeUnavailableReason: "Removal isn't available while this connection needs attention.",
        tone: 'problem',
      };
    case 'removing':
      return {
        label: 'Removing',
        description: 'This institution is being removed.',
        canReconnect: false,
        canRemove: false,
        removeUnavailableReason: null,
        tone: 'busy',
      };
    default:
      return { label: 'Connected', description: null, canReconnect: false, canRemove: true, removeUnavailableReason: null, tone: 'ok' };
  }
}

export interface RemovalProgressView {
  message: string;
  /** The button that resumes the operation, or null when there is nothing to do. */
  actionLabel: string | null;
  /** 'primary' when retrying is the expected next step; 'secondary' when a retry is only worth it
   *  after the cause has been dealt with (it is never presented as likely to fix things by itself). */
  actionEmphasis: 'primary' | 'secondary';
}

/** What a stopped "needs attention" removal means, by its recorded cause. None of these is fixed by
 *  retrying straight away, and none of them ever makes local deletion available. */
function needsAttentionMessage(code: string | null): string {
  switch (code) {
    case 'CREDENTIAL_UNREADABLE':
      return 'This app can’t read this connection’s stored credential, so it can’t ask Plaid to remove it. Nothing has been deleted. We’ve been notified; once it’s fixed, you can finish the removal.';
    case 'MANUAL_LOAN_OWNERSHIP_MISMATCH':
      return 'A payment from this bank is linked to a loan that doesn’t belong to this account, so removal stopped before anything was removed. Nothing has been deleted. This needs investigating before it can continue.';
    case 'MANUAL_LOAN_RECONCILIATION_REQUIRED':
      return 'A loan payment from this bank has no recorded applied amount, so its loan balance couldn’t be restored exactly. Removal stopped before anything was removed. Nothing has been deleted. This needs investigating before it can continue.';
    default:
      return `Plaid refused to remove this connection${code ? ` (${code})` : ''}. Nothing has been deleted. Trying again right away is unlikely to help — this connection needs attention first.`;
  }
}

/** What an unfinished removal needs from the user, in plain words. Nothing here ever implies data was
 *  deleted when it was not: until `cleaned`, every imported record is still in place. */
export function describeRemovalProgress(removal: InstitutionRemoval): RemovalProgressView {
  if (removal.finished) {
    return { message: 'This institution was removed.', actionLabel: null, actionEmphasis: 'secondary' };
  }
  if (removal.status === 'requested') {
    if (removal.last_outcome === 'needs_attention') {
      // A definitive refusal: offered only as a low-key "check again" once the cause is dealt with.
      return { message: needsAttentionMessage(removal.last_error_code), actionLabel: 'Check again', actionEmphasis: 'secondary' };
    }
    return {
      message: "We couldn't confirm the removal with Plaid yet. Nothing has been deleted. Try again to finish removing it.",
      actionLabel: 'Try removal again',
      actionEmphasis: 'primary',
    };
  }
  if (removal.status === 'plaid_removed') {
    return {
      message: 'The connection was removed at Plaid, but deleting its data here didn’t finish. Try again to finish.',
      actionLabel: 'Finish removal',
      actionEmphasis: 'primary',
    };
  }
  return {
    message: 'This institution’s data was removed, but a final update of your reports didn’t finish. Try again to finish.',
    actionLabel: 'Finish removal',
    actionEmphasis: 'primary',
  };
}

/** "Last synced …" text, or null when unknown. */
export function formatLastSynced(lastSyncedAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!lastSyncedAt) return null;
  const ms = Date.parse(lastSyncedAt);
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.round((now.getTime() - ms) / 60000);
  if (minutes < 1) return 'Last synced just now';
  if (minutes < 60) return `Last synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last synced ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `Last synced ${new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

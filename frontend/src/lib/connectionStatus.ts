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

/** What an unfinished removal needs from the user, in plain words. Nothing here ever implies data was
 *  deleted when it was not: until `cleaned`, every imported record is still in place. */
export function describeRemovalProgress(removal: InstitutionRemoval): { message: string; actionLabel: string | null } {
  if (removal.finished) {
    return { message: 'This institution was removed.', actionLabel: null };
  }
  if (removal.status === 'requested') {
    if (removal.last_outcome === 'needs_attention') {
      return {
        message: `Plaid couldn't remove this connection${removal.last_error_code ? ` (${removal.last_error_code})` : ''}. Nothing has been deleted. You can try again; if it keeps failing, this connection needs attention.`,
        actionLabel: 'Try removal again',
      };
    }
    return {
      message: "We couldn't confirm the removal with Plaid yet. Nothing has been deleted. Try again to finish removing it.",
      actionLabel: 'Try removal again',
    };
  }
  if (removal.status === 'plaid_removed') {
    return {
      message: 'The connection was removed at Plaid, but deleting its data here didn’t finish. Try again to finish.',
      actionLabel: 'Finish removal',
    };
  }
  return {
    message: 'This institution’s data was removed, but a final update of your reports didn’t finish. Try again to finish.',
    actionLabel: 'Finish removal',
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

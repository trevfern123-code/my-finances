import type { Request, Response } from 'express';
import * as dataService from '../services/dataService';
import * as syncService from '../services/syncService';
import { verifyPlaidWebhook } from '../services/webhookVerification';
import { PlaidCredentialError } from '../services/tokenEncryption';
import { summarizeErrorSafely } from '../services/errorSanitizer';
import { isSyncableItemStatus } from '../services/itemStatus';

interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  error?: { error_code?: string } | null;
  // LINK / SESSION_FINISHED only.
  link_token?: unknown;
  status?: unknown;
  // ITEM / PENDING_EXPIRATION only.
  consent_expiration_time?: unknown;
}

export async function handlePlaidWebhook(req: Request, res: Response) {
  const signature = req.headers['plaid-verification'];

  if (typeof signature !== 'string' || !req.rawBody) {
    res.status(400).json({ error: 'Missing signature or body' });
    return;
  }

  const verified = await verifyPlaidWebhook(signature, req.rawBody);
  if (!verified) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  const payload = req.body as PlaidWebhookPayload;

  // Acknowledge immediately — Plaid expects a fast response and retries on timeout/5xx.
  // The actual sync work continues after the response is sent.
  res.status(200).json({ acknowledged: true });

  processWebhook(payload).catch((err) => {
    // Never log the raw error — this is the fire-and-forget catch-all for the entire webhook
    // processing chain, including real Plaid/Axios errors from syncItemTransactions (whose
    // `.config` would carry the full outgoing request, access_token included). See
    // errorSanitizer.ts for why the raw object is unsafe.
    console.error('Failed to process Plaid webhook:', payload.webhook_code, summarizeErrorSafely(err));
  });
}

async function processWebhook(payload: PlaidWebhookPayload) {
  if (payload.webhook_type === 'LINK') {
    // Wave 1 Hosted Link. A SESSION_FINISHED webhook only records that Plaid finished the session
    // for this link token (matched by its hash). It never claims, exchanges or stores anything, and
    // its public_token(s) are deliberately ignored: only the attempt's own user, in its own login
    // session, can complete it (completeLinkAttempt), which re-reads the result from Plaid itself.
    // A duplicate delivery is a no-op. The link token is never logged.
    if (payload.webhook_code === 'SESSION_FINISHED' && typeof payload.link_token === 'string' && payload.link_token !== '') {
      await dataService.markPlaidLinkAttemptReady(payload.link_token, typeof payload.status === 'string' ? payload.status : 'UNKNOWN');
    }
    return;
  }

  // Linked Institution Management: the item's lifecycle status decides what (if anything) this webhook
  // may do, and is read WITHOUT decrypting its credential — a status webhook needs no token.
  const current = await dataService.getPlaidItemStatusByPlaidItemId(payload.item_id);
  if (!current) return; // Unknown or since-removed item — nothing to do.
  // A removal operation owns this item: nothing may sync it or change its status (itemStatus.ts).
  if (current.status === 'removing') return;

  if (payload.webhook_type === 'ITEM') {
    await processItemLifecycleWebhook(current.id, payload);
    return;
  }

  if (!(payload.webhook_type === 'TRANSACTIONS' && payload.webhook_code === 'SYNC_UPDATES_AVAILABLE')) return;
  // Revoked access stops syncing; the data stays until the user reconnects or removes the institution.
  if (!isSyncableItemStatus(current.status)) return;

  let item;
  try {
    item = await dataService.getPlaidItemByPlaidItemId(payload.item_id);
  } catch (err) {
    if (err instanceof PlaidCredentialError) {
      // The combined item-lookup-and-decrypt call is what failed, so unlike completeReauth
      // (which already has its internal row id from the route param before any decrypt is
      // attempted), there'd otherwise be no internal id available here at all — resolveAccessToken
      // attaches it to the thrown error itself (itemRowId, tokenEncryption.ts) specifically so
      // this case can still mark the correct row, rather than only being able to log Plaid's own
      // item_id and leave the row's status stale at 'active'.
      console.error(
        `Plaid credential error resolving webhook item ${payload.item_id}:`,
        summarizeErrorSafely(err)
      );
      if (err.itemRowId) {
        await dataService.transitionItemStatus(err.itemRowId, 'credential_error');
      }
      return;
    }
    throw err;
  }
  if (!item) return; // Removed between the two reads — nothing to do.
  await syncService.syncItemTransactions(item);
}

/**
 * ITEM webhooks that change a connection's lifecycle status. Each is a conditional transition
 * (itemStatus.ts), so none of them can override a status it does not own. None of them ever deletes
 * anything: a revoked connection keeps all its data until the user reconnects or removes it.
 */
async function processItemLifecycleWebhook(itemRowId: string, payload: PlaidWebhookPayload) {
  switch (payload.webhook_code) {
    case 'ERROR':
      if (payload.error?.error_code === 'ITEM_LOGIN_REQUIRED') {
        await dataService.transitionItemStatus(itemRowId, 'login_required');
      }
      return;
    case 'USER_PERMISSION_REVOKED':
      // Syncing stops; Update Mode (Reconnect) may restore access, and removal stays available.
      await dataService.transitionItemStatus(itemRowId, 'permission_revoked');
      return;
    case 'PENDING_EXPIRATION': {
      const expiresAt = parseWebhookTimestamp(payload.consent_expiration_time);
      if (expiresAt) {
        await dataService.recordItemPendingExpiration(itemRowId, expiresAt);
      } else {
        await dataService.transitionItemStatus(itemRowId, 'pending_expiration');
      }
      return;
    }
    case 'PENDING_DISCONNECT':
      // Plaid gives no date; any expiry recorded earlier is kept.
      await dataService.transitionItemStatus(itemRowId, 'pending_expiration');
      return;
    case 'LOGIN_REPAIRED':
      await dataService.transitionItemStatus(itemRowId, 'login_repaired');
      return;
    default:
      // NEW_ACCOUNTS_AVAILABLE, USER_ACCOUNT_REVOKED, WEBHOOK_UPDATE_ACKNOWLEDGED, ...: not handled in V1.
      return;
  }
}

/** An ISO 8601 timestamp from a webhook payload, or null if absent or not a real time. */
function parseWebhookTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

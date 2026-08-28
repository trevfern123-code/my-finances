import type { Request, Response } from 'express';
import * as dataService from '../services/dataService';
import * as syncService from '../services/syncService';
import { verifyPlaidWebhook } from '../services/webhookVerification';
import { PlaidCredentialError } from '../services/tokenEncryption';
import { summarizeErrorSafely } from '../services/errorSanitizer';

interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  error?: { error_code?: string } | null;
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
        await dataService.setItemStatus(err.itemRowId, 'credential_error');
      }
      return;
    }
    throw err;
  }
  if (!item) return; // Unknown or since-removed item — nothing to do.

  if (payload.webhook_type === 'TRANSACTIONS' && payload.webhook_code === 'SYNC_UPDATES_AVAILABLE') {
    await syncService.syncItemTransactions(item);
    return;
  }

  if (payload.webhook_type === 'ITEM' && payload.webhook_code === 'ERROR') {
    if (payload.error?.error_code === 'ITEM_LOGIN_REQUIRED') {
      await dataService.setItemStatus(item.id, 'login_required');
    }
  }
}

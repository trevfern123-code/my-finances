import type { Request, Response } from 'express';
import * as dataService from '../services/dataService';
import * as syncService from '../services/syncService';
import { verifyPlaidWebhook } from '../services/webhookVerification';
import { PlaidCredentialError } from '../services/tokenEncryption';

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
    console.error('Failed to process Plaid webhook:', payload.webhook_code, err);
  });
}

async function processWebhook(payload: PlaidWebhookPayload) {
  let item;
  try {
    item = await dataService.getPlaidItemByPlaidItemId(payload.item_id);
  } catch (err) {
    if (err instanceof PlaidCredentialError) {
      // Only Plaid's own item_id is known here — the row lookup itself is what failed, so
      // (unlike completeReauth, which already has its internal row id from the route param)
      // there's no internal id available to set a 'credential_error' status on. This is logged
      // clearly enough for a human to find the row directly (§12 treats this as an investigation
      // trigger, not something to auto-recover from anyway).
      console.error(`Plaid credential error resolving webhook item ${payload.item_id}:`, err.name);
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

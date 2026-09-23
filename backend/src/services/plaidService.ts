import {
  CountryCode,
  Products,
  SandboxItemFireWebhookRequestWebhookCodeEnum,
  type RemovedTransaction,
  type Transaction,
} from 'plaid';
import { plaidClient } from '../config/plaid';
import { env } from '../config/env';

export { isDefinitivePlaidRejection, isReauthRequiredError } from './plaidErrors';

const products = env.plaidProducts.map((p) => p as Products);
const countryCodes = env.plaidCountryCodes.map((c) => c as CountryCode);

const webhookUrl = env.backendPublicUrl ? `${env.backendPublicUrl}/api/webhooks/plaid` : undefined;

/** Seconds a Hosted Link URL stays usable — the same 30 minutes as the plaid_link_attempts row
 *  that owns it (see 20260922130000_plaid_link_attempts.sql). */
export const HOSTED_LINK_LIFETIME_SECONDS = 30 * 60;

/**
 * Wave 1: creates a Plaid HOSTED Link token. The user completes Link on Plaid's own page
 * (`hostedLinkUrl`); the public token it produces is retrieved later by the backend itself, with
 * this link token, via getLinkTokenSessions — it never passes through the browser. The link token
 * must be stored server-side only and never returned to a client or logged.
 */
export async function createHostedLinkToken(
  userId: string
): Promise<{ linkToken: string; hostedLinkUrl: string }> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'My Finances',
    products,
    country_codes: countryCodes,
    language: 'en',
    webhook: webhookUrl,
    hosted_link: {
      completion_redirect_uri: env.plaidHostedLinkCompletionRedirectUri,
      url_lifetime_seconds: HOSTED_LINK_LIFETIME_SECONDS,
    },
  });

  const { link_token: linkToken, hosted_link_url: hostedLinkUrl } = response.data;
  if (!hostedLinkUrl) {
    // Fail closed: without a Hosted Link URL the only way to finish would be embedded Link, which
    // hands the public token to the browser.
    throw new Error('Plaid did not return a Hosted Link URL');
  }
  return { linkToken, hostedLinkUrl };
}

/** The Link sessions Plaid recorded for `linkToken` (/link/token/get), including their public
 *  tokens. Only ever called with a link token read from this backend's own storage. */
export async function getLinkTokenSessions(linkToken: string) {
  const response = await plaidClient.linkTokenGet({ link_token: linkToken });
  return response.data.link_sessions ?? [];
}

/** Bounds how long one exchange (or compensating removal) may keep the completion request waiting.
 *  Hitting it does NOT mean Plaid did nothing — the outcome is then unknown (isDefinitivePlaidRejection
 *  is false) and the attempt is recorded as exchange_unknown, never retried. Must stay well under the
 *  two-minute staleness window in 20260922130000_plaid_link_attempts.sql. */
export const PLAID_EXCHANGE_TIMEOUT_MS = 30_000;

export async function exchangePublicToken(publicToken: string) {
  const response = await plaidClient.itemPublicTokenExchange({ public_token: publicToken }, { timeout: PLAID_EXCHANGE_TIMEOUT_MS });
  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}

/** Wave 1 compensation: removes an Item whose access token this backend received but could not
 *  store. Resolves only when Plaid confirmed the removal; any error means its result is unknown. */
export async function removeItem(accessToken: string): Promise<void> {
  await plaidClient.itemRemove({ access_token: accessToken }, { timeout: PLAID_EXCHANGE_TIMEOUT_MS });
}

/** Confirms `accessToken` is still a live, Plaid-accepted credential by calling **only**
 *  `itemGet` — deliberately does not call `institutionsGetById` or anything else. Used by the
 *  Plaid token-encryption backfill (`backend/src/scripts/backfillTokenEncryption.ts`) to verify a
 *  decrypted token without risking a false-positive credential failure from an unrelated Plaid
 *  call (see PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §22 — the whole reason this exists separately
 *  from `getItemInstitution` below, which *does* also call `institutionsGetById`). The response
 *  body is deliberately discarded — success/failure of the call is the only signal this needs. */
export async function verifyAccessTokenLive(accessToken: string): Promise<void> {
  await plaidClient.itemGet({ access_token: accessToken });
}

export async function getItemInstitution(accessToken: string) {
  const itemResponse = await plaidClient.itemGet({ access_token: accessToken });
  const institutionId = itemResponse.data.item.institution_id;

  if (!institutionId) {
    return { institutionId: null, institutionName: null };
  }

  const institutionResponse = await plaidClient.institutionsGetById({
    institution_id: institutionId,
    country_codes: countryCodes,
  });

  return {
    institutionId,
    institutionName: institutionResponse.data.institution.name,
  };
}

/** Creates a Plaid Link token in Update Mode, for repairing an existing item (e.g. after ITEM_LOGIN_REQUIRED). */
export async function createReauthLinkToken(userId: string, accessToken: string): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'My Finances',
    country_codes: countryCodes,
    language: 'en',
    access_token: accessToken,
    webhook: webhookUrl,
  });

  return response.data.link_token;
}

/** Backfills the webhook URL onto an item that was linked before webhooks were configured. */
export async function updateItemWebhook(accessToken: string) {
  if (!webhookUrl) return;
  await plaidClient.itemWebhookUpdate({ access_token: accessToken, webhook: webhookUrl });
}

/** Sandbox-only: forces an item into ITEM_LOGIN_REQUIRED so the reconnect flow can be tested. */
export async function sandboxResetLogin(accessToken: string) {
  await plaidClient.sandboxItemResetLogin({ access_token: accessToken });
}

/** Sandbox-only: asks Plaid to deliver a real test webhook for this item, to exercise the receiver end-to-end. */
export async function sandboxFireWebhook(accessToken: string) {
  await plaidClient.sandboxItemFireWebhook({
    access_token: accessToken,
    webhook_code: SandboxItemFireWebhookRequestWebhookCodeEnum.SyncUpdatesAvailable,
  });
}

export async function getAccounts(accessToken: string) {
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  return response.data.accounts;
}

export async function syncTransactions(accessToken: string, cursor: string | null) {
  let nextCursor = cursor ?? undefined;
  let hasMore = true;

  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: RemovedTransaction[] = [];

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
    });

    added.push(...response.data.added);
    modified.push(...response.data.modified);
    removed.push(...response.data.removed);
    hasMore = response.data.has_more;
    nextCursor = response.data.next_cursor;
  }

  return { added, modified, removed, cursor: nextCursor! };
}

/** Requires the `liabilities` Plaid product to be enabled for the item — otherwise Plaid rejects the call. */
export async function getLiabilities(accessToken: string) {
  const response = await plaidClient.liabilitiesGet({ access_token: accessToken });
  return response.data.liabilities;
}

export async function getRecurringStreams(accessToken: string) {
  const response = await plaidClient.transactionsRecurringGet({ access_token: accessToken });
  return {
    inflowStreams: response.data.inflow_streams,
    outflowStreams: response.data.outflow_streams,
  };
}

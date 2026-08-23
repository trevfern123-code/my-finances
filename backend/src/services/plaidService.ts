import {
  CountryCode,
  Products,
  SandboxItemFireWebhookRequestWebhookCodeEnum,
  type RemovedTransaction,
  type Transaction,
} from 'plaid';
import { plaidClient } from '../config/plaid';
import { env } from '../config/env';

export { isReauthRequiredError } from './plaidErrors';

const products = env.plaidProducts.map((p) => p as Products);
const countryCodes = env.plaidCountryCodes.map((c) => c as CountryCode);

const webhookUrl = env.backendPublicUrl ? `${env.backendPublicUrl}/api/webhooks/plaid` : undefined;

export async function createLinkToken(userId: string): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'My Finances',
    products,
    country_codes: countryCodes,
    language: 'en',
    webhook: webhookUrl,
  });

  return response.data.link_token;
}

export async function exchangePublicToken(publicToken: string) {
  const response = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
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

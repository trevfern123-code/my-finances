import { CountryCode, Products, type RemovedTransaction, type Transaction } from 'plaid';
import { plaidClient } from '../config/plaid';
import { env } from '../config/env';

const products = env.plaidProducts.map((p) => p as Products);
const countryCodes = env.plaidCountryCodes.map((c) => c as CountryCode);

export async function createLinkToken(userId: string): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'My Finances',
    products,
    country_codes: countryCodes,
    language: 'en',
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
  });

  return response.data.link_token;
}

interface PlaidApiErrorShape {
  response?: { data?: { error_code?: string } };
}

/** True for Plaid errors that mean the item's access token is no longer usable and the user must re-link. */
export function isReauthRequiredError(err: unknown): boolean {
  const code = (err as PlaidApiErrorShape)?.response?.data?.error_code;
  return code === 'ITEM_LOGIN_REQUIRED' || code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN';
}

/** Sandbox-only: forces an item into ITEM_LOGIN_REQUIRED so the reconnect flow can be tested. */
export async function sandboxResetLogin(accessToken: string) {
  await plaidClient.sandboxItemResetLogin({ access_token: accessToken });
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

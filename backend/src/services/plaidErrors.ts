interface PlaidApiErrorShape {
  response?: { data?: { error_code?: string } };
}

/** True for Plaid errors that mean the item's access token is no longer usable and the user must re-link. */
export function isReauthRequiredError(err: unknown): boolean {
  const code = (err as PlaidApiErrorShape)?.response?.data?.error_code;
  return code === 'ITEM_LOGIN_REQUIRED' || code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN';
}

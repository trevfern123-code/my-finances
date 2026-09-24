import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLinkTokenCreate = vi.hoisted(() => vi.fn());
const mockLinkTokenGet = vi.hoisted(() => vi.fn());
const mockItemPublicTokenExchange = vi.hoisted(() => vi.fn());
const mockItemRemove = vi.hoisted(() => vi.fn());
vi.mock('../config/plaid', () => ({
  plaidClient: {
    linkTokenCreate: mockLinkTokenCreate,
    linkTokenGet: mockLinkTokenGet,
    itemPublicTokenExchange: mockItemPublicTokenExchange,
    itemRemove: mockItemRemove,
  },
}));
vi.mock('../config/env', () => ({
  env: {
    plaidProducts: ['transactions'],
    plaidCountryCodes: ['US'],
    backendPublicUrl: 'https://backend.example.test',
    plaidHostedLinkCompletionRedirectUri: 'https://app.example.test/plaid-link-complete.html',
  },
}));

import {
  createHostedLinkToken,
  exchangePublicToken,
  getLinkTokenSessions,
  HOSTED_LINK_LIFETIME_SECONDS,
  PLAID_EXCHANGE_TIMEOUT_MS,
  removeItem,
} from './plaidService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createHostedLinkToken (Wave 1)', () => {
  it('asks Plaid for a HOSTED Link token with a 30-minute URL lifetime and the frontend completion page', async () => {
    mockLinkTokenCreate.mockResolvedValue({
      data: { link_token: 'link-sandbox-1', hosted_link_url: 'https://hosted.plaid.com/link/abc', expiration: 'x', request_id: 'r' },
    });

    await expect(createHostedLinkToken('user-1')).resolves.toEqual({
      linkToken: 'link-sandbox-1',
      hostedLinkUrl: 'https://hosted.plaid.com/link/abc',
    });

    expect(HOSTED_LINK_LIFETIME_SECONDS).toBe(1800);
    expect(mockLinkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { client_user_id: 'user-1' },
        webhook: 'https://backend.example.test/api/webhooks/plaid',
        hosted_link: {
          completion_redirect_uri: 'https://app.example.test/plaid-link-complete.html',
          url_lifetime_seconds: 1800,
        },
      })
    );
  });

  it('fails closed if Plaid returns no Hosted Link URL (never falls back to embedded Link)', async () => {
    mockLinkTokenCreate.mockResolvedValue({ data: { link_token: 'link-sandbox-1', expiration: 'x', request_id: 'r' } });
    await expect(createHostedLinkToken('user-1')).rejects.toThrow('Plaid did not return a Hosted Link URL');
  });
});

describe('getLinkTokenSessions (Wave 1)', () => {
  it('returns the link sessions Plaid recorded for the given link token', async () => {
    mockLinkTokenGet.mockResolvedValue({ data: { link_sessions: [{ link_session_id: 's1' }] } });
    await expect(getLinkTokenSessions('link-sandbox-1')).resolves.toEqual([{ link_session_id: 's1' }]);
    expect(mockLinkTokenGet).toHaveBeenCalledWith({ link_token: 'link-sandbox-1' });
  });

  it('treats a missing link_sessions field as no sessions', async () => {
    mockLinkTokenGet.mockResolvedValue({ data: {} });
    await expect(getLinkTokenSessions('link-sandbox-1')).resolves.toEqual([]);
  });
});

describe('exchangePublicToken / removeItem (Wave 1 recovery)', () => {
  it('bounds the exchange with a 30-second timeout, well inside the two-minute staleness window', async () => {
    mockItemPublicTokenExchange.mockResolvedValue({ data: { access_token: 'access-1', item_id: 'item-1', request_id: 'r' } });
    await expect(exchangePublicToken('public-1')).resolves.toEqual({ accessToken: 'access-1', itemId: 'item-1' });
    expect(PLAID_EXCHANGE_TIMEOUT_MS).toBe(30_000);
    expect(PLAID_EXCHANGE_TIMEOUT_MS).toBeLessThan(2 * 60 * 1000);
    expect(mockItemPublicTokenExchange).toHaveBeenCalledWith({ public_token: 'public-1' }, { timeout: PLAID_EXCHANGE_TIMEOUT_MS });
  });

  it('removeItem calls /item/remove for the access token and resolves only when Plaid confirmed it', async () => {
    mockItemRemove.mockResolvedValueOnce({ data: { request_id: 'r' } });
    await expect(removeItem('access-1')).resolves.toBeUndefined();
    expect(mockItemRemove).toHaveBeenCalledWith({ access_token: 'access-1' }, { timeout: PLAID_EXCHANGE_TIMEOUT_MS });
    const failure = new Error('socket hang up');
    mockItemRemove.mockRejectedValueOnce(failure);
    await expect(removeItem('access-1')).rejects.toBe(failure);
  });
});

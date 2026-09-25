// @vitest-environment jsdom
//
// Service-worker/version compatibility, phase 2: the Plaid flows hold the app-update guard while
// reloading would lose them (lib/appUpdate.ts), and release it when they end — including Reconnect
// being closed without finishing, which previously left the button stuck on "Reconnecting...".
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaidLinkError, PlaidLinkOnExitMetadata, PlaidLinkOptions } from 'react-plaid-link';
import { appUpdate } from '../lib/appUpdate';
import type { SessionOwnership } from '../lib/sessionOwnership';
import { PlaidLink } from './PlaidLink';
import { ReconnectButton } from './ReconnectButton';

const mockCreateHostedLinkAttempt = vi.hoisted(() => vi.fn());
const mockCompleteLinkAttempt = vi.hoisted(() => vi.fn());
const mockCreateReauthLinkToken = vi.hoisted(() => vi.fn());
const mockCompleteReauth = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  createHostedLinkAttempt: mockCreateHostedLinkAttempt,
  completeLinkAttempt: mockCompleteLinkAttempt,
  createReauthLinkToken: mockCreateReauthLinkToken,
  completeReauth: mockCompleteReauth,
}));

// The latest options ReconnectButton handed to Plaid Link, so a test can play Link's part.
let latestLinkOptions: PlaidLinkOptions | null = null;
const mockOpen = vi.hoisted(() => vi.fn());
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (options: PlaidLinkOptions) => {
    latestLinkOptions = options;
    return { open: mockOpen, ready: options.token !== '' };
  },
}));

const ownership: SessionOwnership = { verify: () => true, isCurrent: () => true };
const guards = () => appUpdate.getSnapshot().guards;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  latestLinkOptions = null;
  vi.spyOn(window, 'open').mockImplementation(
    () => ({ opener: {}, location: { replace: vi.fn() }, close: vi.fn() }) as unknown as Window
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  expect(guards()).toEqual([]); // nothing leaks between tests (or past unmount)
});

describe('PlaidLink (Hosted Link) — update guard', () => {
  it('holds hosted_link while the attempt is created and while it waits, and releases it on completion', async () => {
    const created = deferred<unknown>();
    mockCreateHostedLinkAttempt.mockReturnValue(created.promise);
    mockCompleteLinkAttempt.mockResolvedValue({ status: 'completed' });
    const onLinked = vi.fn();
    render(<PlaidLink onLinked={onLinked} captureOwnership={() => ownership} />);
    expect(guards()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Link a bank account' }));
    expect(guards()).toEqual(['hosted_link']); // preparing

    await act(async () => {
      created.resolve({
        link_attempt_id: 'attempt-1',
        hosted_link_url: 'https://hosted.plaid.com/link/abc',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    });
    expect(screen.getByText(/Finish linking in the Plaid tab/)).toBeTruthy();
    expect(guards()).toEqual(['hosted_link']); // waiting for Plaid

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(guards()).toEqual([]);
  });

  it('releases the guard when the attempt is cancelled', async () => {
    mockCreateHostedLinkAttempt.mockResolvedValue({
      link_attempt_id: 'attempt-1',
      hosted_link_url: 'https://hosted.plaid.com/link/abc',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    render(<PlaidLink onLinked={vi.fn()} captureOwnership={() => ownership} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link a bank account' }));
    });
    expect(guards()).toEqual(['hosted_link']);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(guards()).toEqual([]);
  });

  it('releases the guard when creating the attempt fails (including an update-required refusal)', async () => {
    mockCreateHostedLinkAttempt.mockRejectedValue(
      Object.assign(new Error('This version of the app is out of date.'), { code: 'client_update_required' })
    );
    render(<PlaidLink onLinked={vi.fn()} captureOwnership={() => ownership} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link a bank account' }));
    });
    expect(screen.getByText('This version of the app is out of date.')).toBeTruthy();
    expect(guards()).toEqual([]);
  });

  it('releases the guard when completion is refused with a final (coded) answer', async () => {
    mockCreateHostedLinkAttempt.mockResolvedValue({
      link_attempt_id: 'attempt-1',
      hosted_link_url: 'https://hosted.plaid.com/link/abc',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    mockCompleteLinkAttempt.mockRejectedValue(
      Object.assign(new Error('This version of the app is out of date.'), { code: 'client_update_required' })
    );
    render(<PlaidLink onLinked={vi.fn()} captureOwnership={() => ownership} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link a bank account' }));
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(guards()).toEqual([]));
  });

  it('releases the guard on unmount (a sign-in change)', async () => {
    mockCreateHostedLinkAttempt.mockReturnValue(new Promise(() => {}));
    const view = render(<PlaidLink onLinked={vi.fn()} captureOwnership={() => ownership} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank account' }));
    expect(guards()).toEqual(['hosted_link']);
    view.unmount();
    expect(guards()).toEqual([]);
  });
});

describe('ReconnectButton (Plaid Link Update Mode) — onExit and update guard', () => {
  function renderReconnect() {
    return render(
      <ReconnectButton
        itemId="item-1"
        institutionName="Test Bank"
        createRefreshCommitter={() => vi.fn()}
        captureOwnership={() => ownership}
      />
    );
  }

  async function startReconnect() {
    mockCreateReauthLinkToken.mockResolvedValue({ link_token: 'link-update-token' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    });
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
  }

  it('holds the reconnect guard while Link is open; closing Link clears busy and releases it', async () => {
    renderReconnect();
    await startReconnect();
    expect(guards()).toEqual(['reconnect']);
    expect(screen.getByRole('button', { name: 'Reconnecting...' })).toBeTruthy();

    // The user closes Plaid Link without finishing.
    await act(async () => {
      latestLinkOptions!.onExit!(null, {} as PlaidLinkOnExitMetadata);
    });
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(false);
    expect(guards()).toEqual([]);
    expect(mockCompleteReauth).not.toHaveBeenCalled();
  });

  it('shows Link’s own error message when Link exits with an error', async () => {
    renderReconnect();
    await startReconnect();
    await act(async () => {
      latestLinkOptions!.onExit!(
        { display_message: 'The institution is unavailable.', error_message: 'x', error_code: 'X', error_type: 'Y' } as PlaidLinkError,
        {} as PlaidLinkOnExitMetadata
      );
    });
    expect(screen.getByText('The institution is unavailable.')).toBeTruthy();
    expect(guards()).toEqual([]);
  });

  it('keeps the guard through completion after success, then releases it', async () => {
    const completed = deferred<{ items: [] }>();
    mockCompleteReauth.mockReturnValue(completed.promise);
    renderReconnect();
    await startReconnect();
    act(() => {
      void latestLinkOptions!.onSuccess('public-token', {} as never);
    });
    expect(guards()).toEqual(['reconnect']);
    await act(async () => {
      completed.resolve({ items: [] });
    });
    expect(guards()).toEqual([]);
  });

  it('releases the guard when fetching the Update Mode token fails', async () => {
    mockCreateReauthLinkToken.mockRejectedValue(new Error('nope'));
    renderReconnect();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    });
    expect(screen.getByText('nope')).toBeTruthy();
    expect(guards()).toEqual([]);
  });
});

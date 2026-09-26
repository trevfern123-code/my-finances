// @vitest-environment jsdom
//
// Linked Institution Management V1: the removal confirmation/progress panel, the per-connection
// controls, and revoked-access reconnect guidance.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaidLinkError, PlaidLinkOnExitMetadata, PlaidLinkOptions } from 'react-plaid-link';
import type { InstitutionRemoval, InstitutionRemovalPreview, LinkedItem } from '../lib/api';
import type { SessionOwnership } from '../lib/sessionOwnership';
import { RemoveInstitutionPanel, describeFinishedRemoval } from './RemoveInstitutionPanel';
import { ConnectionControls, UnfinishedRemovals } from './ConnectionControls';
import { ReconnectButton, REVOKED_UNRECOVERABLE_MESSAGE } from './ReconnectButton';

const mockGetPreview = vi.hoisted(() => vi.fn());
const mockRemoveInstitution = vi.hoisted(() => vi.fn());
const mockGetRemoval = vi.hoisted(() => vi.fn());
const mockCreateReauthLinkToken = vi.hoisted(() => vi.fn());
const mockCompleteReauth = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  getInstitutionRemovalPreview: mockGetPreview,
  removeInstitution: mockRemoveInstitution,
  getInstitutionRemoval: mockGetRemoval,
  createReauthLinkToken: mockCreateReauthLinkToken,
  completeReauth: mockCompleteReauth,
}));

let latestLinkOptions: PlaidLinkOptions | null = null;
const mockOpen = vi.hoisted(() => vi.fn());
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (options: PlaidLinkOptions) => {
    latestLinkOptions = options;
    return { open: mockOpen, ready: options.token !== '' };
  },
}));

const ownership: SessionOwnership = { verify: () => true, isCurrent: () => true };
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

function preview(overrides: Partial<InstitutionRemovalPreview> = {}): InstitutionRemovalPreview {
  return {
    item_id: 'item-1',
    institution_name: 'Test Bank',
    status: 'active',
    accounts: [{ id: 'a1', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking' }],
    counts: { accounts: 1, transactions: 12, linked_transactions: 2, splits: 1, recurring_streams: 2, liabilities: 0 },
    loan_restorations: [
      { loan_id: 'l1', loan_name: 'Car loan', linked_transactions: 2, restore_amount: 150, current_balance: 850, balance_after: 1000 },
    ],
    unrestorable_links: 0,
    digest: 'digest-1',
    ...overrides,
  };
}

function removal(overrides: Partial<InstitutionRemoval> = {}): InstitutionRemoval {
  return {
    item_id: 'item-1', institution_name: 'Test Bank', status: 'requested', finished: false, attempts: 1,
    last_outcome: 'retryable', last_error_code: null, plaid_outcome: null, loan_adjustments: null, deleted_counts: null,
    requested_at: '2026-09-26T00:00:00Z', cleaned_at: null, ...overrides,
  };
}

const finished = removal({
  status: 'cleaned', finished: true, last_outcome: null, plaid_outcome: 'removed', cleaned_at: 'x',
  loan_adjustments: [{ loan_id: 'l1', loan_name: 'Car loan', linked_transactions: 2, restored: 150, balance_before: 850, balance_after: 1000 }],
  deleted_counts: { accounts: 1 },
});

beforeEach(() => {
  vi.clearAllMocks();
  latestLinkOptions = null;
});
afterEach(() => cleanup());

function renderPanel(props: Partial<Parameters<typeof RemoveInstitutionPanel>[0]> = {}) {
  const onRemoved = vi.fn();
  const onClose = vi.fn();
  render(
    <RemoveInstitutionPanel
      itemId="item-1"
      institutionName="Test Bank"
      captureOwnership={() => ownership}
      onRemoved={onRemoved}
      onClose={onClose}
      {...props}
    />
  );
  return { onRemoved, onClose };
}

describe('RemoveInstitutionPanel', () => {
  it('shows exactly what will be deleted and restored before confirming, with focus on its heading', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    renderPanel();
    await screen.findByRole('button', { name: 'Remove institution' });
    expect(document.activeElement?.textContent).toBe('Remove Test Bank');
    const panel = screen.getByRole('region', { name: 'Remove Test Bank' });
    expect(panel.textContent).toMatch(/can’t be undone/);
    expect(panel.textContent).toMatch(/1 account: Checking \(1234\)/);
    expect(panel.textContent).toMatch(/12 transactions, with 1 split/);
    expect(panel.textContent).toMatch(/2 recurring payments/);
    expect(panel.textContent).toMatch(/Car loan: \+\$150\.00 \(\$850\.00 → \$1,000\.00\)/);
    expect(panel.textContent).toMatch(/net-worth history keeps its past values/);
    expect(mockRemoveInstitution).not.toHaveBeenCalled(); // nothing happens until confirmed
  });

  it('confirming sends the preview digest; a finished removal is reported to the parent', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    mockRemoveInstitution.mockResolvedValue({ removal: finished });
    const { onRemoved } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove institution' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(finished));
    expect(mockRemoveInstitution).toHaveBeenCalledExactlyOnceWith('item-1', 'digest-1', ownership.verify);
  });

  it('a double click sends one request', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    let resolve!: (v: unknown) => void;
    mockRemoveInstitution.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Remove institution' });
    act(() => {
      button.click();
      button.click();
    });
    expect(mockRemoveInstitution).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/Removing Test Bank/);
    await act(async () => resolve({ removal: finished }));
  });

  it('an unfinished removal (Plaid outcome unknown) shows that nothing was deleted and offers a retry of the SAME operation', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    mockRemoveInstitution.mockResolvedValueOnce({ removal: removal() });
    const { onRemoved } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove institution' }));
    expect(await screen.findByText(/Nothing has been deleted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull(); // no cancellation once begun
    mockRemoveInstitution.mockResolvedValueOnce({ removal: finished });
    fireEvent.click(screen.getByRole('button', { name: 'Try removal again' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(finished));
    expect(mockRemoveInstitution).toHaveBeenLastCalledWith('item-1', null, ownership.verify); // resume, digest not needed
  });

  it('a stale preview is shown again (with the reason) instead of removing', async () => {
    mockGetPreview
      .mockResolvedValueOnce({ preview: preview(), blocked_reason: null, blocked_message: null })
      .mockResolvedValueOnce({ preview: preview({ digest: 'digest-2' }), blocked_reason: null, blocked_message: null });
    mockRemoveInstitution.mockRejectedValueOnce(coded('This institution changed since you reviewed it.', 'preview_stale'));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove institution' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed since you reviewed it/);
    mockRemoveInstitution.mockResolvedValueOnce({ removal: finished });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove institution' }));
    await waitFor(() => expect(mockRemoveInstitution).toHaveBeenLastCalledWith('item-1', 'digest-2', ownership.verify));
  });

  it('a blocked removal (unrestorable loan link / credential problem) offers no Remove button', async () => {
    mockGetPreview.mockResolvedValue({
      preview: preview({ unrestorable_links: 1 }),
      blocked_reason: 'manual_loan_reconciliation_required',
      blocked_message: "its loan balance can't be restored exactly. Nothing was removed.",
    });
    renderPanel();
    expect(await screen.findByText(/can't be restored exactly/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove institution' })).toBeNull();
  });

  it('a lost response never retries on its own: it re-reads the recorded operation', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    mockRemoveInstitution.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockGetRemoval.mockResolvedValue({ removal: removal({ status: 'plaid_removed', last_outcome: null }) });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove institution' }));
    expect(await screen.findByText(/removed at Plaid/)).toBeTruthy();
    expect(mockRemoveInstitution).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Finish removal' })).toBeTruthy();
  });

  it('an operation already under way is resumed, not previewed again', async () => {
    renderPanel({ existingRemoval: removal(), onClose: undefined });
    expect(screen.getByRole('status').textContent).toMatch(/Nothing has been deleted/);
    expect(mockGetPreview).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try removal again' })).toBeTruthy();
  });

  it('a definitive Plaid refusal (needs attention) does not suggest an immediate retry will help', async () => {
    renderPanel({ existingRemoval: removal({ last_outcome: 'needs_attention', last_error_code: 'INVALID_ACCESS_TOKEN' }), onClose: undefined });
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toMatch(/INVALID_ACCESS_TOKEN.*Nothing has been deleted.*unlikely to help/);
    expect(screen.queryByRole('button', { name: 'Try removal again' })).toBeNull();
    const check = screen.getByRole('button', { name: 'Check again' });
    expect(check.className).toBe('link-button'); // a low-key action, not the primary one
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull(); // never a local-only removal
  });

  it.each([
    ['CREDENTIAL_UNREADABLE', /can’t read this connection’s stored credential/],
    ['MANUAL_LOAN_OWNERSHIP_MISMATCH', /linked to a loan that doesn’t belong to this account/],
    ['MANUAL_LOAN_RECONCILIATION_REQUIRED', /no recorded applied amount/],
  ])('needs attention because of %s explains that cause', (code, text) => {
    renderPanel({ existingRemoval: removal({ last_outcome: 'needs_attention', last_error_code: code }), onClose: undefined });
    expect(screen.getByRole('status').textContent).toMatch(text);
    expect(screen.getByRole('status').textContent).toMatch(/Nothing has been deleted/);
  });

  it('a blocked preview is announced (role=alert) and offers no Remove button', async () => {
    mockGetPreview.mockResolvedValue({
      preview: preview({ ownership_mismatch_links: 1, blocker: 'manual_loan_ownership_mismatch', loan_restorations: [] }),
      blocked_reason: 'manual_loan_ownership_mismatch',
      blocked_message: "This institution has a payment linked to a loan that doesn't belong to this account, so it can't be removed safely. Nothing was removed.",
    });
    renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/doesn't belong to this account.*Nothing was removed/);
    expect(screen.queryByRole('button', { name: 'Remove institution' })).toBeNull();
  });

  it('an ownership refusal at confirmation shows the blocked message (announced), never a retry', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    mockRemoveInstitution.mockRejectedValueOnce(
      coded("This institution has a payment linked to a loan that doesn't belong to this account, so it can't be removed safely. Nothing was removed.", 'manual_loan_ownership_mismatch')
    );
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove institution' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing was removed/);
    expect(screen.queryByRole('button', { name: /again/i })).toBeNull();
    expect(mockGetRemoval).not.toHaveBeenCalled();
  });

  it('a preview refused because a removal already exists switches to that operation', async () => {
    mockGetPreview.mockRejectedValue(coded('already being removed', 'removal_in_progress'));
    mockGetRemoval.mockResolvedValue({ removal: removal() });
    renderPanel();
    expect((await screen.findByRole('status')).textContent).toMatch(/couldn't confirm the removal/);
  });

  it('describes a finished removal with the loan amounts added back', () => {
    expect(describeFinishedRemoval(finished)).toBe('Test Bank was removed. Car loan: $150.00 added back (now $1,000.00).');
  });
});

describe('ConnectionControls', () => {
  const item = (overrides: Partial<LinkedItem> = {}): LinkedItem => ({
    id: 'item-1', institution_id: null, institution_name: 'Test Bank', status: 'active', accounts: [], ...overrides,
  });
  const renderControls = (i: LinkedItem) =>
    render(<ConnectionControls item={i} createRefreshCommitter={() => vi.fn()} captureOwnership={() => ownership} onRemoved={vi.fn()} />);

  it('active: Remove institution, no Reconnect', () => {
    renderControls(item());
    expect(screen.getByRole('button', { name: 'Remove institution' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('permission_revoked: Reconnect AND Remove, with the data-kept explanation', () => {
    renderControls(item({ status: 'permission_revoked' }));
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove institution' })).toBeTruthy();
    expect(screen.getByText(/Access revoked: .*still here/)).toBeTruthy();
  });

  it('credential_error: neither Reconnect nor Remove', () => {
    renderControls(item({ status: 'credential_error' }));
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove institution' })).toBeNull();
    expect(screen.getByText(/Needs attention/)).toBeTruthy();
  });

  it('removing: shows the operation with its retry (after a reload too), never a fresh Remove', () => {
    renderControls(item({ status: 'removing', removal: removal() }));
    expect(screen.queryByRole('button', { name: 'Remove institution' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try removal again' })).toBeTruthy();
  });

  it('Remove opens the confirmation; Cancel closes it without removing', async () => {
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    renderControls(item());
    fireEvent.click(screen.getByRole('button', { name: 'Remove institution' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(mockRemoveInstitution).not.toHaveBeenCalled();
  });

  it('lists an unfinished removal whose institution is already gone, so it can be finished', () => {
    render(
      <UnfinishedRemovals
        removals={[removal({ item_id: 'gone', status: 'cleaned', last_outcome: null, cleaned_at: 'x' })]}
        items={[]}
        captureOwnership={() => ownership}
        onRemoved={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Finish removal' })).toBeTruthy();
  });
});

describe('ReconnectButton — revoked access', () => {
  it('when Update Mode cannot restore revoked access, tells the user to remove and link again', async () => {
    mockCreateReauthLinkToken.mockResolvedValue({ link_token: 'link-update' });
    render(
      <ReconnectButton itemId="item-1" institutionName="Test Bank" createRefreshCommitter={() => vi.fn()} captureOwnership={() => ownership} revoked />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    });
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    await act(async () => {
      latestLinkOptions!.onExit!({ error_code: 'ITEM_NOT_FOUND', display_message: '' } as PlaidLinkError, {} as PlaidLinkOnExitMetadata);
    });
    expect(screen.getByText(REVOKED_UNRECOVERABLE_MESSAGE)).toBeTruthy();
  });

  it("shows the server's reconnect_unavailable guidance when Plaid refuses Update Mode", async () => {
    mockCreateReauthLinkToken.mockRejectedValue(
      coded("This connection couldn't be restored. Remove the institution, then link the bank again.", 'reconnect_unavailable')
    );
    render(
      <ReconnectButton itemId="item-1" institutionName="Test Bank" createRefreshCommitter={() => vi.fn()} captureOwnership={() => ownership} revoked />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    });
    expect(screen.getByText(/link the bank again/)).toBeTruthy();
  });
});

describe('focus', () => {
  it('a panel shown on page load (removal under way) does not steal focus; one the user opens does', async () => {
    const before = document.activeElement;
    render(
      <ConnectionControls
        item={{ id: 'item-1', institution_id: null, institution_name: 'Test Bank', status: 'removing', accounts: [], removal: removal() }}
        createRefreshCommitter={() => vi.fn()}
        captureOwnership={() => ownership}
        onRemoved={vi.fn()}
      />
    );
    expect(document.activeElement).toBe(before);
    cleanup();
    mockGetPreview.mockResolvedValue({ preview: preview(), blocked_reason: null, blocked_message: null });
    render(
      <ConnectionControls
        item={{ id: 'item-1', institution_id: null, institution_name: 'Test Bank', status: 'active', accounts: [] }}
        createRefreshCommitter={() => vi.fn()}
        captureOwnership={() => ownership}
        onRemoved={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove institution' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Remove Test Bank'));
  });
});

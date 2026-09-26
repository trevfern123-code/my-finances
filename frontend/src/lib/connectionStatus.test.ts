import { describe, expect, it } from 'vitest';
import type { InstitutionRemoval } from './api';
import { describeConnectionStatus, describeRemovalProgress, formatLastSynced } from './connectionStatus';

describe('describeConnectionStatus', () => {
  it('active: removable, nothing to reconnect', () => {
    expect(describeConnectionStatus('active')).toMatchObject({ label: 'Connected', canReconnect: false, canRemove: true });
  });

  it('login_required and pending_expiration: Reconnect and Remove', () => {
    expect(describeConnectionStatus('login_required')).toMatchObject({ label: 'Sign-in needed', canReconnect: true, canRemove: true });
    expect(describeConnectionStatus('pending_expiration')).toMatchObject({ label: 'Reconnect soon', canReconnect: true, canRemove: true });
  });

  it('pending_expiration names the expiry date when Plaid gave one', () => {
    expect(describeConnectionStatus('pending_expiration', '2026-10-02T12:00:00Z').description).toMatch(/expires on .*2026/);
    expect(describeConnectionStatus('pending_expiration', null).description).toMatch(/stop syncing soon/);
  });

  it('permission_revoked: Reconnect (Update Mode may restore it) AND Remove; data is kept', () => {
    const view = describeConnectionStatus('permission_revoked');
    expect(view).toMatchObject({ label: 'Access revoked', canReconnect: true, canRemove: true });
    expect(view.description).toMatch(/still here/);
  });

  it('credential_error: never offers Reconnect, and explains why Remove is unavailable', () => {
    const view = describeConnectionStatus('credential_error');
    expect(view).toMatchObject({ canReconnect: false, canRemove: false });
    expect(view.removeUnavailableReason).toBeTruthy();
  });

  it('removing: neither action (the removal is resumed, not restarted)', () => {
    expect(describeConnectionStatus('removing')).toMatchObject({ label: 'Removing', canReconnect: false, canRemove: false });
  });

  it('every status has a text label (never colour alone)', () => {
    for (const s of ['active', 'login_required', 'pending_expiration', 'credential_error', 'permission_revoked', 'removing']) {
      expect(describeConnectionStatus(s).label.length).toBeGreaterThan(0);
    }
  });
});

describe('describeRemovalProgress', () => {
  const removal = (overrides: Partial<InstitutionRemoval>): InstitutionRemoval => ({
    item_id: 'i', institution_name: 'Bank', status: 'requested', finished: false, attempts: 1, last_outcome: 'retryable',
    last_error_code: null, plaid_outcome: null, loan_adjustments: null, deleted_counts: null, requested_at: 'x', cleaned_at: null,
    ...overrides,
  });

  it('before cleanup, it always says nothing has been deleted', () => {
    expect(describeRemovalProgress(removal({})).message).toMatch(/Nothing has been deleted/);
    expect(describeRemovalProgress(removal({ last_outcome: 'needs_attention', last_error_code: 'INVALID_ACCESS_TOKEN' })).message).toMatch(
      /INVALID_ACCESS_TOKEN.*Nothing has been deleted/
    );
  });

  it('offers the right action for each unfinished state', () => {
    expect(describeRemovalProgress(removal({})).actionLabel).toBe('Try removal again');
    expect(describeRemovalProgress(removal({ status: 'plaid_removed', last_outcome: null })).actionLabel).toBe('Finish removal');
    expect(describeRemovalProgress(removal({ status: 'cleaned', last_outcome: null })).actionLabel).toBe('Finish removal');
    expect(describeRemovalProgress(removal({ status: 'cleaned', finished: true })).actionLabel).toBeNull();
  });
});

describe('formatLastSynced', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  it('formats recent and older syncs, and returns null when unknown', () => {
    expect(formatLastSynced(null, now)).toBeNull();
    expect(formatLastSynced('garbage', now)).toBeNull();
    expect(formatLastSynced('2026-09-26T11:59:50Z', now)).toBe('Last synced just now');
    expect(formatLastSynced('2026-09-26T11:55:00Z', now)).toBe('Last synced 5 minutes ago');
    expect(formatLastSynced('2026-09-26T09:00:00Z', now)).toBe('Last synced 3 hours ago');
    expect(formatLastSynced('2026-09-20T09:00:00Z', now)).toMatch(/^Last synced .*2026/);
  });
});

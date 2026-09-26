import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isSyncableItemStatus,
  PLAID_ITEM_STATUSES,
  STATUS_TRANSITIONS,
  type ItemStatusTransition,
} from './itemStatus';

const ALL_TRANSITIONS = Object.keys(STATUS_TRANSITIONS) as ItemStatusTransition[];

describe('item status transitions (Linked Institution Management)', () => {
  it('no ordinary transition ever leaves removing, or targets it', () => {
    for (const t of ALL_TRANSITIONS) {
      expect(canTransition('removing', t)).toBe(false);
      expect(STATUS_TRANSITIONS[t].to).not.toBe('removing');
    }
  });

  it('an ordinary successful sync or refresh cannot clear permission_revoked or pending_expiration', () => {
    expect(canTransition('permission_revoked', 'synced')).toBe(false);
    expect(canTransition('pending_expiration', 'synced')).toBe(false);
    expect(canTransition('login_required', 'synced')).toBe(true);
    expect(canTransition('credential_error', 'synced')).toBe(true);
  });

  it('a completed reconnect (Update Mode) restores permission_revoked, pending_expiration and login_required', () => {
    for (const s of ['permission_revoked', 'pending_expiration', 'login_required', 'credential_error', 'active']) {
      expect(canTransition(s, 'reauth_completed')).toBe(true);
    }
  });

  it('automatic failure signals never replace permission_revoked', () => {
    expect(canTransition('permission_revoked', 'login_required')).toBe(false);
    expect(canTransition('permission_revoked', 'credential_error')).toBe(false);
    expect(canTransition('permission_revoked', 'pending_expiration')).toBe(false);
  });

  it('PENDING_EXPIRATION only flags a healthy item (it never masks login_required)', () => {
    expect(STATUS_TRANSITIONS.pending_expiration.from).toEqual(['active']);
  });

  it('every source/target status is a real status', () => {
    for (const t of ALL_TRANSITIONS) {
      expect(PLAID_ITEM_STATUSES).toContain(STATUS_TRANSITIONS[t].to);
      for (const s of STATUS_TRANSITIONS[t].from) expect(PLAID_ITEM_STATUSES).toContain(s);
    }
  });

  it('syncing stops for revoked and removing items only', () => {
    expect(PLAID_ITEM_STATUSES.filter((s) => !isSyncableItemStatus(s))).toEqual(['permission_revoked', 'removing']);
  });
});

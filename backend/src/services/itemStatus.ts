/**
 * Linked Institution Management: the connection lifecycle of a Plaid item (`plaid_items.status`,
 * constrained by 20260926120000_linked_institution_management.sql) and which ordinary writer may move
 * an item from which status to which.
 *
 * Every status write in the backend goes through one of these named transitions
 * (dataService.transitionItemStatus), which applies it as ONE conditional UPDATE (`... where status in
 * (from)`). So a writer can never overwrite a status it does not own — most importantly:
 *   - nothing here ever leaves `removing` (and the database trigger plaid_items_keep_removing backs
 *     that up): a removal operation owns the item until its cleanup deletes the row;
 *   - an ordinary successful sync/refresh cannot clear `permission_revoked` or `pending_expiration`
 *     (only a completed reconnect, i.e. Update Mode, does);
 *   - an automatic failure signal never downgrades `permission_revoked` to something vaguer.
 * `removing` itself is entered only by begin_plaid_item_removal.
 */

export const PLAID_ITEM_STATUSES = [
  'active',
  'login_required',
  'pending_expiration',
  'credential_error',
  'permission_revoked',
  'removing',
] as const;

export type PlaidItemStatus = (typeof PLAID_ITEM_STATUSES)[number];

export type ItemStatusTransition =
  /** A sync or balance refresh succeeded, so the bank accepted the credential and we could read it. */
  | 'synced'
  /** Update Mode completed and the credential verified (completeReauth). */
  | 'reauth_completed'
  /** Plaid's LOGIN_REPAIRED webhook. */
  | 'login_repaired'
  /** ITEM_LOGIN_REQUIRED (webhook, or a sync/refresh rejected by Plaid). */
  | 'login_required'
  /** This app could not decrypt/read its stored token. */
  | 'credential_error'
  /** PENDING_EXPIRATION / PENDING_DISCONNECT. */
  | 'pending_expiration'
  /** USER_PERMISSION_REVOKED. */
  | 'permission_revoked';

export const STATUS_TRANSITIONS: Record<
  ItemStatusTransition,
  { to: PlaidItemStatus; from: readonly PlaidItemStatus[] }
> = {
  synced: { to: 'active', from: ['login_required', 'credential_error'] },
  reauth_completed: {
    to: 'active',
    from: ['active', 'login_required', 'pending_expiration', 'credential_error', 'permission_revoked'],
  },
  login_repaired: { to: 'active', from: ['login_required'] },
  login_required: { to: 'login_required', from: ['active', 'pending_expiration', 'credential_error'] },
  credential_error: { to: 'credential_error', from: ['active', 'login_required', 'pending_expiration'] },
  pending_expiration: { to: 'pending_expiration', from: ['active'] },
  permission_revoked: {
    to: 'permission_revoked',
    from: ['active', 'login_required', 'pending_expiration', 'credential_error'],
  },
};

/** Items that manual sync, balance refresh and webhooks act on. A revoked item stops syncing (its data
 *  is kept); a removing item is frozen until its removal finishes. */
export const SYNCABLE_ITEM_STATUSES: readonly PlaidItemStatus[] = [
  'active',
  'login_required',
  'pending_expiration',
  'credential_error',
];

export function isSyncableItemStatus(status: string): boolean {
  return (SYNCABLE_ITEM_STATUSES as readonly string[]).includes(status);
}

/** Whether the transition may be applied to an item currently in `status`. */
export function canTransition(status: string, transition: ItemStatusTransition): boolean {
  return (STATUS_TRANSITIONS[transition].from as readonly string[]).includes(status);
}

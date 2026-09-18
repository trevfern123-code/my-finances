// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualLoanInput } from './api';

const input: ManualLoanInput = {
  name: 'Car',
  loan_type: 'personal',
  current_balance: 1200,
  origination_principal_amount: null,
  interest_rate_percentage: null,
  origination_date: null,
  term_months: null,
  minimum_payment_amount: null,
  next_payment_due_date: null,
  notes: null,
  match_text: null,
};

const KEY = 'myfinances.pendingManualLoanCreation.user-a';

async function freshModule() {
  // A new module instance carries no state of its own — the closest a unit test gets to a page
  // reload, so anything still found afterwards genuinely came from localStorage.
  vi.resetModules();
  return import('./pendingManualLoanCreation');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pendingManualLoanCreation (Round 11/12 remediation)', () => {
  it('persists the exact record durably, and it survives a module reload', async () => {
    const first = await freshModule();
    first.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input });
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ idempotencyKey: 'k1', input }));

    const reloaded = await freshModule();
    expect(reloaded.loadPendingManualLoanCreation('user-a')).toEqual({ idempotencyKey: 'k1', input });
  });

  it('THROWS when localStorage.setItem throws — there is no silent in-memory fallback', async () => {
    const store = await freshModule();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    expect(() => store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input })).toThrow(
      store.PendingCreationPersistenceError
    );
    // Nothing is left behind that a later load could mistake for a resumable attempt.
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
  });

  it('THROWS when the write appears to succeed but does not read back identically', async () => {
    const store = await freshModule();
    const realGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      const value = realGetItem.call(this, key);
      return value === null ? null : value.replace('"k1"', '"corrupted"');
    });

    expect(() => store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input })).toThrow(
      store.PendingCreationPersistenceError
    );
  });

  it('THROWS when localStorage itself is inaccessible (blocked site data)', async () => {
    const store = await freshModule();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });

    expect(() => store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input })).toThrow(
      store.PendingCreationPersistenceError
    );
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
  });

  it('accepts an already-durable record without rewriting it, so retrying still works once storage is full', async () => {
    const store = await freshModule();
    store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    expect(() => store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input })).not.toThrow();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('is scoped per user', async () => {
    const store = await freshModule();
    store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input });
    expect(store.loadPendingManualLoanCreation('user-b')).toBeNull();
  });

  it('clears only the attempt whose outcome was confirmed, never a different one', async () => {
    const store = await freshModule();
    store.persistPendingManualLoanCreation('user-a', { idempotencyKey: 'k2', input });
    store.clearPendingManualLoanCreation('user-a', 'k1');
    expect(store.loadPendingManualLoanCreation('user-a')?.idempotencyKey).toBe('k2');
    store.clearPendingManualLoanCreation('user-a', 'k2');
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
  });

  it('ignores corrupt or malformed stored values rather than resuming garbage', async () => {
    const store = await freshModule();
    localStorage.setItem(KEY, '{not json');
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ idempotencyKey: '' }));
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

async function freshModule() {
  // A new module instance has an empty in-memory fallback — the closest a unit test gets to a page
  // reload, so anything still found afterwards genuinely came from localStorage.
  vi.resetModules();
  return import('./pendingManualLoanCreation');
}

beforeEach(() => {
  localStorage.clear();
});

describe('pendingManualLoanCreation (Round 11 remediation)', () => {
  it('survives a module reload via localStorage', async () => {
    const first = await freshModule();
    first.savePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input });

    const reloaded = await freshModule();
    expect(reloaded.loadPendingManualLoanCreation('user-a')).toEqual({ idempotencyKey: 'k1', input });
  });

  it('is scoped per user', async () => {
    const store = await freshModule();
    store.savePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input });
    expect(store.loadPendingManualLoanCreation('user-b')).toBeNull();
  });

  it('a clear for an OLDER key never erases a newer pending attempt', async () => {
    const store = await freshModule();
    store.savePendingManualLoanCreation('user-a', { idempotencyKey: 'k2', input });
    store.clearPendingManualLoanCreation('user-a', 'k1');
    expect(store.loadPendingManualLoanCreation('user-a')?.idempotencyKey).toBe('k2');
    store.clearPendingManualLoanCreation('user-a', 'k2');
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
  });

  it('ignores corrupt or malformed stored values rather than resuming garbage', async () => {
    const store = await freshModule();
    localStorage.setItem('myfinances.pendingManualLoanCreation.user-a', '{not json');
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
    localStorage.setItem('myfinances.pendingManualLoanCreation.user-a', JSON.stringify({ idempotencyKey: '' }));
    expect(store.loadPendingManualLoanCreation('user-a')).toBeNull();
  });

  it('falls back to memory when localStorage throws, so an unmount within the page still resumes', async () => {
    const store = await freshModule();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    store.savePendingManualLoanCreation('user-a', { idempotencyKey: 'k1', input });
    setItem.mockRestore();
    expect(store.loadPendingManualLoanCreation('user-a')?.idempotencyKey).toBe('k1');
  });
});

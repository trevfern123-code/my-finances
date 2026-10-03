import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: mockRpc } }));
const mockEnv = vi.hoisted(() => ({ cardPaymentSyncEvaluationEnabled: false }));
vi.mock('../config/env', () => ({ env: mockEnv }));

import { CARD_PAYMENT_EVALUATION_TIMEOUT_MS, evaluateCardPaymentsAfterSync } from './cardPaymentEvaluation';

/** A postgrest-js-shaped builder: `.rpc(...).abortSignal(signal)` resolves to `result(signal)`. */
function respond(result: (signal: AbortSignal) => Promise<unknown>) {
  const abortSignal = vi.fn((signal: AbortSignal) => result(signal));
  mockRpc.mockReturnValue({ abortSignal });
  return abortSignal;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.cardPaymentSyncEvaluationEnabled = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const USER = 'user-1';
const loggedText = () => JSON.stringify(warn.mock.calls);

describe('evaluateCardPaymentsAfterSync — the flag', () => {
  it('OFF (the configured default): no matching RPC is called at all', async () => {
    respond(async () => ({ data: true, error: null }));
    expect(await evaluateCardPaymentsAfterSync(USER)).toBe('disabled');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ON through the configured env value: evaluates the user once', async () => {
    mockEnv.cardPaymentSyncEvaluationEnabled = true;
    respond(async () => ({ data: true, error: null }));
    expect(await evaluateCardPaymentsAfterSync(USER)).toBe('evaluated');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateCardPaymentsAfterSync — enabled', () => {
  const run = (timeoutMs?: number) => evaluateCardPaymentsAfterSync(USER, { enabled: true, timeoutMs });

  it('calls try_evaluate_card_payments for the whole user (user id only), with an abort signal', async () => {
    const abortSignal = respond(async () => ({ data: true, error: null }));
    expect(await run()).toBe('evaluated');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('try_evaluate_card_payments', { p_user_id: USER });
    expect(abortSignal).toHaveBeenCalledTimes(1);
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });

  it('documents a finite default timeout', () => {
    expect(Number.isFinite(CARD_PAYMENT_EVALUATION_TIMEOUT_MS)).toBe(true);
    expect(CARD_PAYMENT_EVALUATION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('false (the evaluation failed and rolled back alone): evaluation_failed, logged, no retry', async () => {
    respond(async () => ({ data: false, error: null }));
    expect(await run()).toBe('evaluation_failed');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a returned PostgREST error: rpc_error with only its code logged (never the message)', async () => {
    respond(async () => ({ data: null, error: { code: '57014', message: 'secret-ish detail for user-1', details: 'row data', hint: '' } }));
    expect(await run()).toBe('rpc_error');
    expect(loggedText()).toContain('57014');
    expect(loggedText()).not.toContain('secret-ish detail');
    expect(loggedText()).not.toContain('row data');
    expect(loggedText()).not.toContain(USER);
  });

  it.each(['PGRST202', '42883'])('a missing function (%s): rpc_missing, with a distinguishable configuration warning', async (code) => {
    respond(async () => ({ data: null, error: { code, message: 'Could not find the function public.try_evaluate_card_payments' } }));
    expect(await run()).toBe('rpc_missing');
    expect(loggedText()).toContain('CARD_PAYMENT_SYNC_EVALUATION_ENABLED');
    expect(loggedText()).toContain('rpc_missing');
    expect(loggedText()).not.toContain('Could not find');
  });

  it('a network failure as the installed postgrest-js reports it (resolved, status 0, empty code): request_failed', async () => {
    respond(async () => ({ data: null, status: 0, error: { code: '', message: 'TypeError: fetch failed', details: 'ECONNREFUSED user-1', hint: '' } }));
    expect(await run()).toBe('request_failed');
    expect(loggedText()).not.toContain('ECONNREFUSED');
    expect(loggedText()).not.toContain(USER);
  });

  it('a rejected request (thrown — defensive; the installed client resolves instead): request_failed, logging only the error name', async () => {
    respond(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED with user-1 inside');
    });
    expect(await run()).toBe('request_failed');
    expect(loggedText()).toContain('TypeError');
    expect(loggedText()).not.toContain('ECONNREFUSED');
  });

  it('an rpc() call that throws synchronously never escapes', async () => {
    mockRpc.mockImplementation(() => {
      throw new Error('client misconfigured');
    });
    await expect(run()).resolves.toBe('request_failed');
  });

  it('a hung request is abandoned at the timeout, resolved the way postgrest-js reports an aborted fetch', async () => {
    respond(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ data: null, error: { code: '', message: 'AbortError: This operation was aborted' } })
          );
        })
    );
    const started = Date.now();
    expect(await run(30)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(loggedText()).toContain('timeout');
  });

  it('a hung request whose client rejects on abort is also a timeout', async () => {
    respond(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    expect(await run(30)).toBe('timeout');
  });

  it.each([
    ['null', null],
    ['a string', 'true'],
    ['an object', { ok: true }],
    ['a number', 1],
  ])('an unexpected response (%s): unexpected_response, not treated as evaluated', async (_label, data) => {
    respond(async () => ({ data, error: null }));
    expect(await run()).toBe('unexpected_response');
  });
});

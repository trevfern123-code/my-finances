import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: mockRpc, from: mockFrom } }));

import { CARD_PAYMENT_STATE_READ_TIMEOUT_MS, parseCardPaymentStates, readCardPaymentStates } from './cardPaymentStateReader';

// Financial Semantics Phase B, slice I1: the stored card-payment matching state as the application reads
// it. Freshness is only ever what the database's versions say; a read that got no usable answer is
// `unavailable` and establishes nothing. (The read path receives this payload inside the financial
// snapshot — see financialSnapshot.test.ts; the standalone read below is its brief poll of the versions.)

/** `.rpc(...).abortSignal(signal)` resolves to `result(signal)`, like postgrest-js. */
function respondRpc(result: (signal: AbortSignal) => Promise<unknown>) {
  const abortSignal = vi.fn((signal: AbortSignal) => result(signal));
  mockRpc.mockReturnValue({ abortSignal });
  return abortSignal;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const USER = '11111111-1111-4111-8111-111111111111';
const RANGE = { from: '2026-09-01', to: '2026-10-01' };
const loggedText = () => JSON.stringify(warn.mock.calls);

const leg = (overrides: Record<string, unknown> = {}) => ({
  transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  date: '2026-09-01',
  amountCents: 10000,
  pending: false,
  side: 'cash',
  direction: 'payment',
  accountIncluded: true,
  state: 'tracked',
  reason: 'auto_pair',
  detail: null,
  partnerTransactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  decisionId: null,
  candidates: [],
  effectCents: 0,
  lowCents: 0,
  highCents: 0,
  cashExcessCents: 0,
  cardExcessCents: 0,
  recent: false,
  ...overrides,
});
const freshPayload = (overrides: Record<string, unknown> = {}) => ({
  fresh: true,
  inputVersion: 7,
  evaluatedVersion: 7,
  asOf: '2026-10-01T00:00:00+00:00',
  legs: [leg()],
  decisions: [],
  supersededTransactionIds: [],
  ...overrides,
});

describe('readCardPaymentStates', () => {
  it('calls get_card_payment_states for the user and range, read-only, with an abort signal', async () => {
    const abortSignal = respondRpc(async () => ({ data: freshPayload(), error: null }));
    await readCardPaymentStates(USER, RANGE);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('get_card_payment_states', { p_user_id: USER, p_from: '2026-09-01', p_to: '2026-10-01' });
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('an open-ended range sends a null upper bound', async () => {
    respondRpc(async () => ({ data: freshPayload(), error: null }));
    await readCardPaymentStates(USER, { from: '2026-09-01' });
    expect(mockRpc).toHaveBeenCalledWith('get_card_payment_states', { p_user_id: USER, p_from: '2026-09-01', p_to: null });
  });

  it('fresh: returns the version and exactly the fields the aggregation reads', async () => {
    respondRpc(async () => ({ data: freshPayload({ supersededTransactionIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] }), error: null }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({
      kind: 'fresh',
      inputVersion: 7,
      states: {
        legs: [
          {
            transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            amountCents: 10000,
            side: 'cash',
            accountIncluded: true,
            state: 'tracked',
            reason: 'auto_pair',
            effectCents: 0,
            lowCents: 0,
            highCents: 0,
            cashExcessCents: 0,
            cardExcessCents: 0,
          },
        ],
        supersededTransactionIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unresolved leg keeps its null effect; a NULL superseded array is an empty one', async () => {
    respondRpc(async () => ({
      data: freshPayload({
        legs: [leg({ state: 'unresolved', reason: 'no_candidate', effectCents: null, lowCents: -10000, highCents: 0 })],
        supersededTransactionIds: null,
      }),
      error: null,
    }));
    const read = await readCardPaymentStates(USER, RANGE);
    expect(read).toMatchObject({ kind: 'fresh', states: { supersededTransactionIds: [] } });
    if (read.kind === 'fresh') expect(read.states.legs[0]).toMatchObject({ state: 'unresolved', effectCents: null, lowCents: -10000 });
  });

  it('stale: the versions differ → no states, whatever else the payload carries', async () => {
    respondRpc(async () => ({ data: { fresh: false, inputVersion: 9, evaluatedVersion: 7, lastErrorCode: null, legs: [leg()] }, error: null }));
    const read = await readCardPaymentStates(USER, RANGE);
    expect(read).toEqual({ kind: 'stale', inputVersion: 9, evaluatedVersion: 7, lastErrorCode: null });
    expect(read).not.toHaveProperty('states');
  });

  it('stale with a recorded evaluation failure carries the sanitized code', async () => {
    respondRpc(async () => ({ data: { fresh: false, inputVersion: 9, evaluatedVersion: 7, lastErrorCode: '22012' }, error: null }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'stale', inputVersion: 9, evaluatedVersion: 7, lastErrorCode: '22012' });
  });

  it('stale: a user with no version row at all (nothing was ever evaluated)', async () => {
    respondRpc(async () => ({ data: { fresh: false, inputVersion: null, evaluatedVersion: null, lastErrorCode: null }, error: null }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'stale', inputVersion: null, evaluatedVersion: null, lastErrorCode: null });
  });

  it('a payload that claims fresh with different versions is not believed', async () => {
    respondRpc(async () => ({ data: freshPayload({ inputVersion: 8, evaluatedVersion: 7 }), error: null }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
  });

  it.each([
    ['null', null],
    ['a boolean', true],
    ['an array', [freshPayload()]],
    ['no fresh flag', { inputVersion: 7, evaluatedVersion: 7, legs: [] }],
    ['a string fresh flag', freshPayload({ fresh: 'true' })],
    ['a non-integer version', freshPayload({ inputVersion: 7.5, evaluatedVersion: 7.5 })],
    ['a string version', freshPayload({ inputVersion: '7', evaluatedVersion: '7' })],
    ['legs missing', freshPayload({ legs: undefined })],
    ['a leg without an amount', freshPayload({ legs: [leg({ amountCents: undefined })] })],
    ['a leg with a fractional effect', freshPayload({ legs: [leg({ effectCents: 0.5 })] })],
    ['a leg with a string state id', freshPayload({ legs: [leg({ transactionId: 42 })] })],
    ['a leg with a non-boolean accountIncluded', freshPayload({ legs: [leg({ accountIncluded: 'true' })] })],
    ['superseded ids that are not strings', freshPayload({ supersededTransactionIds: [1] })],
    ['a stale payload with a non-string error code', { fresh: false, inputVersion: 9, evaluatedVersion: 7, lastErrorCode: 500 }],
  ])('an unexpected response (%s) is unavailable — never coerced into a state', async (_name, data) => {
    respondRpc(async () => ({ data, error: null }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
    expect(parseCardPaymentStates(data)).toBeNull();
  });

  it.each(['PGRST202', '42883'])('a missing function (%s) is objects_missing: a configuration problem, not a stale state', async (code) => {
    respondRpc(async () => ({ data: null, error: { code, message: `function public.get_card_payment_states(${USER}) does not exist` }, status: 404 }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'objects_missing' });
    expect(loggedText()).toContain(code);
    expect(loggedText()).not.toContain(USER);
    expect(loggedText()).not.toContain('does not exist');
  });

  it('another PostgREST error is request_error; only its code is logged', async () => {
    respondRpc(async () => ({ data: null, error: { code: '57014', message: `canceling statement for ${USER}` }, status: 500 }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'request_error' });
    expect(loggedText()).toContain('57014');
    expect(loggedText()).not.toContain(USER);
    expect(loggedText()).not.toContain('canceling');
  });

  it('a network failure as the installed client reports it (status 0, no code) is request_failed', async () => {
    respondRpc(async () => ({ data: null, error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }));
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    expect(loggedText()).not.toContain('fetch failed');
  });

  it('a thrown request, and a synchronous throw, are request_failed — the read never throws', async () => {
    respondRpc(async () => {
      throw new TypeError(`socket hang up for ${USER}`);
    });
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    mockRpc.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await readCardPaymentStates(USER, RANGE)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    expect(loggedText()).not.toContain(USER);
  });

  it('a timeout is its own outcome whether the client resolves or rejects on abort, and says nothing about freshness', async () => {
    respondRpc(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ data: null, error: { message: 'AbortError', code: '' }, status: 0 }));
        })
    );
    expect(await readCardPaymentStates(USER, RANGE, { timeoutMs: 5 })).toEqual({ kind: 'unavailable', reason: 'timeout' });
    respondRpc(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    expect(await readCardPaymentStates(USER, RANGE, { timeoutMs: 5 })).toEqual({ kind: 'unavailable', reason: 'timeout' });
  });

  it('documents a finite default timeout', () => {
    expect(Number.isFinite(CARD_PAYMENT_STATE_READ_TIMEOUT_MS)).toBe(true);
    expect(CARD_PAYMENT_STATE_READ_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

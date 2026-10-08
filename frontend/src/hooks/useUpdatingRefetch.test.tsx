// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useUpdatingRefetch } from './useUpdatingRefetch';
import {
  UPDATING_REFETCH_MAX_ATTEMPTS,
  UPDATING_REFETCH_MAX_DELAY_MS,
  UPDATING_REFETCH_MIN_DELAY_MS,
  updatingRefetchDelayMs,
} from '../lib/updatingRefetch';

// Financial Semantics Phase B, I2 correction (review finding F3): the client refetches a read whose
// answer was `updating`, after the server's hint, a bounded number of times
// (CARD_PAYMENT_PAIRING_DESIGN.md §6.2). Time is faked: no test waits in real time.

let rendered: { autoRetrying: boolean }[] = [];

function Probe(props: { answer: object | null; retryAfterMs: number | null; loadKey: unknown; refetch: () => void }) {
  const result = useUpdatingRefetch(props);
  rendered.push(result);
  return null;
}

const latest = () => rendered[rendered.length - 1];

beforeEach(() => {
  rendered = [];
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('updatingRefetchDelayMs', () => {
  it('uses the server hint inside the allowed window', () => {
    expect(updatingRefetchDelayMs(5000)).toBe(5000);
    expect(updatingRefetchDelayMs(UPDATING_REFETCH_MIN_DELAY_MS)).toBe(UPDATING_REFETCH_MIN_DELAY_MS);
    expect(updatingRefetchDelayMs(UPDATING_REFETCH_MAX_DELAY_MS)).toBe(UPDATING_REFETCH_MAX_DELAY_MS);
  });

  it('never returns zero or a tiny wait (no spinning), nor an absurd one (no stalling)', () => {
    expect(updatingRefetchDelayMs(0)).toBe(UPDATING_REFETCH_MIN_DELAY_MS);
    expect(updatingRefetchDelayMs(1)).toBe(UPDATING_REFETCH_MIN_DELAY_MS);
    expect(updatingRefetchDelayMs(-5000)).toBe(UPDATING_REFETCH_MIN_DELAY_MS);
    expect(updatingRefetchDelayMs(Number.MAX_SAFE_INTEGER)).toBe(UPDATING_REFETCH_MAX_DELAY_MS);
    expect(updatingRefetchDelayMs(Number.POSITIVE_INFINITY)).toBe(UPDATING_REFETCH_MIN_DELAY_MS);
    expect(updatingRefetchDelayMs(Number.NaN)).toBe(UPDATING_REFETCH_MIN_DELAY_MS);
  });

  it('the policy is small and bounded', () => {
    expect(UPDATING_REFETCH_MAX_ATTEMPTS).toBe(3);
    expect(UPDATING_REFETCH_MIN_DELAY_MS).toBeGreaterThanOrEqual(1000);
    expect(UPDATING_REFETCH_MAX_ATTEMPTS * UPDATING_REFETCH_MAX_DELAY_MS).toBeLessThanOrEqual(90_000);
  });
});

describe('useUpdatingRefetch', () => {
  it('refetches once after the hinted delay, not before', () => {
    const refetch = vi.fn();
    render(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    expect(latest().autoRetrying).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not ask a second time until an answer to the first has arrived (one request at a time)', () => {
    const refetch = vi.fn();
    const answer = {};
    const view = render(<Probe answer={answer} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(5000);
    expect(refetch).toHaveBeenCalledTimes(1);
    // The request is unanswered for a long time; re-renders with the same answer change nothing.
    view.rerender(<Probe answer={answer} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(120_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an ok (or any other) answer ends it: no timer is left', () => {
    const refetch = vi.fn();
    const view = render(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(5000);
    view.rerender(<Probe answer={null} retryAfterMs={null} loadKey={1} refetch={refetch} />);
    expect(latest().autoRetrying).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`repeated updating answers stop after ${UPDATING_REFETCH_MAX_ATTEMPTS} refetches: no infinite loop`, () => {
    const refetch = vi.fn();
    const view = render(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    for (let attempt = 1; attempt <= UPDATING_REFETCH_MAX_ATTEMPTS; attempt += 1) {
      vi.advanceTimersByTime(5000);
      expect(refetch).toHaveBeenCalledTimes(attempt);
      // Each refetch is answered `updating` again: a new answer object.
      view.rerender(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    }
    expect(latest().autoRetrying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(refetch).toHaveBeenCalledTimes(UPDATING_REFETCH_MAX_ATTEMPTS);
    // Still updating answers arriving some other way do not restart it within the same load.
    view.rerender(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(600_000);
    expect(refetch).toHaveBeenCalledTimes(UPDATING_REFETCH_MAX_ATTEMPTS);
  });

  it('a zero hint cannot spin: it waits the minimum, and the bound still holds', () => {
    const refetch = vi.fn();
    const view = render(<Probe answer={{}} retryAfterMs={0} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(UPDATING_REFETCH_MIN_DELAY_MS - 1);
    expect(refetch).not.toHaveBeenCalled();
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(UPDATING_REFETCH_MIN_DELAY_MS);
      view.rerender(<Probe answer={{}} retryAfterMs={0} loadKey={1} refetch={refetch} />);
    }
    expect(refetch).toHaveBeenCalledTimes(UPDATING_REFETCH_MAX_ATTEMPTS);
  });

  it('a new load (the user, a range change, a sign-in) cancels the pending wait and starts a fresh budget', () => {
    const refetch = vi.fn();
    const view = render(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    // Exhaust the first load.
    for (let attempt = 0; attempt < UPDATING_REFETCH_MAX_ATTEMPTS; attempt += 1) {
      vi.advanceTimersByTime(5000);
      view.rerender(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    }
    expect(latest().autoRetrying).toBe(false);

    // A new load begins: nothing is on screen yet.
    view.rerender(<Probe answer={null} retryAfterMs={null} loadKey={2} refetch={refetch} />);
    // Its answer is `updating` too.
    view.rerender(<Probe answer={{}} retryAfterMs={5000} loadKey={2} refetch={refetch} />);
    expect(latest().autoRetrying).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(refetch).toHaveBeenCalledTimes(UPDATING_REFETCH_MAX_ATTEMPTS + 1);
  });

  it('a wait that is pending when a new load begins never fires for the old one', () => {
    const refetch = vi.fn();
    const view = render(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(3000);
    view.rerender(<Probe answer={null} retryAfterMs={null} loadKey={2} refetch={refetch} />);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('unmounting cancels the pending wait', () => {
    const refetch = vi.fn();
    const view = render(<Probe answer={{}} retryAfterMs={5000} loadKey={1} refetch={refetch} />);
    vi.advanceTimersByTime(3000);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('nothing is scheduled for a state that is not updating (unavailable, refused, failed, ok)', () => {
    const refetch = vi.fn();
    render(<Probe answer={null} retryAfterMs={null} loadKey={1} refetch={refetch} />);
    expect(latest().autoRetrying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('calls the refetch of the current render, not a stale one', () => {
    const first = vi.fn();
    const second = vi.fn();
    const answer = {};
    const view = render(<Probe answer={answer} retryAfterMs={5000} loadKey={1} refetch={first} />);
    view.rerender(<Probe answer={answer} retryAfterMs={5000} loadKey={1} refetch={second} />);
    vi.advanceTimersByTime(5000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

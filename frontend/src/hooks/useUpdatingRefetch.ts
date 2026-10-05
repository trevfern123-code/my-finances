import { useEffect, useRef, useState } from 'react';
import { UPDATING_REFETCH_MAX_ATTEMPTS, updatingRefetchDelayMs } from '../lib/updatingRefetch';

/**
 * Schedules the bounded automatic refetch of ONE resource whose last answer was `updating`
 * (lib/updatingRefetch.ts has the policy and what it is not).
 *
 * - `answer` is the response that said `updating`, or null when the resource is in any other state.
 *   Each new answer is a new object, and the next wait starts only when one arrives: so there is
 *   one timer at a time, and never a second request while the first is unanswered.
 * - `retryAfterMs` is that answer's hint.
 * - `loadKey` identifies the load the answers belong to. It changes when something other than this
 *   hook starts over (the user, a range change, a sign-in), which resets the attempt budget.
 * - `refetch` re-reads the resource WITHOUT starting a new load.
 *
 * Returns whether another automatic refetch is still coming, for wording only.
 */
export function useUpdatingRefetch(options: {
  answer: object | null;
  retryAfterMs: number | null;
  loadKey: unknown;
  refetch: () => void;
}): { autoRetrying: boolean } {
  const { answer, retryAfterMs, loadKey } = options;
  const refetchRef = useRef(options.refetch);
  refetchRef.current = options.refetch;
  const budget = useRef<{ loadKey: unknown; attempts: number }>({ loadKey, attempts: 0 });
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    if (budget.current.loadKey !== loadKey) budget.current = { loadKey, attempts: 0 };
    if (answer === null || retryAfterMs === null) {
      setExhausted(false);
      return;
    }
    if (budget.current.attempts >= UPDATING_REFETCH_MAX_ATTEMPTS) {
      setExhausted(true);
      return;
    }
    setExhausted(false);
    const timer = setTimeout(() => {
      budget.current.attempts += 1;
      refetchRef.current();
    }, updatingRefetchDelayMs(retryAfterMs));
    // A new answer, a new load, or an unmount: the pending wait is cancelled.
    return () => clearTimeout(timer);
  }, [answer, retryAfterMs, loadKey]);

  return { autoRetrying: answer !== null && !exhausted };
}

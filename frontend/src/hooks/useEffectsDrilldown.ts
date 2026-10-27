import { useCallback, useEffect, useRef, useState } from 'react';
import { getTransactionEffects, type EffectsQuery } from '../lib/api';
import {
  createEffectsLoader,
  effectsQueryKey,
  EFFECTS_PAGE_LIMIT,
  type EffectsDrilldownState,
  type EffectsLoader,
} from '../lib/effectsDrilldown';

const LOADING: EffectsDrilldownState = { phase: 'loading', restarting: false };

/**
 * One drill-down, loaded on demand: mounting requests page 1, and nothing is requested before that.
 * A different query (another period, measure or bucket) is a different drill-down: the previous
 * request is aborted and none of its rows are shown under the new query, not even for one render.
 */
export function useEffectsDrilldown(query: EffectsQuery): {
  state: EffectsDrilldownState;
  loadMore: () => void;
  retry: () => void;
} {
  const key = effectsQueryKey(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const loaderRef = useRef<EffectsLoader | null>(null);
  // The state is held with the query it belongs to, so a state of another query is never returned.
  const [held, setHeld] = useState<{ key: string; state: EffectsDrilldownState }>({ key, state: LOADING });

  useEffect(() => {
    const current = queryRef.current;
    const loader = createEffectsLoader((cursor, signal) => getTransactionEffects(current, { cursor, limit: EFFECTS_PAGE_LIMIT }, signal));
    loaderRef.current = loader;
    const unsubscribe = loader.subscribe(() => setHeld({ key, state: loader.getState() }));
    loader.start();
    return () => {
      unsubscribe();
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [key]);

  const loadMore = useCallback(() => loaderRef.current?.loadMore(), []);
  const retry = useCallback(() => loaderRef.current?.start(), []);
  return { state: held.key === key ? held.state : LOADING, loadMore, retry };
}

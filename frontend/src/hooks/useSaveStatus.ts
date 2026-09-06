import { useEffect, useRef, useState } from 'react';
import { SaveStatusTracker, type SaveStatus } from '../lib/saveStatus';

export type { SaveStatus };

/**
 * Thin React wrapper around SaveStatusTracker (lib/saveStatus.ts) — see that file for the actual
 * state-machine logic and its tests. This hook only exists to bridge the tracker's plain
 * onStatusChange callback into React state.
 */
export function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const trackerRef = useRef<SaveStatusTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new SaveStatusTracker({ onStatusChange: setStatus });
  }

  useEffect(() => () => trackerRef.current?.dispose(), []);

  return {
    status,
    track: (run: () => Promise<unknown>) => trackerRef.current!.track(run),
    retry: () => trackerRef.current!.retry(),
  };
}

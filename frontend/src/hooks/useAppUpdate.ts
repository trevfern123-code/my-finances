import { useEffect, useSyncExternalStore } from 'react';
import { appUpdate, type AppUpdateManager, type GuardKind, type UpdateSnapshot } from '../lib/appUpdate';

/** The current update state, re-rendering the caller whenever it changes. */
export function useAppUpdateSnapshot(manager: AppUpdateManager = appUpdate): UpdateSnapshot {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}

/**
 * Holds an update guard for exactly as long as `active` is true, so the app never reloads onto a new
 * build while this component has work in progress. Releasing happens on deactivation and on unmount,
 * so a guard can never leak past the component that took it.
 */
export function useUpdateGuard(kind: GuardKind, active: boolean, manager: AppUpdateManager = appUpdate): void {
  useEffect(() => {
    if (!active) return;
    return manager.acquireGuard(kind);
  }, [kind, active, manager]);
}

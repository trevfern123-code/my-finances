import type { SaveStatus } from '../hooks/useSaveStatus';

/** Truthful, reusable save-status feedback — reflects the real outcome of the last save attempt
 *  (§ "Auto-save feedback must be truthful"), never shown as "Saved" merely because local state
 *  changed. Renders nothing at all in the idle state, so a section that hasn't been touched yet
 *  looks exactly as it always has. */
export function SaveStatusIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === 'idle') return null;

  return (
    <span className={`save-status save-status-${status}`} role="status" aria-live="polite">
      {status === 'saving' && 'Saving…'}
      {status === 'saved' && 'Saved ✓'}
      {status === 'error' && (
        <>
          Couldn&rsquo;t save.{' '}
          <button type="button" className="link-button" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </span>
  );
}

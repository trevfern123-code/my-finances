import type { SaveStatus } from '../hooks/useSaveStatus';
import { getSaveStatusDisplay } from '../lib/saveStatus';

/** Truthful, reusable save-status feedback — reflects the real outcome of the last save attempt
 *  (§ "Auto-save feedback must be truthful"), never shown as "Saved" merely because local state
 *  changed. Renders nothing at all in the idle state, so a section that hasn't been touched yet
 *  looks exactly as it always has. What text/whether Retry shows for a given status is decided by
 *  the pure getSaveStatusDisplay (lib/saveStatus.ts, tested there) — this component only renders
 *  its output. */
export function SaveStatusIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const display = getSaveStatusDisplay(status);
  if (!display.visible) return null;

  return (
    <span className={`save-status save-status-${status}`} role="status" aria-live="polite">
      {display.text}
      {display.showRetry && (
        <>
          {' '}
          <button type="button" className="link-button" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </span>
  );
}

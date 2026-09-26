import { useEffect, useId, useRef, useState } from 'react';
import {
  getInstitutionRemoval,
  getInstitutionRemovalPreview,
  removeInstitution,
  type InstitutionRemoval,
  type InstitutionRemovalPreview,
} from '../lib/api';
import { describeRemovalProgress } from '../lib/connectionStatus';
import { formatCurrency } from '../lib/currency';
import type { SessionOwnership } from '../lib/sessionOwnership';

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: InstitutionRemovalPreview; notice: string | null }
  | { kind: 'blocked'; message: string }
  | { kind: 'working' }
  | { kind: 'progress'; removal: InstitutionRemoval }
  | { kind: 'error'; message: string };

/**
 * Linked Institution Management V1: the confirmation and progress for destructively removing one
 * institution. Shared by the Accounts page and Settings -> Connections.
 *
 * The server owns the operation (it survives reloads, double submits and the item itself); this only
 * shows it. Before confirming, the user sees exactly what will be deleted and which manual-loan
 * balances go back up, and the confirmation carries that preview's digest — if anything relevant
 * changed meanwhile the server refuses and the preview is shown again. An unfinished removal (Plaid's
 * answer unknown, or a later step failed) is shown with a Retry that resumes the SAME operation; there
 * is no cancel. Nothing is retried automatically. The request itself holds the app-update mutation
 * guard (lib/api.ts authedFetch), so an app update never reloads the page mid-removal.
 */
export function RemoveInstitutionPanel({
  itemId,
  institutionName,
  existingRemoval,
  captureOwnership,
  onRemoved,
  onClose,
  autoFocus = true,
}: {
  itemId: string;
  institutionName: string | null;
  /** An operation already under way for this item (resume it rather than previewing). */
  existingRemoval?: InstitutionRemoval | null;
  captureOwnership: () => SessionOwnership;
  /** The removal finished: the institution is gone. The parent refreshes everything. */
  onRemoved: (removal: InstitutionRemoval) => void;
  /** Close without removing (offered only before confirming). */
  onClose?: () => void;
  /** Move focus into the panel when it appears — only when the user just opened it; a panel shown
   *  on page load (an operation under way) must not steal focus. */
  autoFocus?: boolean;
}) {
  const name = institutionName ?? 'this institution';
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);
  const [phase, setPhase] = useState<Phase>(() =>
    existingRemoval ? { kind: 'progress', removal: existingRemoval } : { kind: 'loading' }
  );

  useEffect(() => {
    if (autoFocus) headingRef.current?.focus();
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPreview(notice: string | null) {
    setPhase({ kind: 'loading' });
    try {
      const res = await getInstitutionRemovalPreview(itemId);
      if (res.blocked_message) {
        setPhase({ kind: 'blocked', message: res.blocked_message });
      } else {
        setPhase({ kind: 'preview', preview: res.preview, notice });
      }
    } catch (err) {
      if (errorCode(err) === 'removal_in_progress') {
        await showCurrentState();
        return;
      }
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Could not load what would be removed.' });
    }
  }

  /** Re-reads the persisted operation (after an ambiguous failure, or when one already exists). */
  async function showCurrentState(fallbackMessage?: string) {
    try {
      const { removal } = await getInstitutionRemoval(itemId);
      if (removal.finished) onRemoved(removal);
      else setPhase({ kind: 'progress', removal });
    } catch {
      setPhase({ kind: 'error', message: fallbackMessage ?? 'Could not load this removal. Try again in a moment.' });
    }
  }

  useEffect(() => {
    if (!existingRemoval) void loadPreview(null);
    // Mount-only: the preview is fetched once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(previewDigest: string | null) {
    if (busyRef.current) return; // a double click (dispatched before re-render) is ignored
    busyRef.current = true;
    const ownership = captureOwnership();
    setPhase({ kind: 'working' });
    try {
      const { removal } = await removeInstitution(itemId, previewDigest, ownership.verify);
      if (!ownership.isCurrent()) return;
      if (removal.finished) onRemoved(removal);
      else setPhase({ kind: 'progress', removal });
    } catch (err) {
      if (!ownership.isCurrent()) return;
      const code = errorCode(err);
      const message = err instanceof Error ? err.message : 'The removal did not start.';
      if (code === 'preview_stale') {
        await loadPreview(message);
      } else if (code === 'connection_needs_attention' || code === 'manual_loan_reconciliation_required') {
        setPhase({ kind: 'blocked', message });
      } else {
        // Unknown whether the removal started (e.g. the connection dropped): show what the server
        // recorded instead of guessing — never retry on the user's behalf.
        await showCurrentState(message);
      }
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <section className="remove-institution-panel" aria-labelledby={headingId}>
      <h4 id={headingId} ref={headingRef} tabIndex={-1}>
        Remove {name}
      </h4>

      {phase.kind === 'loading' && <p className="hint">Checking what would be removed…</p>}

      {phase.kind === 'preview' && (
        <>
          {phase.notice && (
            <p className="error" role="alert">
              {phase.notice}
            </p>
          )}
          <p>
            This permanently removes <strong>{name}</strong> and everything imported from it from My Finances. It can&rsquo;t
            be undone.
          </p>
          <ul className="remove-institution-effects">
            <li>
              {plural(phase.preview.counts.accounts, 'account', 'accounts')}
              {phase.preview.accounts.length > 0 &&
                `: ${phase.preview.accounts.map((a) => (a.mask ? `${a.name} (${a.mask})` : a.name)).join(', ')}`}
            </li>
            <li>
              {plural(phase.preview.counts.transactions, 'transaction', 'transactions')}
              {phase.preview.counts.splits > 0 && `, with ${plural(phase.preview.counts.splits, 'split', 'splits')}`}
            </li>
            {phase.preview.counts.recurring_streams > 0 && (
              <li>{plural(phase.preview.counts.recurring_streams, 'recurring payment', 'recurring payments')}</li>
            )}
            {phase.preview.counts.liabilities > 0 && (
              <li>{plural(phase.preview.counts.liabilities, 'loan or credit detail record', 'loan or credit detail records')}</li>
            )}
          </ul>
          {phase.preview.loan_restorations.length > 0 && (
            <div className="remove-institution-loans">
              <p>
                These manual loans had payments from this bank applied to them. Removing the payments adds exactly those amounts
                back:
              </p>
              <ul>
                {phase.preview.loan_restorations.map((r) => (
                  <li key={r.loan_id}>
                    {r.loan_name}: +{formatCurrency(r.restore_amount, null)} ({formatCurrency(r.current_balance, null)} &rarr;{' '}
                    {formatCurrency(r.balance_after, null)})
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="hint">
            Past budgets and reports will no longer include these transactions. Your recorded net-worth history keeps its past
            values; today&rsquo;s is recalculated.
          </p>
          <div className="remove-institution-actions">
            <button type="button" className="danger-button" onClick={() => void submit(phase.preview.digest)}>
              Remove institution
            </button>
            {onClose && (
              <button type="button" className="link-button" onClick={onClose}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}

      {phase.kind === 'blocked' && (
        <>
          <p className="error">{phase.message}</p>
          {onClose && (
            <button type="button" className="link-button" onClick={onClose}>
              Close
            </button>
          )}
        </>
      )}

      {phase.kind === 'working' && (
        <p className="hint" role="status">
          Removing {name}… This can take up to a minute. You can leave this page; the removal continues.
        </p>
      )}

      {phase.kind === 'progress' && (
        <>
          <p role="status">{describeRemovalProgress(phase.removal).message}</p>
          {describeRemovalProgress(phase.removal).actionLabel && (
            <button type="button" onClick={() => void submit(null)}>
              {describeRemovalProgress(phase.removal).actionLabel}
            </button>
          )}
        </>
      )}

      {phase.kind === 'error' && (
        <>
          <p className="error" role="alert">
            {phase.message}
          </p>
          <button type="button" className="link-button" onClick={() => void loadPreview(null)}>
            Try again
          </button>
          {onClose && (
            <button type="button" className="link-button" onClick={onClose}>
              Close
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** The outcome of a finished removal, for the parent's confirmation message. */
export function describeFinishedRemoval(removal: InstitutionRemoval): string {
  const name = removal.institution_name ?? 'The institution';
  const restored = (removal.loan_adjustments ?? []).filter((a) => a.restored > 0);
  if (restored.length === 0) return `${name} was removed.`;
  return `${name} was removed. ${restored
    .map((a) => `${a.loan_name}: ${formatCurrency(a.restored, null)} added back (now ${formatCurrency(a.balance_after, null)})`)
    .join('; ')}.`;
}

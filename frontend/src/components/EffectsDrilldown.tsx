import type { EffectsQuery } from '../lib/api';
import { useEffectsDrilldown } from '../hooks/useEffectsDrilldown';
import { toCents } from '../lib/semanticModel';
import { effectRowLabel, effectsFailureText, formatSigned, itemCount } from '../lib/semanticPresentation';

function formatDrilldownDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The transactions behind one published amount (design §7.3). The rows, their signed amounts, the
 * total and the count all come from the server; this component lists them and says how much of the
 * result is loaded. It mounts only when its parent is expanded, so nothing is requested until then.
 *
 * `parentAmount` is the figure the user expanded. It comes from another request than this list, so
 * the two can describe different moments; when they differ, the list says so rather than appearing
 * to explain a figure it does not match, and offers to reload either one.
 */
export function EffectsDrilldown({
  query,
  parentAmount,
  onRefreshParent,
  emptyText = 'No transactions.',
}: {
  query: EffectsQuery;
  parentAmount?: number;
  /** Reloads the figure this list belongs to. */
  onRefreshParent?: () => void;
  emptyText?: string;
}) {
  const { state, loadMore, retry } = useEffectsDrilldown(query);

  if (state.phase === 'loading') {
    return (
      <div className="category-drilldown">
        <p className="hint" role="status">
          {state.restarting ? 'These transactions changed while the list was loading. Reloading…' : 'Loading…'}
        </p>
      </div>
    );
  }

  if (state.phase === 'updating' || state.phase === 'unavailable') {
    return (
      <div className="category-drilldown">
        <p className="hint" role="status">
          {state.phase === 'updating'
            ? `Updating… This list depends on card-payment matching, which is not up to date.${state.autoRetrying ? ' Checking again automatically.' : ''}`
            : "Unavailable. This list couldn't be read right now."}{' '}
          <button type="button" className="link-button" onClick={retry}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="category-drilldown">
        <p className="error drilldown-error" role="alert">
          {effectsFailureText(state.failure)}{' '}
          <button type="button" className="link-button" onClick={retry}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  const complete = state.nextCursor === null;
  const total = state.totalCents / 100;
  const parentChanged = parentAmount !== undefined && toCents(parentAmount) !== state.totalCents;

  return (
    <div className="category-drilldown">
      {state.rows.length === 0 ? (
        <p className="hint">{emptyText}</p>
      ) : (
        state.rows.map((row, index) => (
          <div key={`${row.transaction.id}-${index}`} className="drilldown-row">
            <span className="drilldown-date">{formatDrilldownDate(row.transaction.date)}</span>
            <span className="drilldown-name">
              {effectRowLabel(row)}
              {row.allocation === 'split' && <span className="split-badge">split</span>}
              {row.transaction.pending && <span className="split-badge">pending</span>}
            </span>
            <span className="drilldown-amount">{formatSigned(row.effect_amount)}</span>
          </div>
        ))
      )}
      <p className="hint drilldown-footer" role="status">
        {complete
          ? `${itemCount(state.totalCount)} · ${formatSigned(total)}`
          : `Showing ${state.rows.length} of ${itemCount(state.totalCount)} · ${formatSigned(state.loadedCents / 100)} of ${formatSigned(total)}`}
      </p>
      {!complete && (
        <button type="button" className="link-button" onClick={loadMore} disabled={state.loadingMore}>
          {state.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
      {parentChanged && (
        <p className="hint drilldown-mismatch" role="status">
          This list totals {formatSigned(total)} and the figure above is {formatSigned(parentAmount)}: they were loaded at
          different times and something changed in between.{' '}
          <button type="button" className="link-button" onClick={retry}>
            Reload list
          </button>
          {onRefreshParent && (
            <>
              {' · '}
              <button type="button" className="link-button" onClick={onRefreshParent}>
                Refresh figure
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

import type { SemanticNotShown } from '../lib/semanticModel';
import { withheldText } from '../lib/semanticPresentation';

/**
 * Says, in words, why a role-aware figure is not shown (Financial Semantics Phase B). A failure is
 * announced as an alert; a state that resolves on its own or on reload, as a status. The text is
 * fixed in lib/semanticPresentation.ts: nothing the server sent is displayed.
 */
export function SemanticNotice({ state, onRetry }: { state: SemanticNotShown; onRetry?: () => void }) {
  const text = withheldText(state);
  return (
    <p className={text.tone === 'alert' ? 'error semantic-notice' : 'hint semantic-notice'} role={text.tone === 'alert' ? 'alert' : 'status'}>
      {text.detail}{' '}
      {onRetry && state.kind !== 'loading' && (
        <button type="button" className="link-button" onClick={onRetry}>
          Check again
        </button>
      )}
    </p>
  );
}

/** What stands in a figure's place while it is withheld: an em dash and a word saying why. Never a
 *  number. */
export function WithheldFigure({ state, valueClassName = 'stat-value' }: { state: SemanticNotShown; valueClassName?: string }) {
  return (
    <>
      <span className={valueClassName}>—</span>
      <span className="stat-delta" role="status">
        {withheldText(state).short}
      </span>
    </>
  );
}

import { useState } from 'react';
import type { EffectsQuery } from '../lib/api';
import type { CashFlowFigures } from '../lib/semanticModel';
import { cashFlowLineGroups, formatSigned, type CashFlowLine } from '../lib/semanticPresentation';
import { EffectsDrilldown } from './EffectsDrilldown';

function queryFor(line: CashFlowLine, period: { start: string; end: string }): EffectsQuery {
  return line.measure === 'spending' ? { ...period, measure: 'spending' } : { ...period, measure: line.measure };
}

/**
 * The lines behind one period's cash flow, each from the server's own figures, and each expandable
 * into the transactions that make it up (design §6.3 "explainers", §7.3). A list is requested only
 * when its line is opened, and one is open at a time.
 */
export function CashFlowDetails({
  figures,
  period,
  onRefresh,
}: {
  figures: CashFlowFigures;
  /** `[start, end)` of the period the figures describe. */
  period: { start: string; end: string };
  onRefresh?: () => void;
}) {
  const [openLine, setOpenLine] = useState<string | null>(null);
  const groups = cashFlowLineGroups(figures);

  return (
    <details className="cash-flow-details">
      <summary>What's counted this month</summary>
      {groups.map((group) => (
        <div key={group.title} className="cash-flow-details-group">
          <h3 className="cash-flow-details-title">{group.title}</h3>
          {group.lines.map((line) => {
            const open = openLine === line.id;
            return (
              <div key={line.id}>
                <button
                  type="button"
                  className="cash-flow-details-line"
                  aria-expanded={open}
                  onClick={() => setOpenLine(open ? null : line.id)}
                >
                  <span className="cash-flow-details-label">{line.label}</span>
                  <span className="cash-flow-details-amount">{formatSigned(line.amount)}</span>
                </button>
                {line.note && <p className="hint cash-flow-details-note">{line.note}</p>}
                {open && <EffectsDrilldown query={queryFor(line, period)} parentAmount={line.amount} onRefreshParent={onRefresh} />}
              </div>
            );
          })}
        </div>
      ))}
    </details>
  );
}

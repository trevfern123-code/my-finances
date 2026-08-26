import { REPORTING_RANGE_IDS, REPORTING_RANGE_LABELS, type ReportingRangeId } from '../lib/reportingRange';

/** Shared reporting-range control — Date-Range Customization v1. Rendered wherever a
 *  months-bucketed historical view (Overview's charts, Monthly Breakdown) needs it, always bound
 *  to the same `range`/`onChange` pair from `useReportingRange` so every instance stays in sync;
 *  never rendered near Safe to Spend, Cash Flow Pace, or the Budget tab's recent-average
 *  comparison, which are current-period/independent by design. Horizontally scrollable rather
 *  than a dropdown so the currently-selected option stays visibly highlighted at a glance, per
 *  the transparent-UI preference already established elsewhere in this app. */
export function ReportingRangeSelector({
  range,
  onChange,
}: {
  range: ReportingRangeId;
  onChange: (range: ReportingRangeId) => void;
}) {
  return (
    <div className="reporting-range-selector" role="radiogroup" aria-label="Reporting range">
      {REPORTING_RANGE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={id === range}
          className={id === range ? 'reporting-range-btn active' : 'reporting-range-btn'}
          onClick={() => onChange(id)}
        >
          {REPORTING_RANGE_LABELS[id]}
        </button>
      ))}
    </div>
  );
}

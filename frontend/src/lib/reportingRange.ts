export const REPORTING_RANGE_IDS = [
  'this_month',
  'last_month',
  'last_3_months',
  'last_6_months',
  'last_12_months',
] as const;

export type ReportingRangeId = (typeof REPORTING_RANGE_IDS)[number];

export const DEFAULT_REPORTING_RANGE: ReportingRangeId = 'last_6_months';

/** Short labels for the pill selector — deliberately terse ("3 months", not "Last 3 months") so
 *  five options fit comfortably in a horizontally-scrollable row on a narrow viewport. */
export const REPORTING_RANGE_LABELS: Record<ReportingRangeId, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_3_months: '3 months',
  last_6_months: '6 months',
  last_12_months: '12 months',
};

export function isReportingRangeId(value: unknown): value is ReportingRangeId {
  return typeof value === 'string' && (REPORTING_RANGE_IDS as readonly string[]).includes(value);
}

/** Falls back to the default for anything unrecognized (an older saved value, a fetch that hasn't
 *  resolved yet, server data from a future app version with a range id this build doesn't know
 *  about) — mirrors normalizeTheme/normalizeAccent in lib/theme.ts. */
export function normalizeReportingRange(value: unknown): ReportingRangeId {
  return isReportingRangeId(value) ? value : DEFAULT_REPORTING_RANGE;
}

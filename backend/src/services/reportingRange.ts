import { getCurrentMonthRange, getRecentMonthsRange } from './budgetPeriod';
import { getMonthsAgoStart } from './netWorth';

export const REPORTING_RANGE_IDS = [
  'this_month',
  'last_month',
  'last_3_months',
  'last_6_months',
  'last_12_months',
] as const;

export type ReportingRangeId = (typeof REPORTING_RANGE_IDS)[number];

export const DEFAULT_REPORTING_RANGE: ReportingRangeId = 'last_6_months';

export function isReportingRangeId(value: unknown): value is ReportingRangeId {
  return typeof value === 'string' && (REPORTING_RANGE_IDS as readonly string[]).includes(value);
}

export interface ResolvedRange {
  sinceDate: string;
  /** Exclusive upper bound, or undefined for an open-ended range through today. 'this_month' and
   *  'last_month' are true bounded periods (a look-ahead-free single month); the three rolling
   *  presets deliberately stay open-ended so the current in-progress month keeps showing up as
   *  the trend charts' most recent, still-filling-in bar — exactly today's existing behavior,
   *  just user-selectable instead of hardcoded. */
  untilDate?: string;
}

/** Turns a reporting-range preset into the date bounds the existing months-based endpoints
 *  (summary, monthly-breakdown, net-worth-history) already know how to query. 'this_month' and
 *  'last_month' reuse budgetPeriod.ts's range functions (already correct, already tested) rather
 *  than inventing new date math; the three rolling presets reuse the same getMonthsAgoStart the
 *  three endpoints already call today. */
export function resolveReportingRange(rangeId: ReportingRangeId, now: Date = new Date()): ResolvedRange {
  switch (rangeId) {
    case 'this_month': {
      const range = getCurrentMonthRange(now);
      return { sinceDate: range.start, untilDate: range.end };
    }
    case 'last_month': {
      const range = getRecentMonthsRange(1, now);
      return { sinceDate: range.start, untilDate: range.end };
    }
    case 'last_3_months':
      return { sinceDate: getMonthsAgoStart(3, now) };
    case 'last_6_months':
      return { sinceDate: getMonthsAgoStart(6, now) };
    case 'last_12_months':
      return { sinceDate: getMonthsAgoStart(12, now) };
  }
}

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORTING_RANGE,
  isReportingRangeId,
  REPORTING_RANGE_IDS,
  resolveReportingRange,
} from './reportingRange';

const NOW = new Date('2026-08-15T12:00:00Z');

describe('isReportingRangeId', () => {
  it('accepts every id in REPORTING_RANGE_IDS', () => {
    for (const id of REPORTING_RANGE_IDS) {
      expect(isReportingRangeId(id)).toBe(true);
    }
  });

  it('rejects an unknown string, undefined, and non-string values', () => {
    expect(isReportingRangeId('last_2_months')).toBe(false);
    expect(isReportingRangeId(undefined)).toBe(false);
    expect(isReportingRangeId(null)).toBe(false);
    expect(isReportingRangeId(6)).toBe(false);
  });
});

describe('DEFAULT_REPORTING_RANGE', () => {
  it('is last_6_months, matching the migration column default', () => {
    expect(DEFAULT_REPORTING_RANGE).toBe('last_6_months');
  });
});

describe('resolveReportingRange', () => {
  it('this_month resolves to a bounded current-calendar-month range', () => {
    expect(resolveReportingRange('this_month', NOW)).toEqual({ sinceDate: '2026-08-01', untilDate: '2026-09-01' });
  });

  it('last_month resolves to a bounded prior-calendar-month range, excluding the current month', () => {
    expect(resolveReportingRange('last_month', NOW)).toEqual({ sinceDate: '2026-07-01', untilDate: '2026-08-01' });
  });

  it('last_3_months resolves to an open-ended range that includes the current in-progress month', () => {
    const resolved = resolveReportingRange('last_3_months', NOW);
    expect(resolved.sinceDate).toBe('2026-06-01');
    expect(resolved.untilDate).toBeUndefined();
  });

  it('last_6_months resolves to an open-ended range starting 6 months back', () => {
    const resolved = resolveReportingRange('last_6_months', NOW);
    expect(resolved.sinceDate).toBe('2026-03-01');
    expect(resolved.untilDate).toBeUndefined();
  });

  it('last_12_months resolves to an open-ended range starting 12 months back', () => {
    const resolved = resolveReportingRange('last_12_months', NOW);
    expect(resolved.sinceDate).toBe('2025-09-01');
    expect(resolved.untilDate).toBeUndefined();
  });

  it('this_month and last_month partition cleanly with no gap or overlap', () => {
    const thisMonth = resolveReportingRange('this_month', NOW);
    const lastMonth = resolveReportingRange('last_month', NOW);
    expect(lastMonth.untilDate).toBe(thisMonth.sinceDate);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORTING_RANGE,
  isReportingRangeId,
  normalizeReportingRange,
  REPORTING_RANGE_IDS,
  REPORTING_RANGE_LABELS,
} from './reportingRange';

describe('isReportingRangeId', () => {
  it('accepts every id in REPORTING_RANGE_IDS', () => {
    for (const id of REPORTING_RANGE_IDS) {
      expect(isReportingRangeId(id)).toBe(true);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isReportingRangeId('last_2_months')).toBe(false);
    expect(isReportingRangeId(undefined)).toBe(false);
    expect(isReportingRangeId(null)).toBe(false);
    expect(isReportingRangeId(12)).toBe(false);
  });
});

describe('normalizeReportingRange', () => {
  it('passes through a recognized id unchanged', () => {
    expect(normalizeReportingRange('last_12_months')).toBe('last_12_months');
  });

  it('falls back to the default for anything unrecognized', () => {
    expect(normalizeReportingRange('last_2_months')).toBe(DEFAULT_REPORTING_RANGE);
    expect(normalizeReportingRange(undefined)).toBe(DEFAULT_REPORTING_RANGE);
    expect(normalizeReportingRange(null)).toBe(DEFAULT_REPORTING_RANGE);
  });
});

describe('REPORTING_RANGE_LABELS', () => {
  it('has a label for every id, and only those ids', () => {
    expect(Object.keys(REPORTING_RANGE_LABELS).sort()).toEqual([...REPORTING_RANGE_IDS].sort());
  });
});

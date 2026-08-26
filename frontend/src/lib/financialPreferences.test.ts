import { describe, expect, it } from 'vitest';
import {
  clampMinimumCashBuffer,
  clampRecentAvgMonths,
  clampSavingsRateTarget,
  clampUpcomingBillsDays,
  savingsRateTier,
} from './financialPreferences';

describe('clampMinimumCashBuffer', () => {
  it('passes through a valid non-negative amount', () => {
    expect(clampMinimumCashBuffer(500)).toBe(500);
    expect(clampMinimumCashBuffer(0)).toBe(0);
  });

  it('falls back to 0 for a negative amount', () => {
    expect(clampMinimumCashBuffer(-100)).toBe(0);
  });

  it('falls back to 0 for a non-finite value', () => {
    expect(clampMinimumCashBuffer(NaN)).toBe(0);
  });
});

describe('clampUpcomingBillsDays', () => {
  it('passes through a value within range', () => {
    expect(clampUpcomingBillsDays(30)).toBe(30);
  });

  it('clamps below the minimum to 1', () => {
    expect(clampUpcomingBillsDays(0)).toBe(1);
    expect(clampUpcomingBillsDays(-5)).toBe(1);
  });

  it('clamps above the maximum to 90', () => {
    expect(clampUpcomingBillsDays(200)).toBe(90);
  });

  it('rounds a non-integer to the nearest whole day', () => {
    expect(clampUpcomingBillsDays(14.6)).toBe(15);
  });

  it('falls back to the default (14) for a non-finite value', () => {
    expect(clampUpcomingBillsDays(NaN)).toBe(14);
  });
});

describe('clampRecentAvgMonths', () => {
  it('passes through a value within range', () => {
    expect(clampRecentAvgMonths(6)).toBe(6);
  });

  it('clamps to the 1-12 range', () => {
    expect(clampRecentAvgMonths(0)).toBe(1);
    expect(clampRecentAvgMonths(24)).toBe(12);
  });
});

describe('clampSavingsRateTarget', () => {
  it('passes through a value within range', () => {
    expect(clampSavingsRateTarget(20)).toBe(20);
  });

  it('clamps to the 0-100 range', () => {
    expect(clampSavingsRateTarget(-10)).toBe(0);
    expect(clampSavingsRateTarget(150)).toBe(100);
  });

  it('falls back to the default (15) for a non-finite value', () => {
    expect(clampSavingsRateTarget(NaN)).toBe(15);
  });
});

describe('savingsRateTier', () => {
  it('is "over" whenever the rate is negative, regardless of target', () => {
    expect(savingsRateTier(-0.1, 15)).toBe('over');
    expect(savingsRateTier(-0.1, 0)).toBe('over');
  });

  it('is "warn" when short of the target', () => {
    expect(savingsRateTier(0.1, 15)).toBe('warn');
  });

  it('is "good" when at or above the target', () => {
    expect(savingsRateTier(0.15, 15)).toBe('good');
    expect(savingsRateTier(0.3, 15)).toBe('good');
  });

  it('respects a custom (non-default) target', () => {
    // A 10% rate misses a 20% target (warn) but clears a 5% target (good).
    expect(savingsRateTier(0.1, 20)).toBe('warn');
    expect(savingsRateTier(0.1, 5)).toBe('good');
  });
});

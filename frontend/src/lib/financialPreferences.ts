export interface FinancialPreferences {
  /** Dollar amount, non-negative. Subtracted from Safe to Spend; never alters any actual account
   *  balance, budget target, or transaction. */
  minimumCashBuffer: number;
  /** Days ahead counted as "upcoming" for bills — used consistently by Safe to Spend and the
   *  Upcoming Bills widget, so the two always agree on what "upcoming" means. */
  upcomingBillsDays: number;
  /** How many recent full months the Budget tab's "recent avg" spend figure averages over. */
  recentAvgMonths: number;
  /** A percentage (0-100), not a fraction — the user's personal savings-rate goal. Changes the
   *  target/comparison shown against the Savings Rate card, never the calculated rate itself. */
  savingsRateTarget: number;
}

export const DEFAULT_FINANCIAL_PREFERENCES: FinancialPreferences = {
  minimumCashBuffer: 0,
  upcomingBillsDays: 14,
  recentAvgMonths: 2,
  savingsRateTarget: 15,
};

export const UPCOMING_BILLS_DAYS_MIN = 1;
export const UPCOMING_BILLS_DAYS_MAX = 90;
export const RECENT_AVG_MONTHS_MIN = 1;
export const RECENT_AVG_MONTHS_MAX = 12;
export const SAVINGS_RATE_TARGET_MIN = 0;
export const SAVINGS_RATE_TARGET_MAX = 100;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Non-negative, otherwise falls back to the default (0) rather than allowing a negative buffer
 *  to inflate Safe to Spend. */
export function clampMinimumCashBuffer(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_FINANCIAL_PREFERENCES.minimumCashBuffer;
  return value;
}

export function clampUpcomingBillsDays(value: number): number {
  return clampInt(value, UPCOMING_BILLS_DAYS_MIN, UPCOMING_BILLS_DAYS_MAX, DEFAULT_FINANCIAL_PREFERENCES.upcomingBillsDays);
}

export function clampRecentAvgMonths(value: number): number {
  return clampInt(value, RECENT_AVG_MONTHS_MIN, RECENT_AVG_MONTHS_MAX, DEFAULT_FINANCIAL_PREFERENCES.recentAvgMonths);
}

export function clampSavingsRateTarget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FINANCIAL_PREFERENCES.savingsRateTarget;
  return Math.min(SAVINGS_RATE_TARGET_MAX, Math.max(SAVINGS_RATE_TARGET_MIN, value));
}

/** Classic personal-finance rule of thumb, generalized to a user-configurable target rather than
 *  a hardcoded 15%: negative (spending more than you earned) is always the tier that actually
 *  matters, regardless of target; short of the target is worth a nudge; at or above it is healthy.
 *  `rate` is a fraction (0.15 = 15%), `targetPercent` is a percentage (15, not 0.15) — matches how
 *  each is already represented at its call site (the calculated rate vs. the stored preference). */
export function savingsRateTier(rate: number, targetPercent: number): 'good' | 'warn' | 'over' {
  if (rate < 0) return 'over';
  if (rate < targetPercent / 100) return 'warn';
  return 'good';
}

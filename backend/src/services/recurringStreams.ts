// Average weeks/months per year, used to normalize any cadence to a comparable monthly figure.
const FREQUENCY_TO_MONTHLY_MULTIPLIER: Record<string, number> = {
  WEEKLY: 52 / 12,
  BIWEEKLY: 26 / 12,
  SEMI_MONTHLY: 2,
  MONTHLY: 1,
  ANNUALLY: 1 / 12,
};

/**
 * Converts a stream's per-occurrence amount into an equivalent monthly cost, so a weekly $15
 * charge and an annual $180 charge can be compared/summed on the same basis. Unknown
 * frequencies are treated as already-monthly rather than dropped, since Plaid's own `UNKNOWN`
 * value still represents real recurring spend we don't want to silently exclude from totals.
 */
export function normalizeToMonthlyAmount(amount: number, frequency: string): number {
  const multiplier = FREQUENCY_TO_MONTHLY_MULTIPLIER[frequency] ?? 1;
  return amount * multiplier;
}

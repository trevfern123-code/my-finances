/**
 * Rounds a monetary amount to the nearest cent. Plain IEEE-754 float arithmetic can leave a
 * computed sum/difference a hair off whole cents (e.g. 4.33 - 3 can yield 3.9999999999999996
 * instead of 4), which then compounds if written back and read again later. Every place that
 * writes a *computed* (summed/subtracted, not directly Plaid-sourced) monetary value to the
 * database — as opposed to relaying a value Plaid already gave us — should round through this
 * first, rather than each call site inventing its own tolerance or rounding logic.
 */
export function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

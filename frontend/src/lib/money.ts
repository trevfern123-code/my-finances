/**
 * Rounds a monetary amount to the nearest cent. Mirrors the backend's `roundToCents`
 * (`backend/src/services/money.ts`) — kept as an independent small copy rather than a shared
 * package, since the two workspaces don't otherwise share code and a single rounding function
 * isn't worth the build-tooling overhead of a shared package. Used anywhere the frontend needs
 * to compare a computed sum against a target amount (e.g. transaction split balancing) so it
 * never disagrees with the backend's own (exact, post-rounding) validation.
 */
export function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

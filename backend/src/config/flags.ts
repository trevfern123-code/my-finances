/**
 * Parses an opt-in feature flag from an environment variable. Only the value "true" (case-insensitive,
 * surrounding whitespace ignored) turns the feature on. Absent, empty, "false", "0", "1", "yes", a typo,
 * or anything else leaves it OFF — so a mistyped or half-configured value can never enable a feature by
 * accident. Kept free of side effects (unlike env.ts, which validates required variables on import) so
 * it can be tested on its own.
 */
export function parseOptInFlag(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

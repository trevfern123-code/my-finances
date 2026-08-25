export function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function advance(date: Date, frequency: string): Date | null {
  const next = new Date(date);
  switch (frequency) {
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case 'BIWEEKLY':
      next.setUTCDate(next.getUTCDate() + 14);
      return next;
    case 'SEMI_MONTHLY':
      next.setUTCDate(next.getUTCDate() + 15);
      return next;
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    case 'ANNUALLY':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      return next;
    default:
      return null;
  }
}

/** Plaid gives no explicit "next due" date — only when a recurring stream last occurred and how
 *  often. Estimates the next occurrence by repeatedly stepping forward by the stream's cadence
 *  from last_date until reaching today or later, so a stream whose last known charge was months
 *  ago still projects a plausible upcoming date instead of a stale one in the past. Irregular/
 *  unknown-cadence streams can't be estimated this way and return null rather than a guess. */
export function estimateNextDueDate(lastDate: string, frequency: string): Date | null {
  const today = todayUtc();
  let date = parseDate(lastDate);

  while (date.getTime() < today.getTime()) {
    const next = advance(date, frequency);
    if (!next) return null;
    date = next;
  }

  return date;
}

export function dueLabel(days: number): string {
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

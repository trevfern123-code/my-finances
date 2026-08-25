import type { RecurringStream } from '../lib/api';
import { daysBetween, dueLabel, estimateNextDueDate, todayUtc } from '../lib/recurringDates';

const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Biweekly',
  SEMI_MONTHLY: 'Twice a month',
  MONTHLY: 'Monthly',
  ANNUALLY: 'Annually',
  UNKNOWN: 'Irregular',
};

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatFrequency(frequency: string) {
  return FREQUENCY_LABELS[frequency] ?? frequency;
}

function formatDate(date: Date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Renders one direction's streams as a bar list, bars sized by monthly_amount (the
 *  server-normalized monthly-equivalent) rather than the raw per-charge amount — so a
 *  $10/week cost and a $200/year cost compare correctly instead of looking identical. */
function StreamList({
  streams,
  barClass,
  nextLabel,
}: {
  streams: RecurringStream[];
  barClass: string;
  nextLabel: string;
}) {
  const maxMonthly = Math.max(...streams.map((s) => s.monthly_amount), 1);
  const today = todayUtc();

  return (
    <div className="recurring-list">
      {streams.map((s) => {
        const nextDue = estimateNextDueDate(s.last_date, s.frequency);
        return (
          <div key={s.id} className="sub-row">
            <div className="sub-info">
              <span className="sub-name">{s.merchant_name ?? s.description}</span>
              <span className="sub-frequency">
                {formatFrequency(s.frequency)} · {formatCurrency(Math.abs(s.last_amount))} per charge
              </span>
              <span className="sub-next-due">
                {nextDue
                  ? `${nextLabel} ${formatDate(nextDue)} (${dueLabel(daysBetween(today, nextDue))})`
                  : `${nextLabel} date not predictable — irregular cadence`}
              </span>
            </div>
            <div className="sub-bar-track">
              <div className={barClass} style={{ width: `${(s.monthly_amount / maxMonthly) * 100}%` }} />
            </div>
            <span className="sub-amount">{formatCurrency(s.monthly_amount)}/mo</span>
          </div>
        );
      })}
    </div>
  );
}

export function SubscriptionsRecurring({
  streams,
  totalMonthlyOutflow,
  totalMonthlyInflow,
}: {
  streams: RecurringStream[];
  totalMonthlyOutflow: number;
  totalMonthlyInflow: number;
}) {
  const inflows = streams.filter((s) => s.direction === 'inflow');
  const outflows = streams.filter((s) => s.direction === 'outflow');

  return (
    <div className="tab-panel">
      <div className="card">
        <div className="section-header">
          <h2>Recurring income</h2>
          <span className="monthly-total-badge income">{formatCurrency(totalMonthlyInflow)}/mo total</span>
        </div>
        {inflows.length === 0 ? (
          <p className="hint">
            No recurring income detected yet — this is picked up automatically as transaction
            history builds up (usually needs a few months of history per source).
          </p>
        ) : (
          <StreamList streams={inflows} barClass="sub-bar-fill income" nextLabel="Next deposit" />
        )}
      </div>

      <div className="card">
        <div className="section-header">
          <h2>Subscriptions &amp; recurring costs</h2>
          <span className="monthly-total-badge">{formatCurrency(totalMonthlyOutflow)}/mo total</span>
        </div>
        {outflows.length === 0 ? (
          <p className="hint">
            No recurring costs detected yet — this is picked up automatically as transaction
            history builds up (usually needs a few months of history per merchant).
          </p>
        ) : (
          <StreamList streams={outflows} barClass="sub-bar-fill" nextLabel="Next charge" />
        )}
      </div>
    </div>
  );
}

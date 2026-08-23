import type { RecurringStream } from '../lib/api';

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

export function SubscriptionsRecurring({
  streams,
  totalMonthlyOutflow,
}: {
  streams: RecurringStream[];
  totalMonthlyOutflow: number;
}) {
  const outflows = streams.filter((s) => s.direction === 'outflow');
  const maxMonthly = Math.max(...outflows.map((s) => s.monthly_amount), 1);

  return (
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
        <div className="recurring-list">
          {outflows.map((s) => (
            <div key={s.id} className="sub-row">
              <div className="sub-info">
                <span className="sub-name">{s.merchant_name ?? s.description}</span>
                <span className="sub-frequency">{formatFrequency(s.frequency)}</span>
              </div>
              <div className="sub-bar-track">
                <div
                  className="sub-bar-fill"
                  style={{ width: `${(s.monthly_amount / maxMonthly) * 100}%` }}
                />
              </div>
              <span className="sub-amount">{formatCurrency(s.monthly_amount)}/mo</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

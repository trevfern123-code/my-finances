-- Financial Preferences v1: four user-owned settings on the existing user_preferences table,
-- matching the established pattern (dedicated columns, not JSONB, for simple scalar preferences —
-- see theme/accent_color). Every default here matches the value already hardcoded in the app
-- today (0 buffer, 14-day bill window, 2-month recent-average window, 15% savings target), so
-- behavior is identical for any user who never touches these settings.
alter table public.user_preferences
  add column minimum_cash_buffer numeric(12,2) not null default 0,
  add column upcoming_bills_days integer not null default 14,
  add column recent_avg_months integer not null default 2,
  add column savings_rate_target numeric(5,2) not null default 15.00;

alter table public.user_preferences
  add constraint user_preferences_minimum_cash_buffer_check
    check (minimum_cash_buffer >= 0),
  add constraint user_preferences_upcoming_bills_days_check
    check (upcoming_bills_days between 1 and 90),
  add constraint user_preferences_recent_avg_months_check
    check (recent_avg_months between 1 and 12),
  add constraint user_preferences_savings_rate_target_check
    check (savings_rate_target between 0 and 100);

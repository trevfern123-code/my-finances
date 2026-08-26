-- Date-Range Customization v1: one reporting-range preference on the existing user_preferences
-- table (dedicated column, not JSONB, matching every other simple scalar preference here).
-- Defaults to 'last_6_months' — today's existing hardcoded historical-chart behavior, so nothing
-- changes for a user who never touches this setting.
alter table public.user_preferences
  add column reporting_range text not null default 'last_6_months';

alter table public.user_preferences
  add constraint user_preferences_reporting_range_check
    check (reporting_range in ('this_month', 'last_month', 'last_3_months', 'last_6_months', 'last_12_months'));

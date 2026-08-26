-- Safe to Spend Customization v1: two toggles controlling whether upcoming bills / remaining
-- budget are subtracted in the Safe to Spend calculation. Both default to true, matching the
-- formula's existing behavior exactly, so nothing changes for a user who never touches these.
alter table public.user_preferences
  add column safe_to_spend_include_upcoming_bills boolean not null default true,
  add column safe_to_spend_include_remaining_budget boolean not null default true;

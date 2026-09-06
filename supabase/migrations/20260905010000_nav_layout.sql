-- Navigation Customization v1: one nav-layout preference on the existing user_preferences table,
-- same nullable-jsonb shape and validation approach as dashboard_layout — no default, no backfill,
-- and no Postgres-level shape constraint, since normalization/defaulting already happens entirely
-- in application code (see frontend lib/navLayout.ts's mergeNavLayout), same precedent as
-- dashboard_layout. Null means the user has never customized navigation; the app falls back to its
-- own built-in default tab order, not an empty nav bar. Only the customizable middle tabs are ever
-- stored here — Overview and Settings are structural anchors (frontend lib/tabRegistry.ts) that are
-- never persisted in this column.
alter table public.user_preferences
  add column nav_layout jsonb;

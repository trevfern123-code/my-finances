-- Budget Customization v1: archive/unarchive support for budget categories.
--
-- archived_at is null for an active category, set to the archive timestamp otherwise. Archiving
-- itself never touches transactions.budget_category_id or transaction_splits.budget_category_id
-- -- historical relationships are preserved unchanged; only category_mappings rows targeting the
-- archived category are removed by the application (so future synced transactions stop being
-- auto-assigned to it), which needs no schema change since that table already cascades on delete.
alter table public.budget_categories
  add column archived_at timestamptz null;

-- budget_categories.name was globally unique (not even scoped per user), flagged as
-- second-user-readiness debt during migration reconciliation. Archiving surfaces the same gap in
-- a new way: reusing a name after archiving the category that had it would collide under the old
-- constraint. Replaced with a per-user constraint that only applies to active categories, so an
-- archived name can be reused for a new active category.
alter table public.budget_categories
  drop constraint budget_categories_name_key;

create unique index budget_categories_user_id_name_active_key
  on public.budget_categories (user_id, name)
  where archived_at is null;

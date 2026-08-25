create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dashboard_layout jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

create policy "Users can view own preferences"
  on public.user_preferences for select
  using (auth.uid() = user_id);

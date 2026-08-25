# Schema notes

**Status: reconciled against the live database.** `supabase/migrations/20260825195130_remote_schema.sql`
(pulled via `npx supabase db pull` from the linked project) is now the authoritative schema —
that file, not this one, is the source of truth going forward. This document records how the
earlier hand-reconstructed schema (kept below for history) compared against it, and calls out
the handful of real discrepancies worth knowing about.

From here on, schema changes go through `supabase migration new <name>` + review + Trevor
applying it with `supabase db push` (or pasting the SQL by hand, as before, then immediately
adding the matching migration file to this repo so the two never drift again) — not ad hoc SQL
pasted into the Supabase SQL editor with nothing tracked in the repo.

## Reconciliation findings (2026-08-25)

The hand-reconstructed schema was correct on every table name, column name, and nullability —
it was built directly from what the application code actually selects/inserts/updates, so that
tracked closely. The real, pulled schema added information no amount of reading the app code
could have revealed, and surfaced one genuine finding worth flagging:

- **`budget_categories.name` has a database-wide `unique` constraint** (`budget_categories_name_key`),
  not scoped per user. Today, with one real user, this is invisible. But it means the database
  itself — not just app logic — would currently reject two *different* users both naming a
  category e.g. "Groceries". This is a real pre-existing constraint in production, not something
  introduced by this reconciliation, and **it has not been changed** (changing it means dropping
  and re-adding the constraint as `unique (user_id, name)`, a live schema change on production
  data that deserves its own reviewed migration, not a drive-by fix while reconciling docs).
  Worth deciding on deliberately before a second real user ever signs up.
- Every Phase-1 table's RLS status is now confirmed rather than guessed: `plaid_items`,
  `budget_categories`, `manual_loans`, and `manual_loan_payments` all have RLS enabled *and* an
  explicit `auth.uid() = user_id` select policy. `accounts` has RLS enabled with **no** policy —
  consistent with the documented "join-derived ownership, deny-all-but-service-role" pattern used
  for `transactions`/`loans`/`recurring_streams`/`transaction_splits`, now confirmed rather than
  assumed.
- The two most financially-important columns are already precision-constrained at the schema
  level: `transactions.amount` and `accounts.current_balance`/`available_balance` are
  `numeric(12,2)`, and `budget_categories.budget_amount` is `numeric(10,2)` — genuinely good news
  for the money-precision work already planned (item B on the roadmap). Every other money column
  (`transaction_splits.amount`, `manual_loan_payments.principal_portion`/`interest_portion`, loan
  amounts, `net_worth_snapshots` totals, `credit_limit`, `savings_goal`) is plain unconstrained
  `numeric` — inconsistent, but not urgent; worth standardizing to `numeric(12,2)` as part of the
  broader precision work rather than as its own migration.
- Several `updated_at`/`created_at` timestamp columns exist that the application never reads or
  writes (`accounts.updated_at`, `plaid_items.created_at`/`updated_at`, `transactions.created_at`,
  `budget_categories.updated_at`) — harmless bookkeeping, not used anywhere, not a concern.
- `plaid_items.plaid_item_id` and `accounts.plaid_account_id` are also globally unique — but
  unlike `budget_categories.name`, these are Plaid-assigned identifiers, not user-chosen text, so
  a global uniqueness constraint on them is correct and carries no cross-user collision risk.
- The dump's broad `grant ... to "anon", "authenticated", ...` statements look alarming in
  isolation but are Supabase's standard default grants — RLS is what actually gates access, and
  since no table has an insert/update/delete policy anywhere, `anon`/`authenticated` remain fully
  blocked from writing to anything regardless of these grants; only the tables with an explicit
  select policy are readable by their owning user, and only for reads. Confirms the access-control
  posture described in the main README is accurate, not just documented intent.
- All 11 tables the application code touches were present in the pull, nothing missing, nothing
  extra beyond what the app already queries.

## Hand-reconstructed schema (superseded, kept for history — do not treat as authoritative)

**Status when written: reconstructed from application code, not yet verified against the live
database.** Superseded by `migrations/20260825195130_remote_schema.sql` as of the reconciliation
above — kept here only as a record of what was inferable from code alone vs. what actually
needed a real schema pull to know for certain.

## Phase 1 tables (original MVP — reconstructed, not verified)

```sql
create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  plaid_item_id text not null,
  access_token text not null,
  institution_id text,
  institution_name text,
  transactions_cursor text,
  status text not null default 'active' -- 'active' | 'login_required'
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.plaid_items(id) on delete cascade,
  plaid_account_id text not null,
  name text not null,
  official_name text,
  type text not null,
  subtype text,
  mask text,
  current_balance numeric,
  available_balance numeric,
  iso_currency_code text default 'USD',
  credit_limit numeric,   -- user-entered, never written by the Plaid sync path
  savings_goal numeric    -- user-entered, never written by the Plaid sync path
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  plaid_transaction_id text not null unique,
  amount numeric not null,   -- Plaid convention: positive = spend, negative = income
  iso_currency_code text,
  date date not null,
  name text not null,
  merchant_name text,
  category text,          -- Plaid personal_finance_category.primary
  plaid_category text,    -- legacy Plaid category array, joined with " > "
  pending boolean not null default false,
  budget_category_id uuid references public.budget_categories(id),
  manual_loan_id uuid references public.manual_loans(id),
  principal_portion numeric,
  needs_review boolean not null default false   -- added mid-session, see "Needs Review" below
);

create table public.budget_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null,
  budget_amount numeric not null,
  color text,
  sort_order integer not null default 0,
  emoji text   -- added mid-session, see "Category emojis" below
);

create table public.manual_loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null,
  loan_type text not null,   -- 'personal' | 'student' | 'mortgage' | 'auto' | 'other'
  current_balance numeric not null,
  origination_principal_amount numeric,
  interest_rate_percentage numeric,
  origination_date date,
  term_months integer,
  minimum_payment_amount numeric,
  next_payment_due_date date,
  notes text,
  match_text text,   -- case-insensitive substring match against transaction name/merchant
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.manual_loan_payments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.manual_loans(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  date date not null,
  principal_portion numeric not null,
  interest_portion numeric not null,
  notes text,
  created_at timestamptz not null default now()
);
```

## Tables added mid-project (SQL given verbatim to Trevor at the time, high confidence)

**`recurring_streams`** — Subscriptions & Recurring tab. No RLS policy (join-derived ownership,
matches `accounts`/`transactions`).
```sql
create table public.recurring_streams (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.plaid_items(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  plaid_stream_id text not null,
  description text not null,
  merchant_name text,
  direction text not null check (direction in ('inflow', 'outflow')),
  frequency text not null,
  average_amount numeric not null,
  last_amount numeric not null,
  iso_currency_code text default 'USD',
  first_date date not null,
  last_date date not null,
  is_active boolean not null default true,
  status text not null,
  category text,
  updated_at timestamptz not null default now(),
  unique (item_id, plaid_stream_id)
);
create index if not exists recurring_streams_item_id_idx on public.recurring_streams(item_id);
```

**`loans`** — Loan Progress tab (Plaid Liabilities). RLS enabled, no policy.
```sql
create table public.loans (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.plaid_items(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  plaid_account_id text not null,
  loan_type text not null check (loan_type in ('student', 'mortgage', 'credit')),
  name text,
  interest_rate_percentage numeric,
  origination_principal_amount numeric,
  origination_date date,
  minimum_payment_amount numeric,
  next_payment_due_date date,
  last_payment_amount numeric,
  last_payment_date date,
  is_overdue boolean,
  updated_at timestamptz not null default now(),
  unique (item_id, plaid_account_id)
);
create index if not exists loans_item_id_idx on public.loans(item_id);
alter table public.loans enable row level security;
```

**`net_worth_snapshots`** — Overview net worth history. Direct `user_id`, select policy.
```sql
create table public.net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  date date not null,
  total_assets numeric not null default 0,
  total_liabilities numeric not null default 0,
  net_worth numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists net_worth_snapshots_user_id_date_idx on public.net_worth_snapshots(user_id, date);
alter table public.net_worth_snapshots enable row level security;
create policy "Users can only see their own net_worth_snapshots"
  on public.net_worth_snapshots for select
  using (auth.uid() = user_id);
```

**Needs Review** (`transactions.needs_review`):
```sql
alter table public.transactions add column needs_review boolean not null default false;
```

**Category emojis** (`budget_categories.emoji`):
```sql
alter table public.budget_categories add column emoji text;
```

**`category_mappings`** — Settings tab, auto-categorization by Plaid category. Direct `user_id`, select policy.
```sql
create table public.category_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_category text not null,
  budget_category_id uuid not null references public.budget_categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, plaid_category)
);
alter table public.category_mappings enable row level security;
create policy "Users can view own category mappings"
  on public.category_mappings for select
  using (auth.uid() = user_id);
```

**`transaction_splits`** — Accounts tab, splitting one transaction across categories. Join-derived
ownership (`transaction_id` → `accounts` → `plaid_items` → `user_id`), RLS enabled, no policy —
matches `transactions`/`accounts`/`loans`/`recurring_streams`.
```sql
create table public.transaction_splits (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  budget_category_id uuid not null references public.budget_categories(id) on delete cascade,
  amount numeric not null,
  note text,
  created_at timestamptz not null default now()
);
alter table public.transaction_splits enable row level security;
```

# Schema reconstruction notes

**Status: reconstructed from application code, not verified against the live database.**
This file exists to document the schema as best-understood *before* running `supabase db pull`
for the first time (see "Linking to the live project" below) — once that's run, the generated
migration file in `migrations/` is the authoritative source and this file becomes historical
context only. Do not treat the column types/constraints below as certain; several are inferred
from how the application queries the table, not from a verified `pg_dump`/introspection.

High confidence: table names, column names, and nullability (all directly observable from what
`backend/src/services/dataService.ts` selects/inserts/updates, and from `backend/src/types/index.ts`).
Lower confidence: exact SQL types where more than one type would behave identically from the
application's point of view (e.g. `text` vs `varchar`), default values, and whether a few
Phase-1 tables (`budget_categories`, `manual_loans`, `manual_loan_payments`) already have RLS
enabled — the project's later tables definitely do (a Supabase security-linter prompt caught
`accounts`/`transactions` missing it and it was added), but whether that pass covered the
earlier direct-`user_id` tables too isn't recorded anywhere in code or history.

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

## Linking to the live project (do this once, gives us the real authoritative schema)

These need to run in a real terminal on your machine (interactive browser login — can't be
automated) and use the Supabase CLI, available via `npx supabase` without a global install:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>   # from the Supabase dashboard URL
npx supabase db pull
```

`db pull` introspects the live database and writes the actual current schema as the first file
in `supabase/migrations/`. Once that's done, tell me and I'll reconcile it against this document
(fix anything I guessed wrong above) and from then on every schema change goes through
`supabase migration new <name>` + a review + you applying it, instead of ad hoc SQL in chat.

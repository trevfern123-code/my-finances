-- Minimal stand-in for the parts of the production base schema the Phase A migration depends on:
-- the Supabase roles (so its REVOKE/GRANTs are meaningful), Supabase's default of granting EXECUTE
-- on new functions to anon/authenticated (so the migration's explicit revokes are actually tested),
-- and the plaid_items/accounts/budget_categories/manual_loans/manual_loan_payments/transactions
-- tables with the column types and foreign keys of supabase/migrations/20260825195130_remote_schema.sql.
-- It is NOT a replay of that migration (no auth schema, RLS policies or storage).
--
-- Also defines the `th` ("test harness") schema of assertion helpers every test file uses. A failed
-- assertion raises, and the runner executes every file with ON_ERROR_STOP, so any failure fails the
-- test.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$$;

-- A recreated `public` schema does not get the special PUBLIC usage the bootstrap one has.
grant usage on schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public grant execute on functions to anon;
alter default privileges for role postgres in schema public grant execute on functions to authenticated;
alter default privileges for role postgres in schema public grant execute on functions to service_role;

create extension if not exists pgcrypto;

create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.plaid_items(id)
);

create table public.budget_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  budget_amount numeric(10,2) not null default 0
);

create table public.manual_loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  loan_type text not null default 'personal',
  current_balance numeric not null,
  origination_principal_amount numeric,
  interest_rate_percentage numeric,
  origination_date date,
  term_months integer,
  minimum_payment_amount numeric,
  next_payment_due_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  match_text text
);

create table public.manual_loan_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  loan_id uuid not null references public.manual_loans(id),
  date date not null,
  principal_portion numeric not null default 0,
  interest_portion numeric not null default 0,
  notes text
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  plaid_transaction_id text unique,
  amount numeric(12,2) not null,
  iso_currency_code text default 'USD',
  date date not null,
  name text,
  merchant_name text,
  category text,
  plaid_category text,
  pending boolean default false,
  needs_review boolean not null default false,
  budget_category_id uuid references public.budget_categories(id),
  manual_loan_id uuid references public.manual_loans(id) on delete set null,
  principal_portion numeric
);

grant all on all tables in schema public to service_role;

create schema th;

create function th.assert(p_condition boolean, p_message text) returns void
language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
end;
$$;

-- Runs p_sql and requires it to fail with an error whose message matches p_pattern (LIKE). The
-- statement runs inside this function's own exception block, i.e. a subtransaction, so whatever it
-- did before failing is rolled back — callers then assert the database is unchanged.
create function th.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_pattern then
      return;
    end if;
    raise exception 'ASSERTION FAILED: expected an error like % but got: %', p_pattern, sqlerrm;
  end;
  raise exception 'ASSERTION FAILED: expected an error like % but the statement succeeded: %', p_pattern, p_sql;
end;
$$;

grant usage on schema th to anon, authenticated, service_role;
grant execute on all functions in schema th to anon, authenticated, service_role;

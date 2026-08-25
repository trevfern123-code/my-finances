alter default privileges for role "postgres" in schema "public" revoke all on sequences from "anon";

alter default privileges for role "postgres" in schema "public" revoke all on sequences from "authenticated";

alter default privileges for role "postgres" in schema "public" revoke all on sequences from "service_role";

alter default privileges for role "postgres" in schema "public" revoke all on tables from "anon";

alter default privileges for role "postgres" in schema "public" revoke all on tables from "authenticated";

alter default privileges for role "postgres" in schema "public" revoke all on tables from "service_role";

create table "public"."accounts" (
  "id"                uuid                     not null default gen_random_uuid(),
  "item_id"           uuid                     not null,
  "plaid_account_id"  text                     not null,
  "name"              text                     not null,
  "official_name"     text,
  "type"              text,
  "subtype"           text,
  "mask"              text,
  "current_balance"   numeric(12,2),
  "available_balance" numeric(12,2),
  "iso_currency_code" text                     default 'USD'::text,
  "updated_at"        timestamp with time zone not null default now(),
  "credit_limit"      numeric,
  "savings_goal"      numeric,
  constraint "accounts_pkey" primary key (id),
  constraint "accounts_plaid_account_id_key" unique (plaid_account_id)
);

alter table "public"."accounts"
  enable row level security;

create table "public"."budget_categories" (
  "id"            uuid                     not null default gen_random_uuid(),
  "name"          text                     not null,
  "budget_amount" numeric(10,2)            not null default 0,
  "color"         text,
  "sort_order"    integer                  default 0,
  "updated_at"    timestamp with time zone not null default now(),
  "emoji"         text,
  constraint "budget_categories_name_key" unique (name),
  constraint "budget_categories_pkey" primary key (id),
  "user_id"       uuid                     not null default auth.uid()
);

alter table "public"."budget_categories"
  enable row level security;

create table "public"."category_mappings" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "user_id"            uuid                     not null,
  "plaid_category"     text                     not null,
  "budget_category_id" uuid                     not null,
  "created_at"         timestamp with time zone not null default now(),
  constraint "category_mappings_pkey" primary key (id),
  constraint "category_mappings_user_id_plaid_category_key" unique (user_id, plaid_category)
);

alter table "public"."category_mappings"
  enable row level security;

create table "public"."loans" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "item_id"                      uuid                     not null,
  "account_id"                   uuid,
  "plaid_account_id"             text                     not null,
  "loan_type"                    text                     not null,
  "name"                         text,
  "interest_rate_percentage"     numeric,
  "origination_principal_amount" numeric,
  "origination_date"             date,
  "minimum_payment_amount"       numeric,
  "next_payment_due_date"        date,
  "last_payment_amount"          numeric,
  "last_payment_date"            date,
  "is_overdue"                   boolean,
  "updated_at"                   timestamp with time zone not null default now(),
  constraint "loans_item_id_plaid_account_id_key" unique (item_id, plaid_account_id),
  constraint "loans_loan_type_check" check ((loan_type = ANY (ARRAY['student'::text, 'mortgage'::text, 'credit'::text]))),
  constraint "loans_pkey" primary key (id)
);

alter table "public"."loans"
  enable row level security;

create table "public"."manual_loan_payments" (
  "id"                uuid                     not null default gen_random_uuid(),
  "loan_id"           uuid                     not null,
  "user_id"           uuid                     not null,
  "date"              date                     not null,
  "principal_portion" numeric                  not null default 0,
  "interest_portion"  numeric                  not null default 0,
  "notes"             text,
  "created_at"        timestamp with time zone not null default now(),
  constraint "manual_loan_payments_pkey" primary key (id)
);

alter table "public"."manual_loan_payments"
  enable row level security;

create table "public"."manual_loans" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "user_id"                      uuid                     not null,
  "name"                         text                     not null,
  "loan_type"                    text                     not null default 'personal'::text,
  "current_balance"              numeric                  not null,
  "origination_principal_amount" numeric,
  "interest_rate_percentage"     numeric,
  "origination_date"             date,
  "term_months"                  integer,
  "minimum_payment_amount"       numeric,
  "next_payment_due_date"        date,
  "notes"                        text,
  "created_at"                   timestamp with time zone not null default now(),
  "updated_at"                   timestamp with time zone not null default now(),
  "match_text"                   text,
  constraint "manual_loans_loan_type_check" check ((loan_type = ANY (ARRAY['personal'::text, 'student'::text, 'mortgage'::text, 'auto'::text, 'other'::text]))),
  constraint "manual_loans_pkey" primary key (id)
);

alter table "public"."manual_loans"
  enable row level security;

create table "public"."net_worth_snapshots" (
  "id"                uuid                     not null default gen_random_uuid(),
  "user_id"           uuid                     not null,
  "date"              date                     not null,
  "total_assets"      numeric                  not null default 0,
  "total_liabilities" numeric                  not null default 0,
  "net_worth"         numeric                  not null default 0,
  "created_at"        timestamp with time zone not null default now(),
  constraint "net_worth_snapshots_pkey" primary key (id),
  constraint "net_worth_snapshots_user_id_date_key" unique (user_id, date)
);

alter table "public"."net_worth_snapshots"
  enable row level security;

create table "public"."plaid_items" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "plaid_item_id"       text                     not null,
  "access_token"        text                     not null,
  "institution_id"      text,
  "institution_name"    text,
  "transactions_cursor" text,
  "status"              text                     not null default 'active'::text,
  "created_at"          timestamp with time zone not null default now(),
  "updated_at"          timestamp with time zone not null default now(),
  constraint "plaid_items_pkey" primary key (id),
  constraint "plaid_items_plaid_item_id_key" unique (plaid_item_id),
  "user_id"             uuid                     not null default auth.uid()
);

alter table "public"."plaid_items"
  enable row level security;

create table "public"."recurring_streams" (
  "id"                uuid                     not null default gen_random_uuid(),
  "item_id"           uuid                     not null,
  "account_id"        uuid,
  "plaid_stream_id"   text                     not null,
  "description"       text                     not null,
  "merchant_name"     text,
  "direction"         text                     not null,
  "frequency"         text                     not null,
  "average_amount"    numeric                  not null,
  "last_amount"       numeric                  not null,
  "iso_currency_code" text                     default 'USD'::text,
  "first_date"        date                     not null,
  "last_date"         date                     not null,
  "is_active"         boolean                  not null default true,
  "status"            text                     not null,
  "category"          text,
  "updated_at"        timestamp with time zone not null default now(),
  constraint "recurring_streams_direction_check" check ((direction = ANY (ARRAY['inflow'::text, 'outflow'::text]))),
  constraint "recurring_streams_item_id_plaid_stream_id_key" unique (item_id, plaid_stream_id),
  constraint "recurring_streams_pkey" primary key (id)
);

alter table "public"."recurring_streams"
  enable row level security;

create table "public"."transaction_splits" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "transaction_id"     uuid                     not null,
  "budget_category_id" uuid                     not null,
  "amount"             numeric                  not null,
  "note"               text,
  "created_at"         timestamp with time zone not null default now(),
  constraint "transaction_splits_pkey" primary key (id)
);

alter table "public"."transaction_splits"
  enable row level security;

create table "public"."transactions" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "account_id"           uuid                     not null,
  "plaid_transaction_id" text                     not null,
  "amount"               numeric(12,2)            not null,
  "iso_currency_code"    text                     default 'USD'::text,
  "date"                 date                     not null,
  "name"                 text,
  "merchant_name"        text,
  "category"             text,
  "plaid_category"       text,
  "pending"              boolean                  default false,
  "created_at"           timestamp with time zone not null default now(),
  "budget_category_id"   uuid,
  "manual_loan_id"       uuid,
  "principal_portion"    numeric,
  "needs_review"         boolean                  not null default false,
  constraint "transactions_pkey" primary key (id),
  constraint "transactions_plaid_transaction_id_key" unique (plaid_transaction_id)
);

alter table "public"."transactions"
  enable row level security;

alter table "public"."category_mappings"
  add constraint "category_mappings_budget_category_id_fkey" foreign key (budget_category_id) references public.budget_categories(id) on delete cascade;

alter table "public"."category_mappings"
  add constraint "category_mappings_user_id_fkey" foreign key (user_id) references auth.users(id) on delete cascade;

alter table "public"."loans"
  add constraint "loans_account_id_fkey" foreign key (account_id) references public.accounts(id) on delete cascade;

alter table "public"."manual_loan_payments"
  add constraint "manual_loan_payments_user_id_fkey" foreign key (user_id) references auth.users(id);

alter table "public"."manual_loan_payments"
  add constraint "manual_loan_payments_loan_id_fkey" foreign key (loan_id) references public.manual_loans(id) on delete cascade;

alter table "public"."manual_loans"
  add constraint "manual_loans_user_id_fkey" foreign key (user_id) references auth.users(id);

alter table "public"."net_worth_snapshots"
  add constraint "net_worth_snapshots_user_id_fkey" foreign key (user_id) references auth.users(id);

alter table "public"."accounts"
  add constraint "accounts_item_id_fkey" foreign key (item_id) references public.plaid_items(id) on delete cascade;

alter table "public"."loans"
  add constraint "loans_item_id_fkey" foreign key (item_id) references public.plaid_items(id) on delete cascade;

alter table "public"."recurring_streams"
  add constraint "recurring_streams_account_id_fkey" foreign key (account_id) references public.accounts(id) on delete cascade;

alter table "public"."recurring_streams"
  add constraint "recurring_streams_item_id_fkey" foreign key (item_id) references public.plaid_items(id) on delete cascade;

alter table "public"."transaction_splits"
  add constraint "transaction_splits_budget_category_id_fkey" foreign key (budget_category_id) references public.budget_categories(id) on delete cascade;

alter table "public"."transactions"
  add constraint "transactions_account_id_fkey" foreign key (account_id) references public.accounts(id) on delete cascade;

alter table "public"."transactions"
  add constraint "transactions_budget_category_id_fkey" foreign key (budget_category_id) references public.budget_categories(id);

alter table "public"."transactions"
  add constraint "transactions_manual_loan_id_fkey" foreign key (manual_loan_id) references public.manual_loans(id) on delete set null;

alter table "public"."transaction_splits"
  add constraint "transaction_splits_transaction_id_fkey" foreign key (transaction_id) references public.transactions(id) on delete cascade;

create index idx_transactions_account on public.transactions using btree (account_id);

create index idx_transactions_date on public.transactions using btree (date desc);

create index loans_item_id_idx on public.loans using btree (item_id);

create index manual_loan_payments_loan_id_idx on public.manual_loan_payments using btree (loan_id);

create index manual_loans_user_id_idx on public.manual_loans using btree (user_id);

create index net_worth_snapshots_user_id_date_idx on public.net_worth_snapshots using btree (user_id, date);

create index recurring_streams_item_id_idx on public.recurring_streams using btree (item_id);

create index transactions_budget_category_id_idx on public.transactions using btree (budget_category_id);

create index transactions_manual_loan_id_idx on public.transactions using btree (manual_loan_id);

create policy "Users can view own category mappings" on "public"."category_mappings"
  for select
  to PUBLIC
  using ((auth.uid() = user_id));

create policy "Users can only see their own manual_loan_payments" on "public"."manual_loan_payments"
  for select
  to PUBLIC
  using ((auth.uid() = user_id));

create policy "Users can only see their own manual_loans" on "public"."manual_loans"
  for select
  to PUBLIC
  using ((auth.uid() = user_id));

create policy "Users can only see their own net_worth_snapshots" on "public"."net_worth_snapshots"
  for select
  to PUBLIC
  using ((auth.uid() = user_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."accounts" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."budget_categories" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."category_mappings" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."loans" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."manual_loan_payments" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."manual_loans" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."net_worth_snapshots" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."plaid_items" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."recurring_streams" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."transaction_splits" to "anon", "authenticated", "postgres", "service_role";

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."transactions" to "anon", "authenticated", "postgres", "service_role";

alter default privileges for role "postgres" in schema "public" grant select, update, usage on sequences to "anon";

alter default privileges for role "postgres" in schema "public" grant select, update, usage on sequences to "authenticated";

alter default privileges for role "postgres" in schema "public" grant select, update, usage on sequences to "service_role";

alter default privileges for role "postgres" in schema "public" grant execute on FUNCTIONS to "anon";

alter default privileges for role "postgres" in schema "public" grant execute on FUNCTIONS to "authenticated";

alter default privileges for role "postgres" in schema "public" grant execute on FUNCTIONS to "service_role";

alter default privileges for role "postgres" in schema "public" grant delete, insert, maintain, references, select, trigger, truncate, update on tables to "anon";

alter default privileges for role "postgres" in schema "public" grant delete, insert, maintain, references, select, trigger, truncate, update on tables to "authenticated";

alter default privileges for role "postgres" in schema "public" grant delete, insert, maintain, references, select, trigger, truncate, update on tables to "service_role";

alter table "public"."budget_categories"
  add constraint "budget_categories_user_id_fkey" foreign key (user_id) references auth.users(id);

create index budget_categories_user_id_idx on public.budget_categories using btree (user_id);

create policy "Users can only see their own budget_categories" on "public"."budget_categories"
  for select
  to PUBLIC
  using ((auth.uid() = user_id));

alter table "public"."plaid_items"
  add constraint "plaid_items_user_id_fkey" foreign key (user_id) references auth.users(id);

create index plaid_items_user_id_idx on public.plaid_items using btree (user_id);

create policy "Users can only see their own plaid_items" on "public"."plaid_items"
  for select
  to PUBLIC
  using ((auth.uid() = user_id));


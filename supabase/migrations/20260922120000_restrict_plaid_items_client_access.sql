-- Wave 1 remediation (1/2): no browser client may read or write public.plaid_items.
--
-- plaid_items holds Plaid credential material: the legacy plaintext `access_token` (still present
-- on every row until Phase 2b/backfill — see PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md) and the five
-- encrypted-token columns. Until now the base schema (20260825195130_remote_schema.sql) granted
-- anon and authenticated every table privilege, and the "Users can only see their own plaid_items"
-- SELECT policy let any signed-in user read their own rows — plaintext access token included —
-- straight from Supabase's REST API with nothing but the public anon key and their own JWT.
--
-- Nothing legitimate uses that path. The frontend's Supabase client is used for Auth only (see
-- frontend/src/lib/supabaseClient.ts; no `.from(`/`.rpc(` call exists anywhere in frontend/src),
-- and every plaid_items read/write happens in the backend through the service-role key
-- (backend/src/config/supabase.ts), which needs SELECT, INSERT and UPDATE here and is deliberately
-- left exactly as it was. So the owner-select policy is removed outright rather than replaced by a
-- credential-free view: the application has no use for one.
--
-- RLS stays enabled with zero policies — the same "deny everyone except service_role" posture as
-- accounts/transactions/loans — so a future accidental re-GRANT still exposes no row.
--
-- The post-condition block at the end makes the migration fail (and roll back entirely) if any
-- anon/authenticated/PUBLIC privilege, at table OR column level, or any policy survives, or if
-- service_role lost anything the backend needs.
--
-- Rollback (restores the previous, credential-exposing posture — only if something unexpected
-- turns out to depend on direct client access; nothing in this repository does):
--   grant delete, insert, maintain, references, select, trigger, truncate, update
--     on table public.plaid_items to anon, authenticated;
--   create policy "Users can only see their own plaid_items" on public.plaid_items
--     for select to public using ((auth.uid() = user_id));

revoke all on table public.plaid_items from public, anon, authenticated;

-- A table-level REVOKE ALL also revokes column privileges, but the credential columns are named
-- explicitly so that remains true even if someone later adds a column-level grant.
revoke all (
  access_token,
  access_token_ciphertext,
  access_token_nonce,
  access_token_auth_tag,
  access_token_key_id,
  access_token_enc_version
) on table public.plaid_items from public, anon, authenticated;

drop policy if exists "Users can only see their own plaid_items" on public.plaid_items;

alter table public.plaid_items enable row level security;

do $$
declare
  v_role text;
  v_priv text;
  v_col  record;
begin
  foreach v_role in array array['public', 'anon', 'authenticated'] loop
    foreach v_priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege(v_role, 'public.plaid_items', v_priv) then
        raise exception 'plaid_items lockdown failed: % still has % on public.plaid_items', v_role, v_priv;
      end if;
    end loop;
    for v_col in
      select attname from pg_attribute
      where attrelid = 'public.plaid_items'::regclass and attnum > 0 and not attisdropped
    loop
      foreach v_priv in array array['select', 'insert', 'update', 'references'] loop
        if has_column_privilege(v_role, 'public.plaid_items', v_col.attname, v_priv) then
          raise exception 'plaid_items lockdown failed: % still has % on column %', v_role, v_priv, v_col.attname;
        end if;
      end loop;
    end loop;
  end loop;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_items') then
    raise exception 'plaid_items lockdown failed: a row-level security policy still exists';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.plaid_items'::regclass) then
    raise exception 'plaid_items lockdown failed: row level security is not enabled';
  end if;

  foreach v_priv in array array['select', 'insert', 'update'] loop
    if not has_table_privilege('service_role', 'public.plaid_items', v_priv) then
      raise exception 'plaid_items lockdown failed: service_role lost % (the backend needs it)', v_priv;
    end if;
  end loop;
end
$$;

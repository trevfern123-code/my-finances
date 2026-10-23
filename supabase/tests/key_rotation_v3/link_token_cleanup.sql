-- PLAID_KEY_ROTATION_V2_TO_V3.md §4.3 step 2 — the ONE write of the Hosted Link cleanup. Separately
-- approved, with <purgeable from step 1> replaced by the exact number step 1 reported. Any exception
-- aborts the statement and the delete rolls back.
do $$
declare
  v_expected constant integer := <purgeable from step 1>;
  v_deleted integer;
begin
  if v_expected < 1 or v_expected > 100 then
    raise exception 'expected count out of bounds';
  end if;
  if exists (select 1 from public.plaid_link_attempts
              where link_token_key_id = 'RAILWAY_PROD_V2'
                and expires_at > now() - interval '1 hour') then
    raise exception 'V2 link tokens newer than the purge threshold exist; wait and recount';
  end if;
  delete from public.plaid_link_attempts
   where link_token_key_id = 'RAILWAY_PROD_V2'
     and status in ('pending', 'claimed')
     and expires_at <= now() - interval '1 hour';
  get diagnostics v_deleted = row_count;
  if v_deleted <> v_expected then
    raise exception 'deleted % rows, expected %: rolled back', v_deleted, v_expected;
  end if;
end $$;

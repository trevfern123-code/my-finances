-- Access-control harness helpers, loaded once (as supabase_admin) after phase_a/helpers.sql.
-- Every "link token" here is a placeholder string — never a real Plaid token.

-- The SHA-256 the backend (and so the webhook path) would compute for an attempt's placeholder token.
create function th.attempt_token_hash(p_id uuid) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_id::text || ':placeholder-link-token', 'UTF8')), 'hex');
$$;

-- A pending attempt created exactly the way the backend creates one (through the real function).
create function th.new_attempt(p_user uuid, p_session text, p_id uuid default gen_random_uuid()) returns uuid
language plpgsql as $$
begin
  perform public.create_plaid_link_attempt(p_id, p_user, p_session, th.attempt_token_hash(p_id),
    'cGxhY2Vob2xkZXI=', 'bm9uY2Vub25jZW5v', 'dGFndGFndGFndGFn', 'HARNESS_KEY', 1::smallint);
  return p_id;
end;
$$;

-- A row written directly, for states the functions never produce on their own schedule (old or
-- expired rows). A completed row gets a placeholder item id; completed/failed rows carry no token.
create function th.insert_attempt(p_user uuid, p_session text, p_created_at timestamptz, p_expires_at timestamptz,
                                  p_status text default 'pending', p_id uuid default gen_random_uuid()) returns uuid
language plpgsql as $$
declare
  v_live boolean := p_status in ('pending', 'completing');
begin
  insert into public.plaid_link_attempts (id, user_id, session_id, created_at, expires_at, status, link_token_hash,
    link_token_ciphertext, link_token_nonce, link_token_auth_tag, link_token_key_id, link_token_enc_version, plaid_item_id)
  values (p_id, p_user, p_session, p_created_at, p_expires_at, p_status, th.attempt_token_hash(p_id),
    case when v_live then 'cGxhY2Vob2xkZXI=' end, case when v_live then 'bm9uY2Vub25jZW5v' end,
    case when v_live then 'dGFndGFndGFndGFn' end, case when v_live then 'HARNESS_KEY' end,
    case when v_live then 1::smallint end, case when p_status = 'completed' then gen_random_uuid() end);
  return p_id;
end;
$$;

grant execute on all functions in schema th to postgres, anon, authenticated, service_role;

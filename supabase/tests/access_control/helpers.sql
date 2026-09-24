-- Access-control harness helpers, loaded once (as supabase_admin) after phase_a/helpers.sql.
-- Every "link token" / "access token" here is a placeholder string — never a real Plaid token.

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

-- A row written directly in any lifecycle state, for states the functions never produce on their
-- own schedule (old, expired, or stale rows). Fills exactly the columns each state requires.
create function th.insert_attempt(p_user uuid, p_session text, p_created_at timestamptz, p_expires_at timestamptz,
                                  p_status text default 'pending', p_id uuid default gen_random_uuid(),
                                  p_step_at timestamptz default now()) returns uuid
language plpgsql as $$
declare
  v_token boolean := p_status in ('pending', 'claimed');
  v_claimed boolean := p_status in ('claimed', 'exchanging', 'completed', 'failed', 'exchange_unknown');
  v_exchanged boolean := p_status in ('exchanging', 'completed', 'exchange_unknown');
begin
  insert into public.plaid_link_attempts (id, user_id, session_id, created_at, expires_at, status, link_token_hash,
    link_token_ciphertext, link_token_nonce, link_token_auth_tag, link_token_key_id, link_token_enc_version,
    claim_token, claimed_at, exchange_started_at, failure_reason, plaid_item_id)
  values (p_id, p_user, p_session, p_created_at, p_expires_at, p_status, th.attempt_token_hash(p_id),
    case when v_token then 'cGxhY2Vob2xkZXI=' end, case when v_token then 'bm9uY2Vub25jZW5v' end,
    case when v_token then 'dGFndGFndGFndGFn' end, case when v_token then 'HARNESS_KEY' end,
    case when v_token then 1::smallint end,
    case when v_claimed then gen_random_uuid() end, case when v_claimed then p_step_at end,
    case when v_exchanged then p_step_at end,
    case p_status when 'failed' then 'exited' when 'exchange_unknown' then 'stale_exchange' end,
    case when p_status = 'completed' then gen_random_uuid() end);
  return p_id;
end;
$$;

-- The claim token currently held on an attempt (what the backend keeps in memory after claiming).
create function th.claim_token_of(p_id uuid) returns uuid
language sql stable as $$ select claim_token from public.plaid_link_attempts where id = p_id $$;

grant execute on all functions in schema th to postgres, anon, authenticated, service_role;

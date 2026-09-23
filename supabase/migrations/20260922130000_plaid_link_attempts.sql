-- Wave 1 remediation (2/2): one-time, short-lived, server-side Plaid Link attempts.
--
-- POST /api/plaid/link-token now records an attempt bound to the authenticated user AND that
-- user's Supabase login session (the verified JWT's `session_id` claim), and returns its id with
-- the link token. POST /api/plaid/exchange-public-token must present that id, and consumes it
-- atomically BEFORE the public token is exchanged with Plaid. So a public token can only be turned
-- into a stored Plaid item by the same user, in the same login session, that started the Link flow,
-- once, within the TTL — never by a different user who signed in on that browser mid-flow, never
-- by a replay, never after expiry. The user id always comes from the verified bearer token on the
-- server, never from the request body.
--
-- Both functions follow the Phase A conventions: SECURITY INVOKER, search_path pinned empty,
-- executable by service_role only. The table is reachable by service_role only, with exactly the
-- privileges those functions need (SELECT for the WHERE/RETURNING, INSERT, DELETE) — Supabase's
-- default privileges would otherwise grant every privilege to anon/authenticated/service_role.
--
-- Deploy order: apply this migration BEFORE deploying the backend that calls these functions
-- (until then that backend refuses to create link tokens: linking fails closed, nothing else is
-- affected).
--
-- Rollback (only after reverting the backend to a build that does not call these functions):
--   drop function public.consume_plaid_link_attempt(uuid, uuid, text);
--   drop function public.create_plaid_link_attempt(uuid, text);
--   drop table public.plaid_link_attempts;

create table public.plaid_link_attempts (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  session_id text        not null check (btrim(session_id) <> ''),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index plaid_link_attempts_user_id_idx on public.plaid_link_attempts (user_id);

alter table public.plaid_link_attempts enable row level security;

revoke all on table public.plaid_link_attempts from public, anon, authenticated, service_role;
grant select, insert, delete on table public.plaid_link_attempts to service_role;

-- Returns the new attempt's id. Also removes the user's expired attempts and keeps at most the five
-- newest live ones, so the table stays bounded however often link tokens are requested.
create function public.create_plaid_link_attempt(p_user_id uuid, p_session_id text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_session_id is null or btrim(p_session_id) = '' then
    raise exception 'create_plaid_link_attempt: a user and a login session are required'
      using errcode = '22023';
  end if;

  delete from public.plaid_link_attempts a
   where a.user_id = p_user_id and a.expires_at <= now();

  insert into public.plaid_link_attempts (user_id, session_id, expires_at)
  values (p_user_id, p_session_id, now() + interval '30 minutes')
  returning id into v_id;

  delete from public.plaid_link_attempts a
   where a.user_id = p_user_id
     and a.id in (select b.id from public.plaid_link_attempts b
                   where b.user_id = p_user_id
                   order by b.created_at desc, b.id desc
                   offset 5);

  return v_id;
end;
$$;

-- Consumes the attempt exactly once: one DELETE ... RETURNING, so of two concurrent consumers of the
-- same attempt, the second blocks on the row lock and then finds nothing. Returns
--   'consumed'  the attempt existed, belonged to this user and session, and had not expired
--   'expired'   it belonged to this user and session but its TTL had passed (it is deleted anyway)
--   'invalid'   no such attempt for this user and session: unknown, already used, or someone else's.
--               Another user's attempt is left untouched (it is not theirs to spend).
create function public.consume_plaid_link_attempt(p_attempt_id uuid, p_user_id uuid, p_session_id text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
begin
  delete from public.plaid_link_attempts a
   where a.id = p_attempt_id and a.user_id = p_user_id and a.session_id = p_session_id
  returning a.expires_at into v_expires_at;

  if not found then
    return 'invalid';
  end if;
  if v_expires_at <= now() then
    return 'expired';
  end if;
  return 'consumed';
end;
$$;

revoke all on function public.create_plaid_link_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.consume_plaid_link_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_plaid_link_attempt(uuid, text) to service_role;
grant execute on function public.consume_plaid_link_attempt(uuid, uuid, text) to service_role;

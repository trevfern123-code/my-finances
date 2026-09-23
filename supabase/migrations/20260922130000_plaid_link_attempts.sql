-- Wave 1 remediation (2/2): one-time, short-lived, server-side Plaid Link attempts.
--
-- POST /api/plaid/link-token records an attempt bound to the authenticated user AND that user's
-- Supabase login session (the verified JWT's `session_id` claim), and returns its id with the link
-- token. POST /api/plaid/exchange-public-token must present that id, and consumes it atomically
-- BEFORE the public token is exchanged with Plaid. The user id always comes from the verified
-- bearer token on the server, never from the request body.
--
-- What an attempt proves: the caller is the same user, in the same login session, that asked for a
-- link token within the last 30 minutes, and has not already spent that request. What it does NOT
-- prove: that the submitted public token came from THAT link token's Link flow. Plaid's embedded
-- Link hands the public token to the browser, and Plaid exposes no default server-side way to tie a
-- public token back to its link token (see README "Wave 1 follow-ups"). A public token captured
-- from another user can therefore still be presented alongside the presenter's own valid attempt.
--
-- Concurrency: create_plaid_link_attempt serializes per user with a transaction-scoped advisory
-- lock, so concurrent requests for one user cannot exceed five live (unexpired) attempts. Expired
-- attempts are swept globally, in bounded batches, by every create and consume — not only when the
-- same user creates again.
--
-- Every function follows the Phase A conventions: SECURITY INVOKER, search_path pinned empty,
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
--   drop function public.purge_expired_plaid_link_attempts(integer);
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
create index plaid_link_attempts_expires_at_idx on public.plaid_link_attempts (expires_at);

alter table public.plaid_link_attempts enable row level security;

revoke all on table public.plaid_link_attempts from public, anon, authenticated, service_role;
grant select, insert, delete on table public.plaid_link_attempts to service_role;

-- Deletes up to p_limit expired attempts belonging to ANY user, oldest first, and returns how many.
-- At most one sweep runs at a time: a sweeper that cannot take the sweep lock immediately returns 0
-- rather than waiting, so two sweeps never contend for (or deadlock on) the same rows. The lock is
-- transaction-scoped, released at commit. Only expired rows are touched, and the per-user cap below
-- only touches live ones, so a sweep in progress does not hold up another user's link creation.
create function public.purge_expired_plaid_link_attempts(p_limit integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'purge_expired_plaid_link_attempts: p_limit must be between 1 and 1000'
      using errcode = '22023';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('public.plaid_link_attempts:sweep', 0)) then
    return 0;
  end if;

  delete from public.plaid_link_attempts a
   where a.id in (select b.id from public.plaid_link_attempts b
                   where b.expires_at <= now()
                   order by b.expires_at, b.id
                   limit p_limit);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Returns the new attempt's id. Serialized per user: the advisory lock below is held until the
-- calling transaction commits, so a concurrent create for the same user waits here and then sees
-- this one's committed row. Under it, the user's oldest LIVE attempts are removed until four remain,
-- then the new one is inserted: never more than five live attempts. Expired ones are already
-- unusable (consume reports them 'expired') and are left to the sweep.
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

  perform pg_advisory_xact_lock(hashtextextended('public.plaid_link_attempts:user:' || p_user_id::text, 0));

  delete from public.plaid_link_attempts a
   where a.user_id = p_user_id
     and a.id in (select b.id from public.plaid_link_attempts b
                   where b.user_id = p_user_id and b.expires_at > now()
                   order by b.created_at desc, b.id desc
                   offset 4);

  insert into public.plaid_link_attempts (user_id, session_id, expires_at)
  values (p_user_id, p_session_id, now() + interval '30 minutes')
  returning id into v_id;

  perform public.purge_expired_plaid_link_attempts(100);

  return v_id;
end;
$$;

-- Consumes the attempt exactly once: one DELETE ... RETURNING, so of two concurrent consumers of the
-- same attempt, the second blocks on the row lock and then finds nothing. Returns
--   'consumed'  the attempt existed, belonged to this user and session, and had not expired
--   'expired'   it belonged to this user and session but its TTL had passed (it is deleted anyway)
--   'invalid'   no such attempt for this user and session: unknown, already used, or someone else's.
--               Another user's attempt is left untouched (it is not theirs to spend).
-- Also runs one bounded global sweep of expired attempts.
create function public.consume_plaid_link_attempt(p_attempt_id uuid, p_user_id uuid, p_session_id text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
  v_found boolean;
begin
  delete from public.plaid_link_attempts a
   where a.id = p_attempt_id and a.user_id = p_user_id and a.session_id = p_session_id
  returning a.expires_at into v_expires_at;
  v_found := found;

  perform public.purge_expired_plaid_link_attempts(100);

  if not v_found then
    return 'invalid';
  end if;
  if v_expires_at <= now() then
    return 'expired';
  end if;
  return 'consumed';
end;
$$;

revoke all on function public.purge_expired_plaid_link_attempts(integer) from public, anon, authenticated;
revoke all on function public.create_plaid_link_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.consume_plaid_link_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.purge_expired_plaid_link_attempts(integer) to service_role;
grant execute on function public.create_plaid_link_attempt(uuid, text) to service_role;
grant execute on function public.consume_plaid_link_attempt(uuid, uuid, text) to service_role;

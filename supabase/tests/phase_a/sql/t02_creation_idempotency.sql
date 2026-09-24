-- create_manual_loan_idempotent: replay, payload-conflict detection with an unambiguous fingerprint
-- (Round 10 H1), per-user scoping, and survival of the key after the loan is deleted (Round 10 B6).
set role service_role;

create function pg_temp.create(p_user text, p_key text, p_name text, p_notes text, p_match text) returns uuid
language sql as $$
  select public.create_manual_loan_idempotent(p_user::uuid, p_key, p_name, 'personal', 100, null, null, null, null, null, null, p_notes, p_match)
$$;

-- Replay: identical payload returns the same loan and creates nothing new.
select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'K1', 'L', null, null) as first \gset
select th.assert(pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'K1', 'L', null, null) = :'first'::uuid, 'identical retry replays');
select th.assert((select count(*) from public.manual_loans) = 1, 'no second loan');

-- Distinct key, identical fields: a separate loan.
select th.assert(pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'K2', 'L', null, null) <> :'first'::uuid, 'new key, new loan');
-- Same key, different user: scoped per user.
select th.assert(pg_temp.create('00000000-0000-0000-0000-0000000000bb', 'K1', 'L', null, null) <> :'first'::uuid, 'same key for another user is independent');

-- Payload conflicts, including every ambiguity the old \x01/\x02-delimited md5 fingerprint had.
select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'K1', 'Changed', null, null) $q$, '%different request payload%');
select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F1', 'L', E'a\x01b', 'c');
select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F1', 'L', 'a', E'b\x01c') $q$, '%different request payload%');
select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F2', 'L', E'x\x02y', null);
select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F2', 'L', null, E'x\x02y') $q$, '%different request payload%');
select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F3', 'L', '', null);
select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F3', 'L', null, null) $q$, '%different request payload%');
select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F4', 'Ünïcødé 名前', '日本語', 'emoji') as unicode \gset
select th.assert(pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F4', 'Ünïcødé 名前', '日本語', 'emoji') = :'unicode'::uuid, 'unicode payload replays');
select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'F4', 'Ünïcødé 名前', 'emoji', '日本語') $q$, '%different request payload%');

-- Deleting the loan keeps the key: a delayed retry must not resurrect it.
select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'K-DEL', 'Doomed', null, null) as doomed \gset
select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', :'doomed'::uuid, '[]');
select th.assert((select loan_id is null from public.manual_loan_creation_requests where idempotency_key = 'K-DEL'), 'key record survives with loan_id cleared');
select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', 'K-DEL', 'Doomed', null, null) $q$, '%has since been deleted%');
select th.assert(not exists (select 1 from public.manual_loans where name = 'Doomed'), 'no replacement loan created');

select th.expect_error($q$ select pg_temp.create('00000000-0000-0000-0000-0000000000aa', '  ', 'L', null, null) $q$, '%idempotency_key is required%');

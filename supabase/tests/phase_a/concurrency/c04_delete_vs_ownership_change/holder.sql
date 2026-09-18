-- Re-parents plaid item 1 (and therefore account a1 and G) to user bb, holding the row lock for 4s.
-- Deliberately a plain UPDATE that does NOT take the per-user advisory lock: the point is that the
-- deletion's own row locks on the ownership chain are what protect it.
begin;
update public.plaid_items set user_id = '00000000-0000-0000-0000-0000000000bb'
where id = '00000000-0000-0000-0000-000000000001';
select pg_sleep(4);
commit;

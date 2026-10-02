-- 50 rounds of: announce ready, wait until the holder holds L2, delete one card leg (row lock, then its
-- trigger bump waits on L2), commit. See seed.sql.
call public.th_c14_deleter();

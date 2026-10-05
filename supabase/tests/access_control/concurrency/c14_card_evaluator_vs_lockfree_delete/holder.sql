-- 50 rounds of: L1 + input write (L2), wait until the deleter is blocked on L2 while holding its row,
-- evaluate, commit. See seed.sql.
call public.th_c14_holder();

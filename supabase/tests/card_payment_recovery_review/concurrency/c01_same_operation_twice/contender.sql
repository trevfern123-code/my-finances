-- Arrives while the holder's transaction is open, with the versions the client saw before it.
set application_name = 'c01-contender';
set role service_role;
insert into public.th_c01_outcome
select 'contender', rrh.outcome(rrh.act(rrh.op(1), rrh.pair_kw(), rrh.aa(), s.input, s.review)) from public.th_c01_seen s;

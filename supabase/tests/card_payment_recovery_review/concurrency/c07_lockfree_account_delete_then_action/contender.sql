-- Arrives while the holder's transaction is open, with the versions the client saw before it.
set application_name = 'c07-contender';
set role service_role;
insert into public.th_c07_outcome
select 'contender', rrh.outcome(rrh.act(rrh.op(2), rrh.pair_kw(), rrh.aa(), s.input, s.review)) from public.th_c07_seen s;

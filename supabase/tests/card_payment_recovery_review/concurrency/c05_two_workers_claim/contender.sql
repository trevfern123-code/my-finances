set application_name = 'c05-contender';
set role service_role;
insert into public.th_c05_outcome select 'contender', jsonb_array_length(public.claim_card_payment_recovery_refresh(rrh.op(2), 10)->'claims')::text;

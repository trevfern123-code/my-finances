set application_name = 'c06-contender';
set role service_role;
insert into public.th_c06_outcome select 'contender', public.refresh_card_payment_recovery_owner(rrh.aa(), l.token)::text from public.th_c06_lease l;

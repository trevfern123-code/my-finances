-- PLAID_KEY_ROTATION_V2_TO_V3.md §4.3 step 1 — READ-ONLY. Counts only; never a token value.
select count(*)                                                          as v2_link_tokens,
       count(*) filter (where expires_at <= now() - interval '1 hour')   as purgeable,
       count(*) filter (where expires_at >  now() - interval '1 hour')   as not_yet_purgeable
  from public.plaid_link_attempts
 where link_token_key_id = 'RAILWAY_PROD_V2';

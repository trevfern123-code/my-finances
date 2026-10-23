-- PLAID_KEY_ROTATION_V2_TO_V3.md §7 — READ-ONLY integrity queries. Counts only; never a token value.
select count(*)                                                                    as total_items,
       count(*) filter (where access_token_key_id = 'RAILWAY_PROD_V2')             as v2_items,
       count(*) filter (where access_token_key_id = 'RENDER_PROD_V3')              as v3_items,
       count(*) filter (where access_token_key_id is not null
                          and access_token_key_id not in ('RAILWAY_PROD_V2', 'RENDER_PROD_V3'))
                                                                                   as unexpected_key_id_items,
       count(*) filter (where access_token is not null)                            as plaintext_copies,
       count(*) filter (where access_token_ciphertext is null)                     as not_encrypted_items,
       count(*) filter (where num_nonnulls(access_token_ciphertext, access_token_nonce, access_token_auth_tag,
                                           access_token_key_id, access_token_enc_version) between 1 and 4)
                                                                                   as partial_encrypted_items,
       count(*) filter (where access_token_enc_version is not null
                          and access_token_enc_version <> 1)                       as unexpected_version_items,
       count(distinct access_token_nonce)                                          as distinct_encrypted_nonces
  from public.plaid_items;

select link_token_key_id, count(*) as attempts, count(*) filter (where expires_at > now()) as unexpired
  from public.plaid_link_attempts
 where link_token_key_id is not null
 group by link_token_key_id;

select conname from pg_constraint
 where conrelid = 'public.plaid_items'::regclass
   and conname in ('plaid_items_token_present', 'plaid_items_encrypted_token_complete')
 order by conname;

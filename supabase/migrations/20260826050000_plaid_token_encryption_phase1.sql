-- Plaid Access-Token Encryption — Phase 1 (expand schema only).
-- See PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md for the full design.
--
-- Additive and nullable: no existing row's data is touched by this migration. `access_token`
-- stops being NOT NULL here (needed later for Phase 2b's encrypted-only writes), replaced by the
-- `plaid_items_token_present` check below, which enforces the same "never truly empty" guarantee
-- via either representation instead of only the plaintext one.
--
-- Rollback: `alter table public.plaid_items drop column access_token_ciphertext, drop column
-- access_token_nonce, drop column access_token_auth_tag, drop column access_token_key_id, drop
-- column access_token_enc_version;` then `alter table public.plaid_items alter column
-- access_token set not null;` then drop the two constraints below by name. Safe at this phase
-- because nothing has written to the new columns yet.

alter table public.plaid_items
  alter column access_token drop not null,
  add column access_token_ciphertext text,
  add column access_token_nonce      text,
  add column access_token_auth_tag   text,
  add column access_token_key_id     text,
  add column access_token_enc_version smallint;

-- Defense in depth: a row should never carry a partial encrypted representation.
alter table public.plaid_items
  add constraint plaid_items_encrypted_token_complete
    check (
      (access_token_ciphertext is null
       and access_token_nonce is null
       and access_token_auth_tag is null
       and access_token_key_id is null
       and access_token_enc_version is null)
      or
      (access_token_ciphertext is not null
       and access_token_nonce is not null
       and access_token_auth_tag is not null
       and access_token_key_id is not null
       and access_token_enc_version is not null)
    );

-- Defense in depth: a row must always have at least one usable representation — this is what
-- actually replaces the NOT NULL that access_token gave up above.
alter table public.plaid_items
  add constraint plaid_items_token_present
    check (access_token is not null or access_token_ciphertext is not null);

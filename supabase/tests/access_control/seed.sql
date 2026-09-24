-- Run as supabase_admin before every test. Two users, each owning one Plaid item. Every token value
-- is an obvious placeholder — no real credential is ever used by this harness.
truncate auth.users cascade;
truncate public.plaid_items cascade;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000bb', 'other@example.test');

insert into public.plaid_items (id, user_id, plaid_item_id, access_token,
                                access_token_ciphertext, access_token_nonce, access_token_auth_tag,
                                access_token_key_id, access_token_enc_version) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a',
   'placeholder-plaintext-token-a', 'cGxhY2Vob2xkZXI=', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000bb', 'harness-item-b',
   'placeholder-plaintext-token-b', null, null, null, null, null);

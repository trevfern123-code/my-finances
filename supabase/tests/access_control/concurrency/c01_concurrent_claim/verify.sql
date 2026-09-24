select th.assert((select status = 'claimed' and claimed_at is not null and claim_token is not null from public.plaid_link_attempts
                  where id = '00000000-0000-0000-0000-00000000c001'), 'claimed exactly once, by the holder');

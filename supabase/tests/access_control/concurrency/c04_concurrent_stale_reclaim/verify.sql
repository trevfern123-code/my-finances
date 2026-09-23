select th.assert((select status = 'claimed' and claimed_at > now() - interval '1 minute' from public.plaid_link_attempts
                  where id = '00000000-0000-0000-0000-00000000c004'), 're-claimed exactly once, freshly');

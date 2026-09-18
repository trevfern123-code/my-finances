-- The `th` ("test harness") schema of assertion helpers every test file uses, in both harness
-- modes. A failed assertion raises, and the runner executes every file with ON_ERROR_STOP, so any
-- failure fails the test.
create schema th;

create function th.assert(p_condition boolean, p_message text) returns void
language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
end;
$$;

-- Runs p_sql and requires it to fail with an error whose message matches p_pattern (LIKE). The
-- statement runs inside this function's own exception block, i.e. a subtransaction, so whatever it
-- did before failing is rolled back — callers then assert the database is unchanged.
create function th.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_pattern then
      return;
    end if;
    raise exception 'ASSERTION FAILED: expected an error like % but got: %', p_pattern, sqlerrm;
  end;
  raise exception 'ASSERTION FAILED: expected an error like % but the statement succeeded: %', p_pattern, p_sql;
end;
$$;

grant usage on schema th to postgres, anon, authenticated, service_role;
grant execute on all functions in schema th to postgres, anon, authenticated, service_role;

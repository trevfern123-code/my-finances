-- A brand-new backend, for comparison with the long-lived sessions in growth.sql.
select 'fresh session: GUCMemoryContext ' || coalesce(sum(total_bytes) filter (where name = 'GUCMemoryContext'), 0)
       || ' bytes; all memory contexts ' || sum(total_bytes) || ' bytes'
from pg_backend_memory_contexts;

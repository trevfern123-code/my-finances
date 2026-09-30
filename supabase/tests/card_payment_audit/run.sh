#!/usr/bin/env bash
# Validates the DRAFT read-only audit supabase/preflight/phase_b_card_payment_matching_audit.sql against
# synthetic rows (seed.sql) in a THROWAWAY container of Supabase's PostgreSQL 17 image. Nothing here
# touches any real database. The seed dates are relative to current_date, so expected.out is stable.
#
#   supabase/tests/card_payment_audit/run.sh            compare with expected.out
#   UPDATE=1 supabase/tests/card_payment_audit/run.sh   rewrite expected.out (review the diff!)
#
# Requires: docker, bash.  PG_IMAGE=<image> overrides the image.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
CONTAINER="card-payment-audit-$$"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1' EXIT

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || exit 1
until docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do sleep 1; done
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3

for f in "$ROOT"/supabase/migrations/*.sql; do
  docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >/dev/null 2>&1 \
    || { echo "FAILED to apply migration $(basename "$f")"; exit 1; }
done
docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$HERE/seed.sql" >/dev/null 2>&1 \
  || { echo "FAILED to seed"; exit 1; }

# The audit runs in a read-only session: any write in it would fail the run.
ACTUAL="$(docker exec -i "$CONTAINER" psql -X -q -A -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "set default_transaction_read_only = on" -f - < "$ROOT/supabase/preflight/phase_b_card_payment_matching_audit.sql")" \
  || { echo "FAILED: the audit did not run"; exit 1; }

if [ "${UPDATE:-0}" = 1 ]; then printf '%s\n' "$ACTUAL" > "$HERE/expected.out"; echo "expected.out rewritten"; exit 0; fi
if diff --strip-trailing-cr <(printf '%s\n' "$ACTUAL") "$HERE/expected.out"; then echo "PASS  card-payment audit buckets"; else echo "FAIL  (diff above)"; exit 1; fi

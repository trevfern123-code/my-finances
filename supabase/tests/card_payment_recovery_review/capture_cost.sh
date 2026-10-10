#!/usr/bin/env bash
# Bounded capture-cost check of the review-obligation capture (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §12).
#
# What it shows, on synthetic histories in one throwaway database:
#   * GROWTH      how many obligations, known edges and sources a removal writes — for an ordinary history (every
#                 payment its own amount) and for a deliberately dense one (one amount, one day: every payment ties
#                 between all cards), and for the same dense history with NO kept card (every candidate of every
#                 payment is removed: the removal writes no hold and no record, and the capture must still keep
#                 every payment and every removed candidate). The counts are asserted against hand-computed values:
#                 the capture is COMPLETE.
#   * EXTRA WORK  the wall time of the removal call WITH the capture and with the capture replaced by a no-op, on
#                 identical data: the difference is what the capture adds before the delete.
#   * STRICT      a removal whose statement timeout fires during the dense case removes nothing and writes nothing;
#                 run again without the timeout, it captures everything.
# It truncates nothing to meet a budget and has no pass/fail threshold on time. THE TIMES ARE THIS MACHINE'S: they
# say nothing about a hosted database's capacity or statement limits (a release gate, not validated here).
#
#   supabase/tests/card_payment_recovery_review/capture_cost.sh
#   PG_IMAGE, LOGDIR, STARTUP_TIMEOUT, PSQL_TIMEOUT: as run.sh.   SIZES="40 12 20": n of the ordinary case, then the two dense cases.
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAILED: node is required"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres@sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b}"
CONTAINER="recovery-review-cost-$$"
LOGS="${LOGDIR:-$(mktemp -d)}"
WORK="$(mktemp -d)"
mkdir -p "$LOGS"
MIGRATION="$ROOT/supabase/migrations/20261009120000_card_payment_recovery_review.sql"
SEED="$ROOT/supabase/tests/access_control/seed.sql"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-900}"
read -r ORDINARY DENSE_SMALL DENSE_LARGE <<<"${SIZES:-40 12 20}"
psql_as() { local role="$1"; shift; timeout "$PSQL_TIMEOUT" docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$role" -d postgres "$@"; }

# The capture function as the migration defines it, and a no-op with the same signature.
node - "$MIGRATION" "$WORK" <<'NODE' || { echo "FAILED: the capture function was not found in the migration"; exit 1; }
const fs = require('node:fs');
const [migration, work] = process.argv.slice(2);
const text = fs.readFileSync(migration, 'utf8').replace(/\r\n/g, '\n');
const start = text.search(/^create or replace function public\.card_payment_review_capture\(/m);
const end = text.indexOf('\n$$;', start);
if (start < 0 || end < 0) process.exit(1);
fs.writeFileSync(`${work}/capture.sql`, text.slice(start, end + 4) + '\n');
fs.writeFileSync(`${work}/capture_noop.sql`,
  "create or replace function public.card_payment_review_capture(p_user_id uuid, p_removal_id uuid) returns bigint\n" +
  "language plpgsql security invoker set search_path = '' as $$ begin return 0; end; $$;\n");
NODE

echo "image: $IMAGE   container: $CONTAINER"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=harness "$IMAGE" >/dev/null || { echo "FAILED: could not start the database container"; exit 1; }
deadline=$((SECONDS + STARTUP_TIMEOUT))
until timeout 10 docker exec "$CONTAINER" psql -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAILED: the database did not start"; exit 1; }
  sleep 1
done
for _ in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
sleep 3
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql_as postgres -1 < "$f" >>"$LOGS/history.log" 2>&1 || { echo "FAILED to apply $(basename "$f")"; tail -5 "$LOGS/history.log"; exit 1; }
done
{ psql_as supabase_admin < "$ROOT/supabase/tests/phase_a/helpers.sql" && psql_as supabase_admin < "$ROOT/supabase/tests/access_control/helpers.sql" \
  && psql_as supabase_admin < "$HERE/helpers.sql"; } >"$LOGS/helpers.log" 2>&1 || { echo "FAILED to load the helpers"; cat "$LOGS/helpers.log"; exit 1; }
echo "history applied"

FAILED=0
RESULTS="$LOGS/capture_cost.txt"; : >"$RESULTS"
# measure <label> <shape> <n> <timeout_ms> <capture: real|noop>
measure() {
  local label="$1" shape="$2" n="$3" timeout_ms="$4" capture="$5" log="$LOGS/$1.log"
  psql_as supabase_admin < "$SEED" >"$log" 2>&1 || { echo "FAIL  $label (seed)"; FAILED=$((FAILED + 1)); return; }
  if [ "$capture" = noop ]; then psql_as postgres < "$WORK/capture_noop.sql" >>"$log" 2>&1; else psql_as postgres < "$WORK/capture.sql" >>"$log" 2>&1; fi
  if { echo "set cost.timeout_ms = '$timeout_ms';"; cat "$HERE/capture_cost.sql"; } | psql_as postgres -v shape="$shape" -v n="$n" >>"$log" 2>&1; then
    local line
    line="$(grep '^COST|' "$log" | tail -1)"
    echo "PASS  $label  ${line#COST|}"
    echo "$label|capture=$capture|${line#COST|}" >>"$RESULTS"
  else
    echo "FAIL  $label"; grep -E 'ERROR|ASSERTION' "$log" | head -4 | sed 's/^/      | /'
    FAILED=$((FAILED + 1))
  fi
  psql_as postgres < "$WORK/capture.sql" >>"$log" 2>&1 || { echo "FAILED: the capture function could not be restored"; exit 1; }
}

echo
echo "The no-op runs measure the removal WITHOUT the capture. With a no-op the removal writes no obligation, so its"
echo "completeness assertion is expected to be skipped there: capture_cost.sql asserts it only for the real capture."
for rep in 1 2 3; do
  measure "ordinary-n$ORDINARY-real-$rep" ordinary "$ORDINARY" 0 real
done
for rep in 1 2 3; do
  measure "dense-n$DENSE_SMALL-real-$rep" dense "$DENSE_SMALL" 0 real
done
measure "dense-n$DENSE_LARGE-real-1" dense "$DENSE_LARGE" 0 real
# ALL COUNTERPARTS REMOVED: no decision is written; the obligations and the graph-observed sources are.
for rep in 1 2 3; do
  measure "allremoved-n$DENSE_LARGE-real-$rep" allremoved "$DENSE_LARGE" 0 real
done
measure "allremoved-n$DENSE_LARGE-timeout-5ms" allremoved "$DENSE_LARGE" 5 real
# STRICT: the same dense case under a statement timeout that cannot be met: once at 5 ms (cancelled at the start) and
# once at 60% of the time just measured (cancelled well inside the removal, after it has begun to write).
measure "dense-n$DENSE_LARGE-timeout-5ms" dense "$DENSE_LARGE" 5 real
MID_MS="$(grep "^dense-n$DENSE_LARGE-real-1|" "$RESULTS" | sed 's/.*removal_ms=//; s/[.|].*//')"
case "$MID_MS" in ''|*[!0-9]*) echo "FAILED: the dense case was not measured, so the mid-run timeout cannot be chosen"; exit 1 ;; esac
MID_MS=$((MID_MS * 60 / 100))
measure "dense-n$DENSE_LARGE-timeout-midrun" dense "$DENSE_LARGE" "$MID_MS" real

echo
echo "EXTRA WORK (the capture replaced by a no-op; same data):"
NOOP_FAILED=0
for spec in "ordinary $ORDINARY" "dense $DENSE_SMALL" "dense $DENSE_LARGE" "allremoved $DENSE_LARGE"; do
  set -- $spec
  for rep in 1 2 3; do
    label="$1-n$2-noop-$rep"; log="$LOGS/$label.log"
    psql_as supabase_admin < "$SEED" >"$log" 2>&1
    psql_as postgres < "$WORK/capture_noop.sql" >>"$log" 2>&1
    # With the no-op the hand count of obligations cannot hold; only the timing line is taken.
    { echo "set cost.timeout_ms = '0';"; sed '/^select th.assert((select outcome from pg_temp.run) = .removed./,/^where (select outcome from pg_temp.run) = .removed.;/d; /^select th.assert((select bool_and(n = /,/^where (select outcome from pg_temp.run) = .removed.;/d' "$HERE/capture_cost.sql"; } \
      | psql_as postgres -v shape="$1" -v n="$2" >>"$log" 2>&1 || { echo "FAIL  $label"; grep -E 'ERROR' "$log" | head -3; NOOP_FAILED=1; }
    line="$(grep '^COST|' "$log" | tail -1)"
    echo "      $label  ${line#COST|}"
    echo "$label|capture=noop|${line#COST|}" >>"$RESULTS"
    psql_as postgres < "$WORK/capture.sql" >>"$log" 2>&1 || { echo "FAILED: the capture function could not be restored"; exit 1; }
  done
done

echo
node - "$RESULTS" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((line) => {
  const parts = line.split('|');
  const get = (key) => (parts.find((p) => p.startsWith(`${key}=`)) ?? '').split('=')[1];
  return { label: parts[0], capture: get('capture'), timeout: get('timeout_ms'), shape: parts[2], n: Number(get('n')), outcome: parts[5], ms: Number(get('removal_ms')), obligations: get('obligations'), edges: get('edges'), sources: get('sources') };
});
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log('shape     n   obligations  edges  sources   removal ms with capture (median)   without (median)   extra');
for (const key of [...new Set(rows.map((r) => `${r.shape}|${r.n}`))]) {
  const [shape, n] = key.split('|');
  const real = rows.filter((r) => r.shape === shape && String(r.n) === n && r.capture === 'real' && r.outcome === 'removed');
  const noop = rows.filter((r) => r.shape === shape && String(r.n) === n && r.capture === 'noop' && r.outcome === 'removed');
  if (real.length === 0) continue;
  const a = median(real.map((r) => r.ms));
  const b = noop.length ? median(noop.map((r) => r.ms)) : NaN;
  console.log(`${shape.padEnd(9)} ${n.padStart(3)} ${real[0].obligations.padStart(11)} ${real[0].edges.padStart(6)} ${real[0].sources.padStart(8)} ${String(a).padStart(22)} ${String(b).padStart(27)} ${Number.isNaN(b) ? '' : (a - b).toFixed(1).padStart(10)}`);
}
const cancelled = rows.filter((r) => r.outcome === 'cancelled');
for (const r of cancelled) console.log(`cancelled by its ${r.timeout} ms statement timeout after ${r.ms} ms: ${r.shape} n=${r.n} — nothing removed, nothing written (asserted)`);
NODE
echo
echo "These are this machine's timings on synthetic data. They do not validate a hosted database's capacity or limits."
echo "transcripts: $LOGS   (capture_cost.txt)"
[ "$FAILED" -eq 0 ] && [ "$NOOP_FAILED" -eq 0 ] || exit 1
[ "$(grep -c '|cancelled|' "$RESULTS")" -eq 3 ] || { echo "FAILED: a timeout case was not cancelled — the strict-rollback check did not run (raise the dense size)"; exit 1; }

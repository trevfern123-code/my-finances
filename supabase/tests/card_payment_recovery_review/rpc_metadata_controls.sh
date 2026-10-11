#!/usr/bin/env bash
# Negative controls of the RPC-sequence comparison (supabase/tests/card_payment_evaluator/rpc_sequences.sql and
# compare_rpc.cjs) since it carries the recovery inputs and compares the review metadata
# (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §11; correction C4).
#
# One throwaway database with the migration history. rpc_sequences.sql is run ONCE, unchanged; its output is the
# baseline, which compare_rpc.cjs must accept. Then the OUTPUT is altered, one way at a time, and the unchanged
# compare_rpc.cjs must reject it ON THE NAMED ASSERTION:
#   k1  the recovery inputs are omitted (no reviewObligations on any I / CI line): the reference evaluator no
#       longer withholds what SQL withholds — the legs differ;
#   k2  the review metadata is corrupted (every review of user aa loses its obligations) while every leg is as
#       it was: ONLY the review-metadata comparison can notice — and the leg comparison must NOT fail;
#   k3  the review metadata is absent (no `reviews` key in what the reader returned);
#   k4  a hand-written review expectation is contradicted by the evaluators (Q20: who is withheld from whom);
#   k5  a hand-written figure is contradicted (Q10: the range of a withheld payment).
# A control is DETECTED when the comparison exits non-zero AND prints the named failure; FAILED DIFFERENTLY when
# it exits non-zero without it; SURVIVED when it exits zero. Exit status 0 only when the baseline passes and
# every control is DETECTED.
#
#   supabase/tests/card_payment_recovery_review/rpc_metadata_controls.sh
#   PG_IMAGE, LOGDIR, STARTUP_TIMEOUT, PSQL_TIMEOUT: as run.sh.
set -uo pipefail
command -v timeout >/dev/null 2>&1 || { echo "FAILED: GNU timeout (coreutils) is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAILED: node is required"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
EVAL="$ROOT/supabase/tests/card_payment_evaluator"
IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres@sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b}"
CONTAINER="recovery-review-rpc-controls-$$"
LOGS="${LOGDIR:-$(mktemp -d)}"
WORK="$(mktemp -d)"
mkdir -p "$LOGS"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
PSQL_TIMEOUT="${PSQL_TIMEOUT:-900}"

(cd "$ROOT/backend" && npx tsc --outDir "$WORK/compiled" --rootDir src --module commonjs --target es2022 \
   --strict --skipLibCheck src/services/cardPaymentMatching.ts) >"$LOGS/compile.log" 2>&1 || { echo "FAILED to compile the reference evaluator"; cat "$LOGS/compile.log"; exit 1; }

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
  timeout "$PSQL_TIMEOUT" docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >>"$LOGS/history.log" 2>&1 \
    || { echo "FAILED to apply $(basename "$f")"; tail -5 "$LOGS/history.log"; exit 1; }
done
echo "migration history applied"
timeout "$PSQL_TIMEOUT" docker exec -i "$CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < "$EVAL/rpc_sequences.sql" >"$WORK/actual_rpc.txt" 2>"$LOGS/rpc_sequences.err" \
  || { echo "FAILED while running the RPC sequences"; tail -10 "$LOGS/rpc_sequences.err"; exit 1; }
cp "$WORK/actual_rpc.txt" "$LOGS/actual_rpc.txt"

# The altered outputs. Every alteration must change something, or the control would prove nothing.
node - "$WORK" <<'NODE' || { echo "FAILED: an alteration changed nothing (the control would prove nothing)"; exit 1; }
const fs = require('node:fs');
const work = process.argv[2];
const AA = '00000000-0000-4000-8000-0000000000aa';
const lines = fs.readFileSync(`${work}/actual_rpc.txt`, 'utf8').split(/\r?\n/);
// tag|scenario|…|json  →  the json is everything after the tag's fixed fields.
const fields = { I: 3, R: 3, E: 2, CI: 4, CR: 4 };
function alter(name, tags, change) {
  let changed = 0;
  const out = lines.map((line) => {
    const tag = line.split('|', 1)[0];
    if (!tags.includes(tag)) return line;
    const parts = line.split('|');
    const head = parts.slice(0, fields[tag]);
    const json = JSON.parse(parts.slice(fields[tag]).join('|'));
    const before = JSON.stringify(json);
    const after = change(json, head) ?? json;
    if (JSON.stringify(after) !== before) changed += 1;
    return [...head, JSON.stringify(after)].join('|');
  });
  if (changed === 0) throw new Error(`${name}: nothing changed`);
  fs.writeFileSync(`${work}/${name}.txt`, out.join('\n'));
  console.log(`${name}: ${changed} lines altered`);
}
alter('k1', ['I', 'CI'], (j) => { if ((j.reviewObligations ?? []).length > 0) j.reviewObligations = []; return j; });
alter('k2', ['R', 'CR'], (j, head) => {
  if (head[head.length - 1] === AA && Array.isArray(j.reviews)) j.reviews = j.reviews.map((r) => ({ ...r, obligationIds: [] }));
  return j;
});
alter('k3', ['R', 'CR'], (j) => { delete j.reviews; return j; });
alter('k4', ['E'], (j, head) => {
  if (head[1] === 'Q20' && j.reviews) j.reviews = { ...j.reviews, 'q20-k': 'withheld=-,obligations=1,gap=f' };
  return j;
});
alter('k5', ['E'], (j, head) => {
  if (head[1] === 'Q10' && j.figures) j.figures = { ...j.figures, 'q10-a': '0[0..0]>q10-r2-a' };
  return j;
});
NODE

FAILED=0
compare() { node "$EVAL/compare_rpc.cjs" "$WORK/compiled" "$1"; }

echo
echo "1. BASELINE (the unaltered output)"
if compare "$WORK/actual_rpc.txt" >"$LOGS/baseline.log" 2>&1; then
  echo "PASS  baseline  $(grep '^RPC sequences:' "$LOGS/baseline.log")"
else
  echo "FAIL  baseline: the unaltered output is rejected — the controls prove nothing"; grep '^FAIL' "$LOGS/baseline.log" | head -5 | sed 's/^/      | /'
  exit 1
fi

echo
echo "2. CONTROLS (the unchanged comparison on an altered output)"
# control <id> <description> <expected (extended regex on a FAIL line)> [<must-not-appear regex>]
control() {
  local id="$1" what="$2" expected="$3" forbidden="${4:-}" log="$LOGS/$1.log" rc
  compare "$WORK/$id.txt" >"$log" 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SURVIVED            $id — $what"; FAILED=$((FAILED + 1)); return
  fi
  if ! grep -E '^FAIL' "$log" | grep -Eq "$expected"; then
    echo "FAILED DIFFERENTLY  $id — $what"; grep '^FAIL' "$log" | head -3 | cut -c1-220 | sed 's/^/                    | /'; FAILED=$((FAILED + 1)); return
  fi
  if [ -n "$forbidden" ] && grep -E '^FAIL' "$log" | grep -Eq "$forbidden"; then
    echo "FAILED DIFFERENTLY  $id — $what (it also failed on: $forbidden)"; FAILED=$((FAILED + 1)); return
  fi
  echo "DETECTED            $id — $what"
  echo "                    by: $(grep -E '^FAIL' "$log" | grep -E "$expected" | head -1 | cut -c1-200)   ($(grep -c '^FAIL' "$log") failures in all)"
}
control k1 "the recovery inputs are omitted" "Q10 user .*SQL states differ from the reference evaluator"
control k2 "the review metadata is corrupted while every leg is unchanged" "review metadata: SQL .reviews. differ from the reference evaluator" "SQL states differ from the reference evaluator on the RPC-written decisions"
control k3 "the review metadata is absent" "review metadata: the reader returned no .reviews."
control k4 "a hand-written review expectation is contradicted (Q20)" "Q20: review metadata: the legs under review are"
control k5 "a hand-written figure is contradicted (Q10)" "Q10: figures: leg q10-a is null\[-10000\.\.0\]>- under the reference evaluator"

echo
echo "controls: 5 run — $((5 - FAILED)) detected   (transcripts: $LOGS)"
[ "$FAILED" -eq 0 ] || exit 1

# P2-C1 — card-payment bump coalescing with evaluator hardening: implementation handoff

**Status:** reviewed implementation candidate, committed locally only.
- Not pushed; no PR; nothing applied to any hosted database; no flag changed; no deployment.
- `CARD_PAYMENT_SYNC_EVALUATION_ENABLED` is untouched.
- The performance gate is **not** declared closed (§9).
- Lifecycle findings F1–F9 stay queued, and this does not approve D1–D13.

## 1. Baseline and branches

| | Value |
|---|---|
| Runtime baseline (PR #11) | `d55a9eb7a6020e6920d8feb5e99881f6098663eb` |
| P0 checkpoint (`investigate/p0-trigger-cost`) | `f07c579ae9f73709f1e4c9e78de2fd510cbb15c8` |
| P1 prototype head (`experiment/p1-c1-bump-coalescing`) | `7d6d98ae6fd3dab3ae07748ec045c11875c5328e` |
| This branch | `feature/phase-b-c1-bump-coalescing`, worktree `C:\Users\Trevor\dev\my-finances-p2-c1`, created from `d55a9eb` |

Checks before starting:
- `d55a9eb` is an ancestor of `f07c579`, which is an ancestor of `7d6d98a`.
- `d55a9eb..7d6d98a` touches no migration, backend or frontend file.
- Every existing worktree was clean.

Only the accepted implementation and the durable tests were ported. The P0/P1 diagnostic history is not merged. The experiment, the diagnostics, the lifecycle docs and every PR branch are untouched.

## 2. Decisions applied

1. **a09:** the multi-row exact-count assertion is replaced by a contract-based block (§5). Every other a09 assertion is unchanged.
2. **Evaluator reset:** implemented, with regression tests (a14 §14, §15, a15) and mutation evidence (§7).
3. **Tracking state:** the transaction-local, xid-bound per-user setting from C1, with no `bumped_xid` column. Setting-name growth is quantified in §8. It is not material at this scale, so I did not stop for a decision.
4. **C2:** not implemented. The residual overhead is reported in §9 for a separate acceptance decision.

## 3. The migration — `supabase/migrations/20261002120000_card_payment_bump_coalescing.sql`

It is one forward migration, ordered after `20261001120000`, and it replaces two function definitions. It changes no table, column, trigger, grant, row or version number, and no previously committed migration file was edited.

**Guard:** it refuses unless both current bodies have the exact `20260930120000` checksums (md5 of the LF-normalised `prosrc`):
- `card_payment_bump` `9b67a299…`
- `evaluate_card_payments` `c4312829…`

No later migration redefines either function.

**Postconditions:**
- the new checksums: bump `3fa11a0e…`, evaluator `f620515f…`;
- plpgsql, SECURITY INVOKER, volatile, `search_path=""`;
- execute for service_role only, with no execute for `public`, `anon` or `authenticated`;
- unchanged return types and arguments;
- all 10 card-payment triggers present and enabled.

### Final `card_payment_bump`
```sql
create or replace function public.card_payment_bump(p_user_id uuid) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_marker text;
  v_xact text;
  v_input bigint;
  v_evaluated bigint;
begin
  if p_user_id is null then
    return;
  end if;
  -- Coalescing: this transaction already made the user stale with a bump that still stands (so it still
  -- holds the row lock), and nothing has published since. The row cannot change before this transaction
  -- ends, so another increment would add nothing.
  v_marker := 'card_payment.bumped_' || replace(p_user_id::text, '-', '');
  v_xact := pg_current_xact_id()::text;
  if current_setting(v_marker, true) = v_xact then
    select v.input_version, v.evaluated_version into v_input, v_evaluated
    from public.card_payment_eval_versions v where v.user_id = p_user_id;
    if found and v_evaluated is distinct from v_input then
      return;
    end if;
  end if;
  update public.card_payment_eval_versions set input_version = input_version + 1 where user_id = p_user_id;
  if found then
    perform set_config(v_marker, v_xact, true);
    return;
  end if;
  begin
    insert into public.card_payment_eval_versions (user_id, input_version) values (p_user_id, 1)
    on conflict (user_id) do update set input_version = public.card_payment_eval_versions.input_version + 1;
  exception when foreign_key_violation then
    return; -- the user row is being deleted in this transaction: no version row, so no marker
  end;
  perform set_config(v_marker, v_xact, true);
end;
$$;
```

### The evaluator delta
This is the complete diff of the normalised `evaluate_card_payments` body: `20260930120000` vs `20261002120000`.
```diff
   -- Step 3: L2, and the version these states will be stamped with. Never re-read.
   insert into public.card_payment_eval_versions (user_id) values (p_user_id) on conflict (user_id) do nothing;
   select ev.input_version into v_version from public.card_payment_eval_versions ev where ev.user_id = p_user_id for update;
+  -- Step 3a: from this capture on, every input write this transaction makes must bump again, so clear the
+  -- user's bump-coalescing marker (card_payment_bump, 20261002120000). Otherwise a write after the capture,
+  -- by a transaction that had already bumped this user, would be coalesced, and the publication below would
+  -- stamp states that miss it as fresh.
+  perform set_config('card_payment.bumped_' || replace(p_user_id::text, '-', ''), '', true);
```
That is `diff` output `51a52,56`: five added lines, nothing removed or changed. The only other change in the file is `create function` → `create or replace function`.
- The locks are taken and the version is captured exactly as before.
- The reset comes before any input is read (step 4).
- Publication still stamps the captured `v_version`.
- The self-review independently re-derived this diff and all four checksums.

### Preserved C1 conditions
- **Marker binding:** bound to the top-level transaction id and keyed by user.
- **Set only after a surviving bump:** the marker is set only after the function's own UPDATE or INSERT succeeds.
- **Skip only when safe:** only on an existing stale row, while this transaction's surviving bump excludes every other session. An UPDATE holds L2. An INSERT holds the uncommitted key; others' `INSERT … ON CONFLICT` waits on it, and a decision RPC finds no row and refuses as stale.
- **First bump always happens:** a transaction's first bump always runs, even if the user was already stale (a14 §5, §9; c25).
- **Rollback, exceptions, reuse:** none of these can leave a marker that suppresses a later bump (a14 §5–§8, a15).

### Client-facing paths cannot reach the marker
a14 §16 checks this in the catalog:
- Only `card_payment_bump` and `evaluate_card_payments` name the marker, and neither is executable by a client role.
- **No function in an API-exposed schema that `anon` or `authenticated` can execute calls `set_config` at all.**
- PostgREST exposes `public` and `graphql_public` only, sets only its own `request.*` settings, and has no pre-request hook configured.

No privilege was broadened. The marker is an optimization, not authorization. Forging it needs arbitrary SQL as a writer role, which could already update the version table directly.

### Rollback plan
`supabase/rollback/20261002120000_card_payment_bump_coalescing_rollback.sql`:
- **Shape:** one explicit transaction, run without `-1`.
- **Guard:** refuses unless the current bodies are the 20261002120000 ones.
- **What it does:** re-creates both baseline bodies verbatim, verified by checksum and by the same security postconditions.
- **No data step:** markers are transaction-local and versions are monotonic.
- **Ledger:** the migration ledger row is left alone. Re-applying means running the migration SQL again; its guard accepts the restored bodies. See §6 for the rehearsal.

## 4. Changed files (`d55a9eb..HEAD`)

| File | Change |
|---|---|
| `supabase/migrations/20261002120000_card_payment_bump_coalescing.sql` | **new**: the migration |
| `supabase/rollback/20261002120000_card_payment_bump_coalescing_rollback.sql` | **new**: the operator rollback script |
| `supabase/tests/access_control/sql/a09_card_payment_invalidation.sql` | account-insert block replaced (§5) |
| `supabase/tests/access_control/sql/a14_card_payment_bump_coalescing.sql` | **new**: freshness contract (17 sections, CI) |
| `supabase/tests/access_control/sql/a15_card_payment_bump_coalescing_effect.sql` | **new**: implementation properties (CI) |
| `supabase/tests/access_control/concurrency/c23_*`, `c24_*`, `c25_*` | **new**: coordinated races (CI) |
| `supabase/tests/card_payment_coalescing_mutations/{run.sh,mutants.cjs}` | **new**: mutation runner (manual) |
| `supabase/tests/card_payment_coalescing_rehearsal/*` | **new**: upgrade, rollback and re-apply rehearsal (manual) |
| `supabase/tests/card_payment_benchmark/coalescing/*` | **new**: final benchmark, session-growth check and its raw result (manual) |
| `CARD_PAYMENT_PAIRING_DESIGN.md` | §3.7 and acceptance test 13: coalescing, the reset, session state |
| `P2_C1_IMPLEMENTATION_HANDOFF.md` | **new**: this document |

Everything under `access_control/` runs in CI's existing `database-harness` job automatically, because the runner picks up every file. The mutation, rehearsal and benchmark tools are manual, since each needs its own throwaway databases.

## 5. The revised a09 assertion

**Before:**
```sql
-- Account inserts bumped already (three of them: aa twice, bb once).
select th.assert(pg_temp.v(aa) = 2 and pg_temp.v(bb) = 1, 'account inserts bumped their owners');
```

**After:**
- **Setup:** an unrelated user `ee` is added. aa, bb and ee are evaluated first, so they are fresh. Their versions are captured, and then the same three-row INSERT runs.
- **Assertions:**
  - `account inserts advanced each owner`: aa and bb each advanced;
  - `account inserts left each owner stale`;
  - `an unrelated owner did not advance and stays fresh`;
  - inside a two-row insert transaction, each owner advances; after `ROLLBACK`, `a rolled-back account insert leaves every version as it was` (aa, bb and ee);
  - `a later account-insert transaction advances its (already stale) owner again, and only it`.

**Why the coverage is sufficient:**
- The old line proved only "the counts were per-row". The new block proves the contract the old count stood in for: each affected owner is invalidated in the writer's transaction. It also adds staleness, a negative (unrelated owner) control, rollback and repeat-transaction checks the old line lacked.
- The other 29 `check_bump` exact deltas are single-row, single-statement transactions, which C1 leaves at exactly 1 (or 0). They, the non-input and same-value checks, and the ownership, cascade, rollback and user-deletion assertions are all unchanged.
- The self-review confirmed the rest of a09 is byte-identical. One trade-off: the version rows now exist before the account insert, because the evaluations create them. Row creation by a bump is covered by a14 §12.

**Mutation evidence** (§7):
- `account_insert_no_bump` (inserts no longer invalidate) fails "account inserts advanced each owner";
- `account_insert_single_owner` (one fixed owner is bumped) fails the same assertion;
- `account_insert_overbroad` (every user is bumped) fails "an unrelated owner did not advance and stays fresh".

## 6. Validation

All runs used throwaway containers of `public.ecr.aws/supabase/postgres:17.6.1.155`. That is image `3866d94d8426`, the same image CI pins by digest.

Final run, on the committed files:

| Suite | Command | Result |
|---|---|---|
| Access control (every sql test + every concurrency test; clean replay of the full history as `postgres`, one transaction per file) | `bash supabase/tests/access_control/run.sh` | **40 passed, 0 failed**. a09 (revised), a14, a15, c23, c24, c25 all pass; a10–a13 and c12–c22 unchanged and passing |
| Same new tests on the **unchanged baseline** (`EXCLUDE=20261002120000_…`) | `run.sh a09 a14 a15 c23 c24` | a09, a14, c23, c24 **pass**, which shows the contract holds without coalescing. a15 **fails by design** (300 increments for 300 rows) |
| SQL ↔ TypeScript reference equivalence | `bash supabase/tests/card_payment_evaluator/run.sh` | **662 evaluations, 0 differ**; RPC sequences **8 scenarios, 0 failures** |
| Phase A scaffold / history (+ continuity a06 is in access control) | `bash supabase/tests/phase_a/run.sh`, `PHASE_A_BASE=history …` | **23 passed**, **18 passed + 7 skipped** (same as before) |
| Card-payment audit harness | `bash supabase/tests/card_payment_audit/run.sh` | **PASS** |
| Migration replay, both tiers (pinned CLI 2.117.0, cached; local throwaway DBs only) | `SUPABASE_CLI=<cached 2.117.0> bash supabase/tests/replay/run.sh` | **11 passed** (R1–R5, C0–C5). This includes clean `db push`, idempotence, production state applying only the pending files (upgrade from the supported baseline), schema equality, and `db reset` |
| Upgrade / rollback / re-apply rehearsal | `bash supabase/tests/card_payment_coalescing_rehearsal/run.sh` | **all 10 steps pass** (below) |
| Backend typecheck / tests / build | `npm run typecheck\|test\|build --workspace backend` (CI placeholder env) | **pass / 1,307 passed + 3 expected-fail + 5 todo / pass** |

No unexpected failure remains. The only intentionally replaced assertion is a09:28 (§5). Nothing was skipped or ignored beyond the suites' own pre-existing skips.

**Rehearsal** (`supabase/tests/card_payment_coalescing_rehearsal/run.sh`):
1. **Baseline:** every migration before `20261002120000`, plus matching state: a fresh user with a saved decision, a stale user, a never-evaluated user, and a straddler user.
2. **Upgrade:** applied while a transaction straddles it. That transaction bumps under the old body; after the upgrade commits, it runs the new body in the same transaction, asserted through its marker.
3. **Verify the upgrade:**
   - every card-payment table, plus transactions and accounts, is byte-identical (md5 digests, excluding the straddler's user);
   - freshness is exactly as before, and stored states with the decision are still readable;
   - the straddler is stale, and its re-evaluation includes all three writes;
   - coalescing is active (1 increment for 3 rows), and a write after evaluation re-invalidates;
   - a stale expected version is refused and the current one accepted.
4. **Rollback:** the script is applied as documented, while a transaction that bumped under the new body straddles it. That transaction then bumps per row under the old body.
5. **Verify the rollback:**
   - both bodies are byte-identical to `20260930120000`, with security and grants intact;
   - data is unchanged, and states published under the new bodies stay readable;
   - per-row bumps are back.
6. **Re-apply:** the migration file applies again, data is unchanged, and coalescing is back.
7. **Evidence step:** all six snapshots and both signals exist.

**Equivalence.** The SQL evaluator still matches the TypeScript reference on 662 evaluations, and RPC-written decisions on 8 scenarios. Matching rules are unchanged.

## 7. Mutation evidence

Run with `supabase/tests/card_payment_coalescing_mutations/run.sh`. Each mutant is applied as the last migration of its own throwaway database. Each run covers a09, a14, a15, c23, c24 and c25.

Final run: **14 of 14 as expected** (exit 0). Raw output: `supabase/tests/card_payment_coalescing_mutations/results/2026-10-02_final.txt`.

| Mutant | What it breaks | Detected by (first failing assertion) |
|---|---|---|
| `naive_once_per_tx` (negative control) | skips whenever this transaction already bumped; no staleness re-check | **a14 §17** "the next input write still invalidates (a skip requires a stale row)" |
| `naive_once_per_tx_without_reset` | the same, and the evaluator reset is removed (the P1 control) | **a14 §4** "stale after the second write (post-evaluation write re-invalidates)"; a15 |
| `stale_only_skip` | skips whenever the row is stale, with no marker (no lock held) | **a14 §5**; a09; a15; **c25** (the evaluator is never blocked → coordination timeout) |
| `unbound_marker` | any marker value counts (not bound to the xid) | **a14 §8** "a leftover session-level value did not suppress the bump" |
| `unkeyed_marker` | one marker for all users | **a14 §10**; a09 "inside the writer's transaction, each owner advanced"; a15 |
| `session_marker` | marker at session scope | **survives a14** (the xid binding alone protects); a15 "no marker after commit" |
| `session_unbound` | session scope **and** no binding | **a14 §5** "the surviving write advanced input_version in its own transaction"; a09; a15 |
| `no_row_check` | drops the explicit row-exists check | **survives** (redundant: a missing row reads NULL = NULL, not stale) |
| `no_evaluator_reset` | evaluator does not clear the marker | **a14 §14a** "a write after the capture leaves the publication stale, inside the transaction"; a15 |
| `late_evaluator_reset` | marker cleared only after publication | **a14 §14a** |
| `wrong_key_reset` | evaluator clears a valid but different key | **a14 §14a**; a15 |
| `account_insert_no_bump` | account INSERT does not invalidate | **a09** "account inserts advanced each owner" |
| `account_insert_single_owner` | invalidates one fixed owner, not the row's | **a09** "account inserts advanced each owner" |
| `account_insert_overbroad` | invalidates every user | **a09** "an unrelated owner did not advance and stays fresh" |

**Which safeguard each test actually detects:**
- **(c), the staleness re-check:** with the evaluator reset in place, (c) is redundant for evaluator publications. The reset already re-arms invalidation, so the naive once-per-transaction rule passes everything except a14 §17, a publication that does not clear the marker. Without the reset, the naive rule fails a14 §4, the P1 negative control. Each of the two safeguards is therefore independently tested.
- **(a), transaction binding:** detected by a14 §8, a leftover session-level value.
- **Session scope:** session scope alone is protected by the binding, and is caught only by a15's hygiene check. Session scope *and* no binding fails a14 §5 (a marker carried into a later transaction).
- **Skip without any marker:** fails a14 §5, and c25 times out because the evaluator is never blocked. That is the cross-session lock argument.
- **Per-user keying:** detected by a14 §10, with a09 also failing.
- **(b), the explicit row-exists check:** redundant by construction, because a missing row reads as NULL = NULL, which is not stale. It survives, as expected.
- **Evaluator reset removed, placed after publication, or clearing the wrong key:** each fails a14 §14a, the injected write between capture and publication.
- **Races c23/c24:** these pass under every skip-rule mutant. They guard the lock path, which those mutants don't touch. c25 is the race that detects a lock-free skip.

**The injected post-capture write (a14 §14)** is a test-only statement trigger on `card_payment_leg_states`. It is created in a14, armed per case, dropped at the end of the section, and inert unless armed. It runs through:
- (a) plain evaluation after an earlier bump;
- (b) `try_evaluate_card_payments`;
- (c) a control with no earlier bump;
- (d) a decision RPC's own evaluation;
- (e) a successful retry after a failed evaluation.

Every case must leave the user stale and unreadable as fresh, and the next evaluation must include the write. No injection mechanism exists in runtime SQL.

## 8. Session lifetime: setting-name growth

Measured with `growth.sql`: one long-lived session, 20,000 distinct synthetic users, each bumped in its own committed transaction. The baseline body is the control.

| Distinct users | GUC context growth, final | Bytes per user | All contexts growth, final | Baseline (control) |
|---|---|---|---|---|
| 100 | 64 KiB | 655 | 0.36 MB | 0 (all contexts +0.31 MB) |
| 1,000 | 448 KiB | 459 | 0.83 MB | 0 |
| 5,000 | 1.94 MiB | 406 | 2.5 MB | 0 |
| 20,000 | 7.94 MiB | 416 | 9.6 MB | 0 (all contexts +0.29 MB) |
| the same 20,000 again | +0 | — | +0 | 0 |

- **Value vs name.** A marker's *value* is reset at every commit and rollback: it reads `''` after commit. The setting *name* (a placeholder) stays for the backend's lifetime.
- **RESET ALL and DISCARD ALL** do not remove the name: still 8 MiB, value `''`. Only ending the connection frees it. A fresh session has the 64 KiB base context.
- **What creates names:** every distinct user bumped, or evaluated (the reset also creates the name), through a connection.
- **Time:** no per-bump time growth (~595–620 µs per committed single-bump transaction in both modes, commit-dominated).

**Assessment: not material now.**
- **At today's scale:** a handful of users means a few KB per connection.
- **Rough bound:** about 0.5 KB × distinct users × pooled connections. Even 10,000 active users spread over 20 long-lived PostgREST connections would cost at most about 100 MB, and only if every connection eventually touched every user.
- **Connection recycling:** connections recycled by the pooler bound the growth further. That is a PostgREST/Supavisor setting I did not inspect on the hosted project, and it was out of scope.
- **When to revisit:** if the user count reaches the tens of thousands. The `bumped_xid` column alternative avoids session state entirely.

## 9. Performance

`supabase/tests/card_payment_benchmark/coalescing/run.sh 6 1` benchmarks the actual migration (raw output in `results/2026-10-02_final_6x1.txt`).

**Method:**
- **Setup:** the container gets every migration before 20261002120000. The benchmark saves those definitions, applies the real migration file, saves its definitions, and then switches *both* functions (checksum-verified) untimed before every sample.
- **Sampling:** matched fixtures; 6 measured samples after 1 warm-up, with rotated order.
- **What is timed:** BEGIN → COMMIT, commit included.
- **Recorded:** per-transaction version-row updates (an in-block counter delta).
- **Lower bound:** `off` (triggers disabled) is a diagnostic lower bound only.
- **Environment:** Docker Desktop with 12 CPUs and 8 GB, `fsync=on`, `synchronous_commit=on`.

| Case | Baseline ms, median (p25–p75) | Final ms (p25–p75) | `off` ms | Paired Δ (final faster in) | Added over `off`: baseline → final | Version-row updates |
|---|---|---|---|---|---|---|
| insert_batch 5k | 1,156.7 (1,148–1,163) | **900.2** (890–901) | 711.0 | −259.5 (6/6) | 446 → **189** | 5,000 → **1** |
| insert_batch 20k | 7,263.1 (7,234–7,272) | **3,727.7** (3,718–3,750) | 2,958.9 | −3,514 (6/6) | 4,304 → **769** | 20,000 → **1** |
| update_batch 5k | 525.2 (521–532) | **264.9** (263–270) | 95.7 | −264.2 (6/6) | 430 → **169** | 5,000 → **1** |
| update_batch 20k | 4,753.3 (4,736–4,834) | **1,159.3** (1,158–1,163) | 454.6 | −3,596 (6/6) | 4,299 → **705** | 20,000 → **1** |
| batch 5k + try_evaluate, one transaction | 1,591.4 (1,571–1,601) | **1,301.5** (1,298–1,318) | 1,149.5 | −271.3 (6/6) | 442 → **152** | 5,001 → **2** |
| evaluate_only, 20k rows | 289.9 (289–291) | 292.7 (291–295) | — | +1.7 (1/6) | — | 1 → 1 |
| carryover_sweep 1k | 34.2 (33.9–34.3) | **14.5** (13.9–14.6) | 3.5 | −19.9 (6/6) | 30.7 → **11.0** | 1,000 → **1** |
| carryover_sweep 5k | 323.0 (322–324) | **59.7** (59.6–60.2) | 9.2 | −263.4 (6/6) | 314 → **50.5** | 5,000 → **1** |
| multi-user insert (5k rows, 10 users, one statement) | 307.6 (306–310) | **214.4** (212–218) | 82.1 | −92.5 (6/6) | 226 → **132** | 5,000 → **10** |
| item_delete_cascade 5k | 130.8 (130–132) | 129.9 (129–133) | 40.3 | −1.9 (5/6) | 90.5 → 89.6 | 51 → 1 |
| item_delete_cascade 20k | 509.6 (499–518) | 513.5 (513–514) | 152.6 | +11.3 (2/6) | 357 → 361 | 51 → 1 |
| reconcile, 200 single calls | 237.9 (236–239) | 240.3 (236–241) | 221.7 | +1.1 (2/6) | 16.2 → 18.6 | 200 → 200 |
| loan link, 100 single calls | 97.8 (97–99) | 99.1 (99–101) | 91.1 | +1.3 (3/6) | 6.6 → 8.0 | 100 → 100 |
| sync, 100 one-row calls | 143.1 (138–146) | 145.2 (139–148) | 139.4 | +2.3 (1/6) | 3.7 → 5.8 | 100 → 100 |
| 1,000 transactions × one bump | 582.4 | 578.9 | — | −0.7 (3/6) | — | 1,000 → 1,000 |

**Bump-only controls** call `card_payment_bump` directly in a loop; they are not production shapes.

| Control | Baseline | Final |
|---|---|---|
| same user, 5k bumps | 299.3 ms | **42.9 ms** |
| same user, 20k bumps | 3,720.2 ms | **189.3 ms** |
| 100 users, 5k bumps | 161.2 ms | **50.7 ms** |
| 100 users, 20k bumps | 1,187.8 ms | **207.8 ms** |

**Rolled-back EXPLAIN profile** (instrumented; not a timing): the bump trigger's time inside the multirow INSERT falls from 382 to 123 ms at 5k, and from 3,991 to 493 ms at 20k. The version-row updates per transaction fall from 5,000 / 20,000 to 1.

**Reading:**
- The superlinear term is gone. Each batch now makes one version-row write per user, plus one per publication.
- The evaluator reset costs no measurable time: evaluate-only +1.7 ms on a 290 ms evaluation, within the run-to-run spread.
- Small single-row calls are about 1–1.5 % slower: +1–2 ms per 100–200 calls, about 10–20 µs per call, faster in only 1–3 of 6 pairs. This is consistent with the first bump's `current_setting` and `set_config`, and close to the measurement floor.
- Cascades are unchanged. Cascaded rows call `card_payment_bump(NULL)`, which returns on its first line in both versions.

**Residual overhead (explicit limitation).** This is linear per-row trigger cost that C1 does not remove: the trigger call, the account → item → user lookup, and the skip check (about 14–20 µs per row). Over the `off` bound it is:

| Case | Residual over `off` |
|---|---|
| inserts 5k / 20k | +189 / +769 ms (+27 % / +26 %) |
| updates 5k / 20k | +169 / +705 ms |
| carry-over sweep 5k | +50 ms |
| multi-user | +132 ms |
| cascade 20k | +361 ms (unchanged) |

**The performance gate is not declared closed.** Whether this residual is acceptable, or whether C2 (statement-level triggers) should be evaluated, is a separate decision for you.

## 10. Self-review

A separate, read-only **Claude self-review** of the uncommitted diff. It is not independent cross-family approval.

**Result:** no defect that could commit an input change while the user reads as fresh with states that miss it. Low-severity findings and what was done:

| Finding | Disposition |
|---|---|
| Header's lock argument covered only the UPDATE path (the INSERT path is held by the uncommitted key) | Header corrected (comment-only; bodies and checksums unchanged) |
| "A publication makes the row fresh" ignored a write after capture | Header and design doc corrected |
| Rollback atomicity depended on the runner | Rollback is now one explicit transaction; the rehearsal runs it exactly as documented |
| No race starting from an already-stale committed row; a lock-free "skip when stale" mutant would pass c23/c24 | Added **c25** and mutant `stale_only_skip` (caught by a14 §5 and c25) |
| Markdown nesting in the design doc | Fixed |
| Session-name growth not stated in header or doc | Stated; measured in §8 |
| Header cited P0/P1 reports that are not in this branch | Now points to this handoff |
| a14 §8's forged value `'1'` can never equal an xid; a forged *current* xid is the accepted trust boundary | Documented (TRUST) |
| Pre-existing (question): `authenticated` holds table privileges on `transactions` (`20260825195130_remote_schema.sql:328`). The SECURITY INVOKER triggers call `card_payment_bump`, which `authenticated` cannot execute, so a direct client write would fail | Verified the grant exists. The behaviour dates from `20260930120000` and is unchanged by this packet. Out of scope; flagged for a separate check |

## 11. Limitations and open decisions

- **Performance acceptance (§9) is open.** The residual linear per-row trigger cost remains, and C2 is not implemented.
- **The same-session invariant is now enforced by the evaluator reset** and tested by injection (§7). The remaining trust assumption is that only writer roles with arbitrary SQL could forge a marker.
- **Session-name growth** is bounded by connection lifetime and is not material at current scale (§8).
- **Measured locally only:** one Docker Desktop host. Hosted latency, concurrency and throughput are not measured.
- **Not this packet:** the known `backend/src/services/cardPaymentEvaluation.ts` comment about per-item sync freshness concerns sync ordering, not this change, and is left for a code packet.
- **Before any rollout:** release planning (PRODUCTION_HEAD, the CLI replay tier with the production state) belongs to a later, approved packet.

## 12. Reproduce

```bash
bash supabase/tests/access_control/run.sh
```

Other commands:

```bash
bash supabase/tests/card_payment_evaluator/run.sh
bash supabase/tests/phase_a/run.sh && PHASE_A_BASE=history bash supabase/tests/phase_a/run.sh
SUPABASE_CLI="npx -y supabase@2.117.0" bash supabase/tests/replay/run.sh
bash supabase/tests/card_payment_coalescing_rehearsal/run.sh
bash supabase/tests/card_payment_coalescing_mutations/run.sh
bash supabase/tests/card_payment_benchmark/coalescing/run.sh 6 1
```

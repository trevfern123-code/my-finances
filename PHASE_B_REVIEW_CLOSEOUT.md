# Phase B review closeout: corrections after the independent S1 and cumulative reviews

**Status:** a local, uncommitted correction pass, revised after the focused independent review and awaiting its final wording-only verification.
- Not committed, not pushed, no PR created or changed.
- No hosted access, no migration executed outside disposable local databases, no application integration.
- This document does not approve a merge, a release, or S1 on its own.

**Inputs:** the Codex reports of 2026-10-03.
- `PHASE-B-cumulative-review.txt` (cumulative Phase B review).
- `S1-independent-review.txt` (independent S1 review: ready for a separate draft PR stacked after C1; not approved for merge or release).
- `FOCUSED-CLOSEOUT-REVIEW.txt` (focused review of this correction: the c01 change is technically acceptable; four corrections needed, limited to wording and the handoff and evidence description). Revision 2 of this document applies those four corrections.
- Revision 3 adds one further comment-only correction that Trevor authorized afterwards: the remaining "never got a response" comment in the wrapper (§2.2).

## 1. Baseline and isolation

| | |
|---|---|
| Reviewed C1 (PR #12 head) | `1aab2d8bb8f537f4df952231c078e9944a7c73fd` |
| Reviewed S1 | `221ccd52a9581c48fc33de7521c96d7b4c830c50`, branch `feature/client-table-privilege-hardening` |
| This pass | branch `feature/phase-b-review-closeout`, worktree `C:\Users\Trevor\dev\my-finances-review-closeout`, created from `221ccd5` |

- C1 is an ancestor of S1, and S1 is exactly one commit above C1.
- The S1 and C1 branches, commits and worktrees are untouched. Nothing was reset, rebased, amended or cherry-picked.
- The closeout changes are working-tree changes on the new branch only. They are separate from S1's reviewed four-file delta (`1aab2d8..221ccd5`), and none of those four files is edited here.

## 2. Corrections completed in this pass

### 2.1 c01 concurrency coordination (cumulative finding 1; S1 finding 1)

**The problem, as reviewed.** `c01_concurrent_claim` assumed overlap from elapsed time: the runner waited one second, the holder slept three seconds inside its transaction, and the contender asserted that more than one second had elapsed. A delayed contender could receive the correct `in_progress` result and still fail the timing assertion. Elapsed time also never proved the intended blocking dependency.

**The change.** Two files, test-only:

- `supabase/tests/access_control/concurrency/c01_concurrent_claim/holder.sql`
  - Unchanged: it claims the attempt inside an open transaction and asserts the outcome is `claimed`.
  - New: it announces itself (`application_name = 'c01-holder-claimed'`), then waits until it **observes the contender blocked on this session** (`th.wait_until_blocked_by(th.wait_for_application('c01-contender'), pg_backend_pid())`), and only then commits.
  - Removed: `pg_sleep(3)`.
- `supabase/tests/access_control/concurrency/c01_concurrent_claim/contender.sql`
  - New: it starts its claim only after the holder has announced (`th.wait_for_application('c01-holder-claimed')`), and announces itself as `c01-contender`.
  - Unchanged: it asserts the outcome is `in_progress`.
  - Removed: the `clock_timestamp() - t0 > interval '1 second'` assertion. The holder's observation of the lock dependency replaces it.

**What is preserved.**
- The concurrency being tested: a duplicate completion call that arrives while the first claim is uncommitted blocks on the claimed row's lock and is then told `in_progress`.
- The `claimed` assertion (holder), the `in_progress` assertion (contender), and `verify.sql` (claimed exactly once, by the holder), which is unchanged.

**Why this is at least as strong.** `claim_plaid_link_attempt`'s first statement is an `UPDATE` of the attempt row (`supabase/migrations/20260922130000_plaid_link_attempts.sql:268-273`). While the holder's claim is uncommitted, the contender's `UPDATE` waits on that row lock, which `pg_blocking_pids` reports. The test now requires that exact dependency rather than a duration.

**Diagnostics and cleanup.**
- Both waits are bounded (30 seconds each, the helpers' default) and raise `COORDINATION TIMEOUT` with a snapshot of every session: pid, application name, state, wait event and blocking pids (`supabase/tests/access_control/helpers.sql:56-106`).
- If coordination fails, the holder's transaction aborts, the runner records the failure with both transcripts, and the runner's existing exit trap removes the container.

**Not changed.**
- The runner (`run.sh`), the helpers, and every runtime SQL function.
- No sleep was lengthened and no threshold was relaxed.
- The runner's fixed one-second delay before starting the contender remains. c01 no longer depends on it.

**What this does not establish.** It does not explain why the original 40-passed, 1-failed run failed. Timing interference remains suspected, not established.

**Follow-up, not done here.** `c02` through `c11` use the same sleep-and-elapsed-time pattern. They are outside the approved correction and are listed in §5.

### 2.2 Timeout and freshness wording (cumulative finding 3)

**The overstatement.** Comments, log messages and two documents said that after a timeout or a failed evaluation, matching "stays stale". The implemented contract is different:
- **A timeout** stops the client waiting. The server outcome is unknown: the evaluation may still finish and publish.
- **A failed evaluation** publishes nothing. Freshness is whatever it already was: a stale user stays stale, and a user who was fresh with unchanged inputs stays fresh.
- **Error bookkeeping** is best-effort. An error row is not guaranteed (for example, for a user being deleted).
- **A later item's batch** invalidates an earlier evaluation only if it changes a matching input. An empty batch does not.
- **Freshness is decided only by the stored versions**, read through `get_card_payment_states`. No caller may use the wrapper's outcome to authorize figures.

**Corrected wording.** Four distinct diagnostic messages changed at six call sites. This changes observable diagnostic output. Control flow, outcome values, structured log fields, calculations, timeout settings, security handling and SQL function bodies are unchanged.

| File | Lines (after the change) | What changed |
|---|---|---|
| `backend/src/services/cardPaymentEvaluation.ts` | 19–29 | comment: "every other outcome" now says this call is not known to have published fresh states, and separates the unknown timeout outcome from a failed evaluation |
| same | 34–37 | comment: frequency; an empty later batch does not invalidate |
| same | 58–60 | comment: the timeout bounds the client's wait only |
| same | 69–71 | comment: error bookkeeping is best-effort |
| same | 80–81 | comment on the `request_failed` outcome type (revision 3): the client returned no usable evaluation result and the timeout had not aborted the request; whether the server executed the request is not established |
| same | 123 | comment on the status-0 branch: the client returned no usable evaluation result; this does not establish whether the server executed the request |
| same | 116, 159 | diagnostic message, `timeout` (two call sites) |
| same | 124, 165 | diagnostic message, `request_failed` (two call sites) |
| same | 138 | diagnostic message, `rpc_error` (one call site) |
| same | 147 | diagnostic message, `evaluation_failed` (one call site) |
| `CARD_PAYMENT_PAIRING_DESIGN.md` | 433–435, 466–478, 931–932 | failed evaluation publishes nothing; unknown timeout outcome; per-item evaluation |
| `PHASE_B_MATCHING_ENGINE_HANDOFF.md` | 684–686, 1000–1005, 1115–1118 | best-effort bookkeeping; per-item evaluation; what the timeout bounds |

**What each diagnostic message now claims**, matched to what its code path establishes:

| Outcome | Message says | Why |
|---|---|---|
| `timeout` | the server outcome is unknown; the evaluation may still complete | The client stopped waiting. That is not proof of a server rollback. |
| `request_failed` | no usable evaluation result was obtained; the server outcome is unconfirmed | The client produced no usable result. That does not establish that the request never reached the server, or that no response arrived: a response may have arrived and failed while being read or processed. |
| `rpc_error` | the request returned an error; no evaluation result was received | A definite error was returned to the client. |
| `evaluation_failed` | the evaluation rolled back alone; error bookkeeping is best-effort; this attempt published nothing | The RPC returned `false`. |

In every non-`evaluated` case the client did not confirm a successful evaluation. That observation alone does not establish the server-side outcome or freshness.

**Status of the diagnostic edits.** The focused independent review accepted the message edits as within the requested correction, and asked for the `request_failed` wording and the line-123 comment to be corrected. Those corrections are now applied and await final verification. Text consumers outside this repository were not assessed. The existing tests do not pin these four messages.

**The `request_failed` type comment (revision 3, comment only).** `cardPaymentEvaluation.ts:80-81` said "The request never got a response: a network failure …". That path establishes less than that.
- **When it is returned.** `request_failed` is returned only after the timeout check, so the request had not been aborted by the timeout. It is returned in two cases: the client resolved an error with HTTP status 0 and no error code (line 122), or the call threw (the `catch` at line 157).
- **What status 0 covers.** In the installed postgrest-js 2.112.3, a status-0 result covers both a rejected fetch and a failure while processing a response.
- **What the comment now says.** The client returned no usable evaluation result, the timeout had not aborted the request, and whether the server executed the request is not established.
- **Scope.** No executable statement, diagnostic string, structured field, return value, timeout or test changed. Compiled with comments removed, the wrapper is identical before and after.

**Not changed, and why.**
- `supabase/migrations/20260930120000_card_payment_matching_state.sql:23, 794, 812` carry the older "leaves the user stale" phrasing in comments. Historical migration files must not be edited. That wording limitation stands: read those comments with the qualification above.
- No genuine runtime defect was found. The wrapper already treats an aborted request as an unknown outcome (`cardPaymentEvaluation.ts:43-47`).

## 3. Planned PR and CI arrangement (documentation only; nothing was published)

**The constraint.** `.github/workflows/ci.yml:3-7` runs on pushes to `main` and on pull requests targeting `main`. A literal S1-to-C1 pull request (base `feature/phase-b-c1-bump-coalescing`) would not trigger it.

**The existing precedent.** Draft PRs #8–#12 all target `main` for that reason. PR #12's description names its incremental range and states that its full diff includes the earlier drafts.

**Selected plan (Option B).** Trevor selected Option B as the preferred eventual arrangement, conditional on independent approval and separate execution authorization: one draft PR containing the original S1 commit plus a distinct closeout commit. This section documents that plan. It executes none of it.

**Intended ancestry:**

```
C1:       1aab2d8bb8f537f4df952231c078e9944a7c73fd
  -> S1:       221ccd52a9581c48fc33de7521c96d7b4c830c50
  -> closeout: <future combined head, not yet committed>
```

- **S1 is preserved as its original commit:** no amend, squash or rebase.
- **The closeout does not exist as a commit yet.** It is an uncommitted working tree, and it is not yet approved. Its SHA is unknown until it is created, and none is assumed here.
- **The eventual PR head is the future combined head, not `221ccd5`.** `221ccd5` stays unchanged as its parent.
- **The publication branch will be named in the later authorized packet.** Committing the closeout on the existing `feature/phase-b-review-closeout` branch, whose HEAD is `221ccd5`, would leave the original S1 branch pointer unchanged. No branch is moved now.

**Two separate review ranges, both preserved:**

| Range | What it covers |
|---|---|
| S1 only: `1aab2d8..221ccd5` | The original four files, +439 lines, as independently reviewed |
| Closeout only: `221ccd5..<future combined head>` | The final reviewed correction, including the follow-up wording revisions |

Record the combined head's SHA once it actually exists. This working-tree review is not a review of an uncreated commit.

**Proposed draft PR.**
- **Base:** `main`, so that the existing workflow triggers.
- **Head:** the future combined head.
- **State:** draft, with auto-merge off.
- **Proposed title:** `Phase B: client table privilege hardening (S1) with review closeout, stacked on C1`.
- **The description must state:**
  - **Dependency.** The PR depends on C1 (PR #12) and on the earlier Phase B drafts #8–#11.
  - **Diff.** The main-relative diff is cumulative: it includes C1 and all of those earlier drafts.
  - **Review ranges.** Both ranges above, shown prominently.
  - **Not a literal stack.** It is a semantic dependency stack, not a literal S1-to-C1 pull request. It targets `main` only so that the existing CI runs.
  - **No merge authorization.** Neither the PR target nor passing checks authorizes merging it independently, or ahead of its unresolved dependencies.
  - **CI evidence.** Successful CI must be verified later for the actual published combined candidate. Record both the PR head SHA and the tested commit SHA of each check run, including any PR merge ref.
  - **What does not count as that CI result.** PR #12's CI, the original S1 41-passed run at `221ccd5`, and the local results on this uncommitted working tree are supporting evidence only. None is CI approval for the combined head.
  - **Review status.** S1 was independently reviewed as ready for a separate draft PR. The closeout's review is in progress. Neither is approved for merge or production release.
  - **Limitations.** The limits in §4 and §5.

**Future publication checklist, for a later authorized packet only:**
1. Create the closeout commit with `221ccd5` as its parent, only after independent approval of the final diff.
2. Verify that commit's exact content against the independently reviewed diff, a clean tree, and the preserved ancestry C1 → S1 → closeout.
3. Verify that the S1 and C1 commits are unchanged.
4. Push the named publication branch with a normal push, after checking that the remote branch does not already exist at a different commit.
5. Open the draft PR against `main` with the description above.
6. Record the PR number, the PR head SHA, and each check run's tested commit SHA and conclusion.

Pushing, creating or updating a PR, and changing CI configuration all remain separate authorized tasks. Nothing was committed, pushed or opened in this pass.

## 4. Checks still needed before integration or release

These are carried forward from the cumulative review. None is satisfied by this pass.

**Integration gate (before any merge decision):**
- Resolve the cumulative main-target PR dependencies deliberately, and obtain the required checks on the exact intended candidate. Current successful PR-head checks are supporting evidence, not authorization.

**Pre-release verification gates:**
- **Catalog drift.** Policy drift, inherited and default grants, ownership and the role graph, function definitions with their security mode and search path, enabled triggers, and the service role's TEMP privilege. S1's narrow preflight must be combined with matching-object and role/default inspection. No hosted value has been checked.
- **Populated upgrade rehearsal.** A populated, combined upgrade and preservation rehearsal on the eventual release candidate: non-empty transactions, splits, carry-overs and decisions; owner and unrelated-user rows; catalog fingerprints.
- **Hosted drift.** Hosted schema, ledger and configuration drift, and the actual `PRODUCTION_HEAD`. `README.md:54-56` quotes an older default (`20260924130000`) than `supabase/tests/replay/run.sh` (`20260927120000`). Neither is proof of the hosted ledger. Resolve it against authorized observations, then rehearse that exact starting state in a disposable database.
- **GraphQL.** Direct GraphQL verification for any exposed GraphQL path, or explicit verification that the path is disabled.
- **Product decisions.** The provisional semantics in the Phase B handoff §5 and the RPC choices in §9 must be settled for the affected user flows. Agreement between the SQL evaluator and the reference implementation is not that approval.
- **Engineering confirmations.** Confirm the hosted TEMP permission, and keep the time-label and `as_of` limitations, before rollout.

**Blocks on the complete Phase B product (unfinished work, not passed):**
- **Application read path.** The aggregation and read protocol, complete paging, stale/updating responses without figures, a full-state refresh after RPCs, and recovery without another sync. The five todo tests and three expected failures remain unmet acceptance work. They were not removed or altered.
- **Institution removal.** Institution-removal conversion, and concurrency with the remaining input-changing writers, under a separately reviewed history-preserving lifecycle design.
- **User-facing surface.** API and frontend reasons, actions, ranges and review UI; conflict resolution; authenticated user mapping; and the Phase A backfill audit.

**Limits of the existing evidence:**
- **S1 preservation run.** It found 17 unchanged snapshots, but `transaction_splits`, `transaction_carryovers` and `card_payment_decisions` were **empty** there. It is not proof of preservation for populated rows in those tables, and it is not a full-catalog identity proof: it does not fingerprint table ownership or all function metadata.
- **S1 postconditions.** They do **not** prove "exact policies unchanged". They check RLS enablement, two named SELECT policies, and the absence of policies on three tables. They do not check policy expressions, roles, extra policies, owners or forced RLS. The sentence at `S1_CLIENT_TABLE_PRIVILEGE_HARDENING.md:49` overstates this. That file is part of S1's reviewed delta and is deliberately not edited here; this paragraph is the correction of record until a separately authorized edit.
- **S1 default-privilege guard.** It does not detect a future-table grant acquired through an inherited group role. It is accepted only for the recorded baseline, where the client roles have no memberships.
- **a16.** It samples behaviour and relies on the catalog check for the full matrix. The seven self-review gaps keep the dispositions given in the S1 independent review.
- **Performance.** C1's residual performance cost, the K whole-user evaluations per multi-item sync, and connection-lifetime setting-name growth are accepted development limits. Hosted throughput is unmeasured.

## 5. Explicitly deferred follow-ups

- **Other tables' client grants:** `category_mappings`, `loans`, `manual_loan_payments`, `net_worth_snapshots`, `recurring_streams`, plus a full catalog sweep. S1 is not a database-hardening certification.
- **`supabase_admin` default privileges** in `public`: a different owner, platform-managed, not touched.
- **`c02`–`c11`:** the same sleep-and-elapsed-time pattern as the old c01. Convert them in a separately authorized packet.
- **S1 guard strengthening** (exact policy identity, inherited defaults), or the documentation qualification at `S1_CLIENT_TABLE_PRIVILEGE_HARDENING.md:49`.
- **Historical statuses left as written:** `P2_C1_IMPLEMENTATION_HANDOFF.md:361` still calls performance acceptance open. It was since accepted for this development stage, and C2 is deferred. The stale `PRODUCTION_HEAD` default in `README.md` is also unchanged.
- **C2** (statement-level triggers): deferred.
- **The original c01 failure's cause:** unexplained.

## 6. Validation

Each result below is attributed to the source it actually tested. Nothing in the first table was re-run for revision 2.

### 6.1 First pass (before the focused review)

All database runs used disposable local containers of the pinned image `public.ecr.aws/supabase/postgres:17.6.1.155`. They ran one at a time, and no run was retried.

| Check | Command | Exit | Result |
|---|---|---|---|
| Repeated c01. Parameters fixed before execution: 10 repetitions, each in a fresh container, sequential, 1,800-second total timeout | `bash supabase/tests/access_control/run.sh c01`, ten times, via the scratch driver `repeat_c01.sh` | 0 each | **10 passed, 0 failed, 0 not run**; 326 seconds in total |
| Negative control, one run. Scratch mirror only: the holder commits its claim before announcing, so it holds no lock | the same runner on the mirror, `c01` | 1 (expected) | **FAIL as intended:** `COORDINATION TIMEOUT: pid 505 was not blocked by pid 498 within 00:00:30`, with the session snapshot |
| Complete access-control suite, once | `bash supabase/tests/access_control/run.sh` | 0 | **41 passed, 0 failed** (16 SQL tests, 25 concurrency cases) |
| Focused unit file for the wrapper | `npx vitest run src/services/cardPaymentEvaluation.test.ts` (CI placeholder environment) | 0 | 17 passed |
| Backend typecheck | `npm run typecheck --workspace backend` | 0 | pass |
| Whitespace | `git diff --check` | 0 | clean |

**The source those runs tested.**
- **c01:** the two c01 files as they are now (blobs `778cf46e…` and `55af3177…`), unchanged since before the first run.
- **Wrapper:** the first-pass wrapper, blob `b7d82f02…`. Revision 2 has since changed three lines of it (§6.2).
- **Documents:** the two edited documents were final before the first run. This handoff was written during and after the runs; no test reads it.
- **How the attribution is established:** by the manifest, matching file copies and corroborating file times. The run logs contain no per-run file hashes, so the binding is not cryptographic.

**What the saved evidence contains, and what it does not.**
- **Source-file copies:** full copies of the changed files, with their Git blob ids.
- **Commands and result records:** the driver script with its fixed parameters, each repetition's exit code and duration, and the full-suite exit record.
- **Successful cases:**
  - The complete-suite log is the full suite console.
  - It holds execution transcripts for the successful **SQL** tests.
  - For the successful **concurrency** cases, including c01, it holds **PASS summary lines only**. The unchanged runner prints holder, contender and verify transcripts only on failure.
  - Each of the ten repetition logs is likewise a short console with a PASS summary, not a c01 SQL transcript.
- **Failure diagnostics:** the negative control's failure transcript is retained in full, including the coordination-timeout message and the session snapshot.
- **Not captured:** successful-case SQL transcripts for the concurrency tests, the process ids observed in the passing c01 runs, a Docker inventory after each run, and separate exit transcripts for the unit test and typecheck (their exits are recorded in the manifest).

A PASS line is still meaningful: the runner prints it only after the seed, holder, contender and final verification have all succeeded. It is a summary, though, not a transcript, and nothing here claims that passing-case transcripts were captured or inspected.

**Why the negative control was added.** Ten passes show the corrected test is stable when the overlap exists. They do not show that it fails when the overlap is missing, which is the property the removed timing assertion was meant to supply. The control is an early-commit, no-overlap control in a scratch mirror. It is not a mutation of the production claim function, and no repository file was changed for it.

**Reading these results.**
- The 41-passed run validates the first-pass working tree, with the corrected c01. The earlier 41-passed result remains evidence for the S1 snapshot at `221ccd5`, not for this diff.
- Ten successful repetitions support reliability under these observed local conditions. They are a finite sample, not proof of stability under every scheduling condition, and they do not explain the original failure.
- The scratch driver has no aggregate failure exit. The 10-of-10 result rests on each repetition's recorded exit and the counters, not on the driver's own exit code.
- The 17 wrapper tests mock the client. They support unchanged behaviour. They do not test real transport or server behaviour, or the corrected wording.

### 6.2 Revision 2 (after the focused review)

Revision 2 changed three lines of the wrapper (one comment, and one diagnostic message at two call sites) and this handoff. Because a diagnostic string changed, the existing focused unit file was run once.

| Check | Command | Exit | Result |
|---|---|---|---|
| Focused unit file for the wrapper, once | `npx vitest run src/services/cardPaymentEvaluation.test.ts` (CI placeholder environment) | 0 | 17 passed, against wrapper blob `0d29c844…`; the test file is unchanged from `221ccd5` |
| Whitespace | `git diff --check` | 0 | clean |
| c01 freeze | content hashes of `holder.sql` and `contender.sql` before and after revision 2 | — | identical |

**Not re-run for revision 2, by instruction:** every Docker or database suite, the repeated c01 check, the negative control, the backend typecheck and the broader application suites. The first-pass results above are reused as recorded. They are not fresh runs.

### 6.3 Revision 3 (one comment-only correction)

Revision 3 changed one two-line comment in the wrapper (lines 80–81) and this handoff. No test was run, as instructed.

| Check | Method | Result |
|---|---|---|
| The wrapper's only change since revision 2 is its comment | `diff` of the wrapper against the revision-2 copy | lines 80–81 only |
| Executable content is unchanged | Static comparison: both versions transpiled with comments removed | identical output |
| Whitespace | `git diff --check` | clean (exit 0) |
| c01 freeze and protected paths | content hashes, and `git diff --quiet 221ccd5 -- <protected paths>` | unchanged |

**Wrapper identities, and what each was tested with:**

| Wrapper blob | Revision | Tests run against it |
|---|---|---|
| `b7d82f02…` | first pass | the first-pass 17-test run and typecheck (§6.1) |
| `0d29c844…` | revision 2 | the 17-test run of §6.2 |
| `9ca7b7c2…` | revision 3 (current) | **none** |

The current wrapper differs from the revision-2 wrapper only in the comment at lines 80–81. The 17-passed result of §6.2 belongs to blob `0d29c844…`. It is not a run against the current blob, and it is not relabelled as one.

### 6.4 Not performed at all

- The SQL/TypeScript equivalence suite, the Phase A suites, the migration replay, and the full backend suite and build. No migration, SQL function or evaluated behaviour changed; the only runtime-file edits are comments and diagnostic message text.
- The C1 benchmark, mutation suite and rehearsal.
- Anything hosted, any GraphQL check, and the gates in §4.
- Hosted CI: nothing was pushed, so no CI ran on this working tree.

## 7. Unchanged checkpoints

Verified locally after the last change:
- **S1:** `feature/client-table-privilege-hardening` is at `221ccd52a9581c48fc33de7521c96d7b4c830c50`, and its worktree is clean.
- **C1:** `feature/phase-b-c1-bump-coalescing` is at `1aab2d8bb8f537f4df952231c078e9944a7c73fd`, and its worktree is clean.
- **This branch:** HEAD is still `221ccd5`. Nothing is committed or staged.
- **SQL function bodies:** the C1 migration has Git blob `05a45d1e1745004eb5954270b20638b23b5e8ec6` at `1aab2d8`, at `221ccd5` and in this working tree. Nothing under `supabase/migrations`, `supabase/rollback` or `supabase/preflight` differs from `221ccd5`.
- **S1's four files:** unchanged.
- **Harness and CI:** the test runner, the helpers, c01's `seed.sql` and `verify.sql`, and `.github/workflows` are unchanged.
- **c01:** both files are frozen as the focused review saw them.
- **Remote state:** not re-verified in revision 2. During the first pass, `git ls-remote` showed C1 at `1aab2d8` and no remote branch for S1 or for this closeout branch. Local refs are not a fresh statement about the remote.

**Changed files in this working tree (uncommitted):**

| File | Kind | Changed in revision 2? | Changed in revision 3? |
|---|---|---|---|
| `supabase/tests/access_control/concurrency/c01_concurrent_claim/holder.sql` | test coordination | no | no |
| `supabase/tests/access_control/concurrency/c01_concurrent_claim/contender.sql` | test coordination | no | no |
| `backend/src/services/cardPaymentEvaluation.ts` | comments and diagnostic message text (four messages, six call sites) | yes: lines 123, 124, 165 | yes: lines 80–81, comment only |
| `CARD_PAYMENT_PAIRING_DESIGN.md` | wording | no | no |
| `PHASE_B_MATCHING_ENGINE_HANDOFF.md` | wording | no | no |
| `PHASE_B_REVIEW_CLOSEOUT.md` | new: this document | yes | yes |

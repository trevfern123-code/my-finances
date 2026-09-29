# Pending-to-posted continuity: release closeout

Release date: September 28, 2026 America/Phoenix (September 29 UTC).

## Production release

- [PR #6](https://github.com/trevfern123-code/my-finances/pull/6) merged approved head
  `007971d` as `a1b4120c592d3d163957c9ff446172250647c9c5`.
- Migration `20260927120000` was applied once, before deploying the new backend. Postflight verified
  six columns, five RPCs, six indexes, the trigger, RLS and grants. Both legacy RPC fingerprints
  were unchanged. This closeout does not change or reapply any migration.
- Railway and Vercel deployed the merge; backend health and frontend build markers were verified.
- [Main CI #54](https://github.com/trevfern123-code/my-finances/actions/runs/36516207720) is green:
  build-and-test, database-harness and migration-replay passed. The replay retry completed on
  2026-09-29 at approximately 04:11 UTC with **11 passed, 0 failed**. Earlier failures occurred
  downloading the PostgreSQL image, before assertions, and were resolved by the successful retry.

## Live Sandbox evidence

Trevor linked a new First Platypus Bank dynamic Sandbox connection. Only that connection was used.
Through the deployed UI, one pending transaction was categorized, cleared, categorized again and
approved; another had its mapped category deliberately cleared. One Sandbox refresh then exercised
the deployed webhook/sync path.

- The first transaction posted at the same amount, retaining its user category and approval (K1).
- The second posted at the same amount, retaining NULL / user and its review state (K14).
- Read-only database checks verified the new posted identities, original pending rows absent,
  consumed carryovers and preserved category sequence values. Full app reload confirmed both.
- Trevor separately approved permanent cleanup. The app confirmed removal of this test connection:
  seven accounts, 349 transactions, five recurring payments and two loan/credit detail records.
  The four pre-existing institutions remained listed.

## Automated closeout coverage

Trevor selected repeatable automated coverage for the remaining approval-clears-warning check,
rather than another live Sandbox connection:

- `frontend/src/App.production.test.tsx` exercises the actual App, feed and API client against a
  stateful fake network boundary. Success dismisses the warning only after the response; a fresh
  App mount and GET keep it dismissed. Failure preserves the warning and review state across
  reload. The original pending amount remains informational history, and reload never re-approves.
- `supabase/tests/access_control/sql/a06_pending_posted_continuity.sql` separately calls the real
  approval RPC on K2's amount-changed row, reads the persisted result, rejects a different owner,
  preserves amounts/category and checks repeated approval. CI runs this against throwaway
  PostgreSQL using the full migration history, never the production database.
- `supabase/tests/replay/run.sh` advances the default production head to `20260927120000`, matching
  the completed rollout. Clean replay still applies all migrations; production-state replay now
  verifies an up-to-date database applies none. The explicit override remains supported for
  rehearsing older production states.

The closeout PR's CI checks are the gate for these test-only changes. They add no application
behavior, runtime dependency, deployment setting, production fixture or schema change.

## Boundaries

The two live cases had unchanged amounts. Changed amounts, split/loan edge cases, races and replay
are covered by automated suites; this record does not claim every case was exercised live. The
new approval/reload test uses fake auth/network and separate real-database assertions, not a single
live browser-to-production-database changed-amount scenario.

Financial Semantics Phase B and eventual retirement of the legacy batch RPC are separate work.
Retain the existing rollback procedure in the design; do not drop `user_role_override_at`.

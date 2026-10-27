# My Finances — shared coding-agent instructions

Applies to this repository. Complements the **current scoped work packet** and existing design docs; it is not permission to edit, run tools, or publish. Read only task-relevant material, not every linked document on every turn.

## Purpose and architecture

- Deliver a trustworthy **personal financial pilot**: balances/net worth, transactions, budgets, Safe to Spend, bills/subscriptions, goals, and debt. Defer public scale, native mobile, and optional AI.
- Stack: Express/TypeScript, React/Vite, Supabase/PostgreSQL/Auth, Plaid. Keep provider secrets and service-role credentials backend-only; verify ownership even when using service-role access.
- Prefer deterministic, explainable figures with source drill-downs, exclusions, freshness, coverage, and uncertainty. Never reconstruct authoritative finances from display-only guesses.

## Existing development process — do not reinvent it

1. Start from the approved work packet. Check current source and actual Git/CI evidence; old handoffs and designs do not prove implementation or release.
2. Before **authorized edits**, verify repository/worktree, branch, HEAD, status, protected worktrees, and exact file allowlist. Stop on mismatch; never reset, rebase, or clean up to make a check pass.
3. One builder per surface; independent cross-family review for material financial, security, migration, or lifecycle changes. Reviewers do not edit the builder's candidate without separate scope.
4. Make the smallest change within the packet. Avoid extra agents, incidental refactors, dependencies, duplicated documentation, or tests outside approved scope.
5. Keep design, builder claims, executed tests, independent review, commit, push, CI, integration, and release distinct. Never invent pass results or current production state.

## Financial contracts — preserve in every relevant change

- Missing, stale, partial, malformed, unknown, or ambiguous is **not** zero, complete, or proof of absence. Expose appropriate uncertainty/freshness.
- Preserve user decisions, categories, splits, active/inactive confirmations and reservations across sync, pending-to-posted continuity, removal, and relink. Excluded accounts can still provide matching evidence. Transfers and card payments are not automatically spending/income.
- Manual-loan removal/unlink reverses the **exact applied balance amount**, not the stated principal or an assumed legacy amount.
- Institution removal uses **strict pre-removal preservation** versus **best-effort ordinary final evaluation**. Failed final evaluation may leave committed cleanup with stale derived figures; timeout/unknown outcome is separate.
- Historical matching protection is source-specific: resolving A must never erase independent source B. Unknown attribution, legacy and rollback gaps stay unresolved.
- **P-Y** requires explicit user authorization to permanently release named historical matching protections and source dependencies. **P-D** requires separately identifiable authorization to retire removed-destination evidence. Neither implies the other; correspondence is evidence, not consent.
- Account/institution descriptions, masks, amounts, dates, and merchant similarity—even exact similarity—are not cross-relink historical identity proof.
- Before recovery activation, require the **narrow E7 relink-review safeguard** and reachable user-assisted recovery; provenance capture alone implements neither. Do not globally freeze ordinary matching.

## Execution, privacy, and handoff boundaries

- Use synthetic, owner-scoped fixtures and minimized sanitized evidence. No secrets, tokens, or raw financial/customer data in prompts, logs, or exports.
- Execute installs, downloads, tests, services/Docker, machine changes, and agents **only inside expressly authorized scope**. A command listed in a document is not execution permission.
- Obtain **separately scoped approval** for staging/commit, push, PR writes, merge, hosting, hosted DB access/migrations, deployment/activation, resets/rebases, and cleanup. One-shot permission is consumed by an attempt; do not silently retry.
- On timeout or unknown write outcome, investigate using the original operation identity; do not duplicate financial actions.
- Freeze final inputs and preserve failing evidence. Docs-only updates do not automatically require new runtime tests. Report actual path/branch/HEAD, changed paths, checks run/skipped/blocked, uncertainties, unchanged boundaries, and exact next action.

## Existing documentation — use when relevant

- `README.md`, `package.json`, workspace package files, `.github/workflows/ci.yml`: setup, commands, CI (verify current contents).
- `backend/`, `frontend/`, `supabase/migrations/`, `supabase/tests/`, `supabase/rollback/`: source and validation.
- `CARD_PAYMENT_PAIRING_DESIGN.md`, `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md`, `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md`: payment matching, removal, provenance, and later policy amendments.
- `PHASE_B_I1_BACKEND_READ_PATH.md`, `PHASE_B_I2_FRONTEND_INTEGRATION.md`: snapshot consistency and server-derived UI semantics.
- `PENDING_POSTED_CONTINUITY_DESIGN.md`, `PENDING_POSTED_CONTINUITY_RELEASE.md`: pending-to-posted behavior and its tested limits.

Where intended product policy and verified source behavior differ, report the gap; neither alone establishes authorization to change or release the other.

---
name: risk-based-review
description: Risk-based workflow for TallyPulse code work. Use before modifying, debugging, refactoring, reviewing or testing TallyPulse code - planner, query engine, semantic catalog, analytics, scoring, validation, APIs, database logic, tests, diff reviews, regressions, or choosing which checks to run. Inspects the diff, rates risk and blast radius, picks the relevant verify-* suites, checks for regressions, preserves unrelated changes, and reports PASS, BLOCKED or NEEDS HUMAN DECISION. Not for explanations, learning questions or docs-only answers.
---

# Risk-based review (TallyPulse)

`CLAUDE.md` stays the authority; this skill only orders the work. Keep authorized, routine, reversible steps moving
without asking again. Stop and ask only for a real ambiguity, a high-risk operation, a scope change or an approval
boundary (section 6).

## 1. Inspect the change (read-only)
1. From the repository root: `git status --short --untracked-files=all`, `git diff --stat`, `git diff --cached --stat`.
2. Separate **this task's** changes from **pre-existing** ones (other modified or untracked files). Record both; touch only
   this task's files.
3. Read the actual diff of this task's files, narrowly (sections, not whole files), per `CLAUDE.md` rules 1-3.
4. Never print `.env`, keys, credentials, authorization headers or real tenant data while inspecting.

## 2. Rate risk and blast radius
| Risk | Typical files | Why |
|---|---|---|
| **High** | `backend/src/services/query/*` (planner, `semanticCatalog`, `queryPlan.schema`, `validator`, `compile`, `execute`), `services/analytics/*`, `services/sync/*`, `services/tally/*`, `middleware/*`, `services/auth/*`, `models/*`, controllers/routes | changes answers, tenant isolation, auth or stored data |
| **Medium** | frontend `src/`, `server.js`, operator scripts (`backend/*.js` that write data) | user-visible or operational |
| **Low** | `backend/eval/*`, `eval-nlu-models.js`, `verify-*.js`, docs, `.env.example` comments | no production path (confirm nothing under `src/` requires it) |

Blast radius: search who requires the changed module (`grep -rn "require(.*<module>" backend/src backend/verify-*.js`),
and whether the change alters a prompt, schema, catalog meaning, tenant scope or a stored field.
Escalate one level when the change touches tenant scoping, auth, secrets handling or money/amount semantics.

## 3. Select tests from the repository (no full suite)
1. Map changed areas to suites with `docs/PROJECT_CONTEXT.md` section K (test map) and by grepping `verify-*.js` for the
   changed module. Prefer the narrowest suites that exercise the change, plus direct dependents.
2. Always: `node --check` on changed JS files and `git diff --check`.
3. Planner/prompt/catalog changes: include `verify-planner-digest.js` (prompt size and catalog rules) and
   `verify-query-planner.js`; scorer/eval changes: `verify-nlu-eval.js` (offline self-check) and the eval suites that use it.
4. A new rule needs a check that fails without the change (a negative check), not just one more passing test.
   Do not add tests only to raise counts.
5. Do not rerun unchanged suites whose code did not change (`CLAUDE.md` rule 3).

## 4. Verify safely
- MongoDB suites run only against a loopback test database, e.g. `MONGODB_URI=mongodb://127.0.0.1:27017/tallypulse_test`;
  the test-mode guard refuses anything else - never bypass it, never point tests at Atlas. No local MongoDB -> **BLOCKED**.
- No live model calls (Claude/Anthropic, OpenRouter, NVIDIA) unless the user asked in this session; prefer stubs and saved
  artifacts. Tally: read-only, one request at a time. No production Mongo writes without explicit approval.
- Regression check: compare before/after results of the same suites; for scoring or semantic changes, replay saved
  artifacts offline when they exist. A suite that prints SKIP/PARTIAL did not prove its skipped section.
- Report checks exactly as run: passed, failed, skipped/partial, not run, could not run (and why).

## 5. Preserve unrelated changes
- Never `reset`, `stash`, `restore`, `checkout --`, `clean` or overwrite files this task did not change, unless the user
  names them.
- Stage only the files the user named; show `git diff --cached` when asked; generated artifacts stay git-ignored.

## 6. Approval boundaries (unchanged from CLAUDE.md and the user's instructions)
Ask first, every time, for: commit, push, PR, merge, deploy; any paid or live model/API call; production data writes;
weakening a validator, guard, test assertion or security check; changing scope; deleting or rewriting credentials,
history or others' work. Routine, reversible, already-authorized steps (reading, editing the files in scope, focused
offline checks) need no repeated confirmation.

## 7. Report
Use the `CLAUDE.md` headings (ROOT CAUSE/RESULT, CHANGED, TESTED, COST, STATUS) and end STATUS with exactly one of:
- **PASS** - risk rated, relevant checks ran and passed, regressions checked, unrelated changes untouched.
- **BLOCKED** - a check could not run or failed (say which, with the exact output line), or a dependency is missing.
- **NEEDS HUMAN DECISION** - ambiguity, a high-risk choice, a scope change, or an approval boundary from section 6.
Distinguish verified facts from assumptions, list files changed, and state that nothing was committed or pushed unless
the user authorized it.

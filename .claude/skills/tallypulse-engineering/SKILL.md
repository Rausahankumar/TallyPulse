---
name: tallypulse-engineering
description: Engineering discipline for TallyPulse behaviour changes - a feature, a fix, an investigation improvement or a regression. Use before designing or changing code that affects answers, planning, evidence, follow-ups, analytics or the chat UI. Covers a lightweight spec (problem, real execution path, contract, plan, tasks, verification), root-cause debugging, design guardrails (no arbitrary thresholds or question-specific rules), tests of the actual failure mode, and honest evidence levels in the report. Works with risk-based-review (which picks the checks and the report format). Not for explanations, docs-only answers or one-line edits.
---

# TallyPulse engineering

`CLAUDE.md` is the authority (context file first, narrow reads, approval boundaries, report headings). `risk-based-review`
orders the checks and the final status. This skill is about reasoning: what to change, why, and how to prove it.

## 1. Understand the problem before the code
1. Restate the user's problem in one or two lines, with one concrete failing example (their words, their figures).
2. Trace the REAL execution path for that example (question -> planner -> validator -> executor -> evidence ->
   investigation -> answer -> presentation), citing `file:line`. Read what the code does; do not assume from names.
3. Name the root cause as a specific code path or missing data flow. If it is unclear, say so and gather evidence
   (a focused replay or test) instead of guessing.
4. Ask one concise question only for a genuine ambiguity or a decision that is the user's. Otherwise proceed.

## 2. Lightweight spec (for anything beyond a small fix)
Write it in the conversation (not as files, unless asked), short:
- **Contract:** the behaviour after the change, including what must NOT happen (unsupported claims, fabricated values,
  intent drift).
- **Out of scope:** what this change deliberately leaves alone.
- **Plan:** the smallest change through existing mechanisms; the files it touches.
- **Acceptance checks:** the failing example, realistic variations (including Hinglish phrasing), and negative cases.
For a large, multi-step feature the user may ask for Spec Kit instead (if installed); do not add it unasked.

## 3. Design guardrails
- Make the smallest justified change. Reuse the planner, validator, follow-up state, evidence record and the bounded
  investigation loop before adding anything new.
- Do not substitute reasoning with arbitrary thresholds, keyword lists, regex routers, predefined action templates or
  question-specific heuristics. If a constant is truly needed, derive it from the catalog or data, name it, and report it
  as a judgment call that real data has not validated.
- Preserve: tenant scope from the auth context only; validated queries and execution limits; the accounting basis
  (invoice totals incl. tax vs pre-tax line values, sales vs purchase value, quantity vs money); provenance (every figure
  from a validated step); zero vs missing vs unavailable vs unknown; measured vs contributor vs possible cause vs proven
  cause; follow-up context; the model never states figures.
- Keep investigations bounded (rounds, steps, model calls, time). A comparison stays a comparison; recommendations only
  when asked and only from evidence that supports them.

## 4. Root-cause debugging
Reproduce first (a failing synthetic test or a replay of the reported conversation) -> trace -> hypothesis -> confirm
with evidence -> fix the cause, not the symptom -> keep the reproduction as a regression test. A fix that only makes the
symptom disappear is not done.

## 5. Tests that prove the change
- Synthetic fixtures only (no real tenant data). Test the actual failure mode, realistic user phrasings, and negatives.
- When behaviour intentionally changes, rewrite old assertions to the new contract; never delete them to go green.
- Mutation check: disable the new code path and confirm the new tests fail; restore it exactly.
- Run the affected `verify-*` suites, `eval-investigations.js` when evidence/investigation/planner behaviour changes,
  and the frontend build when the UI changes. Report exact counts, including pre-existing failures.

## 6. Evidence levels - never conflate them
State which level each claim rests on: synthetic tests | scripted model | real model (paid: needs approval) | real
data (read-only: needs approval). Passing synthetic tests do not show that a real model plans well or that real data
behaves the same. Never claim success, a fix or an improvement without the output that shows it.

## 7. Scope and approvals
- One focused improvement per task; no repeated broad audits; no unrelated cleanup; preserve other sessions' and the
  user's uncommitted changes.
- Never commit, push, merge, deploy, write to production data, make paid model calls or live Tally calls without explicit
  approval in the current session. Never read `.env` or print secrets.
- Update `docs/PROJECT_CONTEXT.md` only when behaviour, a rule or a capability actually changed, and only after the
  implementation and tests agree.

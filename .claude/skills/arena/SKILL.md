---
name: arena
description: Arena for hard TallyPulse engineering decisions - several independent candidate solutions to the same brief, adversarial judging against a fixed rubric, evidence-based selection, then verification. Use only when the user asks for an arena, or for a costly, genuinely open problem with several plausible approaches (a design choice, a bug with competing hypotheses) and the user agrees to the extra cost. Not for routine fixes, small edits or questions with one obvious answer. Uses Claude Code's own subagents; no external scripts or network calls.
---

# Arena (TallyPulse)

Several candidates cost several times the tokens of one attempt. Before running, tell the user the candidate count and that
it costs roughly that many times a normal attempt, and get a yes (unless they asked for an arena in this message).
`CLAUDE.md`, `tallypulse-engineering` and `risk-based-review` still apply to every candidate and to the result.

## 1. Frame (lead, before any candidate starts)
- The problem in 2-4 lines, the concrete failing example, constraints (no commit/push/deploy, no paid model or live Tally
  calls, no production writes, tenant isolation, accounting basis, no arbitrary thresholds or question-specific rules).
- A rubric of 3-6 criteria with the EVIDENCE each needs (for example: "fixes the reported conversation - shown by test X";
  "no regression - suites A, B pass"; "no new threshold or keyword rule"; "smallest change - files touched").
- Candidate count: 2 by default, 3 at most.

## 2. Choose the mode
- **Proposal mode (default when the checkout has uncommitted work, as TallyPulse usually does):** worktrees are cut from
  the last commit, so candidates there would not see the current changes. Candidates read the current checkout
  READ-ONLY and return a design plus a unified diff in their report; they edit no file.
- **Worktree mode (only when the work they need is committed):** each candidate runs with `isolation: "worktree"`,
  implements there, runs the named suites, and reports its diff and results. Nothing is merged without the user.

## 3. Generate (independent)
Start each candidate with the Agent tool as a FRESH agent (not a fork, so it does not inherit the lead's preferred idea),
all with the same brief: problem, failing example, constraints, rubric, mode, the `verify-*` suites to run, and "report:
approach, diff, test output, risks, what you could not verify". For diversity, either leave the approach open or give each
a different starting hypothesis - never the lead's own answer.

## 4. Judge (adversarial, blind)
Start one fresh read-only reviewer agent with all candidates labelled A/B/C (no authorship). It scores each criterion
from the evidence only, and for every candidate tries to break it: a counterexample question, a missing case, a hidden
threshold, a tenant or accounting violation, an unsupported claim. A criterion without evidence scores zero.

## 5. Select, graft, verify (lead)
- Pick the base with the best evidenced score; graft a piece from another candidate only if it is verified on its own.
- Apply the chosen change in the main checkout only when the user approves (proposal mode: after showing the diff);
  then run the suites from `risk-based-review` and the mutation check from `tallypulse-engineering`.
- Report: the rubric table (scores and evidence per candidate), why the others lost, what was verified and at which
  evidence level, the cost (agents run), and anything left open. Never present an unverified candidate as the answer.

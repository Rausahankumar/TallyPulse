# TallyPulse: working rules

1. **Context first:** read `docs/PROJECT_CONTEXT.md` before anything else. Do not explore the repository to understand the project.
2. **Read narrowly:** read only files that can affect the task. Search for specific symbols before opening large files, and read sections, not whole files.
3. **Change and test narrowly:** make the smallest safe change and reuse existing patterns. Run only the affected test suites, with filtered output. Do not rerun unchanged suites.
4. **Live budget:**
   - Tally is read-only and bounded, one request at a time.
   - Call Claude/Anthropic zero times unless asked.
   - No production Mongo writes without explicit approval.
   - No real tenant data in fixtures.
5. **No new infrastructure without proof:** no Redis, queues, workers or abstractions unless it is proven the existing architecture cannot do it.
6. **Keep the context file current:** update `docs/PROJECT_CONTEXT.md` (concisely) only when architecture, a data model, a semantic rule, a capability or a limitation changes. It must never hold logs, test counts or run state.
7. **Git:** never commit, push or open PRs unless told to in the current session. Run git from `D:\TallyPulse`, never from `backend/`.
8. **Final report:** use the headings ROOT CAUSE/RESULT, CHANGED, TESTED, COST (Tally calls, Claude calls) and STATUS. Then STOP: no unrelated work or suggestions.

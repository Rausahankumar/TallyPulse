# TallyPulse

TallyPulse syncs accounting data out of a locally running **TallyPrime** into **MongoDB** and serves it through deterministic analytics, dashboards, reports and an **Ask AI** chat. Every number a user sees is computed by code from that user's own synced data; the language model only turns a question into a structured query.

```
Tally ──► incremental sync + reconciliation ──► MongoDB (one tenant per Tally company)
                                                   │
        question ─► Claude planner ─► Query Plan ──┤  validate ─► resolve names ─► coverage/freshness
                                                   ▼
                              compile + execute (tenant-scoped aggregation) ─► deterministic answer
```

## What is in the repository

| Path | Contents |
|---|---|
| `backend/` | Express 5 API, sync / reconciliation / self-heal workers, analytics, the Ask AI query pipeline, `verify-*.js` test suites |
| `frontend/` | React 19 + Vite + Tailwind 4 app: dashboard, analytics, reports, sync status, Ask AI |
| `docs/` | `TALLYPULSE_TECHNICAL_DOCUMENTATION.md` (full reference), `PROJECT_CONTEXT.md` (short map of the code), `SEMANTIC_FOUNDATION.md` (what the AI engine's terms mean) |
| `TallyPulse-Security-Audit.md` | Security audit, fix log and the runnable probes' register |
| `.github/workflows/ci.yml` | CI: backend suites against a throwaway MongoDB, frontend lint, build and checks |

## Run it locally

Requirements: a current Node.js LTS, a MongoDB database, and TallyPrime with its HTTP gateway enabled (default `http://localhost:9000`) for the sync features. An Anthropic API key is needed only for Ask AI.

```bash
cd backend
npm install
cp .env.example .env        # fill in MONGODB_URI, JWT_SECRET and, for Ask AI, ANTHROPIC_API_KEY
npm start                   # API on :5000, plus the sync and reconciliation workers

cd ../frontend
npm install
npm run dev                 # http://localhost:5173
```

Register an account, then use **Connect Tally** with the company open in TallyPrime. Configuration reference: [`backend/.env.example`](backend/.env.example). The real `.env` is git-ignored and must never be committed.

## Tests

There is no test framework: each suite is a plain script that prints one line per check and exits non-zero on failure.

```bash
cd backend && node verify-query-planner.js       # any single suite
cd frontend && npm run lint && npm run build && node verify-chat-rendering.mjs
```

Suites use synthetic tenants that they create and remove themselves; point `MONGODB_URI` at a throwaway database when running them. Suites that need a live TallyPrime or call the billed Claude API are listed in the technical documentation (§13) and are never run by CI.

## Documentation

Start with [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) for a map of the code, then the [technical documentation](docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md) for architecture, data model, API and operations. Working rules for AI-assisted development are in [`CLAUDE.md`](CLAUDE.md).

| Document | Status | Use it for |
|---|---|---|
| [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) | **Maintained** | The short, current map: code layout, data model, rules that must not break, limitations, open items |
| [`docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md`](docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md) | **Maintained** | Full reference: architecture, API, sync, testing and CI (§13), status and dated work log (§15), risks (§16) |
| [`docs/SEMANTIC_FOUNDATION.md`](docs/SEMANTIC_FOUNDATION.md) | **Maintained** | What the query engine's time, comparison and party terms mean |
| [`TallyPulse-Security-Audit.md`](TallyPulse-Security-Audit.md) | Historical record | Audit findings (F-xx) and probe ids (SEC-xx) that code comments and `verify-security-audit.js` cite |
| [`docs/CODE_WALKTHROUGH_HINGLISH.md`](docs/CODE_WALKTHROUGH_HINGLISH.md), [`docs/TALLY_TO_MONGO_FILES.md`](docs/TALLY_TO_MONGO_FILES.md) | Explanatory | Beginner walkthroughs in Hinglish; check the code or the maintained docs for current detail |
| [`docs/CODE_REFERENCE.md`](docs/CODE_REFERENCE.md) | Snapshot (2026-10-15) | Per-file function list; its generator is not in the repository, so it is not kept current |
| `docs/*.excalidraw`, `docs/TallyPulse_Architecture_Handover.pptx` | Snapshots | Architecture diagrams and the handover deck |

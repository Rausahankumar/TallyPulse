# TallyPulse backend

Node.js (CommonJS) + Express 5 + Mongoose 9. Entry point: `server.js`, which connects MongoDB, mounts the routes under `/api/*` and starts the sync, reconciliation and self-heal workers in the same process.

```bash
npm install
cp .env.example .env     # fill in MONGODB_URI, JWT_SECRET, and ANTHROPIC_API_KEY for Ask AI
npm start                # node server.js
npm run dev              # nodemon server.js
```

## Layout

| Path | Role |
|---|---|
| `src/controllers`, `src/routes`, `src/middleware` | HTTP layer: auth, import, Tally connectivity, sync status, vouchers, analytics, reports, chat |
| `src/services/odbc`, `parser`, `mapper`, `tally` | The Tally HTTP/JSONEx client, parsing and mapping, master refreshes, company ownership checks |
| `src/services/sync` | Incremental sync worker, reconciliation, self-heal, recovery, idempotent persistence |
| `src/services/analytics` | Deterministic aggregations, period math, freshness and coverage (REST analytics and reports) |
| `src/services/query` | Ask AI: Claude planner → Query Plan → validation → compile → execute → deterministic answer |
| `src/models` | Mongoose models (every tenant-owned document carries `tenantId`) |
| `eval/nlu-corpus.json` | Planner evaluation corpus (synthetic names) |
| `verify-*.js` | Verification suites, run with plain `node` |
| `refresh-*.js`, `run-adjustment-note-sync.js`, `migrate-*.js` | Operator scripts (master refreshes, one-off migrations) |

See the [technical documentation](../docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md) for the architecture, data model, API reference and the list of test suites, and [`../docs/PROJECT_CONTEXT.md`](../docs/PROJECT_CONTEXT.md) for the code map.

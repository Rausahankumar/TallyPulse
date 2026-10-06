---
name: tallypulse-backend
description: "Use when working on the TallyPulse backend: Express routes, MongoDB models, the Tally sync workers, the analytics layer, the Ask AI query pipeline, and startup/runtime debugging in the backend folder."
---

# TallyPulse Backend Agent

You work on the backend of TallyPulse (Node.js CommonJS, Express 5, Mongoose 9). Read `docs/PROJECT_CONTEXT.md` first; it maps the code, the data model and the rules that must not be broken.

## Responsibilities
- Fix and extend Express routes, controllers and middleware.
- Keep the Tally sync, reconciliation and master-refresh code correct and bounded (one Tally request at a time, narrow ranges).
- Keep every read and write tenant-scoped (`tenantId` comes from the authenticated company context, never from the request body, Tally data or the model).
- Work on the Ask AI pipeline in `backend/src/services/query/`: Claude only plans (one forced `submit_query_plan` call); validation, name resolution, coverage, compilation, execution and the answer text are deterministic.

## Working rules
- Prefer minimal, targeted changes and reuse existing patterns; keep CommonJS (no ES modules in the backend).
- Never put real tenant data, credentials or generated exports in the repository; configuration lives in `backend/.env` (git-ignored), documented by `backend/.env.example`.
- Validate with the smallest `node backend/verify-*.js` suite that covers the change. Suites use synthetic tenants; set `AI_USAGE_PERSIST=off` for suites that exercise telemetry.
- Do not call Claude or TallyPrime from tests unless the task asks for it, and do not commit, push or open pull requests unless asked in the current session.
- Run git from the repository root, never from `backend/`.

## Project context
- Backend root: `backend/`, entry `backend/server.js`
- Routes: `backend/src/routes/`, controllers: `backend/src/controllers/`
- DB config: `backend/src/config/db.js`
- Docs: `docs/PROJECT_CONTEXT.md` (code map), `docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md` (full reference)

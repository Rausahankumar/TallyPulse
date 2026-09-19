---
name: tallypulse-backend
description: "Use when working on the TallyPulse backend, Express routes, MongoDB configuration, API endpoints, and startup/runtime debugging in the backend folder."
---

# TallyPulse Backend Agent

You work on the backend for the TallyPulse project.

## Responsibilities
- Inspect and fix Express route registration issues.
- Keep CommonJS patterns consistent with the existing project.
- Validate backend startup and route behavior with direct commands.
- Trace MongoDB and route setup together when debugging runtime errors.

## Working rules
- Prefer minimal, targeted changes.
- Check the actual exported value from route modules before mounting them in Express.
- Do not introduce ES module syntax in a CommonJS project unless the project is already configured for it.
- Validate with the smallest command that checks the behavior being fixed.
- Keep responses concise and implementation-focused.

## Project context
- Backend root: `backend/`
- Main entry: `backend/server.js`
- Route module: `backend/src/routes/importRoutes.js`
- DB config: `backend/src/config/db.js`

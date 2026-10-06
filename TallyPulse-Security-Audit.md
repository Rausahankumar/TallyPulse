# TallyPulse Security Audit

| | |
|---|---|
| **Audited code** | `backend/` (Node / Express 5 / Mongoose 9 / MongoDB Atlas) and `frontend/` (React 19 / Vite), as on `main` (commit `8460204`, PR #4 merged) |
| **Method** | Line-by-line code trace of every route, controller and service **plus** a runnable probe suite ([`backend/verify-security-audit.js`](backend/verify-security-audit.js)) that talks to an in-process copy of the API, a stub TallyPrime and synthetic data (prefix `verify-sec-`, fully cleaned up) |
| **Not touched** | No production code was changed. No real customer data, real Tally instance or real secret value was read or printed |
| **Result** | **74 probes: 74 secure, 0 vulnerable** (30 / 23 of 53 at the start of the fixes on 2026-09-21) (3 open companies simulated: Nirmal, WE FOUR, Intelli-Cart) |
| **Status** | Remediation in progress (2026-09-21): **17 of the 19 findings fixed and verified** (all Low findings included); **F-02** (database credentials — replaced at deployment) and **F-09** (a decision) remain — it needs you to rotate the MongoDB password. See [Section 0](#0-remediation-progress) |
| **Later changes** | `verify-analytics-and-ai.js`, named in the test tables below, was retired when the legacy Claude chat was removed; `verify-security-audit.js` remains the executable record of the probes. A database credential committed earlier (F-02) stays valid in anyone's copy of the old history until it is rotated in MongoDB Atlas, whatever is done to the history |
| **Audience** | A developer who is still learning security — every finding says *what*, *where*, *why it matters* and *how big the fix is* |

---

## Table of contents

**Part A — The report (read this first)**
0. [Remediation progress](#0-remediation-progress) — **what has been fixed so far, and what is still needed from you**
1. [Executive summary](#1-executive-summary)
2. [How to read this document](#2-how-to-read-this-document)
3. [Figures: how TallyPulse protects data](#3-figures-how-tallypulse-protects-data)
4. [Scorecard: all 28 layers at a glance](#4-scorecard-all-28-layers-at-a-glance)
5. [Findings register and fix roadmap](#5-findings-register-and-fix-roadmap)
6. [Finding details](#6-finding-details)
7. [What is working well](#7-what-is-working-well)
8. [Not verified](#8-not-verified)

**Part B — Layer-by-layer checklist (reference / test plan)**
9. [Layers 1–28](#9-layer-by-layer-checklist)

**Appendix**
- [A. Probe results (all 53)](#appendix-a-probe-results)
- [B. How to run the tests](#appendix-b-how-to-run-the-tests)
- [C. Final summary block](#appendix-c-final-summary-block)

---

## 0. Remediation progress

*Last updated 2026-09-21. This section is the running log of fixes: what was changed, how it was verified, and what is still needed from you. Findings are fixed one at a time, smallest safe change first. **Nothing has been committed or pushed.***

### 0.1 Status board

| ID | Finding | Status | What was done | Verified by | Still needed |
|---|---|:-:|---|---|---|
| **F-01** | Non-string identifiers reach MongoDB filters | ✅ Fixed | Text-type checks in `switchCompany`, `resolveAuthorizedCompany`, `login`, `register`, `addCompany` (2 files, +42 / −1 lines) | `SEC-INJ-1…6` and `SEC-VAL-1` flipped ❌→✅; existing suites pass; live server re-checked | Nothing for F-01 |
| **F-02** | Live secrets in Git history | 🛠 In progress | `JWT_SECRET` rotated; nested `backend/.git` moved out of the project; backend restarted. **You decided to replace the MongoDB URI and password at deployment (fresh database)** | Hash comparison: the committed `JWT_SECRET` no longer matches the live one | **You, at deployment:** create the new database user / URI, then **delete or re-password the old user** (see 0.4) |
| **F-03** | `/api/odbc/*` needed no login | ✅ Fixed | `auth` on both routes; `/sales` also needs a live company and answers only for the company Tally has selected | `SEC-AUTH-2, 3, 11, 12` | Nothing |
| **F-04** | No rate limiting | ✅ Fixed | New in-process limiter on login, register and the connect-company password check | `SEC-ABUSE-1…4`; live: ten `401`, then `429` | Behind a reverse proxy: set Express `trust proxy` |
| **F-05** | No minimum password strength | ✅ Fixed | `register` requires 8 characters or more and at most 72 bytes | `SEC-AUTH-9` | Nothing (existing passwords are unchanged) |
| **F-06** | Access removal not immediate | ✅ Fixed | Company access re-checked against the live account on every company request; new `liveCompanyContext` on sync, import, rename and odbc/sales routes | `SEC-AUTHZ-8, 9, 10` | Nothing |
| **F-07** | `multer` advisory | ✅ Fixed | `multer` 2.2.0 → 2.4.0 | `npm audit`: multer no longer listed | Nothing |
| **F-08** | Deleted user's token keeps working | ✅ Fixed | `auth.js` loads the account on every request and checks a session version (`User.tokenVersion` ↔ token claim `tv`) | `SEC-AUTH-6, 13, 14` | Nothing (a future change-password feature should raise `tokenVersion`) |
| **F-10** | Latent SSRF field | ✅ Fixed | New `tallyUrl.js`: Tally address must be http(s), no credentials, no link-local / metadata address — checked at save and at use | `SEC-TALLY-12, 13` | Nothing (a DNS name resolving to a blocked address is not caught) |
| **F-11** | Open CORS, no security headers | ✅ Fixed | New `httpSecurity.js`: `helmet()` + CORS allow-list from `CORS_ORIGINS` | `SEC-HTTP-1, 2, 3`; live incl. the Vite proxy | Set `CORS_ORIGINS` if the frontend is on another origin |
| **F-12** | Internal error text reaches clients | ✅ Fixed | New `errorHandler.js` + generic 500s in every catch-all; `companyName` and chat-id checks; upload filter is a proper 400 | `SEC-VAL-1, 2, 3, 4, 11, 12, 13` | Nothing |
| **F-13** | Uncapped live-import date range | ✅ Fixed | Range capped at 92 days, reversed / repeated dates refused before Tally is asked | `SEC-VAL-9, 14` | Nothing |
| **F-14** | Uploaded files never deleted | ✅ Fixed | Upload deleted after processing or refusal, before the response is sent | `SEC-LIFE-1, 2`, `SEC-VAL-13` | Optional: delete the 9 older files in `uploads/` (your data) |
| **F-15** | `comparisonType` validation | ✅ Fixed | **A false positive in the first audit**: the route already validated it; the probe was wrong and was corrected | `SEC-VAL-6, 15` | Nothing |
| **F-16** | "Email already registered" | ✅ Fixed | The reply no longer says the address is registered | `SEC-AUTH-10` | Residual accepted: full closure needs an e-mail verification step |
| **F-17** | Unused dependencies | ✅ Fixed | Removed `bcrypt`, `joi`, `winston`, `odbc`; `qs` 6.15.3 → 6.16.0 | `SEC-DEP-1`; `npm audit`: 0 vulnerabilities | Nothing |
| **F-18** | `.env` not git-ignored outside `backend/` | ✅ Fixed | New root `.gitignore`; `.env`, `.env.*` in the frontend and backend ones | `SEC-CONF-1` | Nothing |
| **F-19** | Logging basics | ✅ Fixed | Request id (`X-Request-Id`) in responses and error logs; failed-login and rate-limit lines; no library added | `SEC-LOG-1, 2` | Nothing |

**F-09** (no tenant data-deletion path) is **deliberately not implemented** — it needs a product/legal decision; options are in [Section 0.6](#06-medium-findings--fix-log--done). That is the only finding left open besides F-02.

### 0.2 Progress at a glance

```text
 Critical findings   ██████████░░░░░░░░░░   1 of 2 fully closed   (F-01 done · F-02 waits for the deployment credentials)
 High                ████████████████████   5 of 5 fixed
 Medium              █████████████████░░░   5 of 6 fixed          (F-09 needs your decision)
 Low                 ████████████████████   6 of 6 fixed

 Probes secure       ██████████████████████████████   74 of 74   (was 30 of 53 at the start)
```

### 0.3 F-01 — fix log (✅ done)

**Rule applied, in one line:** a value that must be a string is checked with `typeof x === "string"` *before* it is used in any MongoDB filter; anything else is a `400` input error.

**What changed**

| File | Change |
|---|---|
| `backend/src/controllers/authController.js` | `register`: name, email and password must be text. `login`: a non-text e-mail or password → `400` (a *missing* value still gets the generic `401`). `addCompany`: a non-text password is treated as "not provided" instead of crashing bcrypt. `switchCompany`: `companyGuId` must be text before it reaches the access check and the company lookup. |
| `backend/src/services/auth/companyContext.js` | `resolveAuthorizedCompany`: a requested company (header / query override) must be text — an array or object is refused with `400 "Invalid company identifier."` before any lookup. |

Total: 2 files, +42 / −1 lines. No schema, route, dependency or configuration change.

**Why this and nothing bigger.** The audit's grep of `req.body / req.query / req.params / req.headers` found exactly these entry points where a client value reaches an authorization-relevant filter; every other use is either a fixed comparison or never used in a tenant/user filter. `mongoose.set("sanitizeFilter", true)` was deliberately **not** enabled: it rewrites every operator in the code base, including legitimate `$in` queries, so it could break existing code paths; it can be considered later as a second layer, with tests.

**Before → after (`verify-security-audit.js`)**

| Probe | What it checks | Before | After |
|---|---|:-:|:-:|
| SEC-INJ-1 | switch-company rejects a non-string identifier | ❌ | ✅ |
| SEC-INJ-2 | no request shape yields a session for a tenant the user has no access to | ❌ | ✅ |
| SEC-INJ-3 | repeated `?companyGuId=` parameter refused, no foreign scope | ❌ | ✅ |
| SEC-INJ-4 | form-encoded non-string refused | ❌ | ✅ |
| SEC-INJ-5 | login rejects a non-string e-mail | ❌ | ✅ |
| SEC-INJ-6 | login answers a non-string e-mail with 400 | ❌ | ✅ |
| SEC-VAL-1 | non-string password on login → clean 4xx (a side benefit of the same guard) | ❌ | ✅ |
| **Suite total** | | **30 secure / 23 vulnerable** | **37 secure / 16 vulnerable** |

The 16 that remain vulnerable are all other findings (F-03, F-04, F-05, F-06, F-08, F-11, F-12, F-13, F-14, F-15, F-16). The plain-string authorization probes (`SEC-AUTHZ-1/2/3/6/7`) and all `SEC-TALLY-*` probes stayed ✅.

**Regression — every existing verification suite re-run after the change**

| Suite | Result |
|---|:-:|
| verify-company-identity | ✅ 96 / 96 |
| verify-company-ownership | ✅ 55 / 55 |
| verify-multi-company | ✅ 41 / 41 |
| verify-company-guid-match | ✅ 14 / 14 |
| verify-analytics-and-ai | ✅ 20 / 20 |
| verify-voucher-type-classification | ✅ 78 / 78 |
| verify-sync-batching | ✅ 57 / 57 |
| verify-self-heal | ✅ 56 / 56 |
| verify-voucher-recovery | ✅ 53 / 53 |
| verify-reconciliation-history | ✅ 45 / 45 |
| verify-reconciliation | ✅ 16 / 16 |
| verify-voucher-lifecycle | ✅ 14 / 14 |
| verify-reconciliation-perf-and-failure | ✅ 13 / 13 |
| verify-sync-worker-guard | ✅ 9 / 9 |
| verify-refactor | ✅ "Sync validation passed" |
| verify-duplicate-protection, verify-import-final, verify-import-flow, verify-real-multi-voucher | ⚪ already failing before this change — see below |

**The four legacy scripts that fail.** They call the import service directly and fail for older reasons: `Company GUID is required` (they call `importTallySales` without a company GUID, which the multi-tenant work made mandatory), `ns does not exist: users.sales` (an old database name), and a duplicate-key error from leftover test data. A load check confirmed none of the four ever loads `authController.js` or `companyContext.js`, so this fix cannot affect them. They were **not modified**.

**Live check on the restarted backend (port 5000)**

| Request | Result |
|---|---|
| switch-company with an object `companyGuId`, valid session | `400 companyGuId must be text` |
| login with an object e-mail / object password | `400 email and password must be text` |
| login with an unknown e-mail (unchanged behaviour) | `401 Invalid credentials` |
| register with an object name | `400 name, email and password must be text` |
| token signed with any secret other than the live one | `401` |

**Not done / residual**
- `companyName` in `updateCompanyName` still has no type check (`SEC-VAL-2` stays ❌) — that belongs to F-12.
- No separate new test file was added: the seven probes above in `verify-security-audit.js` are the regression tests (`node verify-security-audit.js --strict` will exit 0 for these once every open finding has been fixed).

### 0.4 F-02 — fix log (🛠 in progress — one step needs you)

**Correction to the original audit (important).** The first version of this audit said the committed secrets were "not on GitHub". Re-checked on 2026-09-21, that was too optimistic:

- The old proof-of-concept nested repo (`backend/.git`) contained a tracked `.env` whose `JWT_SECRET` and `MONGODB_URI` were identical to the live values. Its branch `feature/authentication` **was pushed to `origin` at some point** (a remote-tracking ref `origin/feature/authentication` contains that commit) even though that branch is not among GitHub's branches today.
- Separately, **commit `9a68a59` ("POC Ready", 2026-08-17) is in `main`'s history on GitHub** and added a `.env` whose MongoDB connection string has the **same cluster, user name and password** as the live one (only the default database name differs). No `JWT_SECRET` is in that file.
- The GitHub repository is **private** (checked with `gh repo view`). That limits who can read it, but everyone with access to the repository can.

So the database password must be treated as exposed.

**Done**

| Step | Result |
|---|---|
| Rotate `JWT_SECRET` in `backend/.env` | New 86-character random value (the old one was 21 characters). The committed copy no longer matches. **All existing login sessions are now invalid — everyone logs in again.** |
| Neutralise the nested repository | `backend/.git` moved to `D:\TallyPulse-retired-nested-git\backend.git`, outside the project. `git` inside `backend/` now uses the real repository at `D:\TallyPulse`, so a push from `backend/` can no longer publish that history. Nothing was deleted (to undo: move the folder back); working files are untouched. |
| Restart the backend | Restarted on port 5000 with the fixed code and the new secret (see the live check above). |

**Update (2026-09-21, later): you decided to replace the MongoDB URI and password at deployment, with a fresh database.** That ends the exposure only once the *old* credentials can no longer log in — so at deployment **delete the old database user (or give it a new password)**; creating a new user or cluster alone is not enough. Step 1 below still applies.

**Still needed — only you can do this**

1. Rotate the MongoDB Atlas database user's password (Atlas → *Database Access* → edit the user → new password). Percent-encode special characters when you put it into the URI.
2. Put the new value into `MONGODB_URI` in `backend/.env` — and in any deployed environment — then restart the backend. Also set the new `JWT_SECRET` in any deployed environment, otherwise those users are logged out.
3. Optional, later: delete `D:\TallyPulse-retired-nested-git` when you no longer need the old proof-of-concept history. Removing `.env` from Git history (commit `9a68a59`) would rewrite `main` and needs your explicit go-ahead; once step 1 is done the old password is worthless anyway.

**F-02 stays "In progress" until step 1 is done.**

**Verification.** A script compared SHA-256 hashes (values never printed): the live `JWT_SECRET` no longer matches the committed one ✅; the live `MONGODB_URI` still matches the committed one — expected until you rotate the password.

**One more thing to restart.** Two `node server.js` processes were running; only the one this session started (port 5000) was restarted. If you started another backend yourself, restart it so it also loads the new code and secret.

### 0.5 High findings — fix log (✅ done)

*Round 2, 2026-09-21: all five High findings, again smallest safe change first. Nothing committed or pushed.*

**What changed**

| Finding | Files | Change |
|---|---|---|
| F-03 | `backend/src/routes/odbcRoutes.js`, `backend/src/controllers/odbcController.js`, `frontend/src/api/odbc.js` (comment only) | `auth` on `/company` and `/sales`; `/sales` also runs `liveCompanyContext`, and `getSales` returns `403` unless the company Tally has selected is the caller's |
| F-04 | **new** `backend/src/middleware/rateLimit.js`, `backend/src/routes/authRoutes.js` | limiter on login, register and the connect-company password check |
| F-05 | `backend/src/controllers/authController.js` | `register` requires 8 characters or more and at most 72 bytes |
| F-06 | `backend/src/services/auth/companyContext.js`, `authRoutes.js`, `syncRoutes.js`, `importRoutes.js` | live access check in `resolveAuthorizedCompany`; new `liveCompanyContext` middleware on sync, import and rename routes |
| F-07 | `backend/package.json`, `backend/package-lock.json` | `multer` `^2.2.0` → `^2.4.0` (three transitive packages no longer needed were removed) |
| Tests / docs | `backend/verify-security-audit.js`, `backend/verify-analytics-and-ai.js` (one fixture), `docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md` | 7 new probes; fixture updated; outdated statements corrected |

**Design choices**
- **Limiter written by hand, not a package.** About 60 lines, no new dependency (less supply-chain surface), and enough for a single backend process. A shared store (Redis) is *not* needed and was deliberately not added.
- **Only failed attempts use up the login budget.** A successful request gives its slot back, so a person who logs in correctly is never locked out by their own logins. One account's failures do not lock other accounts.
- **F-06 rule.** The token only says who the user *was* when it was issued. On every company request the user must still exist, and the company must be their current default (on the `User`) or one they hold an access row for — also for a token that was switched to a non-default company.
- **`/api/odbc/sales` is owner-only, not just "logged in".** With authentication alone any signed-in user could read a *different* company's vouchers whenever that company was the one open in Tally.
- **72 bytes, not "any length".** bcrypt only uses the first 72 bytes; a longer password would be silently truncated, so it is refused.

**Before → after (`verify-security-audit.js`)**

| Probe | What it checks | Before | After |
|---|---|:-:|:-:|
| SEC-AUTH-2, 3 | `/api/odbc/company` and `/sales` need authentication | ❌ | ✅ |
| SEC-AUTH-6 | a deleted user's token stops working | ❌ | ✅ |
| SEC-AUTH-9 | 1 and 7 characters refused, 8 accepted, 73 refused | ❌ | ✅ |
| SEC-AUTHZ-8 | removing a user's access is immediate | ❌ | ✅ |
| SEC-ABUSE-1 | repeated wrong logins throttled (with `Retry-After`) | ❌ | ✅ |
| SEC-AUTH-11 *(new)* | a user of a non-selected company gets `403` from `/odbc/sales` | — | ✅ |
| SEC-AUTH-12 *(new)* | the selected company's owner still gets `200`; a company-less token gets `401` | — | ✅ |
| SEC-AUTHZ-9 *(new)* | a token switched to a non-default company stops when that access row is removed | — | ✅ |
| SEC-AUTHZ-10 *(new)* | a removed user's upload is refused and nothing is stored | — | ✅ |
| SEC-ABUSE-2 *(new)* | 15 correct logins in a row all succeed | — | ✅ |
| SEC-ABUSE-3 *(new)* | throttling one account does not lock another | — | ✅ |
| SEC-ABUSE-4 *(new)* | a registration flood is throttled | — | ✅ |
| **Suite total** | | **37 secure / 16 vulnerable** (of 53) | **50 secure / 10 vulnerable** (of 60) |

The 10 that remain vulnerable belong to other findings (F-11, F-12, F-13, F-14, F-15, F-16). One probe *fixture* changed: the mass-assignment probe (`SEC-AUTH-7/8`) registered a user with a 1-character password, which is now correctly refused, so it uses a valid one.

**Regression — existing suites re-run after the change:** `verify-company-identity` 96 / 96, `verify-company-ownership` 55 / 55, `verify-multi-company` 41 / 41, `verify-company-guid-match` 14 / 14, `verify-analytics-and-ai` 20 / 20 (after the fixture update below), `verify-voucher-type-classification` 80 / 80, `verify-sync-batching` 57 / 57, `verify-self-heal` 56 / 56, `verify-voucher-recovery` 53 / 53, `verify-reconciliation-history` 45 / 45, `verify-reconciliation` 24 / 24, `verify-voucher-lifecycle` 14 / 14, `verify-reconciliation-perf-and-failure` 13 / 13, `verify-sync-worker-guard` 9 / 9, `verify-refactor` passed — **0 failures**. The same four legacy import scripts as before still fail for their older, unrelated reasons (not touched).

**One existing test fixture was updated.** `verify-analytics-and-ai.js` (company-context section) built a token payload with no user id and no user record — which is exactly what F-06 now correctly refuses. Its fixture now creates a real user with that default company first; **every assertion is unchanged** (20 / 20).

**Live check on the restarted backend (port 5000)**

| Request | Result |
|---|---|
| `GET /api/odbc/company` and `/sales`, no token | `401` |
| valid signature, but the user does not exist (`/odbc/sales`, `/sync/status`) | `401 Invalid session` |
| register with a 7-character password | `400 Password must be at least 8 characters…` |
| 12 wrong logins for one address | ten `401`, then `429` with `Retry-After: 900` |
| a different address at the same moment | `401` (not throttled) |

**Behaviour changes you will notice**
1. Registering needs a password of **8 characters or more**.
2. **10 failed logins** for one e-mail from one address → `429` for up to 15 minutes. Counters are in memory, so a backend restart clears them.
3. Removing a user's access, or deleting a user, takes effect **immediately** — no waiting for the 7-day token.
4. `/api/odbc/sales` answers only for the owner of the company Tally has selected.
5. Behind a reverse proxy, set Express `trust proxy`; otherwise all users share one address and one limit.

**Not done / residual**
- `/api/sync/recovery` is not rate-limited (it keeps its in-flight guard).
- `/api/odbc/company` still lists Tally's open company *names* to any signed-in account.
- Existing weak passwords are not forced to change (there is no change-password feature yet).
- F-08 (early token invalidation) needs a design decision — see its finding.

### 0.6 Medium findings — fix log (✅ done)

*Round 3, 2026-09-21: five of the six Medium findings (F-08, F-11, F-12, F-13, F-14). The sixth, F-09, is a decision for you. Nothing committed or pushed.*

**What changed**

| Finding | Files | Change |
|---|---|---|
| F-11 | **new** `backend/src/middleware/httpSecurity.js`, `backend/server.js`, `backend/package.json` (+ `helmet` 8.3.0) | security headers (`helmet`) and a CORS allow-list (`CORS_ORIGINS`) |
| F-12 | **new** `backend/src/middleware/errorHandler.js`, `server.js`, `authController.js`, `chatController.js`, `importController.js`, `odbcController.js`, `syncStatusController.js`, `analyticsController.js`, `companyContext.js`, `upload.js` | one rule: clients only see messages we chose; unexpected errors are logged and answered with a generic 500 |
| F-13 | `backend/src/controllers/importController.js` | range check (max 92 days, reversed and repeated dates refused) before Tally is contacted |
| F-14 | `importController.js` | the uploaded file is deleted after processing or refusal, before the response is sent |
| F-08 | `backend/src/middleware/auth.js`, `backend/src/models/user.model.js`, `authController.js`, `companyContext.js` | account loaded on every request; `tokenVersion` / token claim `tv`; the loaded user is reused by the company check |
| Tests / docs | `backend/verify-security-audit.js`, `docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md` | 7 new probes, 2 probe expectations refined; technical docs corrected |

**Design choices**
- **`helmet` is a package this time** (the rate limiter was hand-written). Security headers are a solved, maintained problem with subtle defaults; a package is the safer route and adds no `npm audit` finding.
- **The probes test the real configuration.** `httpSecurity.js` and `errorHandler.js` are used by `server.js` *and* by the probe suite's in-process app, instead of a copy that could drift.
- **CORS fails closed.** Without `CORS_ORIGINS` only the local development origins are allowed. A deployed frontend on another origin must be listed, or browsers will block it.
- **92 days.** About a quarter; a wide voucher query is known to hang TallyPrime. It is one constant; longer periods are imported in pieces.
- **Delete the upload before responding.** Otherwise a client (or a test) could see the file still on disk after receiving its answer.
- **Session version, not a shorter expiry.** Raising `tokenVersion` revokes one account at once without logging everybody else out; a shorter expiry would have logged all users out more often. Old tokens count as version 0, so nobody is signed out by this release.
- **A database outage is not "bad token".** `auth.js` passes a database error to the error handler (a 500) instead of answering `401`, so an outage cannot sign users out.

**Before → after (`verify-security-audit.js`)**

| Probe | What it checks | Before | After |
|---|---|:-:|:-:|
| SEC-VAL-2 | a non-string `companyName` gets a clean 4xx | ❌ | ✅ |
| SEC-VAL-3 | an invalid chat id gets a clean 4xx (no model text) | ❌ | ✅ |
| SEC-VAL-4 | malformed JSON gets our own plain message | ❌ | ✅ |
| SEC-VAL-11 | a non-JSON upload is a client error | ❌ | ✅ |
| SEC-VAL-9 | a 36-year import range is refused before Tally | ❌ | ✅ |
| SEC-LIFE-1 | a processed upload is deleted from disk | ❌ | ✅ |
| SEC-HTTP-1 | CORS allows only the application's own origin(s) | ❌ | ✅ |
| SEC-HTTP-2 | standard security headers are set | ❌ | ✅ |
| SEC-AUTH-13 *(new)* | raising the session version signs the account out everywhere | — | ✅ |
| SEC-AUTH-14 *(new)* | a deleted user's token is refused even on `/api/odbc/company` | — | ✅ |
| SEC-VAL-12 *(new)* | an unexpected internal error is a generic 500 | — | ✅ |
| SEC-VAL-13 *(new)* | an 11 MB upload is `413` with a plain message, nothing left on disk | — | ✅ |
| SEC-VAL-14 *(new)* | 92 days accepted; 93 days, reversed and repeated dates refused | — | ✅ |
| SEC-LIFE-2 *(new)* | an upload that fails processing is also deleted | — | ✅ |
| SEC-HTTP-3 *(new)* | the own frontend origin still works; no `X-Powered-By` | — | ✅ |
| **Suite total** | | **50 secure / 10 vulnerable** (of 60) | **65 secure / 2 vulnerable** (of 67) |

The 2 that remain vulnerable are Low findings (F-15 `comparisonType`, F-16 e-mail enumeration). Two probe *expectations* were refined: `SEC-VAL-10` (uploads are now deleted, so it checks that nothing is written outside `uploads/` instead of that one file exists) and `SEC-VAL-4` (it now looks for parser internals — token, position — instead of the word "JSON", which our own message contains).

**Regression — existing suites re-run after the change:** see the table below (all pass; the same four legacy import scripts still fail for their older, unrelated reasons).

| Suite | Result |
|---|:-:|
| verify-company-identity | ✅ 96 / 96 |
| verify-company-ownership | ✅ 55 / 55 |
| verify-multi-company | ✅ 41 / 41 |
| verify-company-guid-match | ✅ 14 / 14 *(re-run on its own: it talks to the running backend, and my restart landed while it was starting)* |
| verify-analytics-and-ai | ✅ 20 / 20 |
| verify-voucher-type-classification | ✅ 80 / 80 |
| verify-sync-batching | ✅ 57 / 57 |
| verify-self-heal | ✅ 56 / 56 |
| verify-voucher-recovery | ✅ 53 / 53 |
| verify-reconciliation-history | ✅ 45 / 45 |
| verify-reconciliation | ✅ 24 / 24 |
| verify-voucher-lifecycle | ✅ 14 / 14 |
| verify-reconciliation-perf-and-failure | ✅ 13 / 13 |
| verify-sync-worker-guard | ✅ 9 / 9 |
| verify-refactor | ✅ "Sync validation passed" |
| verify-duplicate-protection, verify-import-final, verify-import-flow, verify-real-multi-voucher | ⚪ already failing before these changes (unchanged, not touched) |

**Live check on the restarted backend (port 5000)**

| Request | Result |
|---|---|
| `GET /` with `Origin: https://evil.example` | `200`, no `Access-Control-Allow-Origin`; `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` present; no `X-Powered-By` |
| `GET /` with `Origin: http://localhost:5173` | `Access-Control-Allow-Origin: http://localhost:5173` |
| malformed JSON body | `400 The request body is not valid JSON.` |
| valid signature, user does not exist | `401 Invalid session.` |
| login through the Vite dev proxy (`:5173`) | works (`401 Invalid credentials` for an unknown user) |

**Behaviour changes you will notice**
1. **`CORS_ORIGINS`**: if the frontend runs on a different origin than the API in production, list it there (comma-separated). Local development needs nothing.
2. **Live import**: at most **92 days** per request; a longer range gets a clear `400` telling the user to import in pieces.
3. **Uploads** disappear from `uploads/` once processed.
4. **Error messages** are plainer: server problems say "Something went wrong on the server. Please try again."; details are in the server log only.
5. **Sessions**: every authenticated request now reads the account once (one extra indexed read); a deleted user is refused everywhere.

**F-09 — why it was not implemented, and the options**
Deleting a tenant's data is destructive and policy-laden, and it interacts with things that are deliberate: vouchers are only soft-deleted because reconciliation, recovery and self-heal rely on that, and re-connecting the same Tally company **reuses** its tenant by GUID — so data that is "deleted" can be re-imported from Tally. Decisions needed first:
1. **Scope** — close the account only; erase one company's data; or erase everything including chats.
2. **Retention** — anything you must keep (invoices, audit trail) or must delete within a deadline.
3. **Confirmation** — e.g. password re-entry plus a typed company name.
4. **After deletion** — should re-connecting the same Tally company start empty (a tombstone that blocks reuse of the old tenant) or resume?

A sensible design once decided: one owner-only "delete company data" operation, with password re-entry and typed confirmation, run in batches, that removes the tenant's Sale, Purchase, checkpoint, chat and access records and marks the Company inactive under the existing re-registration rules. Until then an operator can delete a tenant's data by hand in Atlas.

**Not done / residual**
- F-09 as above; F-15 and F-16 (Low) are next.
- The **9 older files** in `backend/uploads/` were left (your data; safe to delete if not needed).
- `helmet`'s `Strict-Transport-Security` header is only honoured by browsers over HTTPS.
- `/api/sync/recovery` is still not rate-limited (see 0.5).

### 0.7 Low findings — fix log (✅ done)

*Round 4, 2026-09-21: all six Low findings (F-10, F-15, F-16, F-17, F-18, F-19). Nothing committed or pushed.*

**What changed**

| Finding | Files | Change |
|---|---|---|
| F-10 | **new** `backend/src/services/odbc/tallyUrl.js`, `backend/src/services/odbc/odbcService.js`, `backend/src/models/company.js` | Tally address validated at save and at the moment each of the nine Tally requests is built |
| F-15 | `backend/verify-security-audit.js` only | **false positive**: the probe was corrected and a real check added; no application code changed |
| F-16 | `backend/src/controllers/authController.js` | duplicate-registration reply no longer says the address is registered |
| F-17 | `backend/package.json`, `backend/package-lock.json` | `bcrypt`, `joi`, `winston`, `odbc` removed; `qs` 6.15.3 → 6.16.0 |
| F-18 | **new** root `.gitignore`, `frontend/.gitignore`, `backend/.gitignore` | real `.env` files (any `.env.*`) ignored everywhere; `.env.example` stays committable |
| F-19 | **new** `backend/src/middleware/requestId.js`, `errorHandler.js`, `rateLimit.js`, `authController.js`, `server.js` | request id in responses and error logs; failed-login and rate-limit lines |
| Tests / docs | `backend/verify-security-audit.js`, `docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md` | 7 new probes, 1 probe corrected; technical docs corrected |

**Design choices**
- **F-15 is closed by correcting the audit, not the code.** Before touching anything I re-checked the route: it already validated `comparisonType`; the probe had sent the parameter to a route that does not take it. Fixing a non-problem would have been the wrong call.
- **Tally address: allow localhost and the LAN, block link-local.** TallyPrime is a desktop application, so private addresses are the normal case; the dangerous ones are cloud-metadata addresses. The check runs where each request is built, so it fails closed even if a bad value reaches the database another way.
- **F-16 is mitigated, not fully closed — and the docs say so.** Without an e-mail verification step an endpoint that refuses duplicates can always be probed by elimination; the F-04 limits bound it.
- **Remove `odbc` too.** It was never imported (only in a commented-out block), and it carries a native build step.
- **F-19 without a logging library.** Request ids and a few security lines give the traceability that matters; rewriting every `console.*` call would be a large change for no security gain.

**Before → after (`verify-security-audit.js`)**

| Probe | What it checks | Before | After |
|---|---|:-:|:-:|
| SEC-VAL-6 | analytics query parameters are validated | ❌ *(probe error)* | ✅ |
| SEC-AUTH-10 | a duplicate registration does not say the address is registered | ❌ | ✅ |
| SEC-VAL-15 *(new)* | `comparisonType` is validated on all four routes that take it | — | ✅ |
| SEC-LOG-1 *(new)* | `X-Request-Id` generated / echoed / unsafe ones replaced; id in server-error bodies | — | ✅ |
| SEC-LOG-2 *(new)* | security log lines carry the id and never the e-mail or password | — | ✅ |
| SEC-TALLY-12 *(new)* | Tally address rules (http(s), no credentials, no link-local / metadata) | — | ✅ |
| SEC-TALLY-13 *(new)* | an unsafe address is refused at save **and** at use | — | ✅ |
| SEC-CONF-1 *(new)* | `.env` files and uploads are git-ignored everywhere; `.env.example` is not | — | ✅ |
| SEC-DEP-1 *(new)* | the four unused packages are gone | — | ✅ |
| **Suite total** | | **65 secure / 2 vulnerable** (of 67) | **74 secure / 0 vulnerable** (of 74) |

**Regression — existing suites re-run after the change:** see the table below (all pass; the same four legacy import scripts still fail for their older, unrelated reasons).

| Suite | Result |
|---|:-:|
| verify-company-identity | ✅ 96 / 96 *(one expectation's wording updated for F-16 — see below)* |
| verify-company-ownership | ✅ 55 / 55 |
| verify-multi-company | ✅ 41 / 41 |
| verify-company-guid-match | ✅ 14 / 14 |
| verify-analytics-and-ai | ✅ 20 / 20 |
| verify-voucher-type-classification | ✅ 80 / 80 |
| verify-sync-batching | ✅ 57 / 57 |
| verify-self-heal | ✅ 56 / 56 |
| verify-voucher-recovery | ✅ 53 / 53 |
| verify-reconciliation-history | ✅ 45 / 45 |
| verify-reconciliation | ✅ 24 / 24 |
| verify-voucher-lifecycle | ✅ 14 / 14 |
| verify-reconciliation-perf-and-failure | ✅ 13 / 13 |
| verify-sync-worker-guard | ✅ 9 / 9 |
| verify-refactor | ✅ "Sync validation passed" |
| verify-duplicate-protection, verify-import-final, verify-import-flow, verify-real-multi-voucher | ⚪ already failing before these changes (unchanged, not touched) |

**One existing test expectation was updated.** `verify-company-identity.js` asserted the exact wording "already registered" for a duplicate registration; F-16 intentionally removed that wording. Only the wording check changed (it now looks for "could not create this account"); the `400` status check is unchanged. The first regression run caught this (95 / 96) and it is 96 / 96 after the update.

**Live check on the restarted backend (port 5000):** `GET /` answers `200` with an `X-Request-Id`; a registration with a new address answers `201` (the synthetic address was removed afterwards).

**Behaviour changes you will notice**
1. **Registering an existing address** now gets "We could not create this account. If you already have one, sign in instead."
2. **Every response has an `X-Request-Id`**, and a server error's JSON now includes `requestId` — quote it to find the matching line in the server log.
3. **Failed logins and rate-limit hits** now appear in the server log (address and request id only).
4. **Git**: a real `.env` anywhere in the repository (including `frontend/`) is ignored; use `.env.example` for templates.
5. **`npm install`** no longer builds `odbc`'s native module.

**F-02 — your decision, and what it needs**
You said you will create a fresh database with a new URI and password when you deploy. That closes the exposure **once the old credentials can no longer log in**: a new database user or cluster only helps if the old user is then **deleted or given a new password** in Atlas — otherwise the old password (in pushed `main` history) still works. Use a fresh `JWT_SECRET` for the deployment too, and remember `CORS_ORIGINS` and Express `trust proxy` (see 0.5, 0.6). Until then the exposure stands; the audit keeps F-02 as *in progress* for that reason.

**Not done / residual**
- F-02 (deployment step) and F-09 (decision) as above.
- F-16 residual (elimination by the reply) — needs an e-mail verification step.
- F-10: a DNS name resolving to a blocked address is not caught; add a resolve-then-check step if a "configure Tally address" screen is ever built.
- The **9 older files** in `backend/uploads/` are still yours to delete.

### 0.8 Change log

| Date | Change | Where |
|---|---|---|
| 2026-09-21 | **F-01 fixed** — text-type checks | `authController.js`, `companyContext.js` |
| 2026-09-21 | Regression: existing suites pass; 4 legacy scripts fail for pre-existing reasons | `backend/verify-*.js` (unchanged) |
| 2026-09-21 | **F-02 (part 1)** — `JWT_SECRET` rotated | `backend/.env` (git-ignored, not committed) |
| 2026-09-21 | **F-02 (part 2)** — nested `backend/.git` moved out of the project | `D:\TallyPulse-retired-nested-git\backend.git` |
| 2026-09-21 | Audit corrected — F-02 evidence widened (pushed `main` history) | this document |
| 2026-09-21 | **F-03 … F-07 fixed** (High round) | see 0.5 |
| 2026-09-21 | **F-08, F-11, F-12, F-13, F-14 fixed** (Medium round); F-09 analysed, deliberately not implemented | see 0.6 |
| 2026-09-21 | **F-10 fixed** — Tally address validated at save and at use | new `tallyUrl.js`, `odbcService.js`, `company.js` |
| 2026-09-21 | **F-15 closed** — a false positive in the audit; probe corrected | `verify-security-audit.js` |
| 2026-09-21 | **F-16 fixed** — reply no longer says the address is registered | `authController.js` |
| 2026-09-21 | **F-17 fixed** — 4 unused packages removed; `qs` updated; `npm audit`: 0 | `package.json`, `package-lock.json` |
| 2026-09-21 | **F-18 fixed** — root `.gitignore`; frontend / backend ones extended | `.gitignore`, `frontend/.gitignore`, `backend/.gitignore` |
| 2026-09-21 | **F-19 fixed** — request id and security log lines | new `requestId.js`, `errorHandler.js`, `rateLimit.js`, `authController.js`, `server.js` |
| 2026-09-21 | 7 new probes, 1 corrected; technical docs corrected; backend restarted | `verify-security-audit.js`, `docs/` |
| 2026-09-21 | You decided to replace the MongoDB URI and password at deployment | F-02 stays *in progress* until the old credentials are deleted |
| — | **F-02 (final step)** — delete / re-password the old database user at deployment | *yours, at deployment* |

---
# Part A — The report

## 1. Executive summary

**In one sentence:** TallyPulse's hardest problem — making sure one company's Tally data can never land in another company's account — is solved and was tested hard. **17 of the 19 findings are now fixed and verified** (the code weakness rated Critical, all five High, five of six Medium and all six Low). Two are left, and both are yours: the live MongoDB password sits in Git history (**F-02** — you plan to replace it at deployment) and **F-09** (letting a tenant delete their own data) needs a product decision before it should be built.

### 1.1 Scoreboard

```text
 FINDINGS BY SEVERITY — open now  (█ open · ▒ fixed)

 Critical  █▒                       1 open · 1 fixed   F-02: replace the database credentials at deployment
 High      ▒▒▒▒▒                    0 open · 5 fixed   done
 Medium    █▒▒▒▒▒                   1 open · 5 fixed   F-09 needs your decision
 Low       ▒▒▒▒▒▒                   0 open · 6 fixed   done
 Not verified  ██████               6                  needs infrastructure review, not code

 PROBES (runnable tests in verify-security-audit.js)

 Secure      ██████████████████████████████   74   (was 30 at the start)
 Vulnerable                                    0   (was 23)
```

### 1.2 The three answers you asked for

| Question | Answer |
|---|---|
| **Most important security boundary** | The **company-ownership guard** (`src/services/tally/companyOwnership.js`). It checks that every voucher/master record Tally returns really belongs to the tenant's own company **before any database write**. It held in a live three-company test, in the reverse direction, and in a deliberate race-condition test. |
| **Most dangerous remaining weakness** | The **live MongoDB password is in Git history**, including `main` on GitHub (a private repository). It stays a risk until the credentials you use today can no longer log in — you plan to create a fresh database with a new URI and password at deployment; **delete or re-password the old database user then**, or the old password still works (**F-02**). Every code weakness is otherwise fixed and verified. |
| **First thing to fix** | At deployment: new database user / URI **and delete or re-password the old user**, a fresh `JWT_SECRET`, `CORS_ORIGINS` for the frontend, and Express `trust proxy` if there is a reverse proxy. Then decide **F-09** (tenant data deletion). |

### 1.3 What the findings meant, and where they stand

```text
   Every other control in TallyPulse ends up asking one question:
   "does this request carry a valid signed token for company X?"

      F-02  leaked signing secret / DB password  ─►  anyone holding them bypasses the app
            JWT_SECRET  ............... ROTATED (2026-09-21)
            nested backend/.git ....... MOVED OUT of the project
            MongoDB password .......... TO REPLACE AT DEPLOYMENT (you) ◄── the one open credential step

      F-01  un-typed identifier    ─►  a normal user could get a token for ANOTHER company   FIXED
      F-06 / F-08  slow revocation ─►  removed / deleted users kept access for up to 7 days    FIXED
      F-03  open /api/odbc/*       ─►  anyone on the network could read raw Tally vouchers     FIXED
      F-04 / F-05  no rate limit, no password rule  ─►  fast password guessing               FIXED
      F-07 / F-17  dependency advisories, unused packages  ─►  npm audit: 0 vulnerabilities  FIXED
      F-11 / F-12  open CORS, error text leaks  ─►  headers + allow-list, plain messages      FIXED
      F-13 / F-14  uncapped import range, uploads kept  ─►  92-day cap, files deleted        FIXED
      F-10 / F-16 / F-18 / F-19  SSRF field, e-mail probe, .env ignore, logging               FIXED
      F-15  "comparisonType not validated"  ─►  a false positive in the audit — corrected     CLOSED
      F-09  no tenant data delete  ─►  a policy decision, deliberately not built yet          OPEN (yours)
```

### 1.4 What is *not* wrong
- Password storage (bcrypt), token signature checking, mass-assignment, tenant filters on every Mongo query, chat isolation, AI tool scoping, worker locking, checkpoint safety and the Tally company guard all passed. Full list in [Section 7](#7-what-is-working-well).

---

## 2. How to read this document

### 2.1 Status labels (the "Answer" for each question)

| Label | Meaning |
|---|---|
| ✅ **PASS** | The code **and** (where one exists) a test prove the property |
| 🟡 **PARTIAL** | Holds in the common case, but a gap was demonstrated |
| ❌ **FAIL** | A probe reproduced the problem |
| ⚪ **NOT VERIFIED** | The repository does not contain enough to answer (usually infrastructure). Never guessed |

### 2.2 Severity scale

| Severity | Rule of thumb |
|---|---|
| 🔴 **Critical** | Breaks tenant isolation or authentication for everyone |
| 🟠 **High** | Real, easy-to-reach weakness with serious impact |
| 🟡 **Medium** | Real weakness, limited impact or needs other conditions |
| 🔵 **Low** | Hardening / hygiene, or currently unreachable |
| ℹ️ **Info** | Control confirmed working — not a finding |

### 2.3 Finding IDs and evidence IDs
- **F-01 … F-19** = findings (defined once, in [Section 5](#5-findings-register-and-fix-roadmap)).
- **SEC-AUTH-6**, **SEC-INJ-1** … = probes in `verify-security-audit.js`; each prints `[SECURE]` or `[VULNERABLE]`.

### 2.4 Ground rules used for this audit
1. Passing tests do **not** prove security — each claim was re-tested from the attacker's side.
2. No evidence is invented: anything not provable from the repo is **NOT VERIFIED**.
3. Secrets are never printed. Only presence, length and hash-equality were checked.
4. Recommendations stay small: **no Redis, queues, microservices or new infrastructure** unless a problem was demonstrated to need them.

---

## 3. Figures: how TallyPulse protects data

### Figure 1 — System overview and trust boundaries

```text
   UNTRUSTED                        SEMI-TRUSTED                       TRUSTED / PROTECTED
 ┌─────────────┐   HTTPS/JSON   ┌──────────────────────┐        ┌─────────────────────────┐
 │  Browser    │───────────────►│   Express API         │───────►│  MongoDB Atlas          │
 │  (React)    │  Bearer JWT    │   (Node, port 5000)   │ tenant │  Sale, Purchase, User,  │
 │  localStorage│               │                       │ scoped │  Company, Checkpoints…  │
 └─────────────┘                │  auth → companyContext │ queries└─────────────────────────┘
                                │  → controllers         │
                                │                       │        ┌─────────────────────────┐
 ┌─────────────┐   any origin   │  Workers (cron)       │        │  Anthropic API (chat)   │
 │ Any website │───────────────►│  sync 60s / recon 20m │───────►│  one tenant per request │
 │ (CORS: list)│  ✅ F-11        └──────────┬───────────┘        └─────────────────────────┘
 └─────────────┘                           │ HTTP JSONEx
                                           ▼
   ✅ F-03 fixed: /api/odbc/*  ┌──────────────────────────┐
     now needs a login         │  TallyPrime (customer PC) │  answers for the ONE company
                               │  localhost:9000            │  that is currently SELECTED
                               └──────────────────────────┘
        ▲                                                            ▲
        └── boundary 1: JWT + company access check                   └── boundary 2: company-ownership guard
```

**How to read it:** there are two real security boundaries. Boundary 1 (token + company access) is where F-01, F-03, F-04, F-05 and F-06 lived — all now fixed. Boundary 2 (ownership guard) is solid.

### Figure 2 — What happens to a normal API request

```text
   Request ─► [1] auth.js ───────────► jwt.verify (signature + 7-day expiry)          ✅ solid
                 │  (was missing on /api/odbc/*  ✅ F-03 fixed)
                 ▼
            [2] activeCompanyContext ─► which company may this user see?
                 │    reads x-company-guid header / ?companyGuId= / JWT claim
                 │    re-loads Company + checks UserCompanyAccess
                 │    ✅ F-01 fixed: the identifier must be text before any lookup
                 │    ✅ F-06 fixed: access re-checked against the live account
                 ▼
            [3] controller ───────────► tenantId comes from the SERVER, never from
                 │                       req.body / req.query / req.params           ✅ solid
                 ▼
            [4] Mongo query ──────────► always { tenantId, … }                       ✅ solid
                 ▼
            [5] response ─────────────► no password/secret fields
                                         ✅ F-12 fixed: errors are plain messages
```

### Figure 3 — The company-ownership guard (why cross-company data cannot be written)

```text
   Tally answers for the SELECTED company only. Three companies are open:
   Nirmal (selected) · WE FOUR · Intelli-Cart

   Tenant "WE FOUR" sync tick                       Voucher GUIDs come back as
   trusted GUID from MongoDB = WF-guid              "<NIRMAL-guid>-<masterId>"
            │                                                  │
            └─────────────►  validateBatchOwnership  ◄─────────┘
                             does EVERY guid start with "WF-guid-" ?
                                  │
                       NO ────────┴──────── YES
                        │                     │
        reject WHOLE batch              write to MongoDB
        · 0 writes                      · checkpoint advances
        · checkpoint NOT advanced         only after all writes succeed
        · logged (counts + 8-char prefix)
```

The same check protects **sync, recovery, reconciliation, self-heal, manual import and master-data caching** (see the table in Section 9, layer 6).

### Figure 4 — The three-company live test (what the probes proved)

```text
                        Nirmal selected in Tally          WE FOUR selected in Tally (reverse)
 Nirmal tenant          ✅ receives own vouchers          ❌ refused, 0 writes, checkpoint unchanged
 WE FOUR tenant         ❌ refused, 0 writes              ✅ receives own vouchers
 Intelli-Cart tenant    ❌ refused, 0 writes              ❌ refused, 0 writes

 Race test (SEC-TALLY-3/10): selection changes BETWEEN the master query and the voucher query
                        → the voucher-level check still refuses. Nothing is trusted from "earlier".
```

### Figure 5 — Where the vulnerable probes came from (23 at the start, 0 now)

```text
   Finding (probe IDs)                                  probes at the start
   F-01 type confusion         (SEC-INJ-1…6)             ██████  6
   F-12 error leakage          (SEC-VAL-1,2,3,4,11)      █████   5
   F-03 /api/odbc unauth       (SEC-AUTH-2,3)            ██      2
   F-11 CORS + headers         (SEC-HTTP-1,2)            ██      2
   F-13 / F-14 / F-15          (VAL-9, LIFE-1, VAL-6)    ███     3
   F-04, F-05, F-06, F-08, F-16 (one each)               █████   5
                                                        ──────────
                                                         23 at the start  →  0 now (74 of 74 secure)
   (F-15's probe was a test error, corrected in round 4.  F-02 nested .git, F-07 multer, F-17… are found
    by review / npm audit, not by an HTTP probe.)
```


### Figure 6 — Priority map (impact vs effort to fix)

```text
   HIGH IMPACT │  F-02 rotate secrets ½ done│  F-06 ✔ FIXED
               │  F-01 type check  ✔ FIXED   │  F-04 ✔ FIXED
               │  F-03 ✔ FIXED               │  F-07 ✔ FIXED
               │  F-05 ✔ FIXED               │
               │        ── DO FIRST ──       │      ── DO NEXT ──
   ────────────┼─────────────────────────────┼─────────────────────────────
   LOW IMPACT  │  F-15 ✔ (false pos.)        │  F-14 ✔ FIXED
               │  F-16 ✔ FIXED               │  F-13 ✔ FIXED
               │  F-17 ✔ FIXED               │  F-11 ✔ FIXED
               │  F-18 ✔ FIXED               │  F-12 ✔ FIXED
               │       ── QUICK WINS ──      │      ── WHEN CONVENIENT ──
               └────────── SMALL FIX ────────┴────────── MEDIUM FIX ─────────
```

---

## 4. Scorecard: all 28 layers at a glance

Legend: ✅ PASS · 🟡 PARTIAL · ❌ FAIL · ⚪ NOT VERIFIED

| # | Layer | Status | Worst risk | Findings | Section |
|---|---|:-:|:-:|---|---|
| 1 | Authentication | ❌ | 🔴 Critical | F-02 (F-03, F-04, F-05, F-08, F-16 fixed) | [9.1](#layer-1--authentication) |
| 2 | Authorization (IDOR/BOLA) | ✅ | ℹ️ | F-06, F-01 (both fixed) | [9.2](#layer-2--authorization-idor--bola) |
| 3 | Input-type validation / NoSQL | ✅ | ℹ️ | F-01 (fixed) | [9.3](#layer-3--input-type-validation--nosql-operator-confusion) |
| 4 | API input validation | ✅ | ℹ️ | F-12, F-13, F-14 (fixed); F-15 was a false positive | [9.4](#layer-4--api-input-validation-and-error-handling) |
| 5 | Tenant isolation (queries) | ✅ | ℹ️ | — | [9.5](#layer-5--tenant-isolation-mongodb-queries) |
| 6 | Tally company isolation | ✅ | ℹ️ | — | [9.6](#layer-6--tally-company-isolation) |
| 7 | Tally master-data isolation | ✅ | ℹ️ | — | [9.7](#layer-7--tally-master-data-isolation-caching) |
| 8 | MongoDB / NoSQL (indexes, projections) | ✅ | ℹ️ | F-01 (fixed) | [9.8](#layer-8--mongodb--nosql-security) |
| 9 | Data exposure in responses | ✅ | ℹ️ | (F-12 for error text) | [9.9](#layer-9--data-exposure-in-api-responses) |
| 10 | Secrets and configuration | 🟡 | 🔴 Critical | F-02 (F-18 fixed) | [9.10](#layer-10--secrets-and-configuration) |
| 11 | Logging | ✅ | ℹ️ | F-19 (fixed) | [9.11](#layer-11--logging-and-observability) |
| 12 | Error handling | ✅ | ℹ️ | F-12 (fixed) | [9.12](#layer-12--error-handling) |
| 13 | Tally connector / SSRF | ✅ | ℹ️ | F-10 (fixed) | [9.13](#layer-13--tally-connector-ssrf-surface) |
| 14 | Worker security | ✅ | ℹ️ | — | [9.14](#layer-14--worker-security) |
| 15 | Checkpoint / AlterID | ✅ | ℹ️ | — | [9.15](#layer-15--checkpoint--alterid) |
| 16 | Recovery | ✅ | ℹ️ | — | [9.16](#layer-16--recovery) |
| 17 | Reconciliation | ✅ | ℹ️ | — | [9.17](#layer-17--reconciliation) |
| 18 | Self-healing | ✅ | ℹ️ | — | [9.18](#layer-18--self-healing) |
| 19 | Race conditions (TOCTOU) | ✅ | ℹ️ | — | [9.19](#layer-19--race-conditions--toctou) |
| 20 | Cache security | ✅ | ℹ️ | — | [9.20](#layer-20--cache-security) |
| 21 | AI / analytics | ✅ | ℹ️ | — | [9.21](#layer-21--ai--analytics) |
| 22 | Frontend | ✅ | ℹ️ | — | [9.22](#layer-22--frontend) |
| 23 | CORS / HTTP headers | ✅ | ℹ️ | F-11 (fixed) | [9.23](#layer-23--cors--http-security) |
| 24 | Rate limiting / abuse | ✅ | ℹ️ | F-04 (fixed) | [9.24](#layer-24--rate-limiting--abuse) |
| 25 | Dependencies | ✅ | ℹ️ | F-07, F-17 (fixed) | [9.25](#layer-25--dependencies--supply-chain) |
| 26 | Data lifecycle | 🟡 | 🟡 Medium | F-09 (F-14 fixed) | [9.26](#layer-26--data-lifecycle) |
| 27 | Backups | ⚪ | not assessed | — | [9.27](#layer-27--backups) |
| 28 | Testing quality | ✅ | ℹ️ | — | [9.28](#layer-28--security-testing-quality) |

```text
 Layers:  ✅ 24    🟡 2    ❌ 1    ⚪ 1        (28)
          ████████████████████████  ██  █  █
```

---

## 5. Findings register and fix roadmap

### 5.1 Register

| ID | Sev | Status | Finding | Where | Fix size | Probe |
|---|:-:|:-:|---|---|:-:|---|
| **F-01** | 🔴 | ✅ Fixed | Non-string company identifier / e-mail reaches Mongo filters (tenant-scoping can be widened) | `authController.js` (`switchCompany`, `login`), `companyContext.js` | ~4 one-line checks | SEC-INJ-1…6 (now ✅) |
| **F-02** | 🔴 | 🛠 In progress | Live MongoDB password is in **pushed** Git history (`main`, commit `9a68a59`); a nested repo's history also held the live `JWT_SECRET` (now rotated) | `backend/.git` (moved out) and GitHub `main` history | rotate 2 secrets + remove folder | manual hash check |
| **F-03** | 🟠 | ✅ Fixed | `/api/odbc/company` and `/api/odbc/sales` need no login and return raw Tally data | `odbcRoutes.js` | add `auth` (1 line each) | SEC-AUTH-2, 3 (now ✅) |
| **F-04** | 🟠 | ✅ Fixed | No rate limit on login / register / recovery | `server.js`, routes | small (in-process limiter) | SEC-ABUSE-1 (now ✅) |
| **F-05** | 🟠 | ✅ Fixed | No minimum password strength (1-character password accepted) | `authController.js` `register` | 2–3 lines | SEC-AUTH-9 (now ✅) |
| **F-06** | 🟠 | ✅ Fixed | Removing a user's access does not take effect on the "own default company" path until the JWT expires | `companyContext.js` | remove one short-circuit | SEC-AUTHZ-8 (now ✅) |
| **F-07** | 🟠 | ✅ Fixed | `multer` has a high-severity npm advisory (DoS); used on the upload route | `package.json` | `npm update multer` | `npm audit` (multer gone from the report) |
| **F-08** | 🟡 | ✅ Fixed | A deleted user's token keeps working for up to 7 days | `auth.js` | small (token version or shorter expiry) | SEC-AUTH-6 (now ✅) |
| **F-09** | 🟡 | ⏳ Open | No way for a tenant to delete their own data | whole app | product decision | code review (needs a decision — Section 0.6) |
| **F-10** | 🔵 | ✅ Fixed | `Company.tallyConnection.baseUrl` is unvalidated (latent SSRF; **not reachable** from any API today) | `company.js`, `odbcService.js` | validate when a setter is built | none possible (SEC-TALLY-12, 13 ✅) |
| **F-11** | 🟡 | ✅ Fixed | `cors()` allows any origin; no security headers (`helmet`) | `server.js` | 2 lines | SEC-HTTP-1, 2 (now ✅) |
| **F-12** | 🟡 | ✅ Fixed | Internal error text (Mongoose model names, library messages) is returned to clients | several controllers | small | SEC-VAL-1, 2, 3, 4, 11, 12, 13 (now ✅) |
| **F-13** | 🟡 | ✅ Fixed | Manual live-import date range is not capped (a 10-year range is known to hang Tally) | `importController.js` | small | SEC-VAL-9 (now ✅) |
| **F-14** | 🟡 | ✅ Fixed | Uploaded business files are never deleted from `uploads/` | `upload.js`, `importController.js` | 1 line (`fs.unlink`) | SEC-LIFE-1 (now ✅) |
| **F-15** | 🔵 | ✅ Fixed | **False positive:** the purchase-comparison route already validates `comparisonType`; the probe hit a route that does not take it | `analyticsController.js` | 1 line | SEC-VAL-6 (false positive — SEC-VAL-6, 15 ✅) |
| **F-16** | 🔵 | ✅ Fixed | Register says "Email already registered" (account enumeration) | `authController.js` | 1 line | SEC-AUTH-10 (now ✅; residual accepted) |
| **F-17** | 🔵 | ✅ Fixed | Unused dependencies (`bcrypt`, `joi`, `winston`); `joi` carries a low advisory; `qs` moderate (transitive) | `package.json` | remove 2–3 lines | `npm audit` (npm audit: 0) |
| **F-18** | 🔵 | ✅ Fixed | No root `.gitignore`, and `frontend/.gitignore` does not list `.env` — a `.env` created there could be committed | repo root, `frontend/` | add 1 line | `git check-ignore` (SEC-CONF-1 ✅) |
| **F-19** | 🔵 | ✅ Fixed | Logging is bare `console.*` (no levels / request ids); `winston` declared but unused | `src/**` | later | code review (SEC-LOG-1, 2 ✅) |

**Count — open now:** 🔴 1 (F-02 — credentials replaced at deployment) · 🟠 0 · 🟡 1 (F-09 — needs your decision) · 🔵 0. **Fixed:** F-01, F-03 … F-08, F-10 … F-19 (17 findings, 2026-09-21).

> **Note on counts.** An earlier chat summary said "High 4, Medium 6, Low 4". This document re-classified consistently: `/api/odbc/*` (F-03) is counted as a High finding on its own, dependency hygiene moved to Low, and the `.gitignore` gap (F-18) and logging note (F-19) are counted as Low. The register shows the status of every finding; the log of fixes is in [Section 0](#0-remediation-progress).

### 5.2 Fix roadmap (ordered)

```text
 Legend:  ☑ done   ◐ partly done   ☐ open

 STEP 1  ─ Today, no code review needed ─────────────────────────────────────────
   ☑ Rotate JWT_SECRET                                           (F-02)  done 2026-09-21
   ☐ New MongoDB user / URI at deployment, then DELETE or        (F-02)  ◄ yours, at deployment
     re-password the old user
   ☑ Disconnect backend/.git; never push from it                 (F-02)  moved out 2026-09-21

 STEP 2  ─ Small code changes, high value (one PR) ──────────────────────────────
   ☑ typeof === "string" guard on companyGuId / email / password (F-01)  done 2026-09-21
   ☑ same check for companyName + generic error text             (F-12)  done 2026-09-21
   ☑ auth middleware on /api/odbc/*                              (F-03)  done 2026-09-21
   ☑ min password length                                         (F-05)  done 2026-09-21
   ☑ live access check instead of the JWT claim                  (F-06)  done 2026-09-21
   ☑ npm update multer                                           (F-07)  done 2026-09-21

 STEP 3  ─ Abuse protection ─────────────────────────────────────────────────────
   ☑ in-process rate limiter on login + register                 (F-04)  done 2026-09-21

 STEP 4  ─ Hardening (one PR) ───────────────────────────────────────────────────
   ☑ helmet + CORS allow-list                                    (F-11)  done 2026-09-21
   ☑ generic error messages, log details server-side             (F-12)  done 2026-09-21
   ☑ cap import date range                                       (F-13)  done 2026-09-21
   ☑ delete uploaded files after processing                      (F-14)  done 2026-09-21
   ☑ comparisonType (false positive) + generic duplicate message (F-15, F-16)  done 2026-09-21
   ☑ .gitignore for .env at repo root and in frontend/           (F-18)  done 2026-09-21

 STEP 5  ─ Housekeeping ─────────────────────────────────────────────────────────
   ☑ remove bcrypt / joi / winston (and odbc); qs updated        (F-17)  done 2026-09-21
   ☑ request id + security log lines                             (F-19)  done 2026-09-21
   ☑ token revocation: account check + session version          (F-08)  done 2026-09-21
   ☐ decide on a tenant data-deletion path                       (F-09)  ◄ your decision (options in 0.6)
   ☑ validate tallyConnection.baseUrl (at save and at use)       (F-10)  done 2026-09-21
```

**Do not build now (no demonstrated need):** Redis, message queues, microservices, a distributed rate limiter, a WAF, an identity provider.

---

## 6. Finding details

Each finding uses the same layout: **What · Where · Why it matters · How it was checked · Fix**.

### 🔴 F-01 — Non-string identifiers reach MongoDB filters — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** The original finding is kept below for the record; the fix and its evidence are in [Section 0.3](#03-f-01--fix-log--done).

- **What (original finding).** Values that must be plain strings (`companyGuId`, `email`) came straight from the request into MongoDB filters. Express parses JSON bodies, form bodies (`urlencoded extended:true`) and repeated query parameters into **objects and arrays**, and Mongoose passes those into the filter as query operators instead of rejecting them.
- **Where.**
  - `src/controllers/authController.js` — `switchCompany` used the *same* unchecked value in an access check scoped to the user **and** in a `Company.findOne` that is **not** scoped to the user.
  - `src/services/auth/companyContext.js` — `resolveAuthorizedCompany` (header / query override) followed the same pattern.
  - `authController.js` — `login` used `email` in `User.findOne({ email })`.
- **Why it mattered.** The access check and the data lookup could end up looking at *different* records, so a session could be issued for a company the user has no access to. That defeats tenant isolation for anyone who knows or can obtain another company's identifier.
- **How it was checked.** `SEC-INJ-1…6`, using synthetic companies only. Before the fix, `switch-company` with a non-string value returned HTTP 200 with a token scoped to another account's tenant, and the analytics route with a repeated `companyGuId` parameter returned another tenant's `totalSales`.
- **How it was fixed.** A `typeof … === "string"` check *before* the value reaches any filter:
  ```js
  if (typeof companyGuId !== "string") {
    return res.status(400).json({ success: false, message: "companyGuId must be text" });
  }
  ```
  Applied in `switchCompany`, `resolveAuthorizedCompany`, `login`, `register` and (for the password compare) `addCompany`. Two files, +42 / −1 lines.
- **Verification.** `SEC-INJ-1…6` and `SEC-VAL-1` flipped from `[VULNERABLE]` to `[SECURE]` (suite: 30/23 → 37/16); all 15 existing suites that ran before still pass; a live request to the restarted backend returns `400 companyGuId must be text`. Details and tables in Section 0.3.
- **Not done on purpose.** `mongoose.set("sanitizeFilter", true)` (it would rewrite legitimate `$in` queries everywhere — a possible second layer later, with tests) and the `companyName` type check (part of F-12).

### 🔴 F-02 — Live secrets in Git history — IN PROGRESS

> **Status: 🛠 In progress (updated 2026-09-21).** `JWT_SECRET` is rotated and the nested repository is moved out of the project. **You decided to replace the MongoDB URI and password at deployment, with a fresh database.** The exposure ends once the *old* credentials can no longer log in. Full log in [Section 0.4](#04-f-02--fix-log--in-progress--one-step-needs-you).

- **What.** Live credentials were committed to Git history in two places:
  1. The old proof-of-concept repository nested in `backend/` (branch `feature/authentication`, commit `8049f28`, and its `HEAD`) tracked a `.env` whose `JWT_SECRET` and `MONGODB_URI` were identical to the live values (SHA-256 comparison, values never printed). That branch **was pushed to `origin` at some point** (the remote-tracking ref `origin/feature/authentication` contains the commit), although it is not among GitHub's branches today.
  2. **Commit `9a68a59` ("POC Ready", 2026-08-17) in `main`'s history on GitHub** added a `.env` with a MongoDB connection string that has the **same cluster, user and password** as the live one (only the database name differs). No `JWT_SECRET` is in that file.
- **Correction to the first audit.** The first version said the secrets were "not on GitHub" and only reachable through the local nested repository. That was wrong: the database password is in pushed `main` history. The repository is **private** (`gh repo view`), which limits readers but does not remove the exposure.
- **Why it matters.** With `JWT_SECRET` anyone can sign a valid token for any user/company without logging in. With `MONGODB_URI` anyone reads or writes every tenant's data directly. Either bypasses every control in this document.
- **How it was checked.** `git log --all`, `git branch -a --contains`, `git ls-remote`, `gh repo view`, and hash / structure comparisons of the values (booleans only). One-time manual checks — they read the real secret, so they are deliberately not automated.
- **Done so far.**
  - ✅ `JWT_SECRET` rotated (86 random characters; the committed copy no longer matches). Everyone must log in again.
  - ✅ `backend/.git` moved to `D:\TallyPulse-retired-nested-git\backend.git` (nothing deleted; move it back to undo). `git` in `backend/` now uses the real repository.
  - ✅ Backend restarted with the new secret.
- **Your plan (deployment).** Create a fresh database with a new URI and password. **Make sure the old credentials stop working**: delete the old database user (or set a new password on it) in Atlas — a new database user or cluster on its own does not help if the old one can still log in. Use a fresh `JWT_SECRET` and set `CORS_ORIGINS` / `trust proxy` for the deployment. Optionally delete `D:\TallyPulse-retired-nested-git`, and consider removing `.env` from `main`'s history (commit `9a68a59`) — that rewrites `main` and needs your explicit go-ahead; after the old credentials are dead it is only tidiness.

### 🟠 F-03 — Two unauthenticated routes expose Tally data — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.5](#05-high-findings--fix-log--done).

- **Where.** `src/routes/odbcRoutes.js`: `GET /api/odbc/company` and `GET /api/odbc/sales` were mounted without `auth`.
- **Why it mattered.** An anonymous caller who could reach the port got the open-company list and **raw sales vouchers** (customer names, amounts) for whichever company Tally had open. Whether the port is reachable from outside is **not verified** (§8).
- **Checked by.** `SEC-AUTH-2`, `SEC-AUTH-3` (anonymous request returned 200 with a voucher) — now `401`.
- **How it was fixed.** `auth` on both routes. `/company` needs any signed-in account (it is used during onboarding, before a company is connected). `/sales` additionally needs a live, authorized company **and** answers only when that company is the one Tally has selected (`403` otherwise) — plain authentication alone would have let any signed-in user read a *different* company's vouchers whenever that company was the one open in Tally. New probes `SEC-AUTH-11` (a user of a non-selected company gets `403` and no vouchers) and `SEC-AUTH-12` (the selected company's owner still gets `200`; a company-less token gets `401`).
- **Residual.** `/company` still returns Tally's list of open company *names* to any signed-in account (no vouchers, no GUIDs).

### 🟠 F-04 — No rate limiting — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.5](#05-high-findings--fix-log--done).

- **Where.** Nothing in `server.js` or any route file throttled requests.
- **Why it mattered.** With F-05 (weak passwords) an attacker could guess passwords at full speed; registration could be spammed. Checked by `SEC-ABUSE-1`: 25 wrong passwords in ~2.7 s, 0 throttled.
- **How it was fixed.** A small in-process limiter, hand-written in the new `src/middleware/rateLimit.js` (about 60 lines, no new dependency): **login** — 10 *failed* attempts per client + e-mail and 100 per client, per 15 minutes; **register** — 20 attempts per client per hour; **connect-company** (it re-checks the account password) — 10 failed attempts per user per 15 minutes. A successful request gives its slot back, so correct logins never use up the budget. The 429 answer carries a `Retry-After` header. The key store is capped and swept so it cannot grow without bound.
- **Verified by.** `SEC-ABUSE-1` (25 wrong passwords → throttled, with `Retry-After`), `SEC-ABUSE-2` (15 correct logins in a row all succeed), `SEC-ABUSE-3` (throttling one account does not lock another), `SEC-ABUSE-4` (a registration flood is throttled). Live: ten `401` then `429` on the restarted backend.
- **Not covered / notes.** Counters live in memory, so they reset when the backend restarts. **Behind a reverse proxy**, set Express `trust proxy` so `req.ip` is the real client — otherwise every user shares the proxy's address. `/api/sync/recovery` is not rate-limited (it keeps its in-flight guard). No Redis or shared store: not needed at a single instance.

### 🟠 F-05 — No minimum password strength — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.5](#05-high-findings--fix-log--done).

- **Where.** `authController.js` `register` — hashing was correct (bcrypt, cost 10) but any length was accepted (`SEC-AUTH-9`: a 1-character password → 201).
- **How it was fixed.** `register` now requires at least **8 characters** and at most **72 bytes** (bcrypt only uses the first 72 bytes, so a longer password would be silently truncated — it is refused instead). The error message says so.
- **Verified by.** `SEC-AUTH-9`: 1 and 7 characters → `400`; 8 characters → `201`; 73 characters → `400`. The mass-assignment probe (`SEC-AUTH-7`) now registers with a valid password (its old 1-character fixture would be refused).
- **Note.** Existing accounts keep their current passwords; there is no "change password" feature yet, so weak existing passwords are not forced to change.

### 🟠 F-06 — Access removal is not immediate on the default-company path — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.5](#05-high-findings--fix-log--done).

- **Where.** `companyContext.js` `resolveAuthorizedCompany` checked the live `UserCompanyAccess` only for a *non-default* company; for the company named in the JWT the token's own claim was trusted. `syncStatusController`, `syncRecoveryController`, the import controller and `updateCompanyName` read `req.user.companyGuId` from the token directly.
- **Why it mattered.** "Employee left, access should be gone now" did not hold for up to 7 days (`SEC-AUTHZ-8`).
- **How it was fixed.** Access is now checked against the **live account on every company request**: the user must still exist, and the company must be their *current* default company (stored on the `User`) or one they hold a `UserCompanyAccess` row for. This also covers a token that was switched to a non-default company. A new middleware `liveCompanyContext` applies the same check to the routes whose controllers read the JWT claim (sync status and recovery, both imports, company rename); on the import routes it runs *before* the upload middleware, so a removed user cannot even store a file. Cost: one extra indexed read per request.
- **Verified by.** `SEC-AUTHZ-8` (default company removed → 403), `SEC-AUTHZ-9` (a token switched to a non-default company stops working when that access row is removed), `SEC-AUTHZ-10` (a removed user's upload is refused with nothing stored on disk). `SEC-AUTH-6` also flipped — see F-08.
- **Test fixture updated.** `verify-analytics-and-ai.js` built a fake token payload with no user behind it; that is exactly what is now (correctly) refused, so its fixture now creates a real user first. Its assertions are unchanged (20 / 20).

### 🟠 F-07 — `multer` high-severity advisory — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.5](#05-high-findings--fix-log--done).

- **Where.** `package.json`; used by `middleware/upload.js` on an authenticated route.
- **Checked by.** `npm audit --omit=dev`. Since the first audit the advisory database grew: at re-check `multer 2.2.0` had **four** advisories (crafted field names, file-descriptor leak on aborted uploads, file-size-limit bypass through an async `fileFilter` race, oversized array index in field names), all fixed from 2.3.0.
- **How it was fixed.** `multer` `^2.2.0` → `^2.4.0` (installed 2.4.0). Three transitive packages the new version no longer needs were removed from the lock file. No application code changed.
- **Verified by.** `npm audit --omit=dev` no longer lists `multer` (remaining: `qs` moderate and `joi` low — see F-17); the upload probes (`SEC-VAL-10`, `SEC-VAL-11`, `SEC-LIFE-1`, `SEC-AUTHZ-10`) behave as before.

### 🟡 F-08 — Deleted user's token keeps working — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21** (mostly mitigated by F-06 in round 2, completed in round 3). Log in [Section 0.6](#06-medium-findings--fix-log--done).

- **Where.** `auth.js` verified the signature and expiry only; tokens live 7 days and carried no revocation marker.
- **How it was fixed.** (1) Round 2 (F-06): every company-scoped route re-checks the live account, so a deleted user already got `401`. (2) Round 3: `auth.js` now loads the account on **every** authenticated request — a deleted user is refused even on routes that only need a login (`/api/odbc/company`) — and compares a **session version**. `User.tokenVersion` (new field, default 0) is copied into each token as `tv`; raising it signs the account out everywhere at once (the lever a password change or an account lock will use). Tokens issued before this change carry no `tv` and count as 0, so existing sessions stay valid. The user record is reused by the company-context check, so this costs **one** extra database read per request, not two. A database *problem* is passed to the error handler (a 500), never answered as "bad token", so an outage cannot sign everyone out.
- **Verified by.** `SEC-AUTH-6` (deleted user), `SEC-AUTH-13` (raising `tokenVersion`: old token `401`, fresh login `200`), `SEC-AUTH-14` (deleted user's token refused on `/api/odbc/company`).
- **To sign an account out everywhere today:** in Atlas set `{ $inc: { tokenVersion: 1 } }` on the user. There is no change-password endpoint yet; when one is added it should do this itself.

### 🟡 F-09 — No tenant data-deletion path — OPEN (needs a decision)

> **Status: ⏳ Open — deliberately not implemented in round 3.** This is a product / legal decision, not a bug. Options and a recommended design are in [Section 0.6](#06-medium-findings--fix-log--done).

Vouchers are only ever soft-deleted (deliberate: reconciliation, recovery and self-heal depend on that), and no endpoint lets a tenant delete their data. Whether that matters depends on legal obligations (§8). Building a deletion feature without the decisions below would risk destroying data by accident and would interact badly with GUID-based tenant reuse, so it was left for you to decide.

### 🔵 F-10 — Latent SSRF field — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21** (defence in depth — the field was not reachable from any API). Log in [Section 0.7](#07-low-findings--fix-log--done).

`Company.tallyConnection.baseUrl` is the destination of every Tally request, and it was used with no scheme or network check. No API can set it today, so it was not exploitable; the risk was the *next* feature.

**How it was fixed.** New `src/services/odbc/tallyUrl.js`: a Tally address must be `http://` or `https://`, must not contain a user name or password, and must not be a link-local or metadata address (`169.254.0.0/16` — where cloud metadata services live — `fe80::/10`, the AWS IPv6 metadata address, `0.0.0.0/8`, `::`, IPv4-mapped forms of those, and well-known metadata host names). **Localhost and private LAN addresses stay allowed on purpose**: TallyPrime is a desktop application on the same machine or office network. The rule is enforced twice: when a company is saved (Mongoose validator) and — the part that fails closed — at the moment each of the nine Tally request functions builds its destination, so a bad value that got into the database some other way is still refused.

**Verified by.** `SEC-TALLY-12` (12 allowed / blocked cases) and `SEC-TALLY-13` (refused at save and at use).

**Known limit.** Only the literal address or host name is checked: a DNS name that *resolves* to a blocked address is not caught. If a "configure my Tally address" screen is ever built, add a resolve-then-check step there.

### 🟡 F-11 — CORS and security headers — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.6](#06-medium-findings--fix-log--done).

- **What it was.** `app.use(cors())` reflected `*`; there was no `helmet`; `X-Powered-By: Express` was sent (`SEC-HTTP-1/2`). Because auth uses a bearer header (not cookies) this was not direct session riding; it removed a defence layer and would matter more if cookies were ever added.
- **How it was fixed.** New `src/middleware/httpSecurity.js`, used by `server.js` **and** by the probe suite, so the probes test the real configuration. `helmet()` sends the standard headers (Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, …) and `X-Powered-By` is off. CORS is an **allow-list**: origins come from the `CORS_ORIGINS` environment variable (comma-separated); if it is not set only `http://localhost:5173` and `http://127.0.0.1:5173` are allowed. An origin not on the list gets no CORS headers. Requests without an `Origin` header (curl, server-to-server, the Vite dev proxy) are unaffected.
- **Action for deployment.** If the frontend is served from another origin than the API (`VITE_API_BASE_URL` set), add that origin to `CORS_ORIGINS`, otherwise browsers will block it. In development the Vite proxy makes requests same-origin, so nothing changes.
- **Verified by.** `SEC-HTTP-1` (an unknown origin gets no `Access-Control-Allow-Origin`), `SEC-HTTP-2` (all four headers present), `SEC-HTTP-3` (the allowed frontend origin still works, no `X-Powered-By`); live, including through the Vite dev proxy.

### 🟡 F-12 — Internal error text reaches clients — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.6](#06-medium-findings--fix-log--done).

| Probe | Input | Before | Now |
|---|---|---|---|
| SEC-VAL-1 ✅ *(fixed with F-01)* | `password` as an object on login | 500 `Illegal arguments: object, string` | `400` |
| SEC-VAL-2 | `companyName` as an object | 500 `companyName.trim is not a function` | `400` (type check) |
| SEC-VAL-3 | non-ObjectId chat id | 500 mentions `for model "Chat"` | `404 Chat not found.` |
| SEC-VAL-4 | malformed JSON | 400 with parser text | `400 The request body is not valid JSON.` |
| SEC-VAL-11 | non-JSON upload | 500 `Only JSON files are allowed.` | `400 Only JSON files are allowed.` |
| SEC-VAL-12 *(new)* | any unexpected internal error | library / model text | `500` with a fixed message |
| SEC-VAL-13 *(new)* | an 11 MB upload | multer internals | `413 The file is too large.` |

**How it was fixed.** One rule: a client only sees a message *we* chose. New `src/middleware/errorHandler.js` (used by `server.js` and the probe suite): errors thrown on purpose carry `userFacing = true` and a 4xx status and pass through; known framework errors (bad JSON, body too large, multer limits) get a fixed friendly message; everything else is logged on the server and answered `500 "Something went wrong on the server. Please try again."`. The same rule was applied to the catch-all blocks in the auth, chat, import, odbc, sync-status, analytics and company-context code, which used to return `err.message`. Invalid chat ids are now "not found", `companyName` must be text, and the upload filter's rejection is a proper `400`. (Only `error.message` was ever returned — never `error.stack`.)

**Note.** A Tally connection failure on `/api/odbc/company` now says "Could not get a response from TallyPrime…" instead of the raw network error; the details are in the server log.

### 🟡 F-13 — Uncapped live-import date range — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.6](#06-medium-findings--fix-log--done).

- **What it was.** `/api/import/tally-live?fromDate=…&toDate=…` forwarded any range to Tally; the project's own notes record that a 10-year range hung the real TallyPrime (`SEC-VAL-9`).
- **How it was fixed.** `importController.js` refuses, with a `400` **before Tally is contacted**: a range longer than **92 days** (about a quarter; the message tells the user to import in pieces), a reversed range (`toDate` before `fromDate`), and a repeated date parameter (which Express turns into an array). A range of up to 92 days, or a single day, works as before; an unparseable date is still reported as "Invalid date".
- **Verified by.** `SEC-VAL-9` (36 years refused, nothing sent to Tally), `SEC-VAL-14` (exactly 92 days forwarded; 93 days, reversed and repeated-parameter requests refused).
- **Note.** The limit is one constant, `MAX_IMPORT_RANGE_DAYS`, in `importController.js`. To load a longer period, import it in several requests.

### 🟡 F-14 — Uploaded files never deleted — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.6](#06-medium-findings--fix-log--done).

- **What it was.** `upload.js` writes to `backend/uploads/`, `importController.js` never `unlink`ed (`SEC-LIFE-1`).
- **How it was fixed.** `importTallyJson` deletes the uploaded file as soon as it has been processed **or refused**, *before* the response is sent (so it is gone by the time the client sees the answer). Every exit path is covered: success, wrong file type, missing company, and failure while processing. A file that is too large is removed by multer itself.
- **Verified by.** `SEC-LIFE-1` (a processed upload is gone), `SEC-LIFE-2` (a failed upload is gone too), `SEC-VAL-13` (an oversized upload leaves nothing behind); `SEC-VAL-10` still shows a `../` filename cannot escape `uploads/`.
- **Not done on purpose.** The **9 older customer files already in `backend/uploads/`** were **not** deleted — they are your data, and deleting them is your call. They are safe to remove if you no longer need them (the folder is git-ignored).

### 🔵 F-15 — Purchase route `comparisonType` validation (a false positive) — FIXED

> **Status: ✅ Closed on 2026-09-21 — this was an error in the audit, not a vulnerability.** Log in [Section 0.7](#07-low-findings--fix-log--done).

The first audit said the purchase-comparison route did not validate `comparisonType`. **It does** (`getPurchaseComparison` calls `parseComparisonTypeFromQuery`, like its sales siblings). The probe `SEC-VAL-6` that seemed to show a gap sent `comparisonType=zzz` to `/sales/top-products`, a route that does not take that parameter and simply ignores it — normal behaviour, not a validation hole. **Fix:** the probe was corrected (`SEC-VAL-6` now tests only the parameters `/top-products` takes) and a new probe `SEC-VAL-15` checks all four routes that *do* take `comparisonType` (sales comparison, growing / declining products, purchase comparison) — each answers `400`. No application code changed for this finding.

### 🔵 F-16 — Register says "Email already registered" — FIXED

> **Status: ✅ Fixed on 2026-09-21, with a residual that is accepted.** Log in [Section 0.7](#07-low-findings--fix-log--done).

- **What it was.** `register` answered "Email already registered", so it could be used to test whether an address has an account (`SEC-AUTH-10`). `login` never leaked this.
- **How it was fixed.** The reply is now "We could not create this account. If you already have one, sign in instead." — it no longer states that the address is registered.
- **Residual (honest).** That is still the *only* message this endpoint gives in that situation, so someone trying many addresses could infer it by elimination. It is bounded by the F-04 limits (20 registrations per hour per address). Closing it completely needs an e-mail verification step — always answer "check your e-mail" — which needs mail sending and is not built.
- **Verified by.** `SEC-AUTH-10`.

### 🔵 F-17 — Unused dependencies — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.7](#07-low-findings--fix-log--done).

- **What it was.** `bcrypt`, `joi`, `winston` (and `odbc`, found unused while checking) were declared but never imported; `joi` carried a low advisory and `qs` a moderate one.
- **How it was fixed.** `npm uninstall bcrypt joi winston odbc` (a repository-wide search found no `require` of any of them; `odbc` only in a commented-out block). This also removes `odbc`'s native build step and about 600 lines of lock file. `npm audit fix` then moved the transitive `qs` from 6.15.3 to 6.16.0 (the only change it made). **`npm audit --omit=dev` now reports 0 vulnerabilities** (backend; the frontend was 0 already).
- **Verified by.** `SEC-DEP-1`; the app loads and every suite still passes.

### 🔵 F-18 — `.env` not git-ignored outside `backend/` — FIXED

> **Status: ✅ Fixed and verified on 2026-09-21.** Log in [Section 0.7](#07-low-findings--fix-log--done).

- **What it was.** No root `.gitignore`, and `frontend/.gitignore` did not list `.env` — a real `.env` created there could have been committed.
- **How it was fixed.** New root `.gitignore` (real `.env` / `.env.*` files, dependencies, build output, logs, `backend/uploads/`; `.env.example` stays committable) and `.env`, `.env.*` added to `frontend/.gitignore` and `backend/.gitignore`. No tracked file became ignored.
- **Verified by.** `SEC-CONF-1` (`git check-ignore` on `.env`, `backend/.env`, `frontend/.env`, `frontend/.env.production`, `backend/.env.staging`, an uploaded file; `.env.example` still committable).

### 🔵 F-19 — Logging basics — FIXED

> **Status: ✅ Fixed (basic level) and verified on 2026-09-21.** Log in [Section 0.7](#07-low-findings--fix-log--done).

- **What it was.** Bare `console.*`, no request ids, so a failure could not be tied to one request; `winston` was declared but unused.
- **How it was fixed.** New `requestId.js`: every request gets an id, returned in the `X-Request-Id` header (a client-sent id is reused only if it is short and plain, so it cannot inject text into the log). Error log lines carry `request=<id>` plus the method and path (no query string); a server-error response repeats the id in its body so a user can quote it. Security events are logged with the id: one line per failed login (never the e-mail or the password) and one line per window when a rate limit is first hit.
- **Not done on purpose.** No logging library (the unused `winston` was removed in F-17) and the existing `console.*` calls were not rewritten — that would be a large change for no security gain. If levels or shipping to a log service are wanted later, add a library then.
- **Verified by.** `SEC-LOG-1` (ids generated, echoed, unsafe ones replaced, id in server-error bodies) and `SEC-LOG-2` (the security lines carry an id and contain no e-mail address or password).

## 7. What is working well

```text
 ✅ Token verification        jwt.verify: wrong secret, expired, alg:none, tampered payload → all 401
 ✅ Password storage          bcrypt hashes verified in the DB (SEC-AUTH-8)
 ✅ Mass assignment           register ignores role / companyGuId / tenantId (SEC-AUTH-7)
 ✅ Login errors              same "Invalid credentials" for unknown e-mail and wrong password
 ✅ Tenant boundary           every Sale/Purchase/Chat/Checkpoint/Analytics query is tenant-scoped
 ✅ No trusted client tenant  no controller reads tenantId from body/query/params (SEC-AUTHZ-6)
 ✅ Login on every data route  /api/odbc/* needs a signed-in user; /sales only for the selected company's owner (F-03)
 ✅ Live access checks         company access is re-verified against the live account on every request (F-06)
 ✅ Abuse limits               login / register / password re-check are rate-limited (F-04); passwords 8 characters to 72 bytes (F-05)
 ✅ Hardened HTTP layer        helmet security headers + CORS allow-list (F-11); clients only see messages we chose (F-12)
 ✅ Sessions can be revoked    account loaded on every request + a session version; deleted users stop at once (F-08)
 ✅ Safe file handling          uploads deleted after processing; live-import range capped at 92 days (F-13, F-14)
 ✅ Traceable, safe logs       every request has an id; failed logins and rate limits are logged without e-mail or password (F-19)
 ✅ Guarded Tally address       http(s) only, no credentials, no link-local / metadata address - at save and at use (F-10)
 ✅ Clean dependencies          npm audit: 0 vulnerabilities; unused packages removed; .env git-ignored everywhere (F-17, F-18)
 ✅ Type checks              company identifier / e-mail / password must be text before any lookup (F-01)
 ✅ Header/query/body IDOR    plain-string attempts at another company → 403 (SEC-AUTHZ-1,2,3)
 ✅ Chat isolation            {tenantId, userId} on every operation; foreign id → 404 (SEC-AUTHZ-4,5)
 ✅ Company-ownership guard   sync · recovery · reconciliation · self-heal · manual import · masters
 ✅ 3-company live test       Nirmal / WE FOUR / Intelli-Cart, both directions, and a TOCTOU race
 ✅ Cache isolation           keyed by companyGuid only; rejected data never cached (SEC-MASTER-1,2)
 ✅ Worker safety             atomic Mongo lock; failed job never advances the checkpoint (SEC-WORKER-1)
 ✅ AI layer                  tenant context is a function parameter; tool schemas are .strict()
 ✅ Body size / path safety   300 KB body → 413; "../" filename cannot escape uploads/
 ✅ Frontend                  no innerHTML / eval / dangerouslySetInnerHTML; npm audit: 0 findings
```

### 7.1 Ownership-guard coverage

| Path | File | On a foreign / malformed GUID |
|---|---|---|
| Incremental sync | `tallySyncWorker.js` | throws before any write; checkpoint untouched |
| Recovery | `voucherRecovery.js` | aborts before fetch (registry) and rejects a contaminated batch |
| Reconciliation | `reconciliation.js` | `aborted_unsafe`, `markedDeletedCount: 0` |
| Self-heal | `selfHeal.js` | only after a *successful* reconciliation, then the recovery guard |
| Manual import | `tallySalesImport.js` | throws, 0 imports |
| Master-data cache | `voucherTypeClassifier.js` | fetch-failure result; nothing cached |

---

## 8. Not verified

| # | Item | Why it cannot be answered from the repo |
|---|---|---|
| 1 | Backup encryption, access control, retention | MongoDB Atlas project settings |
| 2 | Whether `/api/odbc/*` and the API port are reachable from outside | Depends on firewall / hosting |
| 3 | Filesystem permissions around `backend/uploads/` | Depends on the deployed server |
| 4 | Deployed `JWT_SECRET` strength — the local one was replaced on 2026-09-21 by a 64-byte random value (86 characters); any deployed environment must be checked separately | Deployment configuration is not in the repo |
| 5 | Other TallyPrime versions / editions vs. the stub used | Only one real version was available |
| 6 | Legal / compliance (retention, deletion rights) | A business question |

---

# Part B — Layer-by-layer checklist

Every block below answers the same seven questions: **Security question · Answer · Evidence · Attack scenario · Security test · Risk · Recommendation.** Attack scenarios are kept at the level a defender needs — what the weakness allows, not a step-by-step recipe.

## 9. Layer-by-layer checklist

### Layer 1 — Authentication

#### 1.1 Can an unauthenticated user reach a protected API?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL for `/api/odbc/company` and `/api/odbc/sales`) |
| **Evidence** | `middleware/auth.js` requires `Authorization: Bearer <token>` and calls `jwt.verify(token, process.env.JWT_SECRET)`; it is applied in `authRoutes`, `importRoutes`, `chatRoutes`, `analyticsRoutes`, `syncRoutes` and — since the fix — `odbcRoutes`. `/api/odbc/sales` additionally needs a live company and answers only for the company Tally has selected |
| **Attack scenario** | Originally: anyone who could reach the port could read the open-company list and raw Tally sales vouchers without a login. Now blocked |
| **Security test** | `SEC-AUTH-1` (protected routes → 401), `SEC-AUTH-2/3` (odbc, anonymous → 401), `SEC-AUTH-11/12` (odbc/sales owner-only) — all ✅ |
| **Risk** | ℹ️ Info (was 🟠 High) |
| **Recommendation** | Done → **F-03** (log in Section 0.5) |

#### 1.2 Are tokens validated correctly (expired, wrong secret, `alg:none`, tampered)?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | `jwt.verify` enforces signature/expiry and rejects `alg:none`; `jwt.decode` is never used for auth. `Bearer` scheme is matched case-sensitively |
| **Attack scenario** | None demonstrated |
| **Security test** | `SEC-AUTH-4` (five bad-token shapes → 401), `SEC-AUTH-5` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 1.3 Does a deleted / revoked user's token stop working?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (F-06 in round 2, F-08 in round 3) |
| **Evidence** | `auth.js` now loads the account on every authenticated request: a deleted user is refused (`401`), and a token whose session version (`tv`) differs from `User.tokenVersion` is refused, so raising the version signs an account out everywhere. Company-scoped routes additionally re-check live access. Tokens issued before the change count as version 0 |
| **Attack scenario** | Originally: a deactivated or compromised account kept working for up to 7 days. Now stops immediately |
| **Security test** | `SEC-AUTH-6`, `SEC-AUTH-13`, `SEC-AUTH-14` — ✅ |
| **Risk** | ℹ️ Info (was 🟡 Medium) |
| **Recommendation** | Done → **F-08**. A future change-password feature should raise `tokenVersion` itself |

#### 1.4 Are authentication errors safe (no information leak)?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | `login` returns identical `Invalid credentials` for unknown e-mail and wrong password; `auth.js` always returns `Invalid token`; `register` no longer says an address is registered (F-16, with the accepted residual described there) |
| **Attack scenario** | None for login; registration can still be probed by elimination, bounded to 20 attempts per hour per address |
| **Security test** | `SEC-AUTH-10` ✅ |
| **Risk** | ℹ️ Info |
| **Recommendation** | Done → **F-16**; full closure needs an e-mail verification step |

#### 1.5 Are passwords stored and checked securely?
| | |
|---|---|
| **Answer** | ✅ PASS — hashing and (since 2026-09-21) strength |
| **Evidence** | `bcrypt.hash(password, 10)` / `bcrypt.compare`; stored value matches `^\$2[aby]\$\d\d\$`. `register` now requires 8 characters or more and at most 72 bytes (bcrypt's real limit); previously a 1-character password was accepted |
| **Attack scenario** | Originally: trivially guessable passwords + no throttling = an easy target. Both halves are now closed (F-05, F-04) |
| **Security test** | `SEC-AUTH-8` (bcrypt hash), `SEC-AUTH-9` (1 and 7 characters refused, 8 accepted, 73 refused) — ✅ |
| **Risk** | ℹ️ Info (was 🟠 High) |
| **Recommendation** | Done → **F-05**. Existing accounts keep their passwords; a "change password" feature would let weak ones be replaced |

#### 1.6 Can registration create privileged users (mass assignment)?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | `register` destructures only `{ name, email, password }` |
| **Attack scenario** | Extra `role` / `companyGuId` / `tenantId` fields are ignored |
| **Security test** | `SEC-AUTH-7` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 1.7 Is there brute-force protection?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | New `middleware/rateLimit.js`: login 10 failed attempts per client + e-mail and 100 per client per 15 minutes; register 20 per client per hour; connect-company password check 10 per user per 15 minutes. `429` with `Retry-After`; successful logins do not use up the budget |
| **Attack scenario** | Originally: unlimited password guessing against any known e-mail. Now throttled |
| **Security test** | `SEC-ABUSE-1` (throttled + `Retry-After`), `SEC-ABUSE-2` (correct logins never throttled), `SEC-ABUSE-3` (other accounts unaffected), `SEC-ABUSE-4` (registration flood) — ✅ |
| **Risk** | ℹ️ Info (was 🟠 High) |
| **Recommendation** | Done → **F-04**. Behind a reverse proxy set Express `trust proxy` |

#### 1.8 Do Git repositories leak the live secrets? (nested `backend/.git` and `main` history)
| | |
|---|---|
| **Answer** | ❌ FAIL — **in progress**: `JWT_SECRET` rotated and the nested repo neutralised on 2026-09-21; the MongoDB password still needs rotating (you) |
| **Evidence** | (1) The nested proof-of-concept repo in `backend/` (branch `feature/authentication`, commit `8049f28`, and its `HEAD`) tracked a `.env` whose `JWT_SECRET` and `MONGODB_URI` were identical to the live values (SHA-256 comparison). That branch was pushed to `origin` at some point (`origin/feature/authentication` contains the commit) but is not among GitHub's branches today. (2) **Commit `9a68a59` "POC Ready" (2026-08-17) is in `main`'s history on GitHub** and added a `.env` whose MongoDB connection string has the same cluster, user and password as the live one. The GitHub repository is private. **Correction:** the first audit said the secrets were not on GitHub — that was wrong |
| **Attack scenario** | Anyone with access to the repository, to GitHub's stored commits, or to the workstation folder recovers the database credentials (and, before rotation, the token-signing secret), which bypass every other control |
| **Security test** | Manual, documented; not automated (it reads the real secret). After the fix: the committed `JWT_SECRET` no longer matches the live one ✅; the committed `MONGODB_URI` password still matches the live one ❌ (until rotated) |
| **Risk** | 🔴 Critical until the database password is rotated |
| **Recommendation** | Rotate the Atlas password and update `MONGODB_URI`; keep `.env` out of every repo → **F-02** (log in Section 0.4) |

### Layer 2 — Authorization (IDOR / BOLA)

#### 2.1 Can user A access user B's company by supplying its identifier?
| | |
|---|---|
| **Answer** | ✅ PASS — plain-string identifiers, and (since the F-01 fix on 2026-09-21) non-string ones too |
| **Evidence** | `resolveAuthorizedCompany` re-loads `Company` by `companyGuid` (not from the JWT) and needs a `UserCompanyAccess` row for any non-default company; `switchCompany` does the same inline; `syncStatusController` / `syncRecoveryController` never read identifiers from the client |
| **Attack scenario** | Header, query or body naming another company → blocked with 403 |
| **Security test** | `SEC-AUTHZ-1/2/3/6/7` (all secure) |
| **Risk** | ℹ️ Info |
| **Recommendation** | None (F-01 fixed 2026-09-21) |

#### 2.2 Is `UserCompanyAccess` enforced for chat and resources by id?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Every chat operation uses `{ _id, tenantId, userId }`; a foreign id returns 404 (also hides existence) |
| **Attack scenario** | Reading or deleting another tenant's chat by id → 404, document unchanged |
| **Security test** | `SEC-AUTHZ-4/5` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 2.3 Does access revocation take effect immediately?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | `resolveAuthorizedCompany` now checks the live account on every request: the user must exist and the company must be their current default (on the `User`) or one they hold an access row for. `liveCompanyContext` applies the same check to the routes that read the JWT claim (sync, imports, rename, odbc/sales), and on imports runs before the upload middleware |
| **Attack scenario** | Originally: a removed employee kept reading the company's data until token expiry (7 days). Now refused with 403 / 401 |
| **Security test** | `SEC-AUTHZ-8` (default company removed), `SEC-AUTHZ-9` (non-default token, access row removed), `SEC-AUTHZ-10` (removed user's upload refused, nothing stored) — ✅ |
| **Risk** | ℹ️ Info (was 🟠 High) |
| **Recommendation** | Done → **F-06** |

#### 2.4 Is identity taken from the server rather than the client?
| | |
|---|---|
| **Answer** | ✅ PASS (F-01 fixed 2026-09-21) |
| **Evidence** | `tenantId` is derived from `req.user` / `req.companyContext`; grep of all controllers shows no client-supplied `tenantId` is read |
| **Attack scenario** | None found |
| **Security test** | `SEC-AUTHZ-6` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

### Layer 3 — Input-type validation / NoSQL operator confusion

#### 3.1 Can a non-string value reach a MongoDB filter used for an authorization decision?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | Original weakness: `switchCompany` used the same unchecked `companyGuId` in a user-scoped access lookup **and** a global `Company.findOne`; `resolveAuthorizedCompany` had the same shape for header/query overrides; `login` passed `email` unchecked to `User.findOne`. Express's JSON, `urlencoded({extended:true})` and repeated-query parsing all produce objects/arrays. **Now:** each of those entry points refuses anything that is not a string with a `400` before it reaches a filter (`authController.js`: `register`, `login`, `addCompany`, `switchCompany`; `companyContext.js`: `resolveAuthorizedCompany`) |
| **Attack scenario** | Originally: the check and the lookup could refer to different records, so a session could be scoped to a tenant the caller does not own. Exact request shapes are intentionally not reproduced here — the runnable probes contain them for the maintainer. Now blocked at the input |
| **Security test** | `SEC-INJ-1…6` — all six flipped from `[VULNERABLE]` to `[SECURE]`; `SEC-VAL-1` flipped as well; the plain-string authorization probes (`SEC-AUTHZ-1/2/3/6/7`) stayed ✅ |
| **Risk** | ℹ️ Info (was 🔴 Critical) |
| **Recommendation** | Done → **F-01** (log in Section 0.3). Optional second layer later: `mongoose.set("sanitizeFilter", true)`, only with tests, because it rewrites legitimate `$in` queries |

### Layer 4 — API input validation and error handling

#### 4.1 Do malformed inputs leak internal errors or cause unbounded work?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | Fixed: `SEC-VAL-1,2,3,4,11` (internal error text → our own messages), `SEC-VAL-9` (36-year import range → refused before Tally, max 92 days), new `SEC-VAL-12,13,14,15`. Secure: `SEC-VAL-5` (413 on 300 KB body), `-6` (bad limit / period / dates → 400), `-7` (array query params don't crash), `-8` (recovery validates `voucherType` and boolean `apply`), `-10` (`../` filename can't escape `uploads/`). The earlier `SEC-VAL-6` gap (F-15) was a false positive: the probe sent `comparisonType` to a route that does not take it |
| **Attack scenario** | Originally: error text told an outsider which library/model names are in use, and a wide range could make a customer's own Tally hang. Both closed |
| **Security test** | `SEC-VAL-1…15` — all ✅ |
| **Risk** | ℹ️ Info (was 🟡 Medium) |
| **Recommendation** | Done → **F-12, F-13, F-15** |

#### 4.2 Are uploaded business files retained on disk?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | `importTallyJson` deletes the uploaded file after it is processed or refused, before the response is sent, on every exit path. The 9 older files already in `uploads/` were left in place (your data; delete them if not needed) |
| **Attack scenario** | Originally: data-retention exposure outside the tenant-isolation logic. Now no new file is retained |
| **Security test** | `SEC-LIFE-1` (processed), `SEC-LIFE-2` (failed), `SEC-VAL-13` (oversized) — ✅ |
| **Risk** | ℹ️ Info (was 🟡 Medium) |
| **Recommendation** | Done → **F-14** |

### Layer 5 — Tenant isolation (MongoDB queries)

#### 5.1 Does every tenant-owned query have an enforced tenant boundary?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Every `find/findOne/update/delete/aggregate/count/create` call in `backend/src` was checked. Sale/Purchase: `{tenantId, …}`. Analytics: `buildVoucherMatchStage` **throws** without a tenant. Checkpoints: `{tenantId, companyGuid, voucherType}`. Chat: `{tenantId, userId}`. AI tools: `context.tenantId` is a parameter and schemas are `.strict()` |
| **Attack scenario** | None found for the *presence* of a tenant filter (the input-type gap, F-01, is fixed) |
| **Security test** | Code read + existing suites: `verify-company-ownership` 55, `verify-multi-company` 41, `verify-company-identity` 96 |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 5.2 Is a client-supplied `tenantId` ever trusted?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | No controller reads `tenantId` from `req.body/query/params` |
| **Attack scenario** | A `tenantId` query parameter naming another tenant is ignored |
| **Security test** | `SEC-AUTHZ-6` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

### Layer 6 — Tally company isolation

#### 6.1 Where does the trusted company GUID come from, and can a client change it?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Always from the `Company` MongoDB record. A client value is only *compared* (`assertedGuid !== detected.guid`) and rejected on mismatch, never substituted |
| **Attack scenario** | None |
| **Security test** | `verify-company-guid-match`, `verify-company-identity` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 6.2 Can Tally return another company's data, and is every response validated?
| | |
|---|---|
| **Answer** | ✅ PASS for every path exercised |
| **Evidence** | `validateBatchOwnership` requires every guid to start with `<expectedCompanyGuid>-` (a real prefix-plus-hyphen match, not `includes`); one bad item rejects the **whole** batch. Consumers listed in [Section 7.1](#71-ownership-guard-coverage) |
| **Attack scenario** | Tally answers for the selected company while the tenant expects another → refused |
| **Security test** | `SEC-TALLY-0…11` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 6.3 Can a wrong-company voucher enter MongoDB, look "missing" in recovery, or trigger reconciliation deletion?
| | |
|---|---|
| **Answer** | ✅ PASS (live, three companies open, Nirmal selected) |
| **Evidence** | See the table below |
| **Attack scenario** | Blocked in every variant tested |
| **Security test** | `SEC-TALLY-1…11` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

| Probe | Scenario | Result |
|---|---|---|
| TALLY-1 | Selected company syncs its own vouchers (control) | ✅ works |
| TALLY-2 | WE FOUR & Intelli-Cart tenants receive Nirmal's vouchers | ✅ refused, 0 writes, checkpoint unchanged |
| TALLY-3 | Masters cached earlier, selection then moves to Nirmal (race) | ✅ voucher check refuses |
| TALLY-4/5 | Recovery with a foreign registry / a contaminated fetch | ✅ 0 imported |
| TALLY-6 | Recovery touches `SyncCheckpoint`? | ✅ never |
| TALLY-7/8 | Reconciliation given another company's GUID list | ✅ `aborted_unsafe`, nothing deleted, reason recorded |
| TALLY-9/10 | Manual import: simple case and race | ✅ 0 sales written |
| TALLY-11 | **Reverse direction** (WE FOUR selected, Nirmal tenant) | ✅ refused |
| WORKER-1 | Two syncs for one tenant at the same instant | ✅ one runs, one skips |

#### 6.4 What was not verified against a real TallyPrime?
| | |
|---|---|
| **Answer** | ⚪ NOT VERIFIED |
| **Evidence** | The stub reproduces real JSONEx shapes captured earlier but is still a stub; other TallyPrime versions untested; We Four's vouchers return zero from the live Tally in the current session (an unresolved operational issue, not a security finding) |
| **Attack scenario** | n/a |
| **Security test** | Requires a live instance |
| **Risk** | Not assessed |
| **Recommendation** | Re-run `verify-security-audit.js` against staging with a real Tally when available |

### Layer 7 — Tally master-data isolation (caching)

#### 7.1 Can a master-data response be cached under another tenant or a shared key?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | `classificationCache` is keyed only by `companyGuid`; the old `"default"` fallback key is gone; a missing GUID returns a fetch-failure result; `validateMasterOwnership` runs **before** `cache.set` |
| **Attack scenario** | Poisoning one company's cache with another's masters → refused and not cached |
| **Security test** | `SEC-MASTER-1/2` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

### Layer 8 — MongoDB / NoSQL security

#### 8.1 Can user-controlled objects reach Mongo operators?
| | |
|---|---|
| **Answer** | ✅ PASS — fixed 2026-09-21 (same finding as layer 3; was ❌ FAIL) |
| **Evidence / Test** | See 3.1 / `SEC-INJ-1…6` (all `[SECURE]` now) |
| **Risk** | ℹ️ Info (was 🔴 Critical) → **F-01** fixed |

#### 8.2 Are indexes appropriate?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Sale/Purchase unique **partial** `{tenantId, tallyGuid}`; Company unique on `companyGuid` and `tenantId`; `UserCompanyAccess` unique `{userId, companyGuid}`; checkpoints unique `{tenantId, companyGuid, voucherType}` |
| **Security test** | Model review; earlier `.explain()` checks |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

#### 8.3 Are projections used to avoid needless data?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Recovery and self-heal read GUIDs with `select({tallyGuid:1, _id:0})`, answered from the index alone |
| **Risk** | ℹ️ Info |

### Layer 9 — Data exposure in API responses

#### 9.1 Do responses contain only authorized fields?
| | |
|---|---|
| **Answer** | ✅ PASS for secrets/other tenants (error text: see layer 12) |
| **Evidence** | `listCompanies` returns only `{companyGuid, companyName, isActive, isDefault}`. The sync-status serializers return counters, timestamps and voucher summary fields — no password, token or internal ids. No controller returns a raw `User` |
| **Security test** | `SEC-AUTHZ-6` |
| **Risk** | ℹ️ Info |
| **Recommendation** | None |

### Layer 10 — Secrets and configuration

#### 10.1 Are secrets protected? Are defaults dangerous?
| | |
|---|---|
| **Answer** | 🟡 PARTIAL — the one open item is F-02 |
| **Evidence** | **Good:** `backend/.gitignore` lists `.env` and `.env.*`; since 2026-09-21 there is also a root `.gitignore` and `frontend/.gitignore` covers `.env` (F-18 fixed, `SEC-CONF-1`); the current `main` tree tracks no `.env`; no `console.*` call logs `JWT_SECRET`, `MONGODB_URI` or the Anthropic key; `TALLY_URL` defaults to `http://localhost:9000`; `JWT_SECRET` is now a 64-byte random value (86 characters, generated 2026-09-21). **Gap:** F-02 — `main`'s *history* (commit `9a68a59`) still contains the live MongoDB password. You have decided to replace the URI and password when you deploy (new, fresh database); until the old credentials are deleted the exposure remains |
| **Attack scenario** | A committed secret |
| **Security test** | Manual (`git check-ignore`, `git ls-files`, `git log --all`, hash comparison); `SEC-CONF-1` |
| **Risk** | 🔴 Critical (F-02, until the old database credentials are deleted) |
| **Recommendation** | At deployment: create the new database user / URI and **delete or re-password the old user** |

### Layer 11 — Logging and observability

#### 11.1 Could logs leak sensitive data, and are security failures visible?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was 🟡 PARTIAL) |
| **Evidence** | No log prints a Tally body, request body, password or token. The ownership guard logs only counts and 8-character GUID prefixes. New: every request has an id (`X-Request-Id`); error lines carry `request=<id>`, method and path; security events (failed logins, rate limits) are logged with the id and never contain the e-mail or password. Still bare `console.*` — no logging library, by choice |
| **Security test** | `SEC-LOG-1`, `SEC-LOG-2` — ✅ |
| **Risk** | ℹ️ Info (was 🔵 Low) |
| **Recommendation** | Done → **F-19**. Add a logging library only if levels or log shipping are wanted |

### Layer 12 — Error handling

#### 12.1 Do errors expose internals?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | New `errorHandler.js`: clients only see messages we chose; library/database text is logged on the server. The catch-all blocks in the auth, chat, import, odbc, sync-status, analytics and company-context code use the same rule. Only `error.message` was ever returned, never `error.stack` |
| **Security test** | `SEC-VAL-1,2,3,4,11` (flipped), `SEC-VAL-12` (generic 500), `SEC-VAL-13` (413) — ✅ |
| **Risk** | ℹ️ Info (was 🟡 Medium) |
| **Recommendation** | Done → **F-12** |

### Layer 13 — Tally connector (SSRF surface)

#### 13.1 Can a tenant point TallyPulse at an arbitrary internal address?
| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was a latent risk, no reachable exploit) |
| **Evidence** | `tallyConnection.baseUrl` is validated when a company is saved and again where each Tally request is built (`tallyUrl.js`): http(s) only, no credentials, no link-local / metadata addresses. Localhost and LAN addresses stay allowed. Limit: a DNS name resolving to a blocked address is not caught |
| **Attack scenario** | If a future "configure Tally URL" feature accepted free text, requests could have been aimed at internal services. Now refused at save and at use |
| **Security test** | `SEC-TALLY-12`, `SEC-TALLY-13` — ✅ |
| **Risk** | ℹ️ Info (was 🔵 Low) |
| **Recommendation** | Done → **F-10**. When a setter screen is built, add a resolve-then-check step |

#### 13.2 Timeouts, retries and slow Tally?
| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Every Tally `axios.post` has a timeout (30 s vouchers/masters, 15 s company info). Reconciliation has an independent >50% delete-ratio abort |
| **Risk** | ℹ️ Info |

### Layers 14–20 — Workers, checkpoints, recovery, reconciliation, self-heal, races, caches

| # | Layer | Answer | Evidence | Test | Risk |
|---|---|:-:|---|---|:-:|
| 14 | Worker security | ✅ | `acquireLock` is one atomic `findOneAndUpdate` (unlocked or stale only). Failure paths call `releaseLock` with **no** `advanceTo`. No module-level "current company" variable; `inFlight` is keyed `tenantId:voucherType` | `SEC-WORKER-1`, `SEC-TALLY-2/3/11` | ℹ️ |
| 15 | Checkpoint / AlterID | ✅ | `lastAlterId` moves only in the success branch, after the ownership guard, completeness check and per-voucher persistence | `SEC-TALLY-2/3/11` | ℹ️ |
| 16 | Recovery | ✅ | Wrong-company data is rejected before comparison; `SyncCheckpoint` is neither imported nor touched | `SEC-TALLY-4/5/6` | ℹ️ |
| 17 | Reconciliation | ✅ | Wrong-company list → `aborted_unsafe`, 0 marked deleted, reason recorded; the older >50% guard remains as a second layer | `SEC-TALLY-7/8` | ℹ️ |
| 18 | Self-healing | ✅ | Runs only after a *successful* reconciliation; delegates to `recoverMissingVouchers` (same guard); always one tenant's `company` object | `verify-self-heal` | ℹ️ |
| 19 | Race conditions (TOCTOU) | ✅ | Selection changing between the master query and the voucher query is caught by the voucher-level check | `SEC-TALLY-3/10`, `SEC-WORKER-1` | ℹ️ |
| 20 | Cache security | ✅ | See layer 7 | `SEC-MASTER-1/2` | ℹ️ |

### Layer 21 — AI / analytics

#### 21.1 Can analytics or the AI leak another tenant's data?
| | |
|---|---|
| **Answer** | ✅ PASS (code inspection; same `context.tenantId` pattern as the HTTP probes) |
| **Evidence** | `buildVoucherMatchStage` throws without a tenant. `handleChatTurn` gets `{tenantId, companyGuid}` from the authorized `req.companyContext`, never from message text. `executeToolCall` refuses to run without `context.tenantId`. Tool schemas are `.strict()` so a smuggled `tenantId` argument is rejected. One request = one `Chat` = one `{tenantId, userId}`. `MAX_TURNS = 4`. Message bodies and prompts are not logged |
| **Attack scenario** | A prompt trying to name another tenant has no channel to change the server-side context |
| **Security test** | Code inspection (no AI-specific probe) |
| **Risk** | ℹ️ Info |
| **Recommendation** | None. There are no embeddings or vector stores to audit |

### Layer 22 — Frontend

| | |
|---|---|
| **Answer** | ✅ PASS (the frontend is not a security boundary; every route re-checks server-side) |
| **Evidence** | JWT is in `localStorage` (readable by any script on the origin — normal for SPAs; no `dangerouslySetInnerHTML`, `eval` or `innerHTML` exists in `frontend/src`, so no first-party XSS path was found). All calls go through one Axios instance. `npm audit` on the frontend: **0** findings |
| **Risk** | ℹ️ Info |
| **Recommendation** | Re-evaluate token storage only if XSS-prone features are added |

### Layer 23 — CORS / HTTP security

| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | `httpSecurity.js` (shared by `server.js` and the probes): `helmet()` sends Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options and X-Frame-Options; `X-Powered-By` is off; CORS is an allow-list from `CORS_ORIGINS` (default: the local Vite origins) |
| **Attack scenario** | Originally: any web page could call the API from a browser and a defence layer was missing. Now unknown origins get no CORS headers |
| **Security test** | `SEC-HTTP-1/2/3` — ✅ |
| **Risk** | ℹ️ Info (was 🟡 Medium) |
| **Recommendation** | Done → **F-11**. Set `CORS_ORIGINS` when the frontend is served from another origin |

### Layer 24 — Rate limiting / abuse

| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was ❌ FAIL) |
| **Evidence** | In-process limiter in `middleware/rateLimit.js` on login, register and the connect-company password check (limits in 1.7). `/api/sync/recovery` keeps its `inFlight` guard against *concurrent* runs but is not rate-limited |
| **Attack scenario** | Originally: unlimited guessing and registration spam. Now throttled; counters reset on backend restart |
| **Security test** | `SEC-ABUSE-1…4` — ✅ |
| **Risk** | ℹ️ Info (was 🟠 High) |
| **Recommendation** | Done → **F-04**. Behind a reverse proxy set `trust proxy`; move counters to a shared store only if the backend ever runs as several instances |

### Layer 25 — Dependencies / supply chain

| | |
|---|---|
| **Answer** | ✅ PASS — **fixed 2026-09-21** (was 🟡 PARTIAL) |
| **Evidence** | `npm audit --omit=dev` (backend): **0 vulnerabilities**; frontend: 0. `multer` (was **high**) 2.2.0 → 2.4.0 (F-07); `qs` 6.15.3 → 6.16.0; the unused `bcrypt`, `joi`, `winston` and `odbc` were removed (F-17). Point-in-time result — re-run `npm audit` periodically |
| **Attack scenario** | None demonstrated |
| **Security test** | `npm audit`, `SEC-DEP-1` |
| **Risk** | ℹ️ Info (was 🟠 High) |
| **Recommendation** | Done → **F-07, F-17**; keep auditing |

### Layer 26 — Data lifecycle

| | |
|---|---|
| **Answer** | 🟡 PARTIAL |
| **Evidence** | Vouchers are only soft-deleted (by design). Still **no tenant self-deletion endpoint** (F-09 — a decision for you). Uploaded files are now deleted after processing (F-14, fixed). Access loss is immediate (F-06 / F-08, fixed) |
| **Risk** | 🟡 Medium |
| **Recommendation** | → **F-09**: decide the deletion policy first (see Section 0.6); a real deletion path only if regulations or customers require it |

### Layer 27 — Backups

| | |
|---|---|
| **Answer** | ⚪ NOT VERIFIED |
| **Evidence** | Atlas backups, encryption and access policy live in Atlas project settings; nothing in this repo configures or reads them |
| **Risk** | Not assessed |
| **Recommendation** | A separate infrastructure review |

### Layer 28 — Security testing quality

| | |
|---|---|
| **Answer** | ✅ PASS |
| **Evidence** | Existing suites assert negative outcomes ("0 written", "checkpoint unchanged", "no token issued") and verify no leftover data. `verify-security-audit.js` follows the same rule: every probe asserts a database read, an HTTP status, or a decoded token claim |
| **Gap closed by this audit** | Authentication-bypass probes, HTTP-level authorization probes, input-type probes, error-leak probes, HTTP-hardening probes, a three-company live scenario including the reverse direction and a race |
| **Risk** | ℹ️ Info |

---

## Appendix A — Probe results

Last run (2026-09-21, after the fourth remediation round): **74 secure, 0 vulnerable** of 74 (was 30 / 23 of 53 at the original audit; 37 / 16 after round 1, 50 / 10 after round 2, 65 / 2 after round 3), cleanup reported 0 leftover documents and 0 test files.

| Group | Probe | Result | What it checks | Finding |
|---|---|:-:|---|:-:|
| Auth | SEC-AUTH-1 | ✅ | 25 protected routes reject anonymous requests | — |
| Auth | SEC-AUTH-2 | ✅ fixed | `/api/odbc/company` requires auth | F-03 (fixed) |
| Auth | SEC-AUTH-3 | ✅ fixed | `/api/odbc/sales` requires auth | F-03 (fixed) |
| Auth | SEC-AUTH-4 | ✅ | Expired / wrong-secret / `alg:none` / tampered / malformed tokens rejected | — |
| Auth | SEC-AUTH-5 | ✅ | Exact `Bearer ` scheme required | — |
| Auth | SEC-AUTH-6 | ✅ fixed | Token stops working when the user is deleted | F-08 (mostly mitigated) |
| Auth | SEC-AUTH-7 | ✅ | No mass assignment on register | — |
| Auth | SEC-AUTH-8 | ✅ | Passwords stored as bcrypt | — |
| Auth | SEC-AUTH-9 | ✅ fixed | Minimum password strength | F-05 (fixed) |
| Auth | SEC-AUTH-10 | ✅ fixed | Duplicate e-mail does not reveal existence | F-16 (fixed) |
| Auth | SEC-AUTH-11 | ✅ | `/api/odbc/sales` refuses a signed-in user whose company is not the one Tally has selected | F-03 (new) |
| Auth | SEC-AUTH-12 | ✅ | `/api/odbc/sales` still works for the selected company's owner; a company-less token gets 401 | F-03 (new) |
| Auth | SEC-AUTH-13 | ✅ | Raising the account's session version signs it out everywhere (old token 401, fresh login 200) | F-08 (new) |
| Auth | SEC-AUTH-14 | ✅ | A deleted user's token is refused even on `/api/odbc/company` (login-only route) | F-08 (new) |
| Authz | SEC-AUTHZ-1 | ✅ | Header naming another company → 403 | — |
| Authz | SEC-AUTHZ-2 | ✅ | Query naming another company → 403 | — |
| Authz | SEC-AUTHZ-3 | ✅ | switch-company to a foreign plain GUID → 403 | — |
| Authz | SEC-AUTHZ-4 | ✅ | Foreign chat by id → 404 | — |
| Authz | SEC-AUTHZ-5 | ✅ | Chat list only own chats | — |
| Authz | SEC-AUTHZ-6 | ✅ | Client tenant / company values ignored | — |
| Authz | SEC-AUTHZ-7 | ✅ | Company-less token cannot read company data | — |
| Authz | SEC-AUTHZ-8 | ✅ fixed | Access removal is immediate | F-06 (fixed) |
| Authz | SEC-AUTHZ-9 | ✅ | A token scoped to a non-default company stops working when that access row is removed | F-06 (new) |
| Authz | SEC-AUTHZ-10 | ✅ | A user whose access was removed cannot upload a file (nothing stored) | F-06 (new) |
| Types | SEC-INJ-1 | ✅ fixed | switch-company rejects a non-string identifier | F-01 (fixed) |
| Types | SEC-INJ-2 | ✅ fixed | No request shape yields a foreign-tenant session | F-01 (fixed) |
| Types | SEC-INJ-3 | ✅ fixed | Repeated query parameter refused, no foreign scope | F-01 (fixed) |
| Types | SEC-INJ-4 | ✅ fixed | Form-encoded non-string refused | F-01 (fixed) |
| Types | SEC-INJ-5 | ✅ fixed | login rejects a non-string e-mail | F-01 (fixed) |
| Types | SEC-INJ-6 | ✅ fixed | login answers a non-string e-mail with 400 | F-01 (fixed) |
| Validation | SEC-VAL-1 | ✅ fixed | Non-string password → clean 4xx | F-12 (VAL-1 fixed with F-01) |
| Validation | SEC-VAL-2 | ✅ fixed | Non-string companyName → clean 4xx | F-12 (fixed) |
| Validation | SEC-VAL-3 | ✅ fixed | Invalid chat id → clean 4xx | F-12 (fixed) |
| Validation | SEC-VAL-4 | ✅ fixed | Malformed JSON → generic error | F-12 (fixed) |
| Validation | SEC-VAL-5 | ✅ | Oversized body → 413 | — |
| Validation | SEC-VAL-6 | ✅ fixed | Analytics query parameters validated | F-15 (test error, corrected) |
| Validation | SEC-VAL-7 | ✅ | Array query params don't crash | — |
| Validation | SEC-VAL-8 | ✅ | Recovery rejects operator object / non-boolean `apply` | — |
| Validation | SEC-VAL-9 | ✅ fixed | 36-year import range capped | F-13 (fixed) |
| Validation | SEC-VAL-10 | ✅ | `../` filename cannot escape `uploads/` | — |
| Validation | SEC-VAL-11 | ✅ fixed | Non-JSON upload → 4xx | F-12 (fixed) |
| Validation | SEC-VAL-12 | ✅ | An unexpected internal error is answered with a generic 500 (no library / model text) | F-12 (new) |
| Validation | SEC-VAL-13 | ✅ | An 11 MB upload is refused with 413 and a plain message; nothing left on disk | F-12 / F-14 (new) |
| Validation | SEC-VAL-14 | ✅ | 92 days accepted; 93 days, a reversed range and a repeated date parameter refused | F-13 (new) |
| Validation | SEC-VAL-15 | ✅ | `comparisonType` is validated on all four routes that take it (400 for a bad value) | F-15 (new) |
| Lifecycle | SEC-LIFE-1 | ✅ fixed | Uploaded file deleted after processing | F-14 (fixed) |
| Lifecycle | SEC-LIFE-2 | ✅ | An upload that fails processing is also deleted from disk | F-14 (new) |
| HTTP | SEC-HTTP-1 | ✅ fixed | CORS restricted to own origin | F-11 (fixed) |
| HTTP | SEC-HTTP-2 | ✅ fixed | Security headers set | F-11 (fixed) |
| HTTP | SEC-HTTP-3 | ✅ | The application's own frontend origin is still allowed; no `X-Powered-By` | F-11 (new) |
| Logging | SEC-LOG-1 | ✅ | Every response has an `X-Request-Id`; a plain client id is echoed, an unsafe one replaced; the id is in server-error bodies | F-19 (new) |
| Logging | SEC-LOG-2 | ✅ | Failed logins and rate-limit hits are logged with the request id and never contain the e-mail or password | F-19 (new) |
| Abuse | SEC-ABUSE-1 | ✅ fixed | Repeated wrong logins throttled | F-04 (fixed) |
| Abuse | SEC-ABUSE-2 | ✅ | Successful logins do not use up the failed-attempt budget | F-04 (new) |
| Abuse | SEC-ABUSE-3 | ✅ | Throttling one account does not lock other accounts | F-04 (new) |
| Abuse | SEC-ABUSE-4 | ✅ | A flood of account creations is throttled | F-04 (new) |
| Tally | SEC-TALLY-0 | ℹ️ | Open-company guard alone passes all three tenants → cannot be the isolation control | — |
| Tally | SEC-TALLY-1 … 11 | ✅ ×11 | Sync, recovery, reconciliation, manual import, race and reverse direction | — |
| Tally | SEC-TALLY-12 | ✅ | A Tally address must be http(s), no credentials, no link-local / metadata (localhost and LAN allowed) | F-10 (new) |
| Tally | SEC-TALLY-13 | ✅ | An unsafe `tallyConnection.baseUrl` is refused at save and again at use | F-10 (new) |
| Master | SEC-MASTER-1, 2 | ✅ ×2 | Master cache isolation, no shared default key | — |
| Worker | SEC-WORKER-1 | ✅ | Concurrent syncs → one runs | — |
| Config | SEC-CONF-1 | ✅ | A real `.env` (any location, any `.env.<name>`) and uploaded files are git-ignored; `.env.example` is not | F-18 (new) |
| Config | SEC-DEP-1 | ✅ | `bcrypt`, `joi`, `winston` and `odbc` are no longer declared or installed | F-17 (new) |

---

## Appendix B — How to run the tests

```bash
cd backend
node verify-security-audit.js            # prints [SECURE] / [VULNERABLE] per probe; exit 0
node verify-security-audit.js --strict   # exit 1 if any probe is [VULNERABLE] (for CI, after the fixes)
```

- Uses only synthetic data (prefix `verify-sec-`) and cleans up before and after.
- Starts an in-process Express app with the same routers as `server.js` (no workers) and a stub TallyPrime with three open companies.
- **Use it as a regression test:** after each fix, the matching probe(s) in Appendix A must flip from ❌ to ✅. `--strict` should exit 0 once every finding that has a probe is fixed.

---

## Appendix C — Final summary block

*Updated 2026-09-21 after the fourth remediation round (see Section 0).*

```text
Security audit status:
Critical: 1 open, 1 fixed
              F-01 FIXED 2026-09-21 - non-string identifiers no longer reach Mongo filters
              F-02 IN PROGRESS - JWT_SECRET rotated, nested backend/.git moved out; the MongoDB
                   credentials will be replaced at deployment (new user/URI) - the OLD database
                   user must then be deleted or re-passworded
High:     0 open, 5 fixed
              F-03 FIXED  /api/odbc/* needs a login; /sales only for the selected company's owner
              F-04 FIXED  in-process rate limiter (login, register, connect-company)
              F-05 FIXED  password 8 characters to 72 bytes
              F-06 FIXED  company access re-checked against the live account on every request
              F-07 FIXED  multer 2.2.0 -> 2.4.0
Medium:   1 open, 5 fixed
              F-08 FIXED  account checked on every request + session version (tokenVersion)
              F-11 FIXED  helmet security headers + CORS allow-list (CORS_ORIGINS)
              F-12 FIXED  clients only see messages we chose (errorHandler + generic 500s)
              F-13 FIXED  live-import range capped at 92 days
              F-14 FIXED  uploads deleted after processing
              F-09 OPEN   no tenant data deletion - a product decision, deliberately not built
Low:      0 open, 6 fixed
              F-10 FIXED  Tally address validated at save and at use
              F-15 CLOSED a false positive in the first audit (probe corrected)
              F-16 FIXED  reply no longer says the address is registered (residual accepted)
              F-17 FIXED  bcrypt/joi/winston/odbc removed; qs updated; npm audit: 0
              F-18 FIXED  .env git-ignored everywhere
              F-19 FIXED  request id + failed-login / rate-limit log lines
Not verified: 6  Atlas backups; network reachability; filesystem permissions;
                 deployed JWT_SECRET; other TallyPrime versions; legal/compliance scope
Probes: 74 secure / 0 vulnerable of 74 (was 30 / 23 of 53 at the start)

Most important security boundary:
  The company-ownership guard (companyOwnership.js): every Tally response is checked against the
  tenant's trusted company GUID before any MongoDB write. It held in a live three-company test, in the
  reverse direction, and under a deliberate selection-change race.

Most dangerous remaining weakness:
  The live MongoDB password is in Git history, including main on GitHub (private repository), until the
  old credentials can no longer log in (F-02). At deployment create the new database user / URI and
  DELETE or re-password the old user.

First thing we should fix:
  At deployment: new database user / URI and delete the old user, a fresh JWT_SECRET, CORS_ORIGINS,
  Express trust proxy if behind a proxy. Then decide F-09 (tenant data deletion).
```

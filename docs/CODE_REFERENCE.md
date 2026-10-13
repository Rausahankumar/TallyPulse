# TallyPulse code reference (auto-generated from the source)

Har file ke liye: kya karti hai, kaun use karta hai, kaun si functions hain, har function kya karta hai (code ke apne comments se), aur wo kis dusri file ka kaun sa function call karta hai.

> Ye file `gen_ref.js` se banai gayi hai. Comments code se uthaye gaye hain, isliye English me hain. Simple Hindi/Hinglish samjhane wala hissa alag file `CODE_WALKTHROUGH_HINGLISH.md` me hai.

## Index


**0. Entry point**

- `server.js` (76 lines, 0 functions)

**1. Config**

- `src/config/db.js` (145 lines, 5 functions)

**2. Middleware (har request ke raaste me)**

- `src/middleware/auth.js` (80 lines, 1 functions)
- `src/middleware/errorHandler.js` (88 lines, 3 functions)
- `src/middleware/httpSecurity.js` (50 lines, 2 functions)
- `src/middleware/rateLimit.js` (144 lines, 4 functions)
- `src/middleware/requestId.js` (27 lines, 1 functions)
- `src/middleware/upload.js` (41 lines, 1 functions)

**3. Routes (URL → controller)**

- `src/routes/analyticsRoutes.js` (48 lines, 0 functions)
- `src/routes/authRoutes.js` (31 lines, 0 functions)
- `src/routes/chatRoutes.js` (27 lines, 0 functions)
- `src/routes/importRoutes.js` (30 lines, 0 functions)
- `src/routes/odbcRoutes.js` (43 lines, 0 functions)
- `src/routes/reportRoutes.js` (31 lines, 0 functions)
- `src/routes/syncRoutes.js` (15 lines, 0 functions)
- `src/routes/voucherRoutes.js` (17 lines, 0 functions)

**4. Controllers (request handle)**

- `src/controllers/analyticsController.js` (441 lines, 6 functions)
- `src/controllers/authController.js` (480 lines, 7 functions)
- `src/controllers/chatController.js` (243 lines, 5 functions)
- `src/controllers/importController.js` (285 lines, 6 functions)
- `src/controllers/odbcController.js` (331 lines, 2 functions)
- `src/controllers/reportController.js` (223 lines, 6 functions)
- `src/controllers/syncRecoveryController.js` (86 lines, 1 functions)
- `src/controllers/syncStatusController.js` (121 lines, 4 functions)
- `src/controllers/voucherController.js` (135 lines, 7 functions)

**5. Models (MongoDB tables)**

- `src/models/adjustmentNote.model.js` (100 lines, 0 functions)
- `src/models/aiTurnUsage.model.js` (38 lines, 0 functions)
- `src/models/chat.model.js` (111 lines, 0 functions)
- `src/models/company.js` (63 lines, 0 functions)
- `src/models/gstSchemas.js` (162 lines, 0 functions)
- `src/models/ledgerMaster.model.js` (70 lines, 0 functions)
- `src/models/purchase.model.js` (169 lines, 0 functions)
- `src/models/reconciliationCheckpoint.model.js` (89 lines, 0 functions)
- `src/models/sales.model.js` (168 lines, 0 functions)
- `src/models/stockItemMaster.model.js` (88 lines, 0 functions)
- `src/models/syncCheckpoint.model.js` (76 lines, 0 functions)
- `src/models/tenantDataVersion.model.js` (20 lines, 0 functions)
- `src/models/user.model.js` (62 lines, 0 functions)
- `src/models/userCompanyAccess.model.js` (51 lines, 0 functions)

**6. Tally se baat (odbc)**

- `src/services/odbc/odbcService.js` (1329 lines, 23 functions)
- `src/services/odbc/tallyUrl.js` (86 lines, 4 functions)

**7. Tally rules / masters**

- `src/services/tally/adjustmentNoteClassifier.js` (76 lines, 2 functions)
- `src/services/tally/companyOwnership.js` (222 lines, 7 functions)
- `src/services/tally/ledgerMaster.js` (237 lines, 12 functions)
- `src/services/tally/stockItemGst.js` (350 lines, 11 functions)
- `src/services/tally/stockItemMaster.js` (180 lines, 4 functions)
- `src/services/tally/voucherTypeClassifier.js` (394 lines, 7 functions)

**8. Parser**

- `src/services/parser/adjustmentNoteParser.js` (167 lines, 5 functions)
- `src/services/parser/gstFields.js` (429 lines, 21 functions)
- `src/services/parser/tallyParser.js` (460 lines, 17 functions)

**9. Mapper**

- `src/services/mapper/adjustmentNoteMapper.js` (83 lines, 2 functions)
- `src/services/mapper/purchaseMapper.js` (124 lines, 4 functions)
- `src/services/mapper/salesMapper.js` (119 lines, 4 functions)

**10. Sync / reconciliation / recovery**

- `src/services/sync/adjustmentNotePersistence.js` (116 lines, 1 functions)
- `src/services/sync/batchWindow.js` (79 lines, 3 functions)
- `src/services/sync/reconciliation.js` (254 lines, 3 functions)
- `src/services/sync/reconciliationWorker.js` (360 lines, 10 functions)
- `src/services/sync/selfHeal.js` (186 lines, 2 functions)
- `src/services/sync/tallySyncWorker.js` (674 lines, 10 functions)
- `src/services/sync/voucherLineBackfill.js` (280 lines, 10 functions)
- `src/services/sync/voucherPersistence.js` (287 lines, 1 functions)
- `src/services/sync/voucherRecovery.js` (383 lines, 5 functions)

**11. Manual import**

- `src/services/import/tallyPurchaseImport.js` (28 lines, 0 functions)
- `src/services/import/tallySalesImport.js` (677 lines, 8 functions)

**12. Company / auth services**

- `src/services/auth/companyContext.js` (185 lines, 4 functions)
- `src/services/auth/companyIdentity.js` (204 lines, 6 functions)
- `src/services/auth/tallyCompanyGuard.js` (126 lines, 4 functions)

**13. Analytics (dashboards, periods)**

- `src/services/analytics/analyticsScope.js` (118 lines, 4 functions)
- `src/services/analytics/coverage.js` (106 lines, 4 functions)
- `src/services/analytics/dateRanges.js` (278 lines, 21 functions)
- `src/services/analytics/freshness.js` (94 lines, 1 functions)
- `src/services/analytics/insights.js` (280 lines, 8 functions)
- `src/services/analytics/periodEngine.js` (491 lines, 18 functions)
- `src/services/analytics/purchaseAnalytics.js` (195 lines, 6 functions)
- `src/services/analytics/referenceDate.js` (109 lines, 8 functions)
- `src/services/analytics/reportAnalytics.js` (161 lines, 3 functions)
- `src/services/analytics/salesAnalytics.js` (450 lines, 12 functions)
- `src/services/analytics/stockGroupAnalytics.js` (227 lines, 3 functions)
- `src/services/analytics/trustEnvelope.js` (111 lines, 1 functions)

**14. AI query engine**

- `src/services/query/answerCache.js` (204 lines, 4 functions)
- `src/services/query/answerFormatter.js` (189 lines, 17 functions)
- `src/services/query/compile.js` (364 lines, 23 functions)
- `src/services/query/dataVersion.js` (230 lines, 12 functions)
- `src/services/query/entityResolver.js` (113 lines, 3 functions)
- `src/services/query/execute.js` (502 lines, 31 functions)
- `src/services/query/followUp.js` (45 lines, 3 functions)
- `src/services/query/planner.js` (598 lines, 24 functions)
- `src/services/query/presentation.js` (280 lines, 17 functions)
- `src/services/query/queryChat.js` (377 lines, 14 functions)
- `src/services/query/queryPlan.schema.js` (296 lines, 7 functions)
- `src/services/query/semanticCatalog.js` (697 lines, 8 functions)
- `src/services/query/turnTelemetry.js` (147 lines, 13 functions)
- `src/services/query/usageStore.js` (100 lines, 9 functions)
- `src/services/query/validator.js` (407 lines, 15 functions)

---


# 0. Entry point

## `server.js`
**Used by:** (entry file / run directly)

**Imports:** `src/middleware/httpSecurity.js`, `src/middleware/errorHandler.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/reconciliationWorker.js`, `src/config/db.js`, `src/middleware/requestId.js`, `src/routes/authRoutes.js`, `src/routes/importRoutes.js`, `src/routes/odbcRoutes.js`, `src/routes/chatRoutes.js`, `src/routes/syncRoutes.js`, `src/routes/analyticsRoutes.js`, `src/routes/voucherRoutes.js`, `src/routes/reportRoutes.js`



# 1. Config

## `src/config/db.js`
**Used by:** `server.js`

- **`isTestMode()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
- **`parseMongoUri()`** — line 35
  - Purpose: Parses a mongodb:// or mongodb+srv:// URI without keeping credentials. Returns null when the string is not a usable connection string. Manual parsing on purpose: WHATWG URL rejects valid standard URIs with several hosts (mongodb://a:27017,b:27017/db). Returns { srv, hosts, host, dbName } or null. Credentials are dropped here and never returned.
- **`checkConnectionTarget()`** — line 83
  - Purpose: Pure decision function: no I/O, no connection. Returns { ok, reason }. `reason` never contains credentials, and shows the host only when it is loopback.
  - Calls in this file: `parseMongoUri()`
- **`connectDB()`** _(async)_ — line 106
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `checkConnectionTarget()`
- **`connectGuarded()`** _(async)_ — line 128
  - Purpose: For suites that manage their own errors and must not exit the process. Applies the same guard as connectDB, but throws (with err.refused = true) instead of exiting, so a refusal can be told apart from "MongoDB is not reachable".
  - Calls in this file: `checkConnectionTarget()`


# 2. Middleware (har request ke raaste me)

## `src/middleware/auth.js`
**Used by:** `src/routes/analyticsRoutes.js`, `src/routes/authRoutes.js`, `src/routes/chatRoutes.js`, `src/routes/importRoutes.js`, `src/routes/odbcRoutes.js`, `src/routes/reportRoutes.js`, `src/routes/syncRoutes.js`, `src/routes/voucherRoutes.js`

**Imports:** `src/models/user.model.js`

- **`auth()`** _(async)_ — line 5
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/user.model.js → findById()`

## `src/middleware/errorHandler.js`
**Purpose (file comment):** Error responses (audit finding F-12). Rule: what a client sees is a message WE chose. Library and database error text (Mongoose model names, bcrypt/parser messages, stack details) is logged on the server and never sent. Used by server.js and by the probe suite. - Errors thrown on purpose with a user-facing message set `userFacing = true` (and a 4xx `status`); only those messages are passed through. - Known framework errors (bad JSON, body too large, multer upload limits) get a fixed, friendly message. - Anything else with a 4xx status gets a generic message for that status; anything else at all is a generic 500.

**Used by:** `server.js`, `src/middleware/upload.js`, `src/controllers/authController.js`, `src/controllers/chatController.js`, `src/controllers/importController.js`, `src/services/auth/companyContext.js`

**Exports:** `errorHandler`, `notFoundHandler`, `userError`, `GENERIC_SERVER_ERROR`

- **`userError()`** — line 40
  - Purpose: Error to throw for a client mistake whose message is safe to show.
- **`notFoundHandler()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
- **`errorHandler()`** — line 52
  - Purpose: eslint-disable-next-line no-unused-vars

## `src/middleware/httpSecurity.js`
**Purpose (file comment):** HTTP hardening (audit finding F-11): security headers and a CORS allow-list. Used by server.js AND by the security probe suite, so the probes test the exact configuration the real server runs. CORS: the API uses a bearer token in the Authorization header (not cookies), so this is defence in depth, not the only line of defence - but a browser page from an unknown origin should still be unable to read API responses. Allowed origins come from CORS_ORIGINS (comma-separated). If it is not set, only the local development origins are allowed - a deployed frontend on another origin MUST be listed there, otherwise the browser will block it. Requests without an Origin header (curl, server-to-server, t

**Used by:** `server.js`

**Exports:** `applyHttpSecurity`, `parseAllowedOrigins`, `DEV_ORIGINS`

- **`parseAllowedOrigins()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`applyHttpSecurity()`** — line 31
  - Purpose: (no comment in code — see name and calls below)

## `src/middleware/rateLimit.js`
**Purpose (file comment):** Small in-process rate limiter (audit finding F-04). Deliberately NOT a shared store (Redis etc.): TallyPulse runs as one backend process, and the goal is to stop password guessing and account-creation floods, not to meter an API. If the backend is ever run as several instances, move the counters to a shared store then - not before. How it works: every request maps to a key (for example the client IP plus the e-mail being tried). Each key gets `max` requests per `windowMs`; the request after that is answered 429 with a Retry-After header. With `refundOnSuccess` a request that ends with a status below 400 gives its slot back, so only FAILED attempts use up the budget and a person who logs in

**Used by:** `src/routes/authRoutes.js`

**Exports:** `createRateLimiter`, `loginLimiters`, `registerLimiter`, `connectCompanyLimiter`, `resetAllRateLimiters`

- **`createRateLimiter()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `clientIp()`
- **`clientIp()`** — line 90
  - Purpose: (no comment in code — see name and calls below)
- **`emailKey()`** — line 97
  - Purpose: The e-mail part of a login key: only a real string is used (anything else is rejected by the controller anyway), trimmed, lower-cased and length-capped so the key cannot be used to bloat memory.
  - Calls in this file: `createRateLimiter()`, `clientIp()`
- **`resetAllRateLimiters()`** — line 133
  - Purpose: For tests: forget every counter.

## `src/middleware/requestId.js`
**Purpose (file comment):** Request id (audit finding F-19). Every request gets an id, sent back in the X-Request-Id response header, and the error log lines carry the same id - so "this request failed" can be traced to exactly one place in the server log, and one user's report to one line. An id sent by the client is only reused when it is short and plain (letters, digits, dashes, underscores) - anything else is replaced, so it cannot be used to inject text into the log.

**Used by:** `server.js`

- **`requestId()`** — line 17
  - Purpose: (no comment in code — see name and calls below)

## `src/middleware/upload.js`
**Used by:** `src/routes/importRoutes.js`

**Imports:** `src/middleware/errorHandler.js`

- **`fileFilter()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/middleware/errorHandler.js → userError()`


# 3. Routes (URL → controller)

## `src/routes/analyticsRoutes.js`
**Used by:** `server.js`

**Imports:** `src/services/auth/companyContext.js`, `src/controllers/analyticsController.js`, `src/middleware/auth.js`


## `src/routes/authRoutes.js`
**Used by:** `server.js`

**Imports:** `src/middleware/rateLimit.js`, `src/services/auth/companyContext.js`, `src/controllers/authController.js`, `src/middleware/auth.js`


## `src/routes/chatRoutes.js`
**Used by:** `server.js`

**Imports:** `src/services/auth/companyContext.js`, `src/controllers/chatController.js`, `src/middleware/auth.js`


## `src/routes/importRoutes.js`
**Used by:** `server.js`

**Imports:** `src/services/auth/companyContext.js`, `src/controllers/importController.js`, `src/middleware/upload.js`, `src/middleware/auth.js`


## `src/routes/odbcRoutes.js`
**Purpose (file comment):** const express = require("express"); const auth = require("../middleware/auth"); const {testOdbcConnection , getSales} = require("../controllers/odbcController");

**Used by:** `server.js`

**Imports:** `src/controllers/odbcController.js`, `src/services/auth/companyContext.js`, `src/middleware/auth.js`


## `src/routes/reportRoutes.js`
**Used by:** `server.js`

**Imports:** `src/services/auth/companyContext.js`, `src/controllers/reportController.js`, `src/middleware/auth.js`


## `src/routes/syncRoutes.js`
**Used by:** `server.js`

**Imports:** `src/services/auth/companyContext.js`, `src/controllers/syncStatusController.js`, `src/controllers/syncRecoveryController.js`, `src/middleware/auth.js`


## `src/routes/voucherRoutes.js`
**Used by:** `server.js`

**Imports:** `src/services/auth/companyContext.js`, `src/controllers/voucherController.js`, `src/middleware/auth.js`



# 4. Controllers (request handle)

## `src/controllers/analyticsController.js`
**Used by:** `src/routes/analyticsRoutes.js`

**Imports:** `src/services/analytics/referenceDate.js`, `src/services/analytics/trustEnvelope.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/insights.js`, `src/services/analytics/dateRanges.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/stockGroupAnalytics.js`

**Exports:** `getDiscountSummary`, `getProductRates`, `getSupplierRates`, `getSalesSummary`, `getSalesComparison`, `getTopProducts`, `getGrowingProducts`, `getDecliningProducts`, `getTopCustomers`, `getSalesTrend`, `getCustomerCounts`, `getStockGroupPerformance`, `getPurchaseSummary`, `getPurchaseComparison`, `getTopSuppliers`, `getPurchaseTrend`

- **`parsePeriodFromQuery()`** — line 39
  - Purpose: `referenceDate` anchors what "current_month"/"previous_month" actually mean - see services/analytics/referenceDate.js for why this is the tenant's own latest voucher date, not necessarily the wall clock. Every caller below computes it once per request and threads it through; period="custom" ignores it entirely (an explicit from/to
  - Calls other files: `src/services/analytics/dateRanges.js → resolveRequestPeriod()`
- **`parseTrendPeriodFromQuery()`** — line 65
  - Purpose: Default window for a trend chart when the caller hasn't picked an explicit range: the last 6 complete months ending at the tenant's own reference date (see above) - not a hardcoded set of months.
  - Calls other files: `src/services/analytics/dateRanges.js → customRange()`, `src/services/analytics/dateRanges.js → lastNMonthsEnding()`
- **`parseComparisonTypeFromQuery()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`parseLimitFromQuery()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`parseStockGroupPeriodFromQuery()`** — line 111
  - Purpose: Stock Group performance uses the NEW, richer period engine (periodEngine.js) - its own period-kind set (17 kinds, see that file), completely separate from PERIOD_KINDS/parsePeriodFromQuery above, which stays exactly as it was for every existing endpoint. Adding this parser changes no existing endpoint's accepted query
  - Calls other files: `src/services/analytics/periodEngine.js → resolvePeriod()`, `src/services/analytics/periodEngine.js → resolveComparisonPeriod()`, `src/services/analytics/periodEngine.js → resolveSamePeriodLastYear()`
- **`handle()`** — line 157
  - Purpose: Wraps a handler so any thrown error (bad query params, or anything unexpected) becomes a clean HTTP error response instead of a 500 with no message - matches the pattern already used across authController/importController.
  - Calls in this file: `parsePeriodFromQuery()`, `parseTrendPeriodFromQuery()`, `parseComparisonTypeFromQuery()`, `parseLimitFromQuery()`, `parseStockGroupPeriodFromQuery()`
  - Calls other files: `src/services/analytics/referenceDate.js → getTenantReferenceDate()`, `src/services/analytics/trustEnvelope.js → wrapAnalyticsResult()`, `src/services/analytics/salesAnalytics.js → getSalesSummary()`, `src/services/analytics/salesAnalytics.js → getSalesComparison()`, `src/services/analytics/salesAnalytics.js → getTopProducts()`, `src/services/analytics/salesAnalytics.js → getTopGrowingProducts()`, `src/services/analytics/salesAnalytics.js → getDecliningProducts()`, `src/services/analytics/salesAnalytics.js → getTopCustomers()`, `src/services/analytics/salesAnalytics.js → getSalesTrend()`, `src/services/analytics/salesAnalytics.js → getCustomerCounts()`, `src/services/analytics/purchaseAnalytics.js → getPurchaseSummary()`, `src/services/analytics/purchaseAnalytics.js → getPurchaseComparison()`, `src/services/analytics/purchaseAnalytics.js → getTopSuppliers()`, `src/services/analytics/purchaseAnalytics.js → getPurchaseTrend()`

## `src/controllers/authController.js`
**Used by:** `src/routes/authRoutes.js`

**Imports:** `src/services/auth/tallyCompanyGuard.js`, `src/services/auth/companyIdentity.js`, `src/middleware/errorHandler.js`, `src/models/user.model.js`, `src/models/company.js`, `src/models/userCompanyAccess.model.js`

**Exports:** `register`, `login`, `addCompany`, `listCompanies`, `switchCompany`, `updateCompanyName`

- **`signToken()`** — line 16
  - Purpose: A session token. `company` scopes it to one company; without it the token only identifies the account (enough to connect a company, nothing else - every data route needs a company context and refuses such a token).
- **`register()`** _(async)_ — line 33
  - Purpose: REGISTER - account only. No company, GUID or tenant is asked for here: the company is connected afterwards ("Connect Tally"), detected from Tally.
  - Calls other files: `src/models/user.model.js → findOne()`, `src/models/user.model.js → create()`
- **`login()`** _(async)_ — line 101
  - Purpose: LOGIN - email + password. The session opens on the account's default company; an account that has not connected a company yet gets a token without one (`hasCompany: false`) and is sent to "Connect Tally".
  - Calls in this file: `signToken()`
  - Calls other files: `src/models/user.model.js → findOne()`, `src/models/company.js → findOne()`
- **`addCompany()`** _(async)_ — line 179
  - Purpose: CONNECT COMPANY ("Connect Tally") - attach the company that is open in TallyPrime right now to the CURRENT (already-authenticated) account. The user never supplies a GUID or a name: the backend reads them from Tally, and the GUID stays an internal identity (companyIdentity.js decides whether a tenant is created, reused or reactivated, and whether this account is
  - Calls in this file: `signToken()`
  - Calls other files: `src/services/auth/tallyCompanyGuard.js → detectOpenTallyCompany()`, `src/services/auth/companyIdentity.js → ensureCompanyForGuid()`, `src/models/user.model.js → findById()`, `src/models/userCompanyAccess.model.js → exists()`, `src/models/userCompanyAccess.model.js → findOne()`, `src/models/userCompanyAccess.model.js → create()`
- **`listCompanies()`** _(async)_ — line 300
  - Purpose: LIST COMPANIES the current user can access - their default company (always allowed, even for accounts created before the join collection existed) plus every company connected via addCompany() above.
  - Calls in this file: `addCompany()`
  - Calls other files: `src/models/user.model.js → findById()`, `src/models/company.js → find()`, `src/models/userCompanyAccess.model.js → find()`
- **`switchCompany()`** _(async)_ — line 347
  - Purpose: SWITCH ACTIVE COMPANY - re-scopes the JWT to a company the user already has access to (their own, or one added via addCompany()). Deliberately does NOT require the password again: the user is already authenticated for their account, this only changes which already-authorized company that session is acting as - exactly the
  - Calls in this file: `signToken()`
  - Calls other files: `src/models/user.model.js → findById()`, `src/models/company.js → findOne()`, `src/models/userCompanyAccess.model.js → findOne()`
- **`updateCompanyName()`** _(async)_ — line 424
  - Purpose: RENAME the CURRENT active company (req.user.companyGuId, from the JWT - never a company id supplied by the client). Small, additive fix: the frontend previously "saved" a company name change only to browser localStorage and never called the backend at all. That's a fake success the QA pass flagged - this makes the save real.
  - Calls other files: `src/models/company.js → findOneAndUpdate()`

## `src/controllers/chatController.js`
**Used by:** `src/routes/chatRoutes.js`

**Imports:** `src/middleware/errorHandler.js`, `src/services/query/queryChat.js`, `src/models/chat.model.js`

**Exports:** `sendChatMessage`, `listChats`, `getChat`, `renameChat`, `deleteChat`, `MAX_CHAT_TITLE_CHARS`

- **`sendChatMessage()`** _(async)_ — line 24
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/queryChat.js → tryAnswerWithQueryEngine()`, `src/services/query/queryChat.js → createTurnDates()`, `src/models/chat.model.js → findOne()`
- **`listChats()`** _(async)_ — line 146
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/chat.model.js → find()`
- **`getChat()`** _(async)_ — line 158
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/chat.model.js → findOne()`
- **`deleteChat()`** _(async)_ — line 176
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/chat.model.js → deleteOne()`
- **`renameChat()`** _(async)_ — line 199
  - Purpose: PATCH /api/chat/:chatId {title}. Only the title changes: messages, id and ordering are untouched (timestamps are not bumped, so a rename doesn't move the chat to the top of the list). Same ownership filter as getChat/deleteChat - another user's or another company's chat is simply "not found".
  - Calls other files: `src/models/chat.model.js → findOneAndUpdate()`

## `src/controllers/importController.js`
**Used by:** `src/routes/importRoutes.js`

**Imports:** `src/middleware/errorHandler.js`, `src/services/import/tallySalesImport.js`

**Exports:** `importTallyJson`, `importTallyLive`

- **`checkImportRange()`** — line 12
  - Purpose: Returns an error message for a bad or too-wide range, or null when it is fine. Same rule the service applies: a missing toDate means "the same day as fromDate".
- **`removeUpload()`** _(async)_ — line 41
  - Purpose: The upload only exists to be read once. Delete it as soon as it has been processed (or refused), BEFORE the response is sent, so it is gone by the time the client sees the answer (audit F-14). Never throws.
- **`buildImportResponseBody()`** — line 59
  - Purpose: Shared response shaping for both the file-upload and live-Tally import endpoints, since importTallySales/importTallySalesFromTally return the same result shape (single-voucher result or multi-voucher summary).
- **`respondToImportError()`** — line 142
  - Purpose: (no comment in code — see name and calls below)
- **`importTallyJson()`** _(async)_ — line 176
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `removeUpload()`, `buildImportResponseBody()`, `respondToImportError()`
  - Calls other files: `src/services/import/tallySalesImport.js → importTallySales()`
- **`importTallyLive()`** _(async)_ — line 251
  - Purpose: Live TallyPrime import — fetches sales vouchers directly from Tally's HTTP JSON gateway (reusing the existing odbcService integration) and runs them through the same parse -> map -> validate -> dedupe -> save pipeline as the file-upload import. Optional ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD query params select the
  - Calls in this file: `checkImportRange()`, `buildImportResponseBody()`, `respondToImportError()`
  - Calls other files: `src/services/import/tallySalesImport.js → importTallySalesFromTally()`

## `src/controllers/odbcController.js`
**Purpose (file comment):** const { getCompanyInfo, getSalesVouchers, } = require("../services/odbc/odbcService");

**Used by:** `src/routes/odbcRoutes.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`

- **`testTallyConnection()`** _(async)_ — line 201
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/odbc/odbcService.js → getCompanyInfo()`, `src/services/auth/tallyCompanyGuard.js → resolveSelectedOpenCompany()`
- **`getSales()`** _(async)_ — line 254
  - Purpose: No auth/tenant context on this route (a legacy diagnostic endpoint, not the real tenant-scoped /api/import/tally-live path) - so unlike that path, there's no companyGuId to resolve a Company from. Instead it resolves classification for whichever company Tally currently has open, same generic voucherTypeClassifier the rest of the app uses,
  - Calls other files: `src/services/odbc/odbcService.js → getSalesVouchers()`, `src/services/auth/tallyCompanyGuard.js → resolveSelectedOpenCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`

## `src/controllers/reportController.js`
**Used by:** `src/routes/reportRoutes.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/trustEnvelope.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/analytics/reportAnalytics.js`, `src/services/analytics/dateRanges.js`

**Exports:** `getProductReport`, `getCustomerReport`, `exportSalesReport`, `exportPurchaseReport`, `exportProductReport`, `exportCustomerReport`

- **`parsePeriodFromQuery()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/dateRanges.js → resolveRequestPeriod()`
- **`parsePagination()`** — line 46
  - Purpose: (no comment in code — see name and calls below)
- **`handle()`** — line 55
  - Purpose: (no comment in code — see name and calls below)
- **`csvField()`** — line 73
  - Purpose: Minimal RFC 4180 CSV field escaping - wraps in quotes and doubles any embedded quote whenever the field contains a comma, quote or newline (real party/item names can contain any of these, e.g. `M/S ABC, INC.`).
- **`csvRow()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
- **`sendCsv()`** — line 86
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `parsePeriodFromQuery()`, `parsePagination()`, `handle()`, `csvRow()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/services/analytics/referenceDate.js → getTenantReferenceDate()`, `src/services/analytics/trustEnvelope.js → wrapAnalyticsResult()`, `src/models/sales.model.js → find()`, `src/models/purchase.model.js → find()`, `src/services/analytics/reportAnalytics.js → getProductReport()`, `src/services/analytics/reportAnalytics.js → getCustomerReport()`

## `src/controllers/syncRecoveryController.js`
**Used by:** `src/routes/syncRoutes.js`

**Imports:** `src/services/import/tallySalesImport.js`, `src/services/sync/voucherRecovery.js`

**Exports:** `runVoucherRecovery`

- **`runVoucherRecovery()`** _(async)_ — line 26
  - Purpose: POST /api/sync/recovery { voucherType: "Sales"|"Purchase", apply?: boolean } Compares Tally with MongoDB for the caller's own company and (only when apply === true) re-imports vouchers that exist in Tally but are missing from MongoDB. Default is a dry run that writes nothing. This is not a checkpoint reset and never touches the incremental sync's checkpoint.
  - Calls other files: `src/services/import/tallySalesImport.js → resolveTenantContext()`, `src/services/sync/voucherRecovery.js → recoverMissingVouchers()`

## `src/controllers/syncStatusController.js`
**Used by:** `src/routes/syncRoutes.js`

**Imports:** `src/services/import/tallySalesImport.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js`

**Exports:** `getSyncStatus`

- **`serializeCheckpoint()`** — line 9
  - Purpose: (no comment in code — see name and calls below)
- **`serializeReconciliation()`** — line 20
  - Purpose: (no comment in code — see name and calls below)
- **`serializeVoucher()`** — line 33
  - Purpose: (no comment in code — see name and calls below)
- **`getSyncStatus()`** _(async)_ — line 58
  - Purpose: Real backend data for the Sync & Data page (docs §5.1/§16 previously had no REST endpoint exposing SyncCheckpoint/ReconciliationCheckpoint or the actual synced records - only the cron workers wrote them internally). This is that endpoint: everything returned here is read straight from MongoDB for the caller's own tenant (re-derived from
  - Calls in this file: `serializeCheckpoint()`, `serializeReconciliation()`
  - Calls other files: `src/services/import/tallySalesImport.js → resolveTenantContext()`, `src/models/sales.model.js → find()`, `src/models/sales.model.js → countDocuments()`, `src/models/purchase.model.js → find()`, `src/models/purchase.model.js → countDocuments()`, `src/models/syncCheckpoint.model.js → findOne()`, `src/models/reconciliationCheckpoint.model.js → findOne()`

## `src/controllers/voucherController.js`
**Used by:** `src/routes/voucherRoutes.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`

**Exports:** `listSalesVouchers`, `listPurchaseVouchers`

- **`parsePagination()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`parseDateBound()`** — line 32
  - Purpose: (no comment in code — see name and calls below)
- **`escapeRegex()`** — line 46
  - Purpose: Same regex-escaping discipline as the query engine's name matching (query/compile.js) - real voucher/party text, never a pattern, so it must never be interpreted as one.
- **`buildSearchClause()`** — line 56
  - Purpose: One `search` box covers the fields that make sense for free text: voucher number and party name (partial, case-insensitive), plus an exact amount match when the term parses as a number. Date is deliberately NOT part of free-text search - date-format parsing from arbitrary text is ambiguous; the existing `from`/`to` params (same
  - Calls in this file: `escapeRegex()`
- **`listVouchers()`** _(async)_ — line 74
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `parsePagination()`, `parseDateBound()`, `buildSearchClause()`
- **`listSalesVouchers()`** — line 131
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `listVouchers()`
- **`listPurchaseVouchers()`** — line 132
  - Purpose: (no comment in code — see name and calls below)


# 5. Models (MongoDB tables)

## `src/models/adjustmentNote.model.js`
**Used by:** `src/services/sync/adjustmentNotePersistence.js`


## `src/models/aiTurnUsage.model.js`
**Used by:** `src/services/query/usageStore.js`


## `src/models/chat.model.js`
**Used by:** `src/controllers/chatController.js`


## `src/models/company.js`
**Used by:** `src/controllers/authController.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/import/tallySalesImport.js`, `src/services/auth/companyContext.js`, `src/services/auth/companyIdentity.js`

**Imports:** `src/services/odbc/tallyUrl.js`


## `src/models/gstSchemas.js`
**Used by:** `src/models/purchase.model.js`, `src/models/sales.model.js`, `src/models/stockItemMaster.model.js`

**Exports:** `stockItemGstSchema`, `voucherLineGstSchema`


## `src/models/ledgerMaster.model.js`
**Used by:** `src/services/tally/adjustmentNoteClassifier.js`, `src/services/tally/ledgerMaster.js`, `src/services/query/execute.js`


## `src/models/purchase.model.js`
**Used by:** `src/controllers/reportController.js`, `src/controllers/syncStatusController.js`, `src/controllers/voucherController.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/analytics/insights.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/reportAnalytics.js`, `src/services/query/entityResolver.js`

**Imports:** `src/models/gstSchemas.js`


## `src/models/reconciliationCheckpoint.model.js`
**Used by:** `src/controllers/syncStatusController.js`, `src/services/sync/reconciliationWorker.js`, `src/services/auth/companyIdentity.js`


## `src/models/sales.model.js`
**Used by:** `src/controllers/reportController.js`, `src/controllers/syncStatusController.js`, `src/controllers/voucherController.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallySalesImport.js`, `src/services/analytics/insights.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/reportAnalytics.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/entityResolver.js`

**Imports:** `src/models/gstSchemas.js`


## `src/models/stockItemMaster.model.js`
**Used by:** `src/services/tally/stockItemGst.js`, `src/services/tally/stockItemMaster.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/entityResolver.js`, `src/services/query/execute.js`

**Imports:** `src/models/gstSchemas.js`


## `src/models/syncCheckpoint.model.js`
**Used by:** `src/controllers/syncStatusController.js`, `src/services/sync/selfHeal.js`, `src/services/sync/tallySyncWorker.js`, `src/services/auth/companyIdentity.js`, `src/services/analytics/freshness.js`, `src/services/analytics/referenceDate.js`


## `src/models/tenantDataVersion.model.js`
**Used by:** (entry file / run directly)


## `src/models/user.model.js`
**Used by:** `src/middleware/auth.js`, `src/controllers/authController.js`, `src/services/auth/companyContext.js`, `src/services/auth/companyIdentity.js`


## `src/models/userCompanyAccess.model.js`
**Used by:** `src/controllers/authController.js`, `src/services/auth/companyContext.js`, `src/services/auth/companyIdentity.js`



# 6. Tally se baat (odbc)

## `src/services/odbc/odbcService.js`
**Used by:** `src/controllers/odbcController.js`, `src/services/tally/ledgerMaster.js`, `src/services/tally/stockItemGst.js`, `src/services/tally/stockItemMaster.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallySalesImport.js`, `src/services/auth/tallyCompanyGuard.js`

**Imports:** `src/services/odbc/tallyUrl.js`

**Exports:** `getCompanyInfo`, `getVoucherTypeMasters`, `getStockItemMasters`, `getStockItemGstMasters`, `isSafeStockGroupNameForFormula`, `STOCK_ITEM_GST_NATIVE_METHOD`, `getLedgerMasters`, `getGroupMasters`, `getPendingVoucherAlterIds`, `getVouchersByAlterIds`, `MAX_ALTERIDS_PER_RECOVERY_QUERY`, `getSalesVouchers`, `getSalesVouchersSinceAlterId`, `getAllSalesVoucherGuids`, `getAllPurchaseVoucherGuids`, `getPurchaseVouchersSinceAlterId`, `getAdjustmentNoteVouchersSinceAlterId`

- **`formatTallyDate()`** — line 18
  - Purpose: Tally's $$Date literal expects DD-MM-YYYY.
- **`resolveDateBound()`** — line 25
  - Purpose: (no comment in code — see name and calls below)
- **`getCompanyInfo()`** _(async)_ — line 61
  - Purpose: Fixed during QA (2026-09-17→18): the previous version of this function used a Report -> Form -> Part -> Line -> Field TDL chain that was never bound to any Collection, so Tally had no object to iterate and this always returned an empty {} regardless of what was open - it could never actually confirm a company, let alone expose a GUID.
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`isSafeVoucherTypeNameForFormula()`** — line 148
  - Purpose: Voucher type names come from Tally's own metadata, not arbitrary user input, but this is a cheap defensive guard: there's no confirmed-safe escape sequence for a literal double quote inside a Tally TDL formula string literal, so a name containing one is excluded rather than risking a malformed (or injectable) formula.
- **`buildVoucherTypeNameFilterClause()`** — line 157
  - Purpose: Builds a single "($VoucherTypeName = "A") OR ($VoucherTypeName = "B") OR ..." clause. Confirmed live: this correctly aggregates vouchers across multiple distinct voucher-type names in one query (e.g. a company recording sales under both "Sales" and "Invoice" returned the exact sum of each name's individual count).
- **`buildAlterIdRangeClause()`** — line 177
  - Purpose: "$AlterID > threshold", optionally capped with "AND $AlterID <= upTo" so a caller can request one bounded slice of a large backlog instead of everything since the checkpoint. With no cap the clause is exactly what the incremental queries always used.
- **`requireVoucherTypeNames()`** — line 195
  - Purpose: (no comment in code — see name and calls below)
- **`getVoucherTypeMasters()`** _(async)_ — line 220
  - Purpose: GET VOUCHER TYPE MASTERS (for generic Sales/Purchase classification) Confirmed live against TallyPrime: "Type": "VoucherType" is a flat master collection - every voucher type in the company, each carrying its own "parent" (one level up) plus Tally's own ambient metadata.reservedname (returned automatically, without needing to ask
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getStockItemMasters()`** _(async)_ — line 297
  - Purpose: GET STOCK ITEM MASTERS (Stock Item -> Stock Group) Confirmed live against this project's own connected TallyPrime instance (WE FOUR, 2026-09): "Type": "StockItem" is a flat master collection, exactly like "Type": "VoucherType" above - every Stock Item in the company, each carrying its own $Parent (the Stock Group
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`isSafeStockGroupNameForFormula()`** — line 379
  - Purpose: The group name is placed inside a TDL formula string, so a name that could break out of it is refused (the caller reports the group as skipped; its items keep whatever GST data they already had).
- **`getStockItemGstMasters()`** _(async)_ — line 383
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isSafeStockGroupNameForFormula()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`postMasterCollection()`** _(async)_ — line 475
  - Purpose: GET LEDGER / GROUP MASTERS Flat master collections, the same shape as "Type": "StockItem" above. Confirmed live (read-only diagnostic, WE FOUR, 2026-09): 1,979 ledgers in 0.46 s and 70 groups in 30 ms, every record carrying a "<companyGuid>-<hex>" Guid. Minimal field sets only - no GSTIN, no
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getLedgerMasters()`** _(async)_ — line 504
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `postMasterCollection()`
- **`getGroupMasters()`** _(async)_ — line 520
  - Purpose: Groups carry metadata.reservedname ("Sundry Debtors", ...), which is what the ledger party role is derived from - never the user-editable name.
  - Calls in this file: `postMasterCollection()`
- **`getSalesVouchers()`** _(async)_ — line 546
  - Purpose: `voucherTypeNames` must be pre-resolved by voucherTypeClassifier.js - same generic classification the incremental sync worker and reconciliation use, not a hardcoded literal. Replaces the old "Child Of": "$$VchTypeSales" attribute (confirmed live to only match vouchers named exactly "Sales") with a single explicit AND/OR formula
  - Calls in this file: `formatTallyDate()`, `resolveDateBound()`, `buildVoucherTypeNameFilterClause()`, `requireVoucherTypeNames()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getSalesVouchersSinceAlterId()`** _(async)_ — line 690
  - Purpose: GET SALES VOUCHERS SINCE ALTERID (incremental sync) Unlike getSalesVouchers (date-range based, used by the manual /tally-live endpoint), this filters on Tally's $AlterID — a per-object counter that increases on every create AND modify, regardless of the voucher's own date. That's what makes it a correct incremental feed:
  - Calls in this file: `buildVoucherTypeNameFilterClause()`, `buildAlterIdRangeClause()`, `requireVoucherTypeNames()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getPurchaseVouchersSinceAlterId()`** _(async)_ — line 787
  - Purpose: GET PURCHASE VOUCHERS SINCE ALTERID (incremental sync) Mirrors getSalesVouchersSinceAlterId exactly, with the Purchase-class voucherTypeNames set instead - see that function's comment for the full rationale. Kept as its own self-contained function (not a shared builder with the Sales version) to match this file's existing style.
  - Calls in this file: `buildVoucherTypeNameFilterClause()`, `buildAlterIdRangeClause()`, `requireVoucherTypeNames()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getAdjustmentNoteVouchersSinceAlterId()`** _(async)_ — line 888
  - Purpose: GET ADJUSTMENT NOTE VOUCHERS SINCE ALTERID (incremental sync) Credit Note / Debit Note. Same shape as getSalesVouchersSinceAlterId, with two additions to the Native Method field list, proven live in the CN/DN diagnostic (docs/../generic-tumbling-magpie.md): inventoryentries' accountingallocations (which ledger an item's amount is booked to - what
  - Calls in this file: `buildVoucherTypeNameFilterClause()`, `buildAlterIdRangeClause()`, `requireVoucherTypeNames()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getPendingVoucherAlterIds()`** _(async)_ — line 990
  - Purpose: GET PENDING ALTERIDS (batch planning for incremental sync) Light probe used by the sync worker to size a batch BEFORE fetching full vouchers: same filter as the incremental fetch, but only VoucherTypeName + AlterID are requested - no inventoryentries/ledgerentries walk, which is what makes a full fetch of thousands of vouchers exceed the 30s
  - Calls in this file: `buildVoucherTypeNameFilterClause()`, `buildAlterIdRangeClause()`, `requireVoucherTypeNames()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getVouchersByAlterIds()`** _(async)_ — line 1089
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildVoucherTypeNameFilterClause()`, `requireVoucherTypeNames()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`buildAllGuidsRequestBody()`** — line 1218
  - Purpose: GET ALL SALES / PURCHASE VOUCHER GUIDS (reconciliation) Lightest possible query for the reconciliation safety-net: no AlterID filter (deliberately - a deleted voucher never shows up regardless of AlterID, confirmed against a live TallyPrime instance, so filtering by AlterID here would defeat the purpose), and
  - Calls in this file: `buildVoucherTypeNameFilterClause()`
- **`getAllSalesVoucherGuids()`** _(async)_ — line 1252
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `requireVoucherTypeNames()`, `buildAllGuidsRequestBody()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getAllPurchaseVoucherGuids()`** _(async)_ — line 1281
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `requireVoucherTypeNames()`, `buildAllGuidsRequestBody()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`

## `src/services/odbc/tallyUrl.js`
**Purpose (file comment):** Which addresses may TallyPulse send Tally requests to? (audit finding F-10) Each company can carry its own `tallyConnection.baseUrl`. No API sets it today (only direct database edits do), but it is used as the destination of every Tally request, so it is checked at the moment of use - a bad value fails closed instead of turning the backend into a proxy for other internal services. Rules: - must be an http:// or https:// URL, with no user name / password in it - link-local addresses are refused: 169.254.0.0/16 (this is where cloud metadata services live, e.g. 169.254.169.254), fe80::/10, the AWS IPv6

**Used by:** `src/models/company.js`, `src/services/odbc/odbcService.js`

**Exports:** `assertSafeTallyUrl`, `isSafeTallyUrl`, `resolveTallyUrl`

- **`fail()`** — line 38
  - Purpose: (no comment in code — see name and calls below)
- **`assertSafeTallyUrl()`** — line 43
  - Purpose: Returns the URL (trimmed, otherwise unchanged) when it is acceptable; throws otherwise.
  - Calls in this file: `fail()`
- **`isSafeTallyUrl()`** — line 71
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `assertSafeTallyUrl()`
- **`resolveTallyUrl()`** — line 81
  - Purpose: The URL to use for a request: the company's own, or the default when none is set.
  - Calls in this file: `assertSafeTallyUrl()`


# 7. Tally rules / masters

## `src/services/tally/adjustmentNoteClassifier.js`
**Used by:** `src/services/sync/adjustmentNotePersistence.js`

**Imports:** `src/models/ledgerMaster.model.js`

**Exports:** `classifyAdjustmentNote`, `resolveAccountRoles`, `NOTE_ROLE`, `NOTE_CLASSIFICATION`

- **`classifyAdjustmentNote()`** — line 33
  - Purpose: @param {Object} parsedVoucher - from adjustmentNoteParser.parseAdjustmentNoteVoucher @param {"credit"|"debit"} noteType @param {Map<string,string>} accountRoleByLedgerName - THIS tenant's LedgerMaster name -> accountRole, pre-resolved by the caller (one bounded query per voucher's distinct ledger names - see resolveAccountRoles below).
- **`resolveAccountRoles()`** _(async)_ — line 54
  - Purpose: One bounded, tenant-scoped, indexed lookup ({tenantId, name} index) per distinct ledger name a batch of notes actually references - never a full LedgerMaster scan, and never a Tally call (LedgerMaster is sync-time data). Ambiguous (same-name) ledgers resolve to "other" (never guessed), same fail-closed posture as ledgerMaster.js's own new-party resolution.
  - Calls other files: `src/models/ledgerMaster.model.js → find()`

## `src/services/tally/companyOwnership.js`
**Used by:** `src/services/tally/ledgerMaster.js`, `src/services/tally/stockItemGst.js`, `src/services/tally/stockItemMaster.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/sync/reconciliation.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallySalesImport.js`, `src/services/auth/tallyCompanyGuard.js`

**Imports:** `src/services/parser/tallyParser.js`

**Exports:** `validateBatchOwnership`, `assertBatchOwnership`, `validateMasterOwnership`, `classifyGuid`, `logMismatch`, `CompanyMismatchError`

- **`guidText()`** — line 28
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`
- **`classifyGuid()`** — line 35
  - Purpose: "<companyGuid>-<masterId>": exact company GUID, then a hyphen, then a non-empty alphanumeric master id. Anything else is not this company's.
- **`shortGuid()`** — line 50
  - Purpose: Short, non-sensitive label for logs: the first 8 characters of a GUID.
- **`validateBatchOwnership()`** — line 66
  - Purpose: Validate a batch of Tally items (vouchers, registry rows, ...) against the tenant's company GUID. @param {Array} items - rows as returned by Tally; each carries a `guid` (raw JSONEx value or a plain string). @param {string} expectedCompanyGuid - trusted, from the Company record.
  - Calls in this file: `guidText()`, `classifyGuid()`, `shortGuid()`
- **`assertBatchOwnership()`** — line 136
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `validateBatchOwnership()`, `logMismatch()`
- **`logMismatch()`** — line 149
  - Purpose: One line, counts and truncated prefixes only - enough to diagnose, nothing about the vouchers themselves.
  - Calls in this file: `shortGuid()`
- **`validateMasterOwnership()`** — line 167
  - Purpose: Voucher-type MASTERS (and other master data) also follow Tally's selected company. Requested with the Guid method, each master carries "<companyGuid>-<masterId>" too (confirmed live: 39 of 39). A response is accepted only if NO record carries another company's GUID and at least one record positively carries this company's. Records with no GUID at all are
  - Calls in this file: `guidText()`, `classifyGuid()`, `shortGuid()`

## `src/services/tally/ledgerMaster.js`
**Used by:** (entry file / run directly)

**Imports:** `src/services/odbc/odbcService.js`, `src/services/tally/companyOwnership.js`, `src/services/parser/tallyParser.js`, `src/models/ledgerMaster.model.js`

**Exports:** `parseGroupMasterList`, `parseLedgerMasterList`, `derivePartyRole`, `deriveAccountRole`, `refreshLedgerMasters`, `MAX_REMOVAL_RATIO`

- **`unwrap()`** — line 27
  - Purpose: (no comment in code — see name and calls below)
- **`text()`** — line 28
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrap()`
- **`num()`** — line 32
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `text()`
- **`collectionOf()`** — line 39
  - Purpose: (no comment in code — see name and calls below)
- **`parseGroupMasterList()`** — line 45
  - Purpose: [{name, parent, reservedName, guid}] - every group, as Tally returned it.
  - Calls in this file: `text()`, `collectionOf()`
- **`parseLedgerMasterList()`** — line 55
  - Purpose: [{name, parent, guid, alterId, masterId, createdDate}] - every ledger with a name.
  - Calls in this file: `text()`, `num()`, `collectionOf()`
  - Calls other files: `src/services/parser/tallyParser.js → parseTallyDate()`
- **`deriveRole()`** — line 75
  - Purpose: Walks the group chain up to a group Tally itself reserves under one of `reservedRoleMap`'s keys. Renamed or nested sub-groups resolve through the chain; a broken or cyclic chain (or one that never reaches a reserved group in the map) is "other", never a guess.
- **`derivePartyRole()`** — line 96
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `deriveRole()`
- **`deriveAccountRole()`** — line 100
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `deriveRole()`
- **`buildFailureResult()`** — line 104
  - Purpose: (no comment in code — see name and calls below)
- **`parsePayload()`** — line 108
  - Purpose: (no comment in code — see name and calls below)
- **`refreshLedgerMasters()`** _(async)_ — line 128
  - Purpose: Fetch this tenant's Ledger (and Group) masters from Tally, verify company ownership of BOTH lists, and only then upsert into LedgerMaster. @param {Object} params @param {string} params.tenantId - the app's own tenant id (never from Tally). @param {string} params.companyGuid - trusted, from the Company record.
  - Calls in this file: `parseGroupMasterList()`, `parseLedgerMasterList()`, `derivePartyRole()`, `deriveAccountRole()`, `buildFailureResult()`, `parsePayload()`
  - Calls other files: `src/services/tally/companyOwnership.js → validateMasterOwnership()`, `src/models/ledgerMaster.model.js → find()`, `src/models/ledgerMaster.model.js → bulkWrite()`, `src/models/ledgerMaster.model.js → updateMany()`

## `src/services/tally/stockItemGst.js`
**Used by:** `src/services/tally/stockItemMaster.js`

**Imports:** `src/services/parser/gstFields.js`, `src/services/tally/companyOwnership.js`, `src/services/odbc/odbcService.js`, `src/models/stockItemMaster.model.js`

**Exports:** `GST_SCHEMA_VERSION`, `mergeGst`, `hashContent`, `validateGstBlock`, `parseGstResponse`, `refreshStockItemGst`

- **`canonical()`** — line 36
  - Purpose: Key order and null/absent differences must not change the hash, so a re-read of stored data hashes the same as the freshly parsed data it came from.
- **`hashContent()`** — line 46
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `canonical()`
- **`hasContent()`** — line 52
  - Purpose: (no comment in code — see name and calls below)
- **`substance()`** — line 61
  - Purpose: How much real content a section holds. A response whose sections are present but hollow (for example history entries with no rate rows because the nested rate methods were not returned, or HSN entries with no code) must not replace a stored section that has content. Every real entry seen so far, including Non-GST and Exempt, carries its rate rows.
  - Calls in this file: `hasContent()`
- **`capIssues()`** — line 67
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `substance()`
- **`mergeGst()`** — line 91
  - Purpose: Combine the stored `gst` of an item with what Tally just returned. Per section: absent Tally did not return that part -> keep stored empty returned but empty -> keep stored if it had content (never erase), else store the empty hollow entries present but without substance -> keep stored if it had substance (rate rows / HSN codes)
  - Calls in this file: `hashContent()`, `hasContent()`, `substance()`, `capIssues()`
- **`validateGstBlock()`** _(async)_ — line 163
  - Purpose: Schema-level check of a block before it is written (enum/required/type errors from our own code or a future Tally variation never reach the database; the item is reported as invalid instead).
- **`parseGstResponse()`** — line 175
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/gstFields.js → parseStockItemGstRecord()`
- **`newSummary()`** — line 182
  - Purpose: (no comment in code — see name and calls below)
- **`note()`** — line 209
  - Purpose: (no comment in code — see name and calls below)
- **`refreshStockItemGst()`** _(async)_ — line 222
  - Purpose: @param {Object} params @param {string} params.tenantId @param {string} params.companyGuid trusted, from the Company record @param {string} [params.baseUrl] @param {Array<{itemName, stockGroupName, tallyGuid}>} params.items this run's ownership-verified core items
  - Calls in this file: `mergeGst()`, `validateGstBlock()`, `parseGstResponse()`, `newSummary()`, `note()`
  - Calls other files: `src/services/tally/companyOwnership.js → validateMasterOwnership()`, `src/services/odbc/odbcService.js → isSafeStockGroupNameForFormula()`, `src/models/stockItemMaster.model.js → find()`, `src/models/stockItemMaster.model.js → bulkWrite()`

## `src/services/tally/stockItemMaster.js`
**Used by:** (entry file / run directly)

**Imports:** `src/services/odbc/odbcService.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`, `src/services/tally/stockItemGst.js`, `src/models/stockItemMaster.model.js`

**Exports:** `parseStockItemMasterList`, `findUnusableStockItemEntries`, `refreshStockItemMasters`

- **`parseStockItemMasterList()`** — line 28
  - Purpose: {name, parent, guid} (as parsed) -> {itemName, stockGroupName, tallyGuid} (StockItem-appropriate names). Only real, non-empty Tally values pass through - an item with an empty $Parent is dropped (fail closed: "no group" is not a group and must never become one, e.g. "").
  - Calls other files: `src/services/tally/voucherTypeClassifier.js → parseVoucherTypeMasterList()`
- **`findUnusableStockItemEntries()`** — line 43
  - Purpose: Items whose Tally record was missing a usable name/parent/guid - reported separately so a caller can see what was silently excluded, rather than that exclusion being invisible.
  - Calls other files: `src/services/tally/voucherTypeClassifier.js → parseVoucherTypeMasterList()`
- **`buildFailureResult()`** — line 48
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/odbc/odbcService.js → getStockItemMasters()`
- **`refreshStockItemMasters()`** _(async)_ — line 84
  - Purpose: Fetch this tenant's Stock Item masters from Tally, verify company ownership, and (only if verification passes) upsert them into StockItemMaster. Fails closed: any fetch/parse/ownership problem leaves whatever StockItemMaster data already exists completely untouched - never partially written, never cleared, never guessed.
  - Calls in this file: `parseStockItemMasterList()`, `findUnusableStockItemEntries()`, `buildFailureResult()`
  - Calls other files: `src/services/tally/voucherTypeClassifier.js → parseVoucherTypeMasterList()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`, `src/services/tally/stockItemGst.js → refreshStockItemGst()`, `src/models/stockItemMaster.model.js → bulkWrite()`

## `src/services/tally/voucherTypeClassifier.js`
**Used by:** `src/controllers/odbcController.js`, `src/services/tally/stockItemMaster.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallySalesImport.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/tally/companyOwnership.js`

**Exports:** `classifyVoucherTypes`, `parseVoucherTypeMasterList`, `resolveVoucherTypeClassification`, `clearVoucherTypeClassificationCache`, `DEFAULT_CACHE_TTL_MS`, `RESERVED_SALES`, `RESERVED_PURCHASE`, `RESERVED_CREDIT_NOTE`, `RESERVED_DEBIT_NOTE`

- **`safeString()`** — line 49
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`
- **`parseVoucherTypeMasterList()`** — line 58
  - Purpose: Extracts {name, parent, reservedName} for every voucher type Tally's "Type": "VoucherType" collection returns. Real identities only, straight off Tally's own response - never invents a value when one is missing.
  - Calls in this file: `safeString()`
- **`classifyVoucherTypes()`** — line 88
  - Purpose: Pure, synchronous core algorithm - no I/O, fully unit-testable. voucherTypeMasters: [{name, parent, reservedName}] Returns: { sales: { status: "ok" | "needs_configuration", typeNames, rootName, reason },
- **`buildFetchFailureResult()`** — line 252
  - Purpose: (no comment in code — see name and calls below)
- **`cacheKeyFor()`** — line 286
  - Purpose: (no comment in code — see name and calls below)
- **`resolveVoucherTypeClassification()`** _(async)_ — line 295
  - Purpose: Fail-closed by construction: any fetch/parse error, or a company whose Sales/Purchase root can't be uniquely resolved, comes back as a non-"ok" status - it is never translated into a fallback to the old $$VchTypeSales/$$VchTypePurchase behavior by this function or its callers.
  - Calls in this file: `parseVoucherTypeMasterList()`, `classifyVoucherTypes()`, `buildFetchFailureResult()`, `cacheKeyFor()`
  - Calls other files: `src/services/odbc/odbcService.js → getVoucherTypeMasters()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`
- **`clearVoucherTypeClassificationCache()`** — line 375
  - Purpose: (no comment in code — see name and calls below)


# 8. Parser

## `src/services/parser/adjustmentNoteParser.js`
**Used by:** `src/services/sync/adjustmentNotePersistence.js`

**Imports:** `src/services/parser/tallyParser.js`

**Exports:** `parseAdjustmentNoteVoucher`

- **`findInventoryEntries()`** — line 31
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → findCollectionByKeywords()`
- **`findLedgerEntries()`** — line 39
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → findCollectionByKeywords()`
- **`parseAccountingAllocations()`** — line 53
  - Purpose: The single ledger an inventory line's amount is booked against. A line can in principle carry more than one accounting allocation (a split); the diagnostic's 15 sampled real vouchers never showed this, but if Tally ever returns more than one, the line is treated as having NO single resolvable ledger (classification below falls back to value_adjustment
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`, `src/services/parser/tallyParser.js → safeString()`, `src/services/parser/tallyParser.js → parseAmount()`
- **`parseBillAllocations()`** — line 65
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`, `src/services/parser/tallyParser.js → safeString()`, `src/services/parser/tallyParser.js → parseAmount()`
- **`parseAdjustmentNoteVoucher()`** — line 78
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `findInventoryEntries()`, `findLedgerEntries()`, `parseAccountingAllocations()`, `parseBillAllocations()`
  - Calls other files: `src/services/parser/tallyParser.js → safeString()`, `src/services/parser/tallyParser.js → parseTallyDate()`, `src/services/parser/tallyParser.js → parseQuantity()`, `src/services/parser/tallyParser.js → parseRate()`, `src/services/parser/tallyParser.js → parseAmount()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/parser/tallyParser.js → parseTallyBoolean()`, `src/services/parser/tallyParser.js → computePartyLedgerTotal()`

## `src/services/parser/gstFields.js`
**Purpose (file comment):** Pure GST field parsing for Tally data. No I/O, no database, no clock. Two sources use it, and their results are deliberately kept apart: - parseStockItemGstRecord: the CURRENT Stock Item master (dated history of HSN/SAC, taxability and rates, as Tally holds it today). - parseVoucherLineGst: what one voucher inventory line SAID at posting time. A voucher line is a historical fact; it is never rewritten from the master. Field names below are the ones a real TallyPrime returned (read-only probe, WE FOUR, 2026-10-09; see verify-stock-item-gst.js for the captured shape): stock item: gstapplicable, gsttypeofsupply, hsndetails[{applicablefrom, hsncode, hsn, srcofhsndetails}], gstdetails[{applicable

**Used by:** `src/services/tally/stockItemGst.js`, `src/services/parser/tallyParser.js`

**Exports:** `MAX_ISSUES`, `cleanText`, `numericField`, `booleanField`, `dayField`, `keyOf`, `DUTY_HEAD_KEYS`, `TAXABILITY_KEYS`, `VALUATION_KEYS`, `APPLICABLE_KEYS`, `parseStockItemGstRecord`, `parseVoucherLineGst`, `parseLineTaxAmounts`, `LINE_TAX_AMOUNT_KEYS`, `resolveGstAsOf`

- **`unwrap()`** — line 39
  - Purpose: Tally wraps scalars as {type, value} and sometimes as [{metadata:true}, value]. Local copy of the unwrap convention in tallyParser.js (that file requires this one, so requiring it back would be circular).
- **`stripControl()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
- **`cleanText()`** — line 60
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrap()`, `stripControl()`
- **`pick()`** — line 67
  - Purpose: (no comment in code — see name and calls below)
- **`isPresent()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`numericField()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrap()`, `stripControl()`
- **`booleanField()`** — line 97
  - Purpose: true / false / null (not supplied). malformed=true when something unrecognisable was supplied.
  - Calls in this file: `unwrap()`, `stripControl()`
- **`dayField()`** — line 111
  - Purpose: Tally dates arrive as YYYYMMDD. Stored as UTC midnight, the same convention as voucher dates.
  - Calls in this file: `unwrap()`, `stripControl()`, `isPresent()`
- **`normKey()`** — line 130
  - Purpose: (no comment in code — see name and calls below)
- **`keyOf()`** — line 137
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `normKey()`
- **`makeContext()`** — line 144
  - Purpose: (no comment in code — see name and calls below)
- **`objectRows()`** — line 158
  - Purpose: A Tally sub-collection is normally an array of objects; a single object is accepted as one row.
- **`parseRateRows()`** — line 173
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `cleanText()`, `pick()`, `numericField()`, `keyOf()`, `objectRows()`
- **`finaliseTimeline()`** — line 202
  - Purpose: Sort ascending by applicableFrom (undated last, original order kept for ties) and derive each entry's last effective day from the next LATER entry. The last dated entry stays open-ended.
- **`parseHsnEntries()`** — line 226
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `cleanText()`, `pick()`, `dayField()`, `objectRows()`, `finaliseTimeline()`
- **`parseGstDetailEntries()`** — line 245
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `cleanText()`, `pick()`, `numericField()`, `booleanField()`, `dayField()`, `keyOf()`, `objectRows()`, `parseRateRows()`, `finaliseTimeline()`
- **`parseStockItemGstRecord()`** — line 286
  - Purpose: One Stock Item record from the StockItem collection -> the GST view of it. applicability / hsn / details are null when Tally did not return that part at all (absent), which is different from a part that is present but empty.
  - Calls in this file: `cleanText()`, `pick()`, `isPresent()`, `keyOf()`, `makeContext()`, `parseHsnEntries()`, `parseGstDetailEntries()`
- **`parseLineTaxAmounts()`** — line 337
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `pick()`, `numericField()`
- **`parseVoucherLineGst()`** — line 350
  - Purpose: What the voucher line itself carried. Returns null when the line has no GST fields at all (so old-shaped vouchers map to exactly what they did before).
  - Calls in this file: `cleanText()`, `pick()`, `isPresent()`, `keyOf()`, `makeContext()`, `parseRateRows()`, `parseLineTaxAmounts()`
- **`toUtcDay()`** — line 390
  - Purpose: (no comment in code — see name and calls below)
- **`resolveGstAsOf()`** — line 398
  - Purpose: The dated entries in effect on a given day: the latest entry whose applicableFrom is on or before it. Undated entries are never chosen. Returns null parts when nothing was in effect.
  - Calls in this file: `toUtcDay()`

## `src/services/parser/tallyParser.js`
**Used by:** `src/services/tally/companyOwnership.js`, `src/services/tally/ledgerMaster.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/parser/adjustmentNoteParser.js`, `src/services/sync/reconciliation.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherPersistence.js`, `src/services/sync/voucherRecovery.js`, `src/services/auth/tallyCompanyGuard.js`

**Imports:** `src/services/parser/gstFields.js`

**Exports:** `parseTallyVoucher`, `extractOpenCompanies`, `parseTallyDate`, `parseQuantity`, `parseRate`, `parseAmount`, `parseTallyId`, `parseTallyBoolean`, `unwrapJsonExValue`, `computePartyLedgerTotal`, `safeString`, `findCollectionByKeywords`, `parseDiscountPercentage`, `deriveDiscountAmount`

- **`isObject()`** — line 3
  - Purpose: (no comment in code — see name and calls below)
- **`unwrapJsonExValue()`** — line 13
  - Purpose: Tally JSONEx sometimes wraps a field's real value instead of sending a plain primitive, e.g. { value: "...", taxtype: "GST" } or the [ { metadata: true, type: "String" }, "actual value" ] pair pattern used for UDF/list fields. Unwrap those shapes down to the underlying scalar before any parsing runs, so a field being wrapped never silently breaks
  - Calls in this file: `isObject()`
- **`safeString()`** — line 36
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrapJsonExValue()`
- **`normalizeLedgerEntryType()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `safeString()`
- **`computePartyLedgerTotal()`** — line 65
  - Purpose: The true voucher/invoice total: the absolute amount of the ledger entry(ies) whose ledgerName exactly matches partyName (a balanced voucher's party ledger line IS the full total - see the call site's comment for the audit evidence). Returns null (never a fabricated 0 or silently-wrong number) when no ledger entry matches, so the caller can
- **`findCollectionByKeywords()`** — line 78
  - Purpose: (no comment in code — see name and calls below)
- **`parseTallyDate()`** — line 112
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrapJsonExValue()`, `safeString()`
- **`parseQuantity()`** — line 136
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrapJsonExValue()`, `safeString()`
- **`parseRate()`** — line 162
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrapJsonExValue()`, `safeString()`
- **`parseAmount()`** — line 189
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrapJsonExValue()`, `safeString()`
- **`parseTallyId()`** — line 204
  - Purpose: Unlike parseAmount, returns null (not 0) when the id is genuinely absent, so callers can tell "no AlterID on this record" apart from "AlterID 0".
  - Calls in this file: `unwrapJsonExValue()`, `safeString()`
- **`parseTallyBoolean()`** — line 217
  - Purpose: Tally Logical fields arrive either as a wrapped { type: "Logical", value } pair, a plain boolean, or (elsewhere in Tally's API) "Yes"/"No" text.
  - Calls in this file: `unwrapJsonExValue()`, `safeString()`
- **`round2()`** — line 258
  - Purpose: (no comment in code — see name and calls below)
- **`parseDiscountPercentage()`** — line 260
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/gstFields.js → numericField()`
- **`deriveDiscountAmount()`** — line 272
  - Purpose: @param {number} percentage already parsed (0 when none) @param {{quantity: number|null, rate: number|null, amount: number}} line parsed numbers of the same line @returns {number} the discount amount in rupees (>= 0): list value minus line amount, or 0 when that is not plausible
  - Calls in this file: `round2()`
- **`parseTallyVoucher()`** — line 286
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isObject()`, `safeString()`, `normalizeLedgerEntryType()`, `computePartyLedgerTotal()`, `findCollectionByKeywords()`, `parseTallyDate()`, `parseQuantity()`, `parseRate()`, `parseAmount()`, `parseTallyId()`, `parseTallyBoolean()`, `parseDiscountPercentage()`, `deriveDiscountAmount()`
  - Calls other files: `src/services/parser/gstFields.js → parseVoucherLineGst()`
- **`extractOpenCompanies()`** — line 427
  - Purpose: Extracts {name, guid} for every company object Tally's "Type": "Company" collection currently reports (odbcService.getCompanyInfo's raw response shape: {status, data:{collection:[{name:{value},guid:{value},...}]}}). Real identities only, straight off Tally's own response - never invents or approximates a guid when one isn't present.
  - Calls in this file: `safeString()`


# 9. Mapper

## `src/services/mapper/adjustmentNoteMapper.js`
**Used by:** `src/services/sync/adjustmentNotePersistence.js`

**Exports:** `mapAdjustmentNote`

- **`ensureObject()`** — line 1
  - Purpose: (no comment in code — see name and calls below)
- **`mapAdjustmentNote()`** — line 16
  - Purpose: @param {Object} parsedVoucher - from adjustmentNoteParser.parseAdjustmentNoteVoucher @param {Object} context @param {string} context.tenantId @param {string} context.companyGuid @param {"credit"|"debit"} context.noteType
  - Calls in this file: `ensureObject()`

## `src/services/mapper/purchaseMapper.js`
**Purpose (file comment):** Deliberately NOT sharing a core with salesMapper.js. The mapping logic is short and per Sales-sync constraints salesMapper.js/mapTallySale must stay untouched - duplicating this ~40-line transform is the lower risk choice over introducing a shared dependency between the two. (Contrast with the persistence/upsert layer in voucherPersistence.js, which genuinely is shared - that logic is complex enough that two independent copies would be a real maintenance risk.)

**Used by:** `src/services/import/tallyPurchaseImport.js`

**Exports:** `mapTallyPurchase`, `normalizeVoucherType`

- **`ensureObject()`** — line 9
  - Purpose: (no comment in code — see name and calls below)
- **`toNumber()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeVoucherType()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`mapTallyPurchase()`** — line 27
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `ensureObject()`, `toNumber()`, `normalizeVoucherType()`

## `src/services/mapper/salesMapper.js`
**Used by:** `src/services/import/tallySalesImport.js`

**Exports:** `mapTallySale`, `normalizeVoucherType`

- **`ensureObject()`** — line 1
  - Purpose: (no comment in code — see name and calls below)
- **`toNumber()`** — line 8
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeVoucherType()`** — line 14
  - Purpose: (no comment in code — see name and calls below)
- **`mapTallySale()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `ensureObject()`, `toNumber()`, `normalizeVoucherType()`


# 10. Sync / reconciliation / recovery

## `src/services/sync/adjustmentNotePersistence.js`
**Used by:** `src/services/sync/tallySyncWorker.js`

**Imports:** `src/services/parser/adjustmentNoteParser.js`, `src/services/mapper/adjustmentNoteMapper.js`, `src/services/tally/adjustmentNoteClassifier.js`, `src/models/adjustmentNote.model.js`

**Exports:** `createAdjustmentNotePersistence`

- **`createAdjustmentNotePersistence()`** — line 22
  - Purpose: Credit Note / Debit Note persistence. Mirrors voucherPersistence.js's createVoucherPersistence (identity by {tenantId, tallyGuid}, AlterID idempotency, cancel/delete tombstone handling, ambiguous-voucherNo guard) as a SEPARATE, self-contained implementation rather than a shared abstraction - see PROJECT_CONTEXT.md's "smallest safe change" convention.
  - Calls other files: `src/services/parser/adjustmentNoteParser.js → parseAdjustmentNoteVoucher()`, `src/services/mapper/adjustmentNoteMapper.js → mapAdjustmentNote()`, `src/services/tally/adjustmentNoteClassifier.js → classifyAdjustmentNote()`, `src/services/tally/adjustmentNoteClassifier.js → resolveAccountRoles()`, `src/models/adjustmentNote.model.js → find()`, `src/models/adjustmentNote.model.js → findOneAndUpdate()`, `src/models/adjustmentNote.model.js → findOne()`

## `src/services/sync/batchWindow.js`
**Purpose (file comment):** Batch sizing for the incremental sync worker. Problem: a company with a large backlog (a first sync, or a long outage) made the worker ask Tally for EVERY voucher since the checkpoint in one request - thousands of vouchers with their inventory/ledger detail. That exceeds the Tally client timeout, the checkpoint never advances, and the worker repeats the same oversized request every tick, keeping Tally busy. Fix: the worker first probes the pending AlterIDs (a light query), and this module picks a cut-off so each tick fetches at most `batchSize` vouchers: the batch is everything with AlterID in (checkpoint, cutOff]. The cut-off is the batchSize-th smallest pending AlterID - an AlterID of

**Used by:** `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`

**Exports:** `DEFAULT_BATCH_SIZE`, `resolveBatchSize`, `computeBatchWindow`, `findMissingAlterIds`

- **`resolveBatchSize()`** — line 22
  - Purpose: Positive integer from the given value, else the default. Invalid or missing config must never disable bounding or produce a zero-size batch.
- **`computeBatchWindow()`** — line 35
  - Purpose: alterIds: AlterIDs of every pending voucher (any order). Returns: pending - how many are pending in total bounded - true when the backlog exceeds one batch upToAlterId - inclusive cut-off for this batch when bounded, else null
  - Calls in this file: `resolveBatchSize()`
- **`findMissingAlterIds()`** — line 65
  - Purpose: Completeness check for a fetched batch: every AlterID the probe selected for the window must be present in what Tally actually returned. Returned vouchers that were NOT probed are fine (a superset is allowed - e.g. a voucher created after the probe). Any expected AlterID that is missing means the response was partial or the voucher changed between probe and

## `src/services/sync/reconciliation.js`
**Used by:** `src/services/sync/reconciliationWorker.js`

**Imports:** `src/services/import/tallySalesImport.js`, `src/services/parser/tallyParser.js`, `src/services/tally/companyOwnership.js`

**Exports:** `reconcileVoucherType`, `extractGuidSet`, `DEFAULT_MAX_DELETE_RATIO`

- **`extractGuidSet()`** — line 39
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `guidSetFromRows()`
  - Calls other files: `src/services/import/tallySalesImport.js → extractVoucherCollection()`
- **`guidSetFromRows()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`
- **`reconcileVoucherType()`** _(async)_ — line 69
  - Purpose: Run one reconciliation pass for a single {tenantId, voucherType, Model}. Never throws - all outcomes are returned as a result object so callers can log/record without special-casing errors. @param {Object} params @param {string} params.tenantId
  - Calls in this file: `guidSetFromRows()`
  - Calls other files: `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/tally/companyOwnership.js → validateBatchOwnership()`, `src/services/tally/companyOwnership.js → logMismatch()`

## `src/services/sync/reconciliationWorker.js`
**Used by:** `server.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/sync/reconciliation.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/sync/selfHeal.js`, `src/models/company.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/reconciliationCheckpoint.model.js`

**Exports:** `startReconciliationWorker`, `stopReconciliationWorker`, `runReconciliationForAllCompanies`, `runReconciliationForCompanyModule`, `RECONCILIATION_MODULES`

- **`resolveTallyBaseUrl()`** — line 58
  - Purpose: (no comment in code — see name and calls below)
- **`ensureCheckpointExists()`** _(async)_ — line 62
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/reconciliationCheckpoint.model.js → findOneAndUpdate()`
- **`acquireLock()`** _(async)_ — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/reconciliationCheckpoint.model.js → findOneAndUpdate()`
- **`releaseLock()`** _(async)_ — line 100
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/reconciliationCheckpoint.model.js → findOneAndUpdate()`
- **`releaseLockWithoutResult()`** _(async)_ — line 116
  - Purpose: Releases the lock and nothing else - used when a run is skipped, so the last real result (status, error, counts, lastRunAt) is preserved.
  - Calls other files: `src/models/reconciliationCheckpoint.model.js → findOneAndUpdate()`
- **`runReconciliationForCompanyModule()`** _(async)_ — line 125
  - Purpose: Runs one reconciliation pass for a single {company, voucher type}. Never throws.
  - Calls in this file: `resolveTallyBaseUrl()`, `ensureCheckpointExists()`, `acquireLock()`, `releaseLock()`, `releaseLockWithoutResult()`
  - Calls other files: `src/services/sync/reconciliation.js → reconcileVoucherType()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/sync/selfHeal.js → maybeSelfHeal()`
- **`runReconciliationForAllCompanies()`** _(async)_ — line 253
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `runReconciliationForCompanyModule()`
  - Calls other files: `src/models/company.js → find()`
- **`buildCronExpression()`** — line 309
  - Purpose: (no comment in code — see name and calls below)
- **`startReconciliationWorker()`** — line 315
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `runReconciliationForAllCompanies()`, `buildCronExpression()`
- **`stopReconciliationWorker()`** — line 346
  - Purpose: (no comment in code — see name and calls below)

## `src/services/sync/selfHeal.js`
**Used by:** `src/services/sync/reconciliationWorker.js`

**Imports:** `src/services/sync/voucherRecovery.js`, `src/models/syncCheckpoint.model.js`

**Exports:** `maybeSelfHeal`, `DEFAULT_CONFIG`

- **`skip()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
- **`maybeSelfHeal()`** _(async)_ — line 74
  - Purpose: @param {Object} params @param {Object} params.company - Company document (tenantId, companyGuid, ...) @param {string} params.voucherType - "Sales" | "Purchase" @param {import('mongoose').Model} params.Model - Sale or Purchase @param {Object} params.reconcileResult - result of reconcileVoucherType
  - Calls in this file: `skip()`

## `src/services/sync/tallySyncWorker.js`
**Used by:** `server.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/sync/batchWindow.js`, `src/services/import/tallySalesImport.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/sync/adjustmentNotePersistence.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/companyOwnership.js`, `src/services/tally/voucherTypeClassifier.js`, `src/models/company.js`, `src/models/syncCheckpoint.model.js`

**Exports:** `startTallySyncWorker`, `stopTallySyncWorker`, `runSyncForAllCompanies`, `runSyncForCompany`, `runSyncForCompanyModule`, `SALES_SYNC_MODULE`, `PURCHASE_SYNC_MODULE`, `CREDIT_NOTE_SYNC_MODULE`, `DEBIT_NOTE_SYNC_MODULE`

- **`resolveTallyBaseUrl()`** — line 126
  - Purpose: (no comment in code — see name and calls below)
- **`ensureCheckpointExists()`** _(async)_ — line 136
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/syncCheckpoint.model.js → findOneAndUpdate()`
- **`acquireLock()`** _(async)_ — line 157
  - Purpose: Atomically acquire the per-{company, voucher type} lock. Returns the checkpoint doc if acquired, or null if another run currently holds a non-stale lock (in which case this tick simply skips that combination).
  - Calls other files: `src/models/syncCheckpoint.model.js → findOneAndUpdate()`
- **`releaseLock()`** _(async)_ — line 178
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/syncCheckpoint.model.js → findOneAndUpdate()`
- **`runSyncForCompanyModule()`** _(async)_ — line 208
  - Purpose: Runs one incremental sync pass for a single {company, sync module} combination. Never throws — failures are recorded on the checkpoint and returned in the result so the caller can log them and move on.
  - Calls in this file: `resolveTallyBaseUrl()`, `ensureCheckpointExists()`, `acquireLock()`, `releaseLock()`
  - Calls other files: `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/sync/batchWindow.js → computeBatchWindow()`, `src/services/sync/batchWindow.js → findMissingAlterIds()`, `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/companyOwnership.js → assertBatchOwnership()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`
- **`runSyncForCompany()`** _(async)_ — line 548
  - Purpose: Sales-only entry point, kept with its original name/signature/behavior for backward compatibility (anything already calling runSyncForCompany the old way — including this file's own exports — keeps working unchanged). Purely a thin wrapper over the generic function above.
  - Calls in this file: `runSyncForCompanyModule()`
- **`runSyncForAllCompanies()`** _(async)_ — line 555
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `runSyncForCompanyModule()`
  - Calls other files: `src/models/company.js → find()`
- **`buildCronExpression()`** — line 617
  - Purpose: (no comment in code — see name and calls below)
- **`startTallySyncWorker()`** — line 625
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `runSyncForAllCompanies()`, `buildCronExpression()`
- **`stopTallySyncWorker()`** — line 656
  - Purpose: (no comment in code — see name and calls below)

## `src/services/sync/voucherLineBackfill.js`
**Used by:** (entry file / run directly)

**Imports:** `src/services/odbc/odbcService.js`, `src/services/import/tallySalesImport.js`, `src/services/parser/tallyParser.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`, `src/services/sync/batchWindow.js`, `src/services/analytics/dateRanges.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`

**Exports:** `backfillVoucherLineDetails`, `ALLOWED_SET_PATH`, `hostOfMongoUri`, `checkWriteTarget`

- **`clampInt()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
- **`asString()`** — line 46
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`
- **`near()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
- **`emptyResult()`** — line 52
  - Purpose: (no comment in code — see name and calls below)
- **`aborted()`** — line 73
  - Purpose: (no comment in code — see name and calls below)
- **`sameLines()`** — line 76
  - Purpose: The stored voucher and the freshly parsed one must describe the same lines before anything is written.
  - Calls in this file: `near()`
- **`buildSet()`** — line 85
  - Purpose: Build the $set for one voucher: only what differs, only the whitelisted paths.
  - Calls in this file: `near()`
- **`backfillVoucherLineDetails()`** _(async)_ — line 118
  - Purpose: @param {Object} params @param {Object} params.company the tenant's Company record ({tenantId, companyGuid, tallyConnection}) @param {"Sales"|"Purchase"} params.voucherType @param {boolean} [params.apply=false] false = dry run (nothing is written) @param {number} [params.afterAlterId=0] cursor: only stored vouchers with a larger AlterID (the result gives the next one)
  - Calls in this file: `clampInt()`, `asString()`, `emptyResult()`, `aborted()`, `sameLines()`, `buildSet()`
  - Calls other files: `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/parser/tallyParser.js → parseTallyVoucher()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/tally/companyOwnership.js → validateBatchOwnership()`, `src/services/tally/companyOwnership.js → logMismatch()`, `src/services/sync/batchWindow.js → resolveBatchSize()`, `src/services/sync/batchWindow.js → findMissingAlterIds()`, `src/services/analytics/dateRanges.js → storedDayStart()`, `src/services/analytics/dateRanges.js → storedDayEnd()`, `src/services/analytics/dateRanges.js → parseCalendarDay()`
- **`hostOfMongoUri()`** — line 255
  - Purpose: (no comment in code — see name and calls below)
- **`checkWriteTarget()`** — line 263
  - Purpose: @returns {{ok: boolean, host: string|null, loopback: boolean, mode: "dry-run"|"apply", reason: string|null}}
  - Calls in this file: `hostOfMongoUri()`

## `src/services/sync/voucherPersistence.js`
**Used by:** `src/services/import/tallyPurchaseImport.js`, `src/services/import/tallySalesImport.js`

**Imports:** `src/services/parser/tallyParser.js`

**Exports:** `createVoucherPersistence`

- **`createVoucherPersistence()`** — line 27
  - Purpose: The one genuinely shared piece of the sync pipeline: parse -> map -> validate -> tenant-safe upsert -> cancel/delete tombstone fallback. Extracted out of the original Sales-only implementation so Sales and Purchase (and any future voucher type) share this logic instead of each carrying their own copy — this is where real correctness bugs
  - Calls other files: `src/services/parser/tallyParser.js → parseTallyVoucher()`

## `src/services/sync/voucherRecovery.js`
**Used by:** `src/controllers/syncRecoveryController.js`, `src/services/sync/selfHeal.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/import/tallySalesImport.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/parser/tallyParser.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`, `src/services/sync/batchWindow.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`

**Exports:** `recoverMissingVouchers`, `RECOVERY_TARGETS`, `DEFAULT_MAX_BATCHES`, `MAX_BATCHES_CAP`

- **`clampInt()`** — line 71
  - Purpose: (no comment in code — see name and calls below)
- **`emptyResult()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`aborted()`** — line 98
  - Purpose: (no comment in code — see name and calls below)
- **`asString()`** — line 102
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`
- **`recoverMissingVouchers()`** _(async)_ — line 107
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `clampInt()`, `emptyResult()`, `aborted()`, `asString()`
  - Calls other files: `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/parser/tallyParser.js → parseTallyBoolean()`, `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/tally/companyOwnership.js → validateBatchOwnership()`, `src/services/tally/companyOwnership.js → logMismatch()`, `src/services/sync/batchWindow.js → resolveBatchSize()`, `src/services/sync/batchWindow.js → findMissingAlterIds()`


# 11. Manual import

## `src/services/import/tallyPurchaseImport.js`
**Used by:** `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherRecovery.js`

**Imports:** `src/services/mapper/purchaseMapper.js`, `src/services/sync/voucherPersistence.js`, `src/services/import/tallySalesImport.js`, `src/models/purchase.model.js`

**Exports:** `extractVoucherCollection`, `resolveTenantContext`, `processSinglePurchaseVoucher`


## `src/services/import/tallySalesImport.js`
**Used by:** `src/controllers/importController.js`, `src/controllers/syncRecoveryController.js`, `src/controllers/syncStatusController.js`, `src/services/sync/reconciliation.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallyPurchaseImport.js`

**Imports:** `src/services/mapper/salesMapper.js`, `src/services/odbc/odbcService.js`, `src/services/sync/voucherPersistence.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`, `src/models/company.js`, `src/models/sales.model.js`

**Exports:** `extractVoucherCollection`, `importTallySales`, `importTallySalesFromTally`, `resolveTenantContext`, `processSingleVoucher`

- **`sanitizeJsonText()`** — line 17
  - Purpose: (no comment in code — see name and calls below)
- **`detectJsonEncoding()`** — line 29
  - Purpose: (no comment in code — see name and calls below)
- **`decodeJsonBuffer()`** — line 140
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `sanitizeJsonText()`, `detectJsonEncoding()`
- **`extractVoucherCollection()`** — line 205
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/sync/voucherPersistence.js → createVoucherPersistence()`
- **`resolveTenantContext()`** _(async)_ — line 316
  - Purpose: Resolve the tenant a Tally import should be scoped to. The tenant is always re-derived from the Company record via the companyGuId carried in the caller's JWT (see auth middleware) — never trusted directly from client input — so an authenticated user can only ever import into their own company's tenant.
  - Calls other files: `src/models/company.js → findOne()`
- **`importParsedVouchers()`** _(async)_ — line 353
  - Purpose: Run the shared parse -> map -> validate -> dedupe -> save pipeline over an array of raw Tally voucher objects, for a single resolved tenant. Used by both the file-upload import and the live Tally import.
- **`importTallySales()`** _(async)_ — line 415
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `sanitizeJsonText()`, `decodeJsonBuffer()`, `extractVoucherCollection()`, `resolveTenantContext()`, `importParsedVouchers()`
- **`importTallySalesFromTally()`** _(async)_ — line 552
  - Purpose: Fetch sales vouchers live from TallyPrime (HTTP JSON) and run them through the same parse -> map -> validate -> dedupe -> save pipeline used by the file-upload import. Tenant is resolved the same way, from the authenticated user's companyGuId - never from client input.
  - Calls in this file: `extractVoucherCollection()`, `resolveTenantContext()`, `importParsedVouchers()`
  - Calls other files: `src/services/odbc/odbcService.js → getSalesVouchers()`, `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/tally/companyOwnership.js → assertBatchOwnership()`


# 12. Company / auth services

## `src/services/auth/companyContext.js`
**Used by:** `src/routes/analyticsRoutes.js`, `src/routes/authRoutes.js`, `src/routes/chatRoutes.js`, `src/routes/importRoutes.js`, `src/routes/odbcRoutes.js`, `src/routes/reportRoutes.js`, `src/routes/syncRoutes.js`, `src/routes/voucherRoutes.js`

**Imports:** `src/middleware/errorHandler.js`, `src/models/company.js`, `src/models/user.model.js`, `src/models/userCompanyAccess.model.js`

**Exports:** `resolveAuthorizedCompany`, `activeCompanyContext`, `liveCompanyContext`

- **`resolveAuthorizedCompany()`** _(async)_ — line 50
  - Purpose: Resolve and authorize the active company context for an authenticated request. @param {Object} authUser - req.user, the JWT-decoded payload (already verified by the auth middleware). Must carry companyGuId. @param {string} [requestedCompanyGuid] - a company the caller is
  - Calls other files: `src/models/company.js → findOne()`, `src/models/user.model.js → findById()`, `src/models/userCompanyAccess.model.js → findOne()`
- **`activeCompanyContext()`** — line 142
  - Purpose: Express middleware wrapper: resolves the active company context and attaches it to req.companyContext. Accepts an optional company override from the request (header or query param) for a future company-switcher UI - fully authorization-checked, never trusted blindly.
  - Calls in this file: `resolveAndContinue()`
- **`liveCompanyContext()`** — line 158
  - Purpose: Same live authorization, but WITHOUT any client-supplied company: it verifies the company named in the JWT is still one this account may use. For routes whose controllers read `req.user.companyGuId` directly (sync status/recovery, imports, company rename) - they keep working unchanged, but a user whose access was removed is stopped here (audit F-06).
  - Calls in this file: `resolveAndContinue()`
- **`resolveAndContinue()`** — line 162
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `resolveAuthorizedCompany()`

## `src/services/auth/companyIdentity.js`
**Used by:** `src/controllers/authController.js`

**Imports:** `src/models/company.js`, `src/models/user.model.js`, `src/models/userCompanyAccess.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js`

**Exports:** `ensureCompanyForGuid`

- **`collectCandidateTenantIds()`** _(async)_ — line 46
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/company.js → distinct()`, `src/models/user.model.js → distinct()`, `src/models/userCompanyAccess.model.js → distinct()`, `src/models/syncCheckpoint.model.js → distinct()`, `src/models/reconciliationCheckpoint.model.js → distinct()`
- **`survivingOwnerIds()`** _(async)_ — line 68
  - Purpose: String ids of the users that still exist and belong to this company.
  - Calls other files: `src/models/user.model.js → distinct()`, `src/models/user.model.js → find()`, `src/models/userCompanyAccess.model.js → distinct()`
- **`isAllowed()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
- **`notAuthorized()`** — line 90
  - Purpose: 403 only for a company whose EXACT GUID already has a surviving owner other than the requester. The message names the company Tally reported (it is the company open in the requester's own Tally, so nothing is disclosed): the most common cause of an unexpected 403 is that Tally's SELECTED company is not the one the user meant, and the name makes that visible.
- **`proveOrFail()`** _(async)_ — line 99
  - Purpose: (no comment in code — see name and calls below)
- **`ensureCompanyForGuid()`** _(async)_ — line 136
  - Purpose: @param {Object} params @param {string} params.companyGuid authoritative identity, detected from Tally @param {string} params.companyName only used when a record is created @param {string} params.requesterUserId the authenticated account @param {Function} params.proveTallyPossession async () => {ok, reason, message}
  - Calls in this file: `collectCandidateTenantIds()`, `survivingOwnerIds()`, `isAllowed()`, `notAuthorized()`, `proveOrFail()`
  - Calls other files: `src/models/company.js → findOne()`, `src/models/company.js → create()`

## `src/services/auth/tallyCompanyGuard.js`
**Used by:** `src/controllers/authController.js`, `src/controllers/odbcController.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/import/tallySalesImport.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/tally/companyOwnership.js`

**Exports:** `verifyOpenTallyCompany`, `detectOpenTallyCompany`, `resolveSelectedOpenCompany`

- **`readOpenCompanies()`** _(async)_ — line 14
  - Purpose: Asks Tally directly, live, which companies are open right now. The one place that talks to Tally for company identity; both guards below use it.
  - Calls other files: `src/services/odbc/odbcService.js → getCompanyInfo()`, `src/services/parser/tallyParser.js → extractOpenCompanies()`
- **`verifyOpenTallyCompany()`** _(async)_ — line 45
  - Purpose: Central safety check reused by both "add another company" (verify the requested GUID is the one actually open in Tally before linking it to the account) and the live Sales Sync import (never import vouchers from whatever company happens to be open into the wrong TallyPulse tenant). Always asks Tally directly, live, for whichever company is open right
  - Calls in this file: `readOpenCompanies()`
- **`selectedCompanyFromMasters()`** _(async)_ — line 74
  - Purpose: Which of several open companies is the SELECTED one? Tally's company list does not say, but its voucher and master queries answer for the selected company only, and every master carries "<companyGuid>-<id>". So ONE light VoucherType-master query identifies it: the open company whose GUID owns the returned masters. Reuses the same ownership rule as the classifier
  - Calls other files: `src/services/odbc/odbcService.js → getVoucherTypeMasters()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`
- **`resolveSelectedOpenCompany()`** _(async)_ — line 96
  - Purpose: The company TallyPulse should treat as "the one open in Tally": the only open company, or - when several are open - the one Tally has SELECTED, proven by the voucher-type masters. Anything less certain is an explicit ambiguity. Returns the {ok, reason, openCompanies, match} shape verifyOpenTallyCompany uses (match = the selected company), plus `selectedBy`.
  - Calls in this file: `readOpenCompanies()`, `selectedCompanyFromMasters()`


# 13. Analytics (dashboards, periods)

## `src/services/analytics/analyticsScope.js`
**Purpose (file comment):** The one mandatory gate every analytics query must pass through: Tenant Scope -> Valid/Active Voucher Scope -> Date Scope -> Aggregation This exists so correctness (tenant isolation, excluding cancelled/ deleted vouchers) does NOT depend on every analytics function remembering to add `voucherStatus: "active"` and `tenantId` to every query by hand. Every function in analyticsEngine.js builds its $match stage by calling buildVoucherMatchStage() - never by hand-assembling {tenantId, ...} itself. Fails closed: a missing/invalid tenantId throws rather than silently

**Used by:** `src/controllers/reportController.js`, `src/services/analytics/insights.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/reportAnalytics.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/compile.js`, `src/services/query/execute.js`

**Imports:** `src/services/analytics/dateRanges.js`

**Exports:** `buildVoucherMatchStage`, `DEFAULT_STATUSES`, `VALID_STATUSES`

- **`assertTenantId()`** — line 30
  - Purpose: (no comment in code — see name and calls below)
- **`assertValidStatuses()`** — line 38
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeDateBound()`** — line 56
  - Purpose: A bound is a PERIOD BOUNDARY: a local calendar day (what periodEngine/dateRanges produce, or a YYYY-MM-DD string). Voucher dates are stored as UTC midnight of their Tally date, so the bound is converted to the stored form of its calendar day (see dateRanges) - a raw instant comparison would move vouchers across a period edge by the server's UTC offset.
  - Calls other files: `src/services/analytics/dateRanges.js → parseCalendarDay()`, `src/services/analytics/dateRanges.js → storedDayEnd()`, `src/services/analytics/dateRanges.js → storedDayStart()`
- **`buildVoucherMatchStage()`** — line 90
  - Purpose: Build the mandatory MongoDB $match stage for any company-owned analytics query (Sale or Purchase). @param {Object} options @param {string} options.tenantId - REQUIRED. Never optional, never inferred - callers must derive this server-side from the
  - Calls in this file: `assertTenantId()`, `assertValidStatuses()`, `normalizeDateBound()`

## `src/services/analytics/coverage.js`
**Used by:** `src/services/query/answerFormatter.js`, `src/services/query/presentation.js`, `src/services/query/queryChat.js`

**Imports:** `src/services/analytics/dateRanges.js`

**Exports:** `classifyRange`, `assessCoverage`, `fmtDay`, `rangeText`

- **`fmtDay()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`rangeText()`** — line 17
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fmtDay()`
- **`classifyRange()`** — line 27
  - Purpose: Where [from, to] lies relative to the synced window. @returns {"covered"|"partly_before_history"|"before_history"|"partly_after_latest_data"|"after_latest_data"|"no_history"|"unbounded"}
  - Calls other files: `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → endOfDay()`
- **`assessCoverage()`** — line 52
  - Purpose: @param {object} p @param {"sales"|"purchase"} p.entity @param {{from:Date,to:Date,label?:string}} p.period validator-resolved subject range @param {{from:Date,to:Date,label?:string}|null} p.comparison validator-resolved comparison range @param {{earliest:Date|null, latest:Date|null}} p.coverage from the tenant date context
  - Calls in this file: `fmtDay()`, `rangeText()`, `classifyRange()`

## `src/services/analytics/dateRanges.js`
**Purpose (file comment):** Period resolution for analytics comparisons. The correctness trap this exists to avoid: comparing a PARTIAL current month (month-to-date, since "today" is mid-month) against a FULL prior month produces a growth percentage that looks confidently wrong - e.g. "-40%" when the real story is just "the month isn't over yet." Every period this module returns is therefore always paired with an explicit `label` and `isPartial` flag, and every comparison compares like-for- like day-ranges (month-to-date vs the same day-range in the prior period), never a partial period against a complete one. All boundaries are inclusive-from / inclusive-to Date objects, meant

**Used by:** `src/controllers/analyticsController.js`, `src/controllers/reportController.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/coverage.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/referenceDate.js`, `src/services/query/execute.js`, `src/services/query/validator.js`

**Exports:** `startOfDay`, `endOfDay`, `startOfMonth`, `endOfMonth`, `shiftMonths`, `shiftYears`, `shiftDays`, `shiftPeriod`, `currentMonthToDate`, `previousFullMonth`, `previousMonthSameRange`, `sameMonthLastYearToDate`, `lastNMonthsEnding`, `customRange`, `parseCalendarDay`, `storedDayStart`, `storedDayEnd`, `calendarDayOfStored`, `resolveRequestPeriod`, `resolveRequestComparison`

- **`startOfDay()`** — line 18
  - Purpose: (no comment in code — see name and calls below)
- **`endOfDay()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
- **`startOfMonth()`** — line 30
  - Purpose: (no comment in code — see name and calls below)
- **`endOfMonth()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`shiftMonths()`** — line 44
  - Purpose: Shifts by whole months, CLAMPING the day-of-month to the target month's last day. A plain `new Date(y, m + delta, day)` rolls over instead (31 Mar - 1 month = "31 Feb" = 3 Mar), which made "previous month" resolve to the CURRENT month on 29-31 Mar, 31 May/Jul/Oct/Dec. Time of day is kept.
- **`shiftYears()`** — line 54
  - Purpose: Same clamp for years: 29 Feb 2024 - 1 year = 28 Feb 2023 (not 1 Mar 2023).
  - Calls in this file: `shiftMonths()`
- **`shiftDays()`** — line 58
  - Purpose: (no comment in code — see name and calls below)
- **`shiftPeriod()`** — line 69
  - Purpose: Shift a whole {from, to} window back by N months/years, preserving the exact day-of-month range so a month-to-date window stays month-to-date in the shifted period, and a full-month window stays full-month. Clamps `to` to the shifted month's real last day (e.g. Jan 31 shifted back a month doesn't overflow into March).
  - Calls in this file: `endOfMonth()`, `shiftMonths()`, `shiftYears()`
- **`currentMonthToDate()`** — line 97
  - Purpose: Current month, month-to-date: [1st of this month, now]. Explicitly partial unless `now` happens to be the last instant of the month.
  - Calls in this file: `startOfMonth()`, `endOfMonth()`
- **`previousFullMonth()`** — line 121
  - Purpose: The full previous calendar month: [1st, last day 23:59:59.999]. Always complete (a "previous" month, by definition, has already ended).
  - Calls in this file: `startOfMonth()`, `endOfMonth()`, `shiftMonths()`, `currentMonthToDate()`
- **`previousMonthSameRange()`** — line 137
  - Purpose: The SAME day-range in the previous month as currentMonthToDate() - i.e. if today is the 16th, this is [1st, 16th] of last month. This is the correct comparison base for "how much did sales grow vs last month" - comparing MTD to MTD, not MTD to a full month.
  - Calls in this file: `shiftPeriod()`, `currentMonthToDate()`
- **`sameMonthLastYearToDate()`** — line 152
  - Purpose: The same month-to-date window, one year earlier. E.g. if today is 16 Sep 2026, this is [1 Sep 2025, 16 Sep 2025].
  - Calls in this file: `shiftPeriod()`, `currentMonthToDate()`
- **`lastNMonthsEnding()`** — line 169
  - Purpose: The last N complete calendar months ending in referenceDate's month (inclusive) - e.g. n=6 with referenceDate in December returns [1 Jul, 31 Dec]. Used as the default window for trend charts when the caller hasn't picked an explicit range.
  - Calls in this file: `startOfMonth()`, `endOfMonth()`, `shiftMonths()`
- **`parseCalendarDay()`** — line 188
  - Purpose: A YYYY-MM-DD string is a calendar day (local midnight), not a UTC instant: new Date("2025-08-01") is UTC midnight, i.e. Jul 31 west of UTC. 
- **`storedDayStart()`** — line 197
  - Purpose: The stored form of a period START: UTC midnight of the boundary's calendar day. 
- **`storedDayEnd()`** — line 203
  - Purpose: The stored form of a period END (inclusive): the last millisecond of the boundary's calendar day, in the stored (UTC) convention. 
- **`calendarDayOfStored()`** — line 209
  - Purpose: The calendar day of a STORED voucher/ledger date, as a local-midnight Date comparable with period boundaries. 
- **`customRange()`** — line 218
  - Purpose: A caller-supplied custom range, validated and normalized to day boundaries.
  - Calls in this file: `startOfDay()`, `endOfDay()`, `parseCalendarDay()`
- **`hasDate()`** — line 237
  - Purpose: ---------------------------------------------------------------- REST request periods What `period=current_month|previous_month|custom` and `comparisonType=vs_previous_month|vs_same_month_last_year` mean for the REST analytics and report endpoints (analyticsController, reportController). Relative periods are anchored to the tenant's reference date: there is no wall-clock default.
- **`resolveRequestPeriod()`** — line 239
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `currentMonthToDate()`, `previousFullMonth()`, `customRange()`, `hasDate()`
- **`resolveRequestComparison()`** — line 248
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `currentMonthToDate()`, `previousMonthSameRange()`, `sameMonthLastYearToDate()`, `hasDate()`

## `src/services/analytics/freshness.js`
**Used by:** `src/services/analytics/trustEnvelope.js`

**Imports:** `src/models/syncCheckpoint.model.js`

**Exports:** `getFreshness`, `DEFAULT_FRESHNESS_THRESHOLD_MINUTES`

- **`getFreshness()`** _(async)_ — line 22
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/syncCheckpoint.model.js → findOne()`

## `src/services/analytics/insights.js`
**Used by:** `src/controllers/analyticsController.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`

**Exports:** `discountSummary`, `ratesByProduct`, `supplierRates`, `MIN_BILLED_TO_LIST`, `DISCOUNT_NOTE`, `RATE_NOTE`

- **`round2()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
- **`clampLimit()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`escapeRegex()`** — line 39
  - Purpose: (no comment in code — see name and calls below)
- **`modelFor()`** — line 40
  - Purpose: (no comment in code — see name and calls below)
- **`shapeDiscount()`** — line 71
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `round2()`
- **`discountSummary()`** _(async)_ — line 88
  - Purpose: Discount given (sales) or received (purchase): totals, and optionally a breakdown. @param {string} tenantId @param {{from: Date, to: Date, label?: string}} period @param {{entity?: "sales"|"purchase", by?: "customer"|"supplier"|"product"|"month"|null, limit?: number}} [options]
  - Calls in this file: `clampLimit()`, `modelFor()`, `shapeDiscount()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`ratesByProduct()`** _(async)_ — line 129
  - Purpose: Per-product sale and purchase rates for the period, side by side.
  - Calls in this file: `round2()`, `clampLimit()`, `escapeRegex()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`supplierRates()`** _(async)_ — line 192
  - Purpose: What each supplier charged per unit for the same product, and who is cheapest.
  - Calls in this file: `round2()`, `clampLimit()`, `escapeRegex()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/purchase.model.js → aggregate()`

## `src/services/analytics/periodEngine.js`
**Used by:** `src/controllers/analyticsController.js`, `src/services/query/queryChat.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/semanticCatalog.js`, `src/services/query/validator.js`

**Imports:** `src/services/analytics/dateRanges.js`

**Exports:** `PERIOD_KINDS`, `FY_START_MONTH`, `resolvePeriod`, `resolveComparisonPeriod`, `resolveSamePeriodLastYear`, `resolvePeriodWithComparison`, `financialYearStartYear`, `financialYearRange`, `financialYearLabel`, `parseFinancialYearInput`, `startOfWeek`, `endOfWeek`, `startOfQuarter`, `endOfQuarter`, `shiftQuarters`, `safeShiftMonths`, `safeShiftYears`

- **`startOfWeek()`** — line 71
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/dateRanges.js → startOfDay()`
- **`endOfWeek()`** — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `startOfWeek()`
  - Calls other files: `src/services/analytics/dateRanges.js → endOfDay()`
- **`fyMonthOffset()`** — line 105
  - Purpose: Months since 1 April of this date's OWN financial year (see financialYearStartYear below) - 0 = April, 11 = March. Quarter index is then simply this offset divided by 3, unlike a calendar quarter which divides the raw calendar month by 3.
- **`startOfQuarter()`** — line 110
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fyMonthOffset()`, `financialYearStartYear()`
- **`endOfQuarter()`** — line 120
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `startOfQuarter()`
- **`shiftQuarters()`** — line 135
  - Purpose: Day fixed at 1 deliberately: the only thing ever read off this anchor downstream is its year/month (via startOfQuarter/endOfQuarter), never its day-of-month. Carrying the original day through (as a naive "new Date(y, m+delta, day)" would) risks a silent month rollover when the target month has fewer days than `day` (e.g. day 31 shifted into
- **`safeShiftMonths()`** — line 148
  - Purpose: Shifts a date by whole months/years, clamping the day-of-month to the target month's real last day instead of letting it silently roll into the next month (JS's plain `new Date(y, m, day)` does this rollover, e.g. 29 Feb 2024 shifted +1 year becomes 1 Mar 2025, not 28 Feb 2025 - confirmed live in this investigation). dateRanges.shiftMonths/shiftYears
- **`safeShiftYears()`** — line 159
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `safeShiftMonths()`
- **`financialYearStartYear()`** — line 167
  - Purpose: The FY "start year" a date falls in - e.g. any date from 1 Apr 2025 through 31 Mar 2026 has FY start year 2025 ("FY 2025-26").
- **`financialYearRange()`** — line 173
  - Purpose: (no comment in code — see name and calls below)
- **`financialYearLabel()`** — line 179
  - Purpose: (no comment in code — see name and calls below)
- **`parseFinancialYearInput()`** — line 188
  - Purpose: Accepts a start year (number, e.g. 2025) or a label string ("FY 2025-26", "2025-26", "fy2025-26") and returns the FY start year as a number, validating the label's own two-digit end year is consistent (so "FY 2025-27" is rejected, not silently misparsed).
- **`lastNDays()`** — line 211
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → shiftDays()`
- **`isBeforeNaturalEnd()`** — line 222
  - Purpose: True unless `to` already reached the full period's own natural end (same day) - matches currentMonthToDate's existing isPartial logic, generalized to any {to, naturalEnd} pair.
- **`resolvePeriod()`** — line 234
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `startOfWeek()`, `endOfWeek()`, `startOfQuarter()`, `endOfQuarter()`, `shiftQuarters()`, `financialYearStartYear()`, `financialYearRange()`, `financialYearLabel()`, `parseFinancialYearInput()`, `lastNDays()`, `isBeforeNaturalEnd()`
  - Calls other files: `src/services/analytics/dateRanges.js → endOfDay()`, `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → shiftDays()`, `src/services/analytics/dateRanges.js → currentMonthToDate()`, `src/services/analytics/dateRanges.js → previousFullMonth()`, `src/services/analytics/dateRanges.js → sameMonthLastYearToDate()`, `src/services/analytics/dateRanges.js → customRange()`
- **`resolveComparisonPeriod()`** — line 338
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `startOfQuarter()`, `endOfQuarter()`, `shiftQuarters()`, `safeShiftMonths()`, `safeShiftYears()`, `financialYearStartYear()`, `financialYearRange()`, `parseFinancialYearInput()`, `resolvePeriod()`
  - Calls other files: `src/services/analytics/dateRanges.js → shiftDays()`, `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → endOfDay()`, `src/services/analytics/dateRanges.js → previousMonthSameRange()`, `src/services/analytics/dateRanges.js → shiftMonths()`, `src/services/analytics/dateRanges.js → startOfMonth()`, `src/services/analytics/dateRanges.js → endOfMonth()`
- **`resolveSamePeriodLastYear()`** — line 447
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `safeShiftYears()`, `resolvePeriod()`
- **`resolvePeriodWithComparison()`** — line 459
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `resolvePeriod()`, `resolveComparisonPeriod()`

## `src/services/analytics/purchaseAnalytics.js`
**Used by:** `src/controllers/analyticsController.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/services/analytics/salesAnalytics.js`, `src/models/purchase.model.js`

**Exports:** `getPurchaseSummary`, `getPurchaseComparison`, `getTopPurchasedProducts`, `getTopSuppliers`, `getPurchaseTrend`

- **`getPurchaseSummary()`** _(async)_ — line 13
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/purchase.model.js → aggregate()`
- **`getPurchaseComparison()`** _(async)_ — line 48
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `getPurchaseSummary()`
  - Calls other files: `src/services/analytics/salesAnalytics.js → computeGrowth()`
- **`getTopPurchasedProducts()`** _(async)_ — line 74
  - Purpose: Only implemented if the underlying data supports it: Purchase.inventory carries itemName/quantity/rate/amount, same shape as Sale - so this IS reliably calculable, unlike category performance.
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/purchase.model.js → aggregate()`
- **`getTopSuppliers()`** _(async)_ — line 117
  - Purpose: Mirrors salesAnalytics.getTopCustomers exactly, on the Purchase collection - the supplier/vendor ledger name (header.partyName) is the counterpart to a Sales voucher's customer name.
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/purchase.model.js → aggregate()`
- **`monthLabel()`** — line 152
  - Purpose: (no comment in code — see name and calls below)
- **`getPurchaseTrend()`** _(async)_ — line 158
  - Purpose: Mirrors salesAnalytics.getSalesTrend exactly, on the Purchase collection - same monthly-aggregation-of-corrected-totals approach.
  - Calls in this file: `monthLabel()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/purchase.model.js → aggregate()`

## `src/services/analytics/referenceDate.js`
**Used by:** `src/controllers/analyticsController.js`, `src/controllers/reportController.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/services/analytics/dateRanges.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`

**Exports:** `getTenantReferenceDate`, `getTenantDateContext`, `buildDateContext`

- **`DAY()`** — line 33
  - Purpose: (no comment in code — see name and calls below)
- **`valid()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
- **`endOfLocalDay()`** — line 39
  - Purpose: Voucher dates are stored as UTC midnight of the Tally date and every period boundary is a LOCAL calendar day. Everything this module hands out (coverage window, latest voucher, the REST anchor) is therefore the calendar day of the stored date as a local-midnight Date (dateRanges.calendarDayOfStored), so it compares with period boundaries and with "today" by calendar day in any server zone.
- **`voucherDateBounds()`** _(async)_ — line 42
  - Purpose: The earliest and latest active voucher date of one collection (two indexed lookups).
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`lastSuccessfulSync()`** _(async)_ — line 54
  - Purpose: The last successful incremental sync of this tenant (any voucher type). The incremental sync fetches every voucher altered in Tally up to that moment, whatever its date, so data is complete up to it.
  - Calls other files: `src/models/syncCheckpoint.model.js → find()`
- **`buildDateContext()`** — line 66
  - Purpose: The rule (pure). referenceDate = the end of today's local calendar day. Coverage = the first active voucher of either type .. the later of the last active voucher and the last successful sync. @param {{sales:{earliest,latest}, purchase:{earliest,latest}, lastSyncedAt?:Date|null}} bounds @param {Date} now wall clock
  - Calls in this file: `DAY()`, `valid()`, `endOfLocalDay()`
  - Calls other files: `src/services/analytics/dateRanges.js → calendarDayOfStored()`
- **`getTenantDateContext()`** _(async)_ — line 96
  - Purpose: The per-turn tenant date context: reference date (today) + synced coverage window. 
  - Calls in this file: `voucherDateBounds()`, `lastSuccessfulSync()`, `buildDateContext()`
- **`getTenantReferenceDate()`** _(async)_ — line 102
  - Purpose: REST dashboard/report anchor (unchanged rule, see the header): latest active voucher, else the wall clock. 
  - Calls in this file: `voucherDateBounds()`
  - Calls other files: `src/services/analytics/dateRanges.js → calendarDayOfStored()`

## `src/services/analytics/reportAnalytics.js`
**Used by:** `src/controllers/reportController.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`

**Exports:** `getCustomerReport`, `getProductReport`, `escapeRegex`

- **`escapeRegex()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
- **`getCustomerReport()`** _(async)_ — line 26
  - Purpose: True single-query server-side pagination: customers only ever come from ONE collection (Sale), so a single $facet aggregation (count + page) is both correct and efficient - no in-memory merge needed.
  - Calls in this file: `escapeRegex()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getProductReport()`** _(async)_ — line 81
  - Purpose: Products live in BOTH Sale and Purchase inventory - two different collections - so this can't be a single $facet the way the customer report is. Sales are paginated at the database level (true $skip/ $limit on the primary, sorted list); the purchase-side amount is then looked up ONLY for the current page's item names (at most `limit`
  - Calls in this file: `escapeRegex()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`, `src/models/purchase.model.js → aggregate()`

## `src/services/analytics/salesAnalytics.js`
**Used by:** `src/controllers/analyticsController.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/execute.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/models/sales.model.js`

**Exports:** `getSalesSummary`, `getSalesComparison`, `getTopProducts`, `getTopGrowingProducts`, `getDecliningProducts`, `getTopCustomers`, `getCustomerSales`, `getSalesTrend`, `getCustomerCounts`, `computeGrowth`, `CUSTOMER_SALES_AMOUNT_BASIS`

- **`getSalesSummary()`** _(async)_ — line 12
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`computeGrowth()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
- **`getSalesComparison()`** _(async)_ — line 58
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `getSalesSummary()`, `computeGrowth()`
- **`getTopProducts()`** _(async)_ — line 84
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getProductPeriodComparison()`** _(async)_ — line 127
  - Purpose: Shared core for product growth / declining products: per-item sales in two periods, ranked by percentage change. Products with no sales in the earlier period get growthPercentage: null (new product - "infinite" growth is not a meaningful number, so it's reported as null + isNew:true rather than fabricated).
  - Calls in this file: `computeGrowth()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getTopGrowingProducts()`** _(async)_ — line 179
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `getProductPeriodComparison()`
- **`getDecliningProducts()`** _(async)_ — line 198
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `getProductPeriodComparison()`
- **`getTopCustomers()`** _(async)_ — line 209
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getCustomerSales()`** _(async)_ — line 275
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → distinct()`, `src/models/sales.model.js → aggregate()`
- **`monthLabel()`** — line 347
  - Purpose: (no comment in code — see name and calls below)
- **`getSalesTrend()`** _(async)_ — line 358
  - Purpose: Monthly sales totals across a date range - the real aggregation behind the Sales Trend chart. Grouped by calendar month of header.voucherDate (the corrected voucher total, same field every other Sales metric uses), scoped to the requested window. Empty months within the range are NOT synthesized as zero-filled points -
  - Calls in this file: `monthLabel()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getCustomerCounts()`** _(async)_ — line 402
  - Purpose: Distinct-customer counts, all legitimately derivable from header.partyName on real Sale vouchers - no invented "customer" concept beyond "a distinct party name we've sold to": totalCustomers - distinct parties across the tenant's ENTIRE history (not scoped to `period` - a stable,
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → distinct()`, `src/models/sales.model.js → aggregate()`

## `src/services/analytics/stockGroupAnalytics.js`
**Used by:** `src/controllers/analyticsController.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/services/analytics/salesAnalytics.js`, `src/models/sales.model.js`, `src/models/stockItemMaster.model.js`

**Exports:** `aggregateStockGroupSales`, `getTopStockGroups`, `AMOUNT_BASIS`

- **`aggregateStockGroupSales()`** _(async)_ — line 38
  - Purpose: One tenant-scoped period's worth of {stockGroupName -> {salesAmount, salesQuantity}}, plus mapped/unmapped diagnostics for that same period. Pure aggregation, no growth math here - growth is computed by the caller once it has two or three of these results to compare.
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`sumBy()`** — line 116
  - Purpose: (no comment in code — see name and calls below)
- **`getTopStockGroups()`** _(async)_ — line 134
  - Purpose: Top-N Stock Groups by sales amount for `currentPeriod`, with MoM-style growth vs `previousPeriod` and YoY growth vs `samePeriodLastYear` - both OPTIONAL (pass null when the caller's period kind has no natural comparison, e.g. a custom range's MoM - see periodEngine.js). Never guesses a comparison when one wasn't
  - Calls in this file: `aggregateStockGroupSales()`, `sumBy()`
  - Calls other files: `src/services/analytics/salesAnalytics.js → computeGrowth()`

## `src/services/analytics/trustEnvelope.js`
**Used by:** `src/controllers/analyticsController.js`, `src/controllers/reportController.js`

**Imports:** `src/services/analytics/freshness.js`

**Exports:** `wrapAnalyticsResult`

- **`wrapAnalyticsResult()`** _(async)_ — line 23
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/freshness.js → getFreshness()`


# 14. AI query engine

## `src/services/query/answerCache.js`
**Used by:** (entry file / run directly)

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/semanticCatalog.js`, `src/services/query/dataVersion.js`, `src/services/query/execute.js`, `src/services/query/turnTelemetry.js`

**Exports:** `createAnswerCache`, `createDefaultCachedExecutor`, `stableStringify`, `DEFAULTS`

- **`stableStringify()`** — line 29
  - Purpose: (no comment in code — see name and calls below)
- **`deepFreeze()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`createAnswerCache()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `stableStringify()`, `deepFreeze()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/semanticCatalog.js → computeFingerprint()`
- **`createDefaultCachedExecutor()`** — line 192
  - Purpose: Production wiring: real executor + Mongo-backed version. Not used by chat yet. 
  - Calls in this file: `createAnswerCache()`
  - Calls other files: `src/services/query/dataVersion.js → onBump()`, `src/services/query/turnTelemetry.js → timeEngineDeps()`

## `src/services/query/answerFormatter.js`
**Used by:** `src/services/query/presentation.js`, `src/services/query/queryChat.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/analytics/coverage.js`

**Exports:** `formatQueryAnswer`, `formatNonAnswer`, `fmtMoney`, `fmtNumber`, `fmtValue`, `fmtSigned`, `pctOf`, `periodText`, `SCOPE_HINT`, `MAX_DISPLAY_ROWS`

- **`isMoney()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
- **`fmtMoney()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
- **`fmtNumber()`** — line 27
  - Purpose: (no comment in code — see name and calls below)
- **`fmtValue()`** — line 30
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isMoney()`, `fmtMoney()`, `fmtNumber()`
- **`fmtSigned()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fmtValue()`
- **`fmtPct()`** — line 38
  - Purpose: (no comment in code — see name and calls below)
- **`pctOf()`** — line 42
  - Purpose: A % change against a zero comparison value is undefined (never 0% and never infinite): say why.
  - Calls in this file: `fmtPct()`
- **`datesOf()`** — line 47
  - Purpose: The resolved dates of a relative period, so the range actually measured is always visible.
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`label()`** — line 48
  - Purpose: (no comment in code — see name and calls below)
- **`periodText()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `datesOf()`
- **`keyText()`** — line 57
  - Purpose: (no comment in code — see name and calls below)
- **`compareText()`** — line 63
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `datesOf()`
- **`isZero()`** — line 73
  - Purpose: (no comment in code — see name and calls below)
- **`productLevelNote()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`touchesProduct()`** — line 92
  - Purpose: (no comment in code — see name and calls below)
- **`formatQueryAnswer()`** — line 97
  - Purpose: @returns {{text:string, warnings:string[], zero:boolean}}
  - Calls in this file: `fmtMoney()`, `fmtValue()`, `fmtSigned()`, `pctOf()`, `label()`, `periodText()`, `keyText()`, `compareText()`, `isZero()`, `productLevelNote()`, `touchesProduct()`
- **`formatNonAnswer()`** — line 178
  - Purpose: (no comment in code — see name and calls below)

## `src/services/query/compile.js`
**Used by:** `src/services/query/execute.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/services/query/validator.js`, `src/services/query/semanticCatalog.js`

**Exports:** `compileQuery`, `assertPipelineSafe`, `escapeRegex`, `regexCondition`, `ALLOWED_STAGES`

- **`escapeRegex()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
- **`regexCondition()`** — line 48
  - Purpose: User text becomes an inert, escaped, case-insensitive literal - never a pattern.
  - Calls in this file: `escapeRegex()`
- **`bucketExpression()`** — line 58
  - Purpose: (no comment in code — see name and calls below)
- **`groupKeyExpression()`** — line 69
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bucketExpression()`
- **`groupId()`** — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `groupKeyExpression()`
- **`isDerived()`** — line 88
  - Purpose: (no comment in code — see name and calls below)
- **`valueRef()`** — line 89
  - Purpose: (no comment in code — see name and calls below)
- **`baseMetricsNeeded()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`signFactor()`** — line 108
  - Purpose: A metric may declare `entitySign: { <entity>: -1 }`: Tally books that entity's stock entries with the opposite sign (purchase item amounts are stored negative), so the figure is negated to read as a positive value. A plain sign flip - NOT abs - so opposite-signed lines still net.
- **`signedPath()`** — line 109
  - Purpose: (no comment in code — see name and calls below)
- **`accumulators()`** — line 111
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `baseMetricsNeeded()`, `signFactor()`, `signedPath()`
- **`derivedFields()`** — line 120
  - Purpose: (no comment in code — see name and calls below)
- **`projectValues()`** — line 132
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueRef()`
- **`scopeStage()`** — line 148
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`buildPrefix()`** — line 158
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `regexCondition()`, `scopeStage()`
- **`sortStages()`** — line 187
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueRef()`
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`havingMatch()`** — line 208
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueRef()`
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`rowsPipeline()`** — line 218
  - Purpose: finalize=true : non-comparison, non-rolled -> having/sort/limit run in MongoDB. limit+1 detects truncation without a second count query. finalize=false : the executor needs the FULL group set (comparison, or a product-group roll-up) and does having/sort/limit itself.
  - Calls in this file: `groupId()`, `signFactor()`, `signedPath()`, `accumulators()`, `derivedFields()`, `projectValues()`, `buildPrefix()`, `sortStages()`, `havingMatch()`
- **`totalsPipeline()`** — line 240
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `accumulators()`, `derivedFields()`, `projectValues()`, `buildPrefix()`
- **`listPipeline()`** — line 251
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildPrefix()`
- **`walk()`** — line 275
  - Purpose: (no comment in code — see name and calls below)
- **`assertPipelineSafe()`** — line 289
  - Purpose: Throws unless the pipeline is provably scoped and uses only allow-listed constructs. Exported so tests can prove it rejects tampered pipelines.
  - Calls in this file: `walk()`
- **`compileQuery()`** — line 322
  - Purpose: @param {object} n normalized plan from validateQueryPlan (brand-checked) @param {object} context @param {string} context.tenantId from the authorized company context ONLY @param {string[]} [context.groupItemNames] required when the plan filters by productGroup: the item names the executor read from THIS tenant's Stock Item master
  - Calls in this file: `rowsPipeline()`, `totalsPipeline()`, `listPipeline()`, `assertPipelineSafe()`
  - Calls other files: `src/services/query/validator.js → isValidatedPlan()`

## `src/services/query/dataVersion.js`
**Used by:** `src/services/query/answerCache.js`

**Exports:** `tenantDataVersionPlugin`, `bumpTenantVersion`, `getTenantVersion`, `onBump`, `GLOBAL_KEY`, `stats`

- **`getModel()`** — line 33
  - Purpose: (no comment in code — see name and calls below)
- **`log()`** — line 37
  - Purpose: (no comment in code — see name and calls below)
- **`bumpTenantVersion()`** _(async)_ — line 42
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `getModel()`, `log()`
- **`getTenantVersion()`** _(async)_ — line 63
  - Purpose: Version token for a tenant: changes whenever its data (or the global counter) changes. 
  - Calls in this file: `getModel()`
- **`onBump()`** — line 74
  - Purpose: Synchronous invalidation hook for in-process caches (called before the DB counter round trip). 
- **`tenantFrom()`** — line 81
  - Purpose: (no comment in code — see name and calls below)
- **`collectTenants()`** — line 88
  - Purpose: Every tenantId value a write could touch: the one it is filtered by AND any tenantId it assigns (a $set / replacement / pipeline stage that MOVES a document to another tenant must invalidate both sides). A non-string tenantId anywhere (operator object, null) is unattributable.
  - Calls in this file: `tenantFrom()`
- **`tenantsOfWrite()`** — line 99
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `tenantFrom()`, `collectTenants()`
- **`tenantsFromOps()`** — line 108
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `tenantsOfWrite()`
- **`bumpFor()`** _(async)_ — line 125
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bumpTenantVersion()`
- **`tenantDataVersionPlugin()`** — line 131
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bumpTenantVersion()`, `tenantFrom()`, `tenantsOfWrite()`, `tenantsFromOps()`, `bumpFor()`, `finishBulk()`
- **`finishBulk()`** _(async)_ — line 218
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bumpFor()`

## `src/services/query/entityResolver.js`
**Used by:** `src/services/query/queryChat.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/stockItemMaster.model.js`

**Exports:** `createEntityResolver`, `ENTITY_RESOLVER_UNAVAILABLE`

- **`normalizeText()`** — line 16
  - Purpose: Lower-case, punctuation-free, single-spaced form used to compare entity names. 
- **`defaultSources()`** — line 31
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/sales.model.js → distinct()`, `src/models/purchase.model.js → distinct()`, `src/models/stockItemMaster.model.js → distinct()`
- **`createEntityResolver()`** — line 47
  - Purpose: @param {{tenantId: *, sources?: object}} opts `sources` is injectable for tests ({dim: async () => string[]}).
  - Calls in this file: `normalizeText()`, `defaultSources()`

## `src/services/query/execute.js`
**Used by:** `src/services/query/answerCache.js`

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/compile.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/dateRanges.js`, `src/services/query/semanticCatalog.js`, `src/models/stockItemMaster.model.js`, `src/models/ledgerMaster.model.js`

**Exports:** `executeQuery`, `buildAggregate`, `formatDateKey`

- **`getModel()`** — line 39
  - Purpose: (no comment in code — see name and calls below)
- **`buildAggregate()`** — line 47
  - Purpose: Builds (does not run) the aggregate, so tests can assert maxTimeMS is set.
  - Calls in this file: `getModel()`
- **`defaultRunAggregate()`** — line 54
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildAggregate()`
- **`defaultLoadStockGroupMap()`** _(async)_ — line 60
  - Purpose: The ONLY reads outside the compiled pipelines, both explicitly filtered by tenantId: the tenant's own Stock Item master (item -> group).
  - Calls other files: `src/models/stockItemMaster.model.js → find()`
- **`defaultFindGroupItemNames()`** _(async)_ — line 66
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/compile.js → regexCondition()`, `src/models/stockItemMaster.model.js → find()`
- **`defaultFindNewParties()`** _(async)_ — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/dateRanges.js → storedDayStart()`, `src/services/analytics/dateRanges.js → storedDayEnd()`, `src/models/ledgerMaster.model.js → findOne()`, `src/models/ledgerMaster.model.js → find()`, `src/models/ledgerMaster.model.js → countDocuments()`, `src/models/ledgerMaster.model.js → aggregate()`
- **`newPartyActivity()`** _(async)_ — line 116
  - Purpose: One bounded read: for the candidate names, first/last voucher up to the period end. Tells who actually traded in the period and who already traded BEFORE their ledger's creation period.
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`nameList()`** — line 125
  - Purpose: (no comment in code — see name and calls below)
- **`newPartyWarnings()`** — line 127
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `nameList()`
  - Calls other files: `src/services/analytics/dateRanges.js → storedDayStart()`
- **`isTimeout()`** — line 153
  - Purpose: (no comment in code — see name and calls below)
- **`iso()`** — line 159
  - Purpose: (no comment in code — see name and calls below)
- **`rd6()`** — line 160
  - Purpose: (no comment in code — see name and calls below)
- **`periodOut()`** — line 162
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `iso()`
- **`comparisonOut()`** — line 166
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `iso()`
- **`unmappedWarning()`** — line 172
  - Purpose: Lines of items with no Stock Group in the synced master (or whose name differs from the master's) are left out of a productGroup breakdown and of its total. The count and amount were always in `mapping`; this puts them in front of the user as a warning.
- **`fyLabel()`** — line 181
  - Purpose: (no comment in code — see name and calls below)
- **`formatDateKey()`** — line 187
  - Purpose: Bucket keys come back from MongoDB as Dates (day/week/month/quarter) or an integer FY start year; turn them into stable, readable keys.
  - Calls in this file: `fyLabel()`
- **`outKey()`** — line 200
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `formatDateKey()`
- **`metricValues()`** — line 209
  - Purpose: (no comment in code — see name and calls below)
- **`toRows()`** — line 210
  - Purpose: (no comment in code — see name and calls below)
- **`sumValues()`** — line 212
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricValues()`
- **`amountBasisOut()`** — line 218
  - Purpose: (no comment in code — see name and calls below)
- **`growthFor()`** — line 224
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/salesAnalytics.js → computeGrowth()`
- **`refValue()`** — line 233
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`rollupProductGroups()`** — line 252
  - Purpose: Raw rows are per ITEM (key.productGroup holds the item name). Sum them into their Stock Groups; items with no master record are excluded and counted.
  - Calls in this file: `metricValues()`
- **`finalizeInMemory()`** — line 279
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `rd6()`, `metricValues()`, `growthFor()`, `refValue()`
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`assembleScalarComparison()`** — line 343
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricValues()`, `growthFor()`
- **`assemblePlain()`** — line 349
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `outKey()`, `metricValues()`
- **`assembleList()`** — line 358
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `iso()`
- **`fail()`** — line 367
  - Purpose: (no comment in code — see name and calls below)
- **`executeQuery()`** _(async)_ — line 381
  - Purpose: @param {object} rawPlan candidate plan @param {object} context @param {string} context.tenantId from the authorized company context ONLY @param {Date} [context.referenceDate] tenant reference date; resolved from the data when omitted @param {Function} [context.runAggregate] injectable (model, pipeline, options) => Promise<rows>
  - Calls in this file: `defaultLoadStockGroupMap()`, `defaultFindGroupItemNames()`, `defaultFindNewParties()`, `newPartyActivity()`, `newPartyWarnings()`, `isTimeout()`, `periodOut()`, `comparisonOut()`, `unmappedWarning()`, `metricValues()`, `toRows()`, `sumValues()`, `amountBasisOut()`, `rollupProductGroups()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/validator.js → validateQueryPlan()`, `src/services/query/compile.js → compileQuery()`

## `src/services/query/followUp.js`
**Used by:** `src/services/query/queryChat.js`

**Imports:** `src/services/query/queryPlan.schema.js`

**Exports:** `buildQueryState`, `readQueryState`, `basisOf`, `STATE_VERSION`

- **`basisOf()`** — line 21
  - Purpose: What the measure of a plan was, in the user's terms. `revenue` comes from a stated definition. 
- **`buildQueryState()`** — line 31
  - Purpose: The structured state persisted on the assistant message. Plain JSON; no tenant, no figures. 
  - Calls in this file: `basisOf()`
- **`readQueryState()`** — line 36
  - Purpose: A stored state is untrusted input: strict schema re-parse, known basis, else ignored. 
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`

## `src/services/query/planner.js`
**Used by:** `src/services/query/queryChat.js`

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/semanticCatalog.js`

**Exports:** `planQuestion`, `uncalculableTermRefusal`, `createAnthropicPlannerClient`, `getPlannerPrompt`, `buildCatalogDigest`, `PLANNER_TOOL_NAME`, `PLANNER_MAX_TOKENS`, `PLANNER_MAX_QUESTION_CHARS`, `PLANNER_ATTEMPT_TIMEOUT_MS`, `PLANNER_MAX_RETRIES`, `PLANNER_DEADLINE_MS`, `DECLINE_CODES`, `REVENUE_ASSUMPTION`

- **`isUnsafeQuestion()`** — line 49
  - Purpose: The safety gate applied before any Claude call. 
- **`mentionsRevenue()`** — line 62
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeTerms()`** — line 72
  - Purpose: Product decisions D1-D3 (final). Net sales / turnover = invoice sales AFTER returns and BEFORE tax; invoice sales = BEFORE tax and BEFORE returns. The engine has no invoice-level total before tax and cannot combine sales with returns in one figure, so these terms are REFUSED with the catalog's own reason - never answered with a nearby number (the sales total includes tax; revenue is the item lines only). An "order" i
- **`carriesVoucherTotal()`** — line 112
  - Purpose: The amounts that are invoice TOTALS including tax (catalog amountBasis): a list shows them as its amount column.
- **`mentionsOrders()`** — line 122
  - Purpose: (no comment in code — see name and calls below)
- **`catalogReason()`** — line 128
  - Purpose: (no comment in code — see name and calls below)
- **`uncalculableTermRefusal()`** — line 137
  - Purpose: A refusal when the question uses a term the engine cannot calculate (D1-D3) and the model nevertheless produced a plan; else null. @param {string} question the user's question @param {object} plan the plan the model produced (schema-parsed) @param {object|null} [previousPlan] the previous turn's plan, for a follow-up that names no noun of its own
  - Calls in this file: `mentionsRevenue()`, `normalizeTerms()`, `carriesVoucherTotal()`, `mentionsOrders()`, `catalogReason()`, `isRevenuePlan()`
- **`needsMeaning()`** — line 187
  - Purpose: A metric carries its catalog description when it is a summed amount or quantity: that is where the basis (tax-inclusive invoice total vs pre-tax item value) matters. Counts and ratios are self-explanatory from their ids.
- **`buildCatalogDigest()`** — line 189
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `needsMeaning()`
- **`getPlannerPrompt()`** — line 220
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildCatalogDigest()`
  - Calls other files: `src/services/query/queryPlan.schema.js → queryPlanJsonSchema()`
- **`cleanText()`** — line 255
  - Purpose: Anything Claude wrote is untrusted display text: no control chars, bounded, never fed to the engine.
- **`isPlainObject()`** — line 259
  - Purpose: (no comment in code — see name and calls below)
- **`addUsage()`** — line 263
  - Purpose: (no comment in code — see name and calls below)
- **`newUsage()`** — line 270
  - Purpose: (no comment in code — see name and calls below)
- **`isRevenuePlan()`** — line 276
  - Purpose: (no comment in code — see name and calls below)
- **`statedYears()`** — line 282
  - Purpose: Years the user actually wrote: 2025, '25, 2025-26, 24-25 (both years of an FY label).
- **`readPreviousPlan()`** — line 296
  - Purpose: The previous STRUCTURED plan of the conversation (follow-ups). It is untrusted input: it must pass the same strict schema as any plan, otherwise it is ignored (the question is then planned exactly as without one). Only the plan - never chat text, answers, tool results or figures - and it is shown to Claude without its default fields.
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`
- **`previousPlanMessage()`** — line 309
  - Purpose: (no comment in code — see name and calls below)
- **`plannedYears()`** — line 320
  - Purpose: Years in the previous plan's own dates were stated by the user in an earlier turn (and validated then), so a follow-up that keeps that period is not "inventing" a year.
- **`datesStated()`** — line 337
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `statedYears()`, `plannedYears()`
- **`isNewPartyPlan()`** — line 354
  - Purpose: (no comment in code — see name and calls below)
- **`failed()`** — line 358
  - Purpose: (no comment in code — see name and calls below)
- **`planQuestion()`** _(async)_ — line 372
  - Purpose: @param {string} question @param {object} options @param {Function} options.claudeClient async ({system, messages, tools, tool_choice, max_tokens}) => Anthropic-shaped response @param {Function} [options.resolveEntity] tenant-scoped resolver (server-supplied); re-verifies every name Claude used @param {Date} [options.referenceDate] only for running the semantic validator
  - Calls in this file: `isUnsafeQuestion()`, `mentionsRevenue()`, `uncalculableTermRefusal()`, `getPlannerPrompt()`, `cleanText()`, `isPlainObject()`, `addUsage()`, `newUsage()`, `isRevenuePlan()`, `readPreviousPlan()`, `previousPlanMessage()`, `datesStated()`, `isNewPartyPlan()`, `failed()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/validator.js → validateQueryPlan()`
- **`createAnthropicPlannerClient()`** — line 539
  - Purpose: Production planner client: same request shape the fake client receives. Lazily reads the key. Bounded: explicit maxRetries (never the SDK default), a per-attempt timeout, and an overall deadline that aborts the in-flight request and rejects with code PLANNER_DEADLINE_EXCEEDED. `sdkOptions` exists only so tests can point a real SDK client at a local stub (never api.anthropic.com).

## `src/services/query/presentation.js`
**Used by:** `src/services/query/queryChat.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/analytics/coverage.js`, `src/services/query/answerFormatter.js`

**Exports:** `buildPresentation`, `PRESENTATION_VERSION`

- **`shortLabel()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
- **`isMoney()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`primaryOf()`** — line 36
  - Purpose: (no comment in code — see name and calls below)
- **`customLabel()`** — line 49
  - Purpose: "2025-08-01".."2025-08-31" -> "August 2025"; other ranges stay explicit. 
- **`currentLabel()`** — line 58
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customLabel()`
  - Calls other files: `src/services/query/answerFormatter.js → periodText()`
- **`currentRange()`** — line 65
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`compareLabel()`** — line 72
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customLabel()`
- **`compareRange()`** — line 81
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`scopeOf()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`keyName()`** — line 95
  - Purpose: (no comment in code — see name and calls below)
- **`bucketLabel()`** — line 101
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `keyName()`
- **`money()`** — line 112
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isMoney()`
- **`col()`** — line 113
  - Purpose: (no comment in code — see name and calls below)
- **`change()`** — line 114
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `shortLabel()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/answerFormatter.js → fmtSigned()`, `src/services/query/answerFormatter.js → pctOf()`
- **`build()`** — line 128
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `shortLabel()`, `primaryOf()`, `currentLabel()`, `currentRange()`, `compareLabel()`, `compareRange()`, `scopeOf()`, `keyName()`, `bucketLabel()`, `money()`, `col()`, `change()`, `entity()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/answerFormatter.js → fmtSigned()`, `src/services/query/answerFormatter.js → pctOf()`
- **`entity()`** — line 266
  - Purpose: (no comment in code — see name and calls below)
- **`buildPresentation()`** — line 271
  - Purpose: @returns {object|null} never throws 
  - Calls in this file: `build()`

## `src/services/query/queryChat.js`
**Used by:** `src/controllers/chatController.js`

**Imports:** `src/services/query/validator.js`, `src/services/analytics/coverage.js`, `src/services/query/semanticCatalog.js`, `src/services/query/planner.js`, `src/services/query/entityResolver.js`, `src/services/query/answerFormatter.js`, `src/services/query/presentation.js`, `src/services/query/followUp.js`, `src/services/query/turnTelemetry.js`, `src/services/analytics/periodEngine.js`

**Exports:** `tryAnswerWithQueryEngine`, `getTenantResolver`, `createTurnDates`, `chatTelemetry`

- **`getSharedExecutor()`** — line 41
  - Purpose: (no comment in code — see name and calls below)
- **`getPlannerClient()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/planner.js → createAnthropicPlannerClient()`
- **`getTenantResolver()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/entityResolver.js → createEntityResolver()`
- **`createTurnDates()`** — line 76
  - Purpose: ONE tenant date context per chat turn (reference date + coverage window), read lazily and at most once, then shared by planner validation, coverage, the executor and telemetry. @param {string} tenantId @param {Function} [fetch] (tenantId) => date context; defaults to analytics/referenceDate getTenantDateContext
- **`baseResponse()`** — line 94
  - Purpose: (no comment in code — see name and calls below)
- **`RELATIVE_KIND()`** — line 111
  - Purpose: (no comment in code — see name and calls below)
- **`DAY()`** — line 112
  - Purpose: (no comment in code — see name and calls below)
- **`completePeriodNote()`** — line 119
  - Purpose: Month-end (P-SF, disclosure only - the comparison itself is unchanged): a COMPLETE current period compared like-for-like can meet a SHORTER previous period (30 Apr -> 1-30 Mar). Say so instead of hiding it.
  - Calls in this file: `DAY()`
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`futureVouchersNote()`** — line 133
  - Purpose: Future-dated vouchers (decision 1): relative periods end TODAY; vouchers dated later exist and are not in them.
  - Calls in this file: `RELATIVE_KIND()`
  - Calls other files: `src/services/analytics/coverage.js → fmtDay()`
- **`plannerFailureMessage()`** — line 143
  - Purpose: Honest, fixed text for a planner that failed. Only the entity-check message carries planner output, and that text is already sanitised and length-capped by the planner.
- **`recordExecution()`** — line 155
  - Purpose: Telemetry only. Engine timing is known when the executor reports it (production wiring); otherwise null.
- **`tryAnswerWithQueryEngine()`** _(async)_ — line 181
  - Purpose: @param {object} p @param {{tenantId:string}} p.context authorization-verified context from the middleware @param {string} p.userMessage @param {Array} [p.conversationHistory] only its length is used (a previous plan can exist only after an earlier turn); never sent to Claude @param {object} [p.previousQuery] the previous assistant message's stored query state (followUp.buildQueryState)
  - Calls in this file: `finishTurnMetrics()`, `answerTurn()`
  - Calls other files: `src/services/query/followUp.js → readQueryState()`
- **`finishTurnMetrics()`** — line 207
  - Purpose: Classifies the finished turn from what the turn itself reported (meta) - no re-derivation of routing.
- **`answerTurn()`** _(async)_ — line 227
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `getSharedExecutor()`, `getPlannerClient()`, `getTenantResolver()`, `createTurnDates()`, `baseResponse()`, `completePeriodNote()`, `futureVouchersNote()`, `plannerFailureMessage()`, `recordExecution()`
  - Calls other files: `src/services/query/validator.js → validateQueryPlan()`, `src/services/analytics/coverage.js → assessCoverage()`, `src/services/query/planner.js → planQuestion()`, `src/services/query/answerFormatter.js → formatQueryAnswer()`, `src/services/query/answerFormatter.js → formatNonAnswer()`, `src/services/query/presentation.js → buildPresentation()`, `src/services/query/followUp.js → readQueryState()`, `src/services/query/followUp.js → buildQueryState()`

## `src/services/query/queryPlan.schema.js`
**Used by:** `src/services/query/answerCache.js`, `src/services/query/execute.js`, `src/services/query/followUp.js`, `src/services/query/planner.js`, `src/services/query/validator.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/analytics/periodEngine.js`

**Exports:** `queryPlanSchema`, `parseQueryPlan`, `queryPlanJsonSchema`, `ENTITY_IDS`, `METRIC_IDS`, `DIMENSION_IDS`, `FILTERABLE_DIMENSION_IDS`, `FILTER_OPS`, `HAVING_OPS`, `METRIC_REFS`, `SORT_REFS`, `BUCKETS`

- **`isRealIsoDate()`** — line 60
  - Purpose: (no comment in code — see name and calls below)
- **`isConsistentFy()`** — line 68
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/periodEngine.js → parseFinancialYearInput()`
- **`flattenIssues()`** — line 203
  - Purpose: (no comment in code — see name and calls below)
- **`findForbiddenKey()`** — line 226
  - Purpose: (no comment in code — see name and calls below)
- **`fail()`** — line 237
  - Purpose: (no comment in code — see name and calls below)
- **`parseQueryPlan()`** — line 247
  - Purpose: Structural validation of a candidate plan (an object - never a string). Returns {ok:true, plan} with defaults applied, or {ok:false, errors:[{path, code, message}]} - a stable shape safe to feed back to a planner or log. Never throws.
  - Calls in this file: `flattenIssues()`, `findForbiddenKey()`, `fail()`
- **`queryPlanJsonSchema()`** — line 277
  - Purpose: JSON Schema for the planner tool input (Phase 1F). Input-io so defaulted fields are optional. 

## `src/services/query/semanticCatalog.js`
**Used by:** `src/services/query/answerCache.js`, `src/services/query/answerFormatter.js`, `src/services/query/compile.js`, `src/services/query/execute.js`, `src/services/query/planner.js`, `src/services/query/presentation.js`, `src/services/query/queryChat.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`

**Imports:** `src/services/analytics/periodEngine.js`

**Exports:** `CATALOG`, `CATALOG_VERSION`, `AMOUNT_BASIS`, `PERIOD_KINDS`, `COMPARISON_SUPPORT`, `LIMITS`, `COMPLEXITY_WEIGHTS`, `LIST_MODE`, `COMPARE`, `UNSUPPORTED_CAPABILITIES`, `PARITY_ORACLES`, `QUERY_RULES`, `computeFingerprint`, `metricsForEntity`, `dimensionsForEntity`, `metricRefs`, `buildCompatibilityMatrix`

- **`deepFreeze()`** — line 586
  - Purpose: (no comment in code — see name and calls below)
- **`stableStringify()`** — line 611
  - Purpose: Stable serialization (sorted keys) so the fingerprint is deterministic.
- **`computeFingerprint()`** — line 625
  - Purpose: Content hash: the answer cache (Phase 1E) keys on this, so a catalog edit invalidates cached answers automatically even if CATALOG_VERSION is forgotten.
  - Calls in this file: `stableStringify()`
- **`metricsForEntity()`** — line 631
  - Purpose: (no comment in code — see name and calls below)
- **`dimensionsForEntity()`** — line 634
  - Purpose: (no comment in code — see name and calls below)
- **`metricRefs()`** — line 637
  - Purpose: (no comment in code — see name and calls below)
- **`compatibilityCell()`** — line 649
  - Purpose: (no comment in code — see name and calls below)
- **`buildCompatibilityMatrix()`** — line 667
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricsForEntity()`, `dimensionsForEntity()`, `compatibilityCell()`

## `src/services/query/turnTelemetry.js`
**Used by:** `src/services/query/answerCache.js`, `src/services/query/queryChat.js`

**Exports:** `EVENT_NAME`, `now`, `newTurnMetrics`, `timeResolver`, `timeEngineDeps`, `buildTurnEvent`, `emitTurnEvent`, `emitChatTurn`, `setTelemetrySink`

- **`now()`** — line 20
  - Purpose: (no comment in code — see name and calls below)
- **`ms()`** — line 21
  - Purpose: (no comment in code — see name and calls below)
- **`int()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`code()`** — line 23
  - Purpose: (no comment in code — see name and calls below)
- **`bool()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
- **`newTurnMetrics()`** — line 41
  - Purpose: Mutable per-turn metrics bag filled in by queryChat; plain numbers/codes only. 
- **`timeResolver()`** — line 46
  - Purpose: Pass-through resolver wrapper: same arguments, same result, same error - only timed and counted. 
  - Calls in this file: `now()`
- **`timeEngineDeps()`** — line 66
  - Purpose: Answer-cache deps with the engine call timed (same functions, arguments and results). 
  - Calls in this file: `now()`
- **`sink()`** — line 81
  - Purpose: (no comment in code — see name and calls below)
- **`setTelemetrySink()`** — line 83
  - Purpose: Tests only: replace the sink (returns the previous one). 
- **`buildTurnEvent()`** — line 90
  - Purpose: Build the allow-listed event. Pure; exported so tests can inspect exactly what would be logged. 
- **`emitTurnEvent()`** — line 108
  - Purpose: Emit one event. Never throws: telemetry failure must not affect the chat turn. 
  - Calls in this file: `sink()`, `buildTurnEvent()`
- **`emitChatTurn()`** — line 127
  - Purpose: Controller hook: adds the turn-level facts (latency, status, date context) to the query-engine metrics and emits once. Never throws.
  - Calls in this file: `emitTurnEvent()`

## `src/services/query/usageStore.js`
**Used by:** (entry file / run directly)

**Imports:** `src/models/aiTurnUsage.model.js`

**Exports:** `buildUsageRecord`, `persistTurnUsage`, `setUsageWriter`, `plannerModel`

- **`model()`** — line 13
  - Purpose: (no comment in code — see name and calls below)
- **`plannerModel()`** — line 14
  - Purpose: (no comment in code — see name and calls below)
- **`n()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`aiPathOf()`** — line 18
  - Purpose: (no comment in code — see name and calls below)
- **`failureCategoryOf()`** — line 23
  - Purpose: (no comment in code — see name and calls below)
- **`buildUsageRecord()`** — line 30
  - Purpose: Pure: the persisted document, built only from the already-sanitised telemetry event. 
  - Calls in this file: `plannerModel()`, `n()`, `aiPathOf()`, `failureCategoryOf()`
- **`writer()`** _(async)_ — line 64
  - Purpose: Default writer: upsert on requestId ($setOnInsert) so a repeated emit for one request never duplicates; no request id -> plain insert. Dropped when Mongo is not connected, so it can never block on buffering.
  - Calls other files: `src/models/aiTurnUsage.model.js → updateOne()`, `src/models/aiTurnUsage.model.js → create()`
- **`setUsageWriter()`** — line 73
  - Purpose: Tests only: replace the writer (returns the previous one). 
- **`persistTurnUsage()`** — line 80
  - Purpose: Fire-and-forget. Never throws; the caller never awaits it. 
  - Calls in this file: `buildUsageRecord()`, `writer()`

## `src/services/query/validator.js`
**Used by:** `src/services/query/compile.js`, `src/services/query/execute.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/semanticCatalog.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/dateRanges.js`

**Exports:** `validateQueryPlan`, `isValidatedPlan`, `parseRef`, `estimateBuckets`, `NEW_PARTY_NOTE`

- **`isValidatedPlan()`** — line 33
  - Purpose: (no comment in code — see name and calls below)
- **`parseRef()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
- **`isMetricId()`** — line 49
  - Purpose: (no comment in code — see name and calls below)
- **`isDimensionId()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
- **`NEEDS_REFERENCE_DATE()`** — line 52
  - Purpose: (no comment in code — see name and calls below)
- **`toResolved()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
- **`resolvePlanPeriod()`** — line 66
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `toResolved()`
  - Calls other files: `src/services/analytics/periodEngine.js → resolvePeriod()`, `src/services/analytics/dateRanges.js → customRange()`
- **`sameRange()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`resolveComparison()`** — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `sameRange()`
  - Calls other files: `src/services/analytics/periodEngine.js → resolveComparisonPeriod()`, `src/services/analytics/periodEngine.js → resolvePeriod()`, `src/services/analytics/periodEngine.js → resolveSamePeriodLastYear()`, `src/services/analytics/dateRanges.js → customRange()`
- **`spanDays()`** — line 117
  - Purpose: (no comment in code — see name and calls below)
- **`estimateBuckets()`** — line 121
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `spanDays()`
- **`defaultSort()`** — line 138
  - Purpose: (no comment in code — see name and calls below)
- **`refuse()`** — line 147
  - Purpose: (no comment in code — see name and calls below)
- **`validateQueryPlan()`** — line 157
  - Purpose: @param {object} raw candidate plan (object) @param {object} [context] @param {Date} [context.referenceDate] tenant reference date (required for relative periods) @returns {{ok:true, plan, normalized, warnings, assumptions} | {ok:false, stage, errors, warnings}}
  - Calls in this file: `parseRef()`, `isMetricId()`, `isDimensionId()`, `NEEDS_REFERENCE_DATE()`, `resolvePlanPeriod()`, `resolveComparison()`, `spanDays()`, `estimateBuckets()`, `defaultSort()`, `refuse()`, `deepFreeze()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/semanticCatalog.js → metricsForEntity()`, `src/services/query/semanticCatalog.js → dimensionsForEntity()`, `src/services/query/semanticCatalog.js → buildCompatibilityMatrix()`, `src/services/analytics/dateRanges.js → customRange()`
- **`deepFreeze()`** — line 398
  - Purpose: A validated plan is immutable: the brand above proves the compiler is handed exactly what the validator approved, not something edited since.

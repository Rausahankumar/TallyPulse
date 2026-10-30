# TallyPulse code reference (generated from the source)

> **Generated on 2026-10-30 by `docs/gen_ref.js`** from the code in this checkout. To refresh it: install `acorn acorn-jsx` outside the repo (`npm install --no-save acorn acorn-jsx` in a scratch folder) and run `NODE_PATH=<that folder>/node_modules node docs/gen_ref.js`. It is static analysis: only top-level functions are listed, and "Calls other files" shows calls it could resolve from `require()`/`import`; calls through objects passed as arguments are not traced. For the current map of rules and architecture use [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md).

Har file ke liye: kya karti hai, kaun use karta hai, kaun si functions hain, har function kya karta hai (code ke apne comments se), aur wo kis dusri file ka kaun sa function call karta hai. "Tested by" batata hai kaun si verify-*.js suites us file ko require karti hain.

> Comments code se uthaye gaye hain, isliye English me hain. Simple Hindi/Hinglish samjhane wala hissa alag file `CODE_WALKTHROUGH_HINGLISH.md` me hai (wo haath se likha hai, is file se purana ho sakta hai).

**Is snapshot me:** backend 108 source files (784 functions), frontend 86 files (222 functions/components), backend scripts 110 files.

## Index

**0. Entry point**

- `server.js` (80 lines, 0 functions)

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

- `src/routes/analyticsRoutes.js` (52 lines, 0 functions)
- `src/routes/authRoutes.js` (31 lines, 0 functions)
- `src/routes/chatRoutes.js` (27 lines, 0 functions)
- `src/routes/importRoutes.js` (30 lines, 0 functions)
- `src/routes/odbcRoutes.js` (24 lines, 0 functions)
- `src/routes/reportRoutes.js` (31 lines, 0 functions)
- `src/routes/syncRoutes.js` (15 lines, 0 functions)
- `src/routes/voucherRoutes.js` (17 lines, 0 functions)

**4. Controllers (request handle)**

- `src/controllers/analyticsController.js` (493 lines, 6 functions)
- `src/controllers/authController.js` (480 lines, 7 functions)
- `src/controllers/chatController.js` (243 lines, 5 functions)
- `src/controllers/importController.js` (285 lines, 6 functions)
- `src/controllers/odbcController.js` (146 lines, 2 functions)
- `src/controllers/reportController.js` (223 lines, 6 functions)
- `src/controllers/syncRecoveryController.js` (86 lines, 1 functions)
- `src/controllers/syncStatusController.js` (123 lines, 4 functions)
- `src/controllers/voucherController.js` (135 lines, 7 functions)

**5. Models (MongoDB tables)**

- `src/models/adjustmentNote.model.js` (100 lines, 0 functions)
- `src/models/aiTurnUsage.model.js` (57 lines, 0 functions)
- `src/models/chat.model.js` (111 lines, 0 functions)
- `src/models/company.js` (63 lines, 0 functions)
- `src/models/gstSchemas.js` (162 lines, 0 functions)
- `src/models/ledgerMaster.model.js` (70 lines, 0 functions)
- `src/models/purchase.model.js` (170 lines, 0 functions)
- `src/models/reconciliationCheckpoint.model.js` (89 lines, 0 functions)
- `src/models/sales.model.js` (169 lines, 0 functions)
- `src/models/stockItemMaster.model.js` (88 lines, 0 functions)
- `src/models/syncCheckpoint.model.js` (84 lines, 0 functions)
- `src/models/tenantDataVersion.model.js` (20 lines, 0 functions)
- `src/models/user.model.js` (62 lines, 0 functions)
- `src/models/userCompanyAccess.model.js` (51 lines, 0 functions)

**6. Tally se baat (odbc)**

- `src/services/odbc/odbcService.js` (1329 lines, 23 functions)
- `src/services/odbc/tallyUrl.js` (86 lines, 4 functions)

**7. Tally rules / masters**

- `src/services/tally/adjustmentNoteClassifier.js` (123 lines, 3 functions)
- `src/services/tally/companyOwnership.js` (222 lines, 7 functions)
- `src/services/tally/ledgerMaster.js` (243 lines, 12 functions)
- `src/services/tally/stockItemGst.js` (350 lines, 11 functions)
- `src/services/tally/stockItemMaster.js` (191 lines, 4 functions)
- `src/services/tally/voucherTypeClassifier.js` (394 lines, 7 functions)

**8. Parser**

- `src/services/parser/adjustmentNoteParser.js` (167 lines, 5 functions)
- `src/services/parser/gstFields.js` (429 lines, 21 functions)
- `src/services/parser/tallyParser.js` (469 lines, 17 functions)

**9. Mapper**

- `src/services/mapper/adjustmentNoteMapper.js` (83 lines, 2 functions)
- `src/services/mapper/purchaseMapper.js` (124 lines, 4 functions)
- `src/services/mapper/salesMapper.js` (119 lines, 4 functions)

**10. Sync / reconciliation / recovery**

- `src/services/sync/adjustmentNotePersistence.js` (120 lines, 1 functions)
- `src/services/sync/batchWindow.js` (79 lines, 3 functions)
- `src/services/sync/reconciliation.js` (254 lines, 3 functions)
- `src/services/sync/reconciliationWorker.js` (360 lines, 10 functions)
- `src/services/sync/selfHeal.js` (186 lines, 2 functions)
- `src/services/sync/tallySyncWorker.js` (795 lines, 12 functions)
- `src/services/sync/voucherLineBackfill.js` (286 lines, 10 functions)
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
- `src/services/analytics/freshness.js` (110 lines, 2 functions)
- `src/services/analytics/insightTools.js` (295 lines, 16 functions)
- `src/services/analytics/insights.js` (602 lines, 20 functions)
- `src/services/analytics/periodEngine.js` (491 lines, 18 functions)
- `src/services/analytics/purchaseAnalytics.js` (195 lines, 6 functions)
- `src/services/analytics/referenceDate.js` (112 lines, 8 functions)
- `src/services/analytics/reportAnalytics.js` (161 lines, 3 functions)
- `src/services/analytics/salesAnalytics.js` (450 lines, 12 functions)
- `src/services/analytics/stockGroupAnalytics.js` (227 lines, 3 functions)
- `src/services/analytics/trustEnvelope.js` (111 lines, 1 functions)

**14. AI query engine**

- `src/services/query/aiPricing.js` (45 lines, 4 functions)
- `src/services/query/analysisAnswer.js` (151 lines, 8 functions)
- `src/services/query/analysisPlan.js` (281 lines, 12 functions)
- `src/services/query/analysisPlanner.js` (330 lines, 11 functions)
- `src/services/query/analysisPresentation.js` (250 lines, 9 functions)
- `src/services/query/answerCache.js` (204 lines, 4 functions)
- `src/services/query/answerFormatter.js` (216 lines, 20 functions)
- `src/services/query/basicAnalysis.js` (124 lines, 11 functions)
- `src/services/query/calculation.js` (194 lines, 10 functions)
- `src/services/query/compile.js` (375 lines, 24 functions)
- `src/services/query/dataVersion.js` (230 lines, 12 functions)
- `src/services/query/entityResolver.js` (180 lines, 7 functions)
- `src/services/query/evidence.js` (582 lines, 36 functions)
- `src/services/query/execute.js` (605 lines, 37 functions)
- `src/services/query/followUp.js` (192 lines, 14 functions)
- `src/services/query/groupComparison.js` (246 lines, 17 functions)
- `src/services/query/investigation.js` (324 lines, 13 functions)
- `src/services/query/plainAnswer.js` (400 lines, 19 functions)
- `src/services/query/planner.js` (869 lines, 37 functions)
- `src/services/query/plannerResponseCache.js` (226 lines, 7 functions)
- `src/services/query/presentation.js` (314 lines, 19 functions)
- `src/services/query/providerAttempts.js` (48 lines, 2 functions)
- `src/services/query/queryChat.js` (661 lines, 24 functions)
- `src/services/query/queryPlan.schema.js` (307 lines, 8 functions)
- `src/services/query/semanticCatalog.js` (760 lines, 10 functions)
- `src/services/query/turnTelemetry.js` (155 lines, 13 functions)
- `src/services/query/usageStore.js` (123 lines, 9 functions)
- `src/services/query/validator.js` (410 lines, 15 functions)

**15. Frontend: pages**

- `frontend/src/pages/Analytics.jsx` (40 lines, 1 functions)
- `frontend/src/pages/AskAI.jsx` (310 lines, 3 functions)
- `frontend/src/pages/CustomersAnalytics.jsx` (143 lines, 2 functions)
- `frontend/src/pages/Dashboard.jsx` (283 lines, 6 functions)
- `frontend/src/pages/ProductsAnalytics.jsx` (339 lines, 7 functions)
- `frontend/src/pages/PurchaseAnalytics.jsx` (257 lines, 2 functions)
- `frontend/src/pages/Reports.jsx` (426 lines, 1 functions)
- `frontend/src/pages/SalesAnalytics.jsx` (246 lines, 2 functions)
- `frontend/src/pages/Settings.jsx` (227 lines, 6 functions)
- `frontend/src/pages/SyncData.jsx` (349 lines, 6 functions)
- `frontend/src/pages/auth/AuthLayout.jsx` (60 lines, 1 functions)
- `frontend/src/pages/auth/ConnectCompany.jsx` (71 lines, 1 functions)
- `frontend/src/pages/auth/Login.jsx` (112 lines, 1 functions)
- `frontend/src/pages/auth/Register.jsx` (101 lines, 1 functions)

**15. Frontend: components**

- `frontend/src/components/charts/ComparisonBarChart.jsx` (55 lines, 2 functions)
- `frontend/src/components/charts/DonutChart.jsx` (74 lines, 3 functions)
- `frontend/src/components/charts/LineTrendChart.jsx` (61 lines, 2 functions)
- `frontend/src/components/charts/SimpleBarChart.jsx` (35 lines, 2 functions)
- `frontend/src/components/chat/ChatBubble.jsx` (140 lines, 2 functions)
- `frontend/src/components/chat/ChatInput.jsx` (51 lines, 1 functions)
- `frontend/src/components/chat/ChatSidebarList.jsx` (281 lines, 1 functions)
- `frontend/src/components/chat/MarkdownMessage.jsx` (88 lines, 1 functions)
- `frontend/src/components/chat/present/AnalysisView.jsx` (204 lines, 7 functions)
- `frontend/src/components/chat/present/CalculationPanel.jsx` (224 lines, 11 functions)
- `frontend/src/components/chat/present/DataTable.jsx` (81 lines, 1 functions)
- `frontend/src/components/chat/present/PresentationView.jsx` (259 lines, 12 functions)
- `frontend/src/components/chat/present/charts.jsx` (147 lines, 11 functions)
- `frontend/src/components/chat/present/direction.js` (9 lines, 0 functions)
- `frontend/src/components/chat/present/isPresentation.js` (12 lines, 2 functions)
- `frontend/src/components/company/AddCompanyModal.jsx` (80 lines, 1 functions)
- `frontend/src/components/company/CompanyList.jsx` (56 lines, 1 functions)
- `frontend/src/components/company/CompanySwitcher.jsx` (75 lines, 1 functions)
- `frontend/src/components/dashboard/RecentActivity.jsx` (45 lines, 1 functions)
- `frontend/src/components/layout/AppLayout.jsx` (55 lines, 1 functions)
- `frontend/src/components/layout/GuestRoute.jsx` (16 lines, 1 functions)
- `frontend/src/components/layout/NotificationsMenu.jsx` (47 lines, 1 functions)
- `frontend/src/components/layout/ProfileMenu.jsx` (67 lines, 1 functions)
- `frontend/src/components/layout/ProtectedRoute.jsx` (20 lines, 1 functions)
- `frontend/src/components/layout/Sidebar.jsx` (151 lines, 2 functions)
- `frontend/src/components/layout/Topbar.jsx` (25 lines, 1 functions)
- `frontend/src/components/layout/navConfig.js` (26 lines, 0 functions)
- `frontend/src/components/reports/ReportTable.jsx` (114 lines, 1 functions)
- `frontend/src/components/ui/AnalyticsNotice.jsx` (30 lines, 2 functions)
- `frontend/src/components/ui/Badge.jsx` (33 lines, 1 functions)
- `frontend/src/components/ui/Button.jsx` (59 lines, 0 functions)
- `frontend/src/components/ui/Card.jsx` (29 lines, 2 functions)
- `frontend/src/components/ui/DateInput.jsx` (65 lines, 1 functions)
- `frontend/src/components/ui/EmptyState.jsx` (20 lines, 1 functions)
- `frontend/src/components/ui/FilterBar.jsx` (77 lines, 1 functions)
- `frontend/src/components/ui/FreshnessBadge.jsx` (43 lines, 2 functions)
- `frontend/src/components/ui/Input.jsx` (56 lines, 0 functions)
- `frontend/src/components/ui/KpiCard.jsx` (79 lines, 1 functions)
- `frontend/src/components/ui/MiniStatCard.jsx` (26 lines, 1 functions)
- `frontend/src/components/ui/PageHeader.jsx` (12 lines, 1 functions)
- `frontend/src/components/ui/Select.jsx` (24 lines, 1 functions)
- `frontend/src/components/ui/Skeleton.jsx` (35 lines, 4 functions)
- `frontend/src/components/ui/Table.jsx` (48 lines, 1 functions)
- `frontend/src/components/ui/Tabs.jsx` (22 lines, 1 functions)
- `frontend/src/components/vouchers/VoucherRegister.jsx` (167 lines, 1 functions)

**15. Frontend: context**

- `frontend/src/context/AuthContext.jsx` (95 lines, 2 functions)
- `frontend/src/context/AuthContextObject.js` (8 lines, 0 functions)
- `frontend/src/context/CompanyContext.jsx` (90 lines, 1 functions)
- `frontend/src/context/CompanyContextObject.js` (6 lines, 0 functions)
- `frontend/src/context/useAuth.js` (9 lines, 1 functions)
- `frontend/src/context/useCompany.js` (9 lines, 1 functions)

**15. Frontend: api (backend calls)**

- `frontend/src/api/analytics.js` (103 lines, 19 functions)
- `frontend/src/api/auth.js` (70 lines, 7 functions)
- `frontend/src/api/chat.js` (51 lines, 5 functions)
- `frontend/src/api/client.js` (94 lines, 2 functions)
- `frontend/src/api/imports.js` (33 lines, 2 functions)
- `frontend/src/api/odbc.js` (122 lines, 5 functions)
- `frontend/src/api/reports.js` (63 lines, 8 functions)
- `frontend/src/api/sync.js` (13 lines, 1 functions)
- `frontend/src/api/vouchers.js` (22 lines, 3 functions)

**15. Frontend: lib (hooks and helpers)**

- `frontend/src/lib/cn.js` (9 lines, 1 functions)
- `frontend/src/lib/dateRange.js` (69 lines, 6 functions)
- `frontend/src/lib/format.js` (43 lines, 5 functions)
- `frontend/src/lib/markdownText.js` (19 lines, 1 functions)
- `frontend/src/lib/period.js` (73 lines, 11 functions)
- `frontend/src/lib/useAsync.js` (36 lines, 2 functions)
- `frontend/src/lib/useDebouncedValue.js` (17 lines, 1 functions)
- `frontend/src/lib/usePersistedRange.js` (63 lines, 3 functions)
- `frontend/src/lib/usePolling.js` (66 lines, 1 functions)
- `frontend/src/lib/useTallyConnectionTest.js` (29 lines, 1 functions)

**15. Frontend: app entry**

- `frontend/src/App.jsx` (48 lines, 1 functions)
- `frontend/src/main.jsx` (20 lines, 0 functions)

**16. Backend scripts (operator tools, evaluations, verification suites)**

- see section 16 below (one line per script)


# 0. Entry point

## `server.js`
**Used by:** (entry file / run directly)

**Imports:** `src/config/db.js`, `src/middleware/httpSecurity.js`, `src/middleware/errorHandler.js`, `src/middleware/requestId.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/reconciliationWorker.js`, `src/routes/authRoutes.js`, `src/routes/importRoutes.js`, `src/routes/odbcRoutes.js`, `src/routes/chatRoutes.js`, `src/routes/syncRoutes.js`, `src/routes/analyticsRoutes.js`, `src/routes/voucherRoutes.js`, `src/routes/reportRoutes.js`, `src/services/query/basicAnalysis.js`

**Middleware and route mounts (in order):**

- `applyHttpSecurity(app) (src/middleware/httpSecurity.js)`
- `app.use() → requestId (src/middleware/requestId.js)`
- `app.use() → express.json()`
- `app.use() → express.urlencoded()`
- `app.get("/") → (inline handler)`
- `app.use("/api/auth") → authRoutes (src/routes/authRoutes.js)`
- `app.use("/api/import") → importRoutes (src/routes/importRoutes.js)`
- `app.use("/api/odbc") → odbcRoutes (src/routes/odbcRoutes.js)`
- `app.use("/api/chat") → chatRoutes (src/routes/chatRoutes.js)`
- `app.use("/api/sync") → syncRoutes (src/routes/syncRoutes.js)`
- `app.use("/api/analytics") → analyticsRoutes (src/routes/analyticsRoutes.js)`
- `app.use("/api/vouchers") → voucherRoutes (src/routes/voucherRoutes.js)`
- `app.use("/api/reports") → reportRoutes (src/routes/reportRoutes.js)`
- `app.use() → notFoundHandler (src/middleware/errorHandler.js)`
- `app.use() → errorHandler (src/middleware/errorHandler.js)`
- `app.listen() PORT → (inline handler)`


# 1. Config

## `src/config/db.js`
**Used by:** `server.js`

**Tested by:** `backfill-voucher-line-details.js`, `drop-stale-indexes.js`, `eval-findings-real.js`, `eval-investigations.js`, `list-indexes.js`, `migrate-voucher-identity.js`, `migrate-voucher-total-amount.js`, `refresh-ledger-master.js` (+52 more)

**Imports:** (none)

**Exports:** `connectDB (default)`, `connectGuarded`, `checkConnectionTarget`, `isTestMode`, `parseMongoUri`

- **`isTestMode()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
- **`parseMongoUri()`** — line 35
  - Purpose: Parses a mongodb:// or mongodb+srv:// URI without keeping credentials. Returns null when the string is not a usable connection string. Manual parsing on purpose: WHATWG URL rejects valid standard URIs with several hosts (mongodb://a:27017,b:27017/db). Returns { srv, hosts, host, dbName } or null. Credentials are dropped here and never returned.
- **`checkConnectionTarget()`** — line 83
  - Purpose: Pure decision function: no I/O, no connection. Returns { ok, reason }. `reason` never contains credentials, and shows the host only when it is loopback.
  - Calls in this file: `isTestMode()`, `parseMongoUri()`
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

**Exports:** `auth (default)`

- **`auth()`** _(async)_ — line 5
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/user.model.js → findById()`

## `src/middleware/errorHandler.js`
**Used by:** `src/controllers/authController.js`, `src/controllers/chatController.js`, `src/controllers/importController.js`, `src/middleware/upload.js`, `src/services/auth/companyContext.js`, `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** (none)

**Exports:** `errorHandler`, `notFoundHandler`, `userError`, `GENERIC_SERVER_ERROR`

- **`userError()`** — line 40
  - Purpose: Error to throw for a client mistake whose message is safe to show.
- **`notFoundHandler()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
- **`errorHandler()`** — line 52
  - Purpose: eslint-disable-next-line no-unused-vars

## `src/middleware/httpSecurity.js`
**Used by:** `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** (none)

**Exports:** `applyHttpSecurity`, `parseAllowedOrigins`, `DEV_ORIGINS`

- **`parseAllowedOrigins()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`applyHttpSecurity()`** — line 31
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `parseAllowedOrigins()`

## `src/middleware/rateLimit.js`
**Used by:** `src/routes/authRoutes.js`

**Tested by:** `verify-security-audit.js`

**Imports:** (none)

**Exports:** `createRateLimiter`, `loginLimiters`, `registerLimiter`, `connectCompanyLimiter`, `resetAllRateLimiters`

- **`createRateLimiter()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `clientIp()`
- **`clientIp()`** — line 90
  - Purpose: (no comment in code — see name and calls below)
- **`emailKey()`** — line 97
  - Purpose: The e-mail part of a login key: only a real string is used (anything else is rejected by the controller anyway), trimmed, lower-cased and length-capped so the key cannot be used to bloat memory.
- **`resetAllRateLimiters()`** — line 133
  - Purpose: For tests: forget every counter.

## `src/middleware/requestId.js`
**Used by:** `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** (none)

**Exports:** `requestId (default)`

- **`requestId()`** — line 17
  - Purpose: (no comment in code — see name and calls below)

## `src/middleware/upload.js`
**Used by:** `src/routes/importRoutes.js`

**Imports:** `src/middleware/errorHandler.js`

**Exports:** `upload (default)`

- **`fileFilter()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/middleware/errorHandler.js → userError()`


# 3. Routes (URL → controller)

## `src/routes/analyticsRoutes.js`
**Used by:** `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/analyticsController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.use() → auth (src/middleware/auth.js) → activeCompanyContext (src/services/auth/companyContext.js)`
- `router.get("/sales/summary") → getSalesSummary (src/controllers/analyticsController.js)`
- `router.get("/sales/comparison") → getSalesComparison (src/controllers/analyticsController.js)`
- `router.get("/sales/top-products") → getTopProducts (src/controllers/analyticsController.js)`
- `router.get("/sales/growing-products") → getGrowingProducts (src/controllers/analyticsController.js)`
- `router.get("/sales/declining-products") → getDecliningProducts (src/controllers/analyticsController.js)`
- `router.get("/sales/top-customers") → getTopCustomers (src/controllers/analyticsController.js)`
- `router.get("/sales/trend") → getSalesTrend (src/controllers/analyticsController.js)`
- `router.get("/sales/customer-counts") → getCustomerCounts (src/controllers/analyticsController.js)`
- `router.get("/sales/stock-groups") → getStockGroupPerformance (src/controllers/analyticsController.js)`
- `router.get("/purchases/summary") → getPurchaseSummary (src/controllers/analyticsController.js)`
- `router.get("/purchases/comparison") → getPurchaseComparison (src/controllers/analyticsController.js)`
- `router.get("/purchases/top-suppliers") → getTopSuppliers (src/controllers/analyticsController.js)`
- `router.get("/purchases/trend") → getPurchaseTrend (src/controllers/analyticsController.js)`
- `router.get("/discounts") → getDiscountSummary (src/controllers/analyticsController.js)`
- `router.get("/products/rates") → getProductRates (src/controllers/analyticsController.js)`
- `router.get("/products/margin") → getProductMargin (src/controllers/analyticsController.js)`
- `router.get("/products/trend") → getProductTrend (src/controllers/analyticsController.js)`
- `router.get("/purchases/supplier-rates") → getSupplierRates (src/controllers/analyticsController.js)`


## `src/routes/authRoutes.js`
**Used by:** `server.js`

**Tested by:** `verify-multi-company.js`, `verify-security-audit.js`

**Imports:** `src/middleware/auth.js`, `src/middleware/rateLimit.js`, `src/services/auth/companyContext.js`, `src/controllers/authController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.post("/register") → registerLimiter (src/middleware/rateLimit.js) → register (src/controllers/authController.js)`
- `router.post("/login") → ...loginLimiters → login (src/controllers/authController.js)`
- `router.post("/companies") → auth (src/middleware/auth.js) → connectCompanyLimiter (src/middleware/rateLimit.js) → addCompany (src/controllers/authController.js)`
- `router.get("/companies") → auth (src/middleware/auth.js) → listCompanies (src/controllers/authController.js)`
- `router.post("/switch-company") → auth (src/middleware/auth.js) → switchCompany (src/controllers/authController.js)`
- `router.patch("/company") → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js) → updateCompanyName (src/controllers/authController.js)`


## `src/routes/chatRoutes.js`
**Used by:** `server.js`

**Tested by:** `verify-multi-company.js`, `verify-security-audit.js`

**Imports:** `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/chatController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.use() → auth (src/middleware/auth.js) → activeCompanyContext (src/services/auth/companyContext.js)`
- `router.get("/") → listChats (src/controllers/chatController.js)`
- `router.post("/message") → sendChatMessage (src/controllers/chatController.js)`
- `router.post("/:chatId/message") → sendChatMessage (src/controllers/chatController.js)`
- `router.get("/:chatId") → getChat (src/controllers/chatController.js)`
- `router.patch("/:chatId") → renameChat (src/controllers/chatController.js)`
- `router.delete("/:chatId") → deleteChat (src/controllers/chatController.js)`


## `src/routes/importRoutes.js`
**Used by:** `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** `src/middleware/upload.js`, `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/importController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.post("/tally-json") → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js) → upload.single() → importTallyJson (src/controllers/importController.js)`
- `router.post("/tally-live") → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js) → importTallyLive (src/controllers/importController.js)`


## `src/routes/odbcRoutes.js`
**Used by:** `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/odbcController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.get("/company") → auth (src/middleware/auth.js) → testTallyConnection (src/controllers/odbcController.js)`
- `router.get("/sales") → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js) → getSales (src/controllers/odbcController.js)`


## `src/routes/reportRoutes.js`
**Used by:** `server.js`

**Imports:** `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/reportController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.use() → auth (src/middleware/auth.js) → activeCompanyContext (src/services/auth/companyContext.js)`
- `router.get("/products") → getProductReport (src/controllers/reportController.js)`
- `router.get("/customers") → getCustomerReport (src/controllers/reportController.js)`
- `router.get("/sales/export") → exportSalesReport (src/controllers/reportController.js)`
- `router.get("/purchases/export") → exportPurchaseReport (src/controllers/reportController.js)`
- `router.get("/products/export") → exportProductReport (src/controllers/reportController.js)`
- `router.get("/customers/export") → exportCustomerReport (src/controllers/reportController.js)`


## `src/routes/syncRoutes.js`
**Used by:** `server.js`

**Tested by:** `verify-security-audit.js`

**Imports:** `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/syncStatusController.js`, `src/controllers/syncRecoveryController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.get("/status") → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js) → getSyncStatus (src/controllers/syncStatusController.js)`
- `router.post("/recovery") → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js) → runVoucherRecovery (src/controllers/syncRecoveryController.js)`


## `src/routes/voucherRoutes.js`
**Used by:** `server.js`

**Imports:** `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/controllers/voucherController.js`

**Exports:** `router (default)`

**Routes (METHOD path → middleware → handler):**

- `router.use() → auth (src/middleware/auth.js) → liveCompanyContext (src/services/auth/companyContext.js)`
- `router.get("/sales") → listSalesVouchers (src/controllers/voucherController.js)`
- `router.get("/purchases") → listPurchaseVouchers (src/controllers/voucherController.js)`


# 4. Controllers (request handle)

## `src/controllers/analyticsController.js`
**Used by:** `src/routes/analyticsRoutes.js`

**Tested by:** `verify-insights.js`

**Imports:** `src/services/analytics/salesAnalytics.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/insights.js`, `src/services/analytics/dateRanges.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/trustEnvelope.js`

**Exports:** `getDiscountSummary`, `getProductRates`, `getProductMargin`, `getProductTrend`, `getSupplierRates`, `getSalesSummary`, `getSalesComparison`, `getTopProducts`, `getGrowingProducts`, `getDecliningProducts`, `getTopCustomers`, `getSalesTrend`, `getCustomerCounts`, `getStockGroupPerformance`, `getPurchaseSummary`, `getPurchaseComparison`, `getTopSuppliers`, `getPurchaseTrend`

- **`parsePeriodFromQuery()`** — line 39
  - Purpose: `referenceDate` anchors what "current_month"/"previous_month" actually mean - see services/analytics/referenceDate.js for why this is the tenant's own latest voucher date, not necessarily the wall clock. Every caller below computes it once per request and threads it through; period="custom" ignores it entirely (an explicit from/to needs no anchor).
  - Calls other files: `src/services/analytics/dateRanges.js → resolveRequestPeriod()`
- **`parseTrendPeriodFromQuery()`** — line 65
  - Purpose: Default window for a trend chart when the caller hasn't picked an explicit range: the last 6 complete months ending at the tenant's own reference date (see above) - not a hardcoded set of months.
  - Calls other files: `src/services/analytics/dateRanges.js → customRange()`, `src/services/analytics/dateRanges.js → lastNMonthsEnding()`
- **`parseComparisonTypeFromQuery()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`parseLimitFromQuery()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`parseStockGroupPeriodFromQuery()`** — line 111
  - Purpose: Stock Group performance uses the NEW, richer period engine (periodEngine.js) - its own period-kind set (17 kinds, see that file), completely separate from PERIOD_KINDS/parsePeriodFromQuery above, which stays exactly as it was for every existing endpoint. Adding this parser changes no existing endpoint's accepted query params or behavior.
  - Calls other files: `src/services/analytics/periodEngine.js → resolvePeriod()`, `src/services/analytics/periodEngine.js → resolveComparisonPeriod()`, `src/services/analytics/periodEngine.js → resolveSamePeriodLastYear()`
- **`handle()`** — line 157
  - Purpose: Wraps a handler so any thrown error (bad query params, or anything unexpected) becomes a clean HTTP error response instead of a 500 with no message - matches the pattern already used across authController/importController.

## `src/controllers/authController.js`
**Used by:** `src/routes/authRoutes.js`

**Tested by:** `verify-company-identity.js`

**Imports:** `src/models/user.model.js`, `src/models/company.js`, `src/models/userCompanyAccess.model.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/auth/companyIdentity.js`, `src/middleware/errorHandler.js`

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
  - Purpose: CONNECT COMPANY ("Connect Tally") - attach the company that is open in TallyPrime right now to the CURRENT (already-authenticated) account. The user never supplies a GUID or a name: the backend reads them from Tally, and the GUID stays an internal identity (companyIdentity.js decides whether a tenant is created, reused or reactivated, and whether this account is allowed to have it at all). - the first company need...
  - Calls in this file: `signToken()`
  - Calls other files: `src/models/user.model.js → findById()`, `src/models/userCompanyAccess.model.js → exists()`, `src/services/auth/tallyCompanyGuard.js → detectOpenTallyCompany()`, `src/services/auth/companyIdentity.js → ensureCompanyForGuid()`, `src/models/userCompanyAccess.model.js → findOne()`, `src/models/userCompanyAccess.model.js → create()`
- **`listCompanies()`** _(async)_ — line 300
  - Purpose: LIST COMPANIES the current user can access - their default company (always allowed, even for accounts created before the join collection existed) plus every company connected via addCompany() above.
  - Calls other files: `src/models/user.model.js → findById()`, `src/models/userCompanyAccess.model.js → find()`, `src/models/company.js → find()`
- **`switchCompany()`** _(async)_ — line 347
  - Purpose: SWITCH ACTIVE COMPANY - re-scopes the JWT to a company the user already has access to (their own, or one added via addCompany()). Deliberately does NOT require the password again: the user is already authenticated for their account, this only changes which already-authorized company that session is acting as - exactly the "future company-switcher UI" companyContext.js's activeCompanyContext middleware was already...
  - Calls in this file: `signToken()`
  - Calls other files: `src/models/user.model.js → findById()`, `src/models/userCompanyAccess.model.js → findOne()`, `src/models/company.js → findOne()`
- **`updateCompanyName()`** _(async)_ — line 424
  - Purpose: RENAME the CURRENT active company (req.user.companyGuId, from the JWT - never a company id supplied by the client). Small, additive fix: the frontend previously "saved" a company name change only to browser localStorage and never called the backend at all. That's a fake success the QA pass flagged - this makes the save real.
  - Calls other files: `src/models/company.js → findOneAndUpdate()`

## `src/controllers/chatController.js`
**Used by:** `src/routes/chatRoutes.js`

**Tested by:** `verify-ai-telemetry.js`, `verify-analysis-followup.js`, `verify-chat-management.js`, `verify-cost-forensic.js`, `verify-followup-context.js`, `verify-group-comparison.js`, `verify-query-chat.js`, `verify-semantic-foundation.js` (+1 more)

**Imports:** `src/middleware/errorHandler.js`, `src/models/chat.model.js`, `src/services/query/queryChat.js`

**Exports:** `sendChatMessage`, `listChats`, `getChat`, `renameChat`, `deleteChat`, `MAX_CHAT_TITLE_CHARS`

- **`sendChatMessage()`** _(async)_ — line 24
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/chat.model.js → findOne()`, `src/services/query/queryChat.js → createTurnDates()`, `src/services/query/queryChat.js → tryAnswerWithQueryEngine()`
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
  - Purpose: Live TallyPrime import — fetches sales vouchers directly from Tally's HTTP JSON gateway (reusing the existing odbcService integration) and runs them through the same parse -> map -> validate -> dedupe -> save pipeline as the file-upload import. Optional ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD query params select the voucher date range; both default to today when omitted.
  - Calls in this file: `checkImportRange()`, `buildImportResponseBody()`, `respondToImportError()`
  - Calls other files: `src/services/import/tallySalesImport.js → importTallySalesFromTally()`

## `src/controllers/odbcController.js`
**Used by:** `src/routes/odbcRoutes.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`

**Exports:** `testTallyConnection`, `getSales`

- **`testTallyConnection()`** _(async)_ — line 16
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/odbc/odbcService.js → getCompanyInfo()`, `src/services/auth/tallyCompanyGuard.js → resolveSelectedOpenCompany()`
- **`getSales()`** _(async)_ — line 69
  - Purpose: No auth/tenant context on this route (a legacy diagnostic endpoint, not the real tenant-scoped /api/import/tally-live path) - so unlike that path, there's no companyGuId to resolve a Company from. Instead it resolves classification for whichever company Tally currently has open, same generic voucherTypeClassifier the rest of the app uses, never a hardcoded name and never a silent fallback to $$VchTypeSales.
  - Calls other files: `src/services/auth/tallyCompanyGuard.js → resolveSelectedOpenCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/odbc/odbcService.js → getSalesVouchers()`

## `src/controllers/reportController.js`
**Used by:** `src/routes/reportRoutes.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/analytics/reportAnalytics.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/trustEnvelope.js`, `src/services/analytics/dateRanges.js`

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
  - Calls in this file: `csvRow()`

## `src/controllers/syncRecoveryController.js`
**Used by:** `src/routes/syncRoutes.js`

**Tested by:** `verify-voucher-recovery.js`

**Imports:** `src/services/import/tallySalesImport.js`, `src/services/sync/voucherRecovery.js`

**Exports:** `runVoucherRecovery`

- **`runVoucherRecovery()`** _(async)_ — line 26
  - Purpose: POST /api/sync/recovery { voucherType: "Sales"|"Purchase", apply?: boolean } Compares Tally with MongoDB for the caller's own company and (only when apply === true) re-imports vouchers that exist in Tally but are missing from MongoDB. Default is a dry run that writes nothing. This is not a checkpoint reset and never touches the incremental sync's checkpoint. The tenant is re-derived from the JWT's companyGuId, nev...
  - Calls other files: `src/services/import/tallySalesImport.js → resolveTenantContext()`, `src/services/sync/voucherRecovery.js → recoverMissingVouchers()`

## `src/controllers/syncStatusController.js`
**Used by:** `src/routes/syncRoutes.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js`, `src/services/import/tallySalesImport.js`, `src/services/analytics/freshness.js`

**Exports:** `getSyncStatus`

- **`serializeCheckpoint()`** — line 10
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/freshness.js → successTimeOf()`
- **`serializeReconciliation()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`serializeVoucher()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`getSyncStatus()`** _(async)_ — line 60
  - Purpose: Real backend data for the Sync & Data page (docs §5.1/§16 previously had no REST endpoint exposing SyncCheckpoint/ReconciliationCheckpoint or the actual synced records - only the cron workers wrote them internally). This is that endpoint: everything returned here is read straight from MongoDB for the caller's own tenant (re-derived from their JWT's companyGuId via resolveTenantContext, never trusted directly), not...
  - Calls in this file: `serializeCheckpoint()`, `serializeReconciliation()`
  - Calls other files: `src/services/import/tallySalesImport.js → resolveTenantContext()`, `src/models/syncCheckpoint.model.js → findOne()`, `src/models/reconciliationCheckpoint.model.js → findOne()`, `src/models/sales.model.js → find()`, `src/models/purchase.model.js → find()`, `src/models/sales.model.js → countDocuments()`, `src/models/purchase.model.js → countDocuments()`

## `src/controllers/voucherController.js`
**Used by:** `src/routes/voucherRoutes.js`

**Tested by:** `verify-voucher-pagination.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`

**Exports:** `listSalesVouchers`, `listPurchaseVouchers`

- **`parsePagination()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`parseDateBound()`** — line 32
  - Purpose: (no comment in code — see name and calls below)
- **`escapeRegex()`** — line 46
  - Purpose: Same regex-escaping discipline as the query engine's name matching (query/compile.js) - real voucher/party text, never a pattern, so it must never be interpreted as one.
- **`buildSearchClause()`** — line 56
  - Purpose: One `search` box covers the fields that make sense for free text: voucher number and party name (partial, case-insensitive), plus an exact amount match when the term parses as a number. Date is deliberately NOT part of free-text search - date-format parsing from arbitrary text is ambiguous; the existing `from`/`to` params (same convention as the analytics endpoints) cover date filtering instead.
  - Calls in this file: `escapeRegex()`
- **`listVouchers()`** _(async)_ — line 74
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `parsePagination()`, `parseDateBound()`, `buildSearchClause()`
- **`listSalesVouchers()`** — line 131
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `listVouchers()`
- **`listPurchaseVouchers()`** — line 132
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `listVouchers()`


# 5. Models (MongoDB tables)

## `src/models/adjustmentNote.model.js`
**Used by:** `src/services/query/execute.js`, `src/services/sync/adjustmentNotePersistence.js`, `src/services/tally/adjustmentNoteClassifier.js`

**Tested by:** `verify-adjustment-note.js`, `verify-insights.js`, `verify-product-return-analytics.js`, `verify-return-analytics.js`, `verify-return-query.js`, `verify-return-ranking.js`

**Imports:** `src/services/query/dataVersion.js`

**Exports:** `(default)`

**Purpose:** Normalized Credit Note + Debit Note storage (one model, not two - see docs/PROJECT_CONTEXT.md and the CN/DN diagnostic). noteType is the raw Tally family (credit/debit); classification is the DETERMINISTIC, evidence-based reading (adjustmentNoteClassifier.js) - never inferred from the voucher type name alone, and never sales_return/purchase_return merely because noteType says credit/debit.


## `src/models/aiTurnUsage.model.js`
**Used by:** `src/services/query/usageStore.js`

**Tested by:** `verify-ai-usage-persist.js`, `verify-cache-telemetry.js`

**Imports:** (none)

**Exports:** `(default)`

**Purpose:** One allow-listed usage record per AI chat turn (the usage store of the query engine). Usage counters only: no prompts, history, answers, tool results, names or figures. Never part of the chat/financial path.


## `src/models/chat.model.js`
**Used by:** `src/controllers/chatController.js`

**Tested by:** `verify-analysis-followup.js`, `verify-chat-management.js`, `verify-cost-forensic.js`, `verify-followup-context.js`, `verify-group-comparison.js`, `verify-query-chat.js`, `verify-security-audit.js`, `verify-semantic-foundation.js` (+1 more)

**Imports:** (none)

**Exports:** `(default)`

**Purpose:** Chat history, scoped by tenant AND user (never just tenant - two users at the same company must not see each other's chats by default, and definitely never see another company's chats at all). Deliberately does NOT store raw query results or raw Tally/Mongo documents - only what's needed to redisplay the conversation (the assistant's deterministic answer, not the underlying dataset it was computed from): chat history is a display/audit log of what was SAID, not a second copy of the analytics dat


## `src/models/company.js`
**Used by:** `src/controllers/authController.js`, `src/services/auth/companyContext.js`, `src/services/auth/companyIdentity.js`, `src/services/import/tallySalesImport.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`

**Tested by:** `backfill-voucher-line-details.js`, `eval-findings-real.js`, `refresh-ledger-master.js`, `refresh-stock-item-master.js`, `run-adjustment-note-sync.js`, `verify-analytics-scope.js`, `verify-company-guid-match.js`, `verify-company-identity.js` (+17 more)

**Imports:** `src/services/odbc/tallyUrl.js`

**Exports:** `(default)`


## `src/models/gstSchemas.js`
**Used by:** `src/models/purchase.model.js`, `src/models/sales.model.js`, `src/models/stockItemMaster.model.js`

**Imports:** (none)

**Exports:** `stockItemGstSchema`, `voucherLineGstSchema`

**Purpose:** Shared GST sub-schemas (see services/parser/gstFields.js for how each field is produced). Two different things use them and must never be mixed up: - StockItemMaster.gst : the item's CURRENT master configuration, with its dated history. - Sale/Purchase inventory[].gst : what that voucher line carried when it was posted. Conventions: - null means "Tally did not supply it". It is never a stand-in for 0 or false. - A rate is {value, status, raw}: status "value" (0 is a real value), "missing" or "ma


## `src/models/ledgerMaster.model.js`
**Used by:** `src/services/query/execute.js`, `src/services/tally/adjustmentNoteClassifier.js`, `src/services/tally/ledgerMaster.js`

**Tested by:** `verify-adjustment-note.js`, `verify-customer-count.js`, `verify-ledger-master.js`

**Imports:** `src/services/query/dataVersion.js`

**Exports:** `(default)`

**Purpose:** Tally Ledger master (parties and every other ledger), refreshed on demand from Tally by services/tally/ledgerMaster.js - never from the incremental voucher sync, never inferred from voucher party names. Vouchers carry only header.partyName (Tally PartyLedgerName); a party's identity is resolved through this collection by EXACT name (Tally ledger names are unique within a company). It exists so "new customer/supplier" can be answered from Tally's own ledger CreatedDate instead of a history scan o


## `src/models/purchase.model.js`
**Used by:** `src/controllers/reportController.js`, `src/controllers/syncStatusController.js`, `src/controllers/voucherController.js`, `src/services/analytics/insights.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/reportAnalytics.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/query/entityResolver.js`, `src/services/query/execute.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`

**Tested by:** `eval-findings-real.js`, `eval-investigations.js`, `migrate-voucher-total-amount.js`, `verify-analysis-planner.js`, `verify-analytics-scope.js`, `verify-ask-ai-basic-questions.js`, `verify-company-ownership.js`, `verify-comparison-period-capability.js` (+26 more)

**Imports:** `src/models/gstSchemas.js`, `src/services/query/dataVersion.js`

**Exports:** `(default)`


## `src/models/reconciliationCheckpoint.model.js`
**Used by:** `src/controllers/syncStatusController.js`, `src/services/auth/companyIdentity.js`, `src/services/sync/reconciliationWorker.js`

**Tested by:** `verify-company-identity.js`, `verify-company-ownership.js`, `verify-reconciliation-history.js`, `verify-reconciliation-perf-and-failure.js`, `verify-reconciliation.js`, `verify-security-audit.js`, `verify-self-heal.js`

**Imports:** (none)

**Exports:** `(default)`

**Purpose:** Tracking for the reconciliation safety-net, deliberately kept as its own collection - NOT a field added to SyncCheckpoint. Reconciliation is a conceptually separate job from the AlterID incremental sync (it runs on a slower cadence, it never advances an AlterID, and a failed reconciliation run must never be confused with a failed incremental sync in freshness reporting). Mirrors SyncCheckpoint's lock/staleness shape (proven pattern, reused deliberately) without sharing its document or its lastAl


## `src/models/sales.model.js`
**Used by:** `src/controllers/reportController.js`, `src/controllers/syncStatusController.js`, `src/controllers/voucherController.js`, `src/services/analytics/insights.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/reportAnalytics.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/import/tallySalesImport.js`, `src/services/query/entityResolver.js`, `src/services/query/execute.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`

**Tested by:** `eval-findings-real.js`, `eval-investigations.js`, `list-indexes.js`, `migrate-voucher-total-amount.js`, `verify-analysis-plan.js`, `verify-analysis-planner.js`, `verify-analytics-scope.js`, `verify-ask-ai-basic-questions.js` (+33 more)

**Imports:** `src/models/gstSchemas.js`, `src/services/query/dataVersion.js`

**Exports:** `(default)`


## `src/models/stockItemMaster.model.js`
**Used by:** `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/entityResolver.js`, `src/services/query/execute.js`, `src/services/tally/stockItemGst.js`, `src/services/tally/stockItemMaster.js`

**Tested by:** `verify-growth-comparison-capability.js`, `verify-query-cache.js`, `verify-query-engine.js`, `verify-query-parity-synthetic.js`, `verify-query-parity.js`, `verify-stock-group-analytics.js`, `verify-stock-item-gst.js`, `verify-stock-item-master.js`

**Imports:** `src/models/gstSchemas.js`, `src/services/query/dataVersion.js`

**Exports:** `(default)`


## `src/models/syncCheckpoint.model.js`
**Used by:** `src/controllers/syncStatusController.js`, `src/services/analytics/freshness.js`, `src/services/analytics/referenceDate.js`, `src/services/auth/companyIdentity.js`, `src/services/sync/selfHeal.js`, `src/services/sync/tallySyncWorker.js`

**Tested by:** `eval-findings-real.js`, `eval-investigations.js`, `verify-adjustment-note.js`, `verify-analytics-scope.js`, `verify-ask-ai-basic-questions.js`, `verify-company-identity.js`, `verify-company-ownership.js`, `verify-insights.js` (+14 more)

**Imports:** (none)

**Exports:** `(default)`

**Purpose:** One checkpoint document per {tenant, company, voucherType}. Scoped by voucherType so future voucher types (Purchase, Receipt, ...) can each get their own independent incremental position without redesigning this model. lastAlterId only ever advances after a fully successful sync batch for that company — see tallySyncWorker.js.


## `src/models/tenantDataVersion.model.js`
**Used by:** `src/services/query/dataVersion.js`

**Tested by:** `eval-investigations.js`, `verify-analysis-plan.js`, `verify-analysis-planner.js`, `verify-ask-ai-basic-questions.js`, `verify-cost-forensic.js`, `verify-customer-count.js`, `verify-insight-tools.js`, `verify-investigation-eval.js` (+3 more)

**Imports:** (none)

**Exports:** `(default)`

**Purpose:** One tiny counter per tenant. Every committed write to a tenant's Sales / Purchase / Stock Item master data increments it (see services/query/dataVersion.js). The answer cache keys on this value, so a changed dataset can never be answered from an old cached result. tenantId "*" is a reserved GLOBAL counter, bumped when a write cannot be attributed to a single tenant (fail closed: it invalidates everyone).


## `src/models/user.model.js`
**Used by:** `src/controllers/authController.js`, `src/middleware/auth.js`, `src/services/auth/companyContext.js`, `src/services/auth/companyIdentity.js`

**Tested by:** `verify-analytics-scope.js`, `verify-company-guid-match.js`, `verify-company-identity.js`, `verify-dashboard-real-data.js`, `verify-multi-company.js`, `verify-reports.js`, `verify-security-audit.js`, `verify-voucher-pagination.js`

**Imports:** (none)

**Exports:** `(default)`


## `src/models/userCompanyAccess.model.js`
**Used by:** `src/controllers/authController.js`, `src/services/auth/companyContext.js`, `src/services/auth/companyIdentity.js`

**Tested by:** `verify-company-guid-match.js`, `verify-company-identity.js`, `verify-multi-company.js`, `verify-security-audit.js`

**Imports:** (none)

**Exports:** `(default)`

**Purpose:** The join collection companyContext.js explicitly anticipated ("this is the exact line that becomes a join-collection lookup once multi-company is implemented, without changing anything that calls this function" — see resolveAuthorizedCompany). One row per {user, company} pairing a user is allowed to operate as. A user's ORIGINAL company (User.companyId/companyGuId/tenantId, set at registration) is still the source of truth for their default login context and is NOT required to have a row here —


# 6. Tally se baat (odbc)

## `src/services/odbc/odbcService.js`
**Used by:** `src/controllers/odbcController.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/import/tallySalesImport.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/tally/ledgerMaster.js`, `src/services/tally/stockItemGst.js`, `src/services/tally/stockItemMaster.js`, `src/services/tally/voucherTypeClassifier.js`

**Tested by:** `verify-company-guid-match.js`, `verify-reconciliation.js`, `verify-security-audit.js`, `verify-stock-item-gst.js`, `verify-sync-batching.js`, `verify-sync-worker-guard.js`, `verify-voucher-lifecycle.js`, `verify-voucher-line-details.js` (+2 more)

**Imports:** `src/services/odbc/tallyUrl.js`

**Exports:** `getCompanyInfo`, `getVoucherTypeMasters`, `getStockItemMasters`, `getStockItemGstMasters`, `isSafeStockGroupNameForFormula`, `STOCK_ITEM_GST_NATIVE_METHOD`, `getLedgerMasters`, `getGroupMasters`, `getPendingVoucherAlterIds`, `getVouchersByAlterIds`, `MAX_ALTERIDS_PER_RECOVERY_QUERY`, `getSalesVouchers`, `getSalesVouchersSinceAlterId`, `getAllSalesVoucherGuids`, `getAllPurchaseVoucherGuids`, `getPurchaseVouchersSinceAlterId`, `getAdjustmentNoteVouchersSinceAlterId`

- **`formatTallyDate()`** — line 18
  - Purpose: Tally's $$Date literal expects DD-MM-YYYY.
- **`resolveDateBound()`** — line 25
  - Purpose: (no comment in code — see name and calls below)
- **`getCompanyInfo()`** _(async)_ — line 61
  - Purpose: Fixed during QA (2026-09-17→18): the previous version of this function used a Report -> Form -> Part -> Line -> Field TDL chain that was never bound to any Collection, so Tally had no object to iterate and this always returned an empty {} regardless of what was open - it could never actually confirm a company, let alone expose a GUID. This uses "Type": "Company" as a real TDL Collection instead, which Tally resolv...
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
  - Purpose: GET VOUCHER TYPE MASTERS (for generic Sales/Purchase classification)   Confirmed live against TallyPrime: "Type": "VoucherType" is a flat master collection - every voucher type in the company, each carrying its own "parent" (one level up) plus Tally's own ambient metadata.reservedname (returned automatically, without needing to ask for it via Native Method). reservedname is a permanent internal system-class tag th...
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getStockItemMasters()`** _(async)_ — line 297
  - Purpose: GET STOCK ITEM MASTERS (Stock Item -> Stock Group)   Confirmed live against this project's own connected TallyPrime instance (WE FOUR, 2026-09): "Type": "StockItem" is a flat master collection, exactly like "Type": "VoucherType" above - every Stock Item in the company, each carrying its own $Parent (the Stock Group it belongs to) and $Guid. Live result: 2,696 Stock Items returned, 100% with a non-empty Parent, 100...
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`isSafeStockGroupNameForFormula()`** — line 379
  - Purpose: The group name is placed inside a TDL formula string, so a name that could break out of it is refused (the caller reports the group as skipped; its items keep whatever GST data they already had).
- **`getStockItemGstMasters()`** _(async)_ — line 383
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isSafeStockGroupNameForFormula()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`postMasterCollection()`** _(async)_ — line 475
  - Purpose: GET LEDGER / GROUP MASTERS   Flat master collections, the same shape as "Type": "StockItem" above. Confirmed live (read-only diagnostic, WE FOUR, 2026-09): 1,979 ledgers in 0.46 s and 70 groups in 30 ms, every record carrying a "<companyGuid>-<hex>" Guid. Minimal field sets only - no GSTIN, no balances. Masters only: no voucher data is requested.
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getLedgerMasters()`** _(async)_ — line 504
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `postMasterCollection()`
- **`getGroupMasters()`** _(async)_ — line 520
  - Purpose: Groups carry metadata.reservedname ("Sundry Debtors", ...), which is what the ledger party role is derived from - never the user-editable name.
  - Calls in this file: `postMasterCollection()`
- **`getSalesVouchers()`** _(async)_ — line 546
  - Purpose: `voucherTypeNames` must be pre-resolved by voucherTypeClassifier.js - same generic classification the incremental sync worker and reconciliation use, not a hardcoded literal. Replaces the old "Child Of": "$$VchTypeSales" attribute (confirmed live to only match vouchers named exactly "Sales") with a single explicit AND/OR formula combining the date range with every resolved type name - same pattern as getSalesVouch...
  - Calls in this file: `requireVoucherTypeNames()`, `resolveDateBound()`, `formatTallyDate()`, `buildVoucherTypeNameFilterClause()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getSalesVouchersSinceAlterId()`** _(async)_ — line 690
  - Purpose: GET SALES VOUCHERS SINCE ALTERID (incremental sync)   Unlike getSalesVouchers (date-range based, used by the manual /tally-live endpoint), this filters on Tally's $AlterID — a per-object counter that increases on every create AND modify, regardless of the voucher's own date. That's what makes it a correct incremental feed: editing a months-old voucher still surfaces here even though its $Date never changes. Confir...
  - Calls in this file: `requireVoucherTypeNames()`, `buildAlterIdRangeClause()`, `buildVoucherTypeNameFilterClause()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getPurchaseVouchersSinceAlterId()`** _(async)_ — line 787
  - Purpose: GET PURCHASE VOUCHERS SINCE ALTERID (incremental sync)   Mirrors getSalesVouchersSinceAlterId exactly, with the Purchase-class voucherTypeNames set instead - see that function's comment for the full rationale. Kept as its own self-contained function (not a shared builder with the Sales version) to match this file's existing style.
  - Calls in this file: `requireVoucherTypeNames()`, `buildAlterIdRangeClause()`, `buildVoucherTypeNameFilterClause()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getAdjustmentNoteVouchersSinceAlterId()`** _(async)_ — line 888
  - Purpose: GET ADJUSTMENT NOTE VOUCHERS SINCE ALTERID (incremental sync)   Credit Note / Debit Note. Same shape as getSalesVouchersSinceAlterId, with two additions to the Native Method field list, proven live in the CN/DN diagnostic (docs/../generic-tumbling-magpie.md): inventoryentries' accountingallocations (which ledger an item's amount is booked to - what adjustmentNoteClassifier.js needs) and ledgerentries' billallocati...
  - Calls in this file: `requireVoucherTypeNames()`, `buildAlterIdRangeClause()`, `buildVoucherTypeNameFilterClause()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getPendingVoucherAlterIds()`** _(async)_ — line 990
  - Purpose: GET PENDING ALTERIDS (batch planning for incremental sync)   Light probe used by the sync worker to size a batch BEFORE fetching full vouchers: same filter as the incremental fetch, but only VoucherTypeName + AlterID are requested - no inventoryentries/ledgerentries walk, which is what makes a full fetch of thousands of vouchers exceed the 30s timeout. Works for any voucher class (the caller passes that class's re...
  - Calls in this file: `requireVoucherTypeNames()`, `buildAlterIdRangeClause()`, `buildVoucherTypeNameFilterClause()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`getVouchersByAlterIds()`** _(async)_ — line 1089
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `requireVoucherTypeNames()`, `buildVoucherTypeNameFilterClause()`
  - Calls other files: `src/services/odbc/tallyUrl.js → resolveTallyUrl()`
- **`buildAllGuidsRequestBody()`** — line 1218
  - Purpose: GET ALL SALES / PURCHASE VOUCHER GUIDS (reconciliation)   Lightest possible query for the reconciliation safety-net: no AlterID filter (deliberately - a deleted voucher never shows up regardless of AlterID, confirmed against a live TallyPrime instance, so filtering by AlterID here would defeat the purpose), and "Guid" is the only field explicitly requested in Native Method. Confirmed live that Tally still returns...
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
**Used by:** `src/models/company.js`, `src/services/odbc/odbcService.js`

**Tested by:** `verify-security-audit.js`

**Imports:** (none)

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
**Used by:** `src/services/sync/adjustmentNotePersistence.js`, `src/services/sync/tallySyncWorker.js`

**Tested by:** `verify-adjustment-note.js`

**Imports:** `src/models/ledgerMaster.model.js`, `src/models/adjustmentNote.model.js`

**Exports:** `classifyAdjustmentNote`, `resolveAccountRoles`, `reclassifyAdjustmentNotes`, `NOTE_ROLE`, `NOTE_CLASSIFICATION`

- **`classifyAdjustmentNote()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`resolveAccountRoles()`** _(async)_ — line 56
  - Purpose: One bounded, tenant-scoped, indexed lookup ({tenantId, name} index) per distinct ledger name a batch of notes actually references - never a full LedgerMaster scan, and never a Tally call (LedgerMaster is sync-time data). Ambiguous (same-name) ledgers resolve to "other" (never guessed), same fail-closed posture as ledgerMaster.js's own new-party resolution.
  - Calls other files: `src/models/ledgerMaster.model.js → find()`
- **`reclassifyAdjustmentNotes()`** _(async)_ — line 89
  - Purpose: A note is classified when it is STORED, from the Ledger master's account roles. Notes stored while the Ledger master was empty (or before a ledger existed in it) all became "value_adjustment", so returns read zero. Once the master has the roles, this re-reads the stored lines (accountingAllocationLedger) and UPGRADES those notes with the same rule as classifyAdjustmentNote. No Tally call. Upgrade only, on purpose:...
  - Calls in this file: `resolveAccountRoles()`, `classifyAdjustmentNote()`
  - Calls other files: `src/models/adjustmentNote.model.js → find()`, `src/models/adjustmentNote.model.js → bulkWrite()`

## `src/services/tally/companyOwnership.js`
**Used by:** `src/services/auth/tallyCompanyGuard.js`, `src/services/import/tallySalesImport.js`, `src/services/sync/reconciliation.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/tally/ledgerMaster.js`, `src/services/tally/stockItemGst.js`, `src/services/tally/stockItemMaster.js`, `src/services/tally/voucherTypeClassifier.js`

**Tested by:** `verify-company-ownership.js`, `verify-stock-item-master.js`

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
  - Purpose: Validate a batch of Tally items (vouchers, registry rows, ...) against the tenant's company GUID.
  - Calls in this file: `guidText()`, `classifyGuid()`, `shortGuid()`
- **`assertBatchOwnership()`** — line 136
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `validateBatchOwnership()`, `logMismatch()`
- **`logMismatch()`** — line 149
  - Purpose: One line, counts and truncated prefixes only - enough to diagnose, nothing about the vouchers themselves.
  - Calls in this file: `shortGuid()`
- **`validateMasterOwnership()`** — line 167
  - Purpose: Voucher-type MASTERS (and other master data) also follow Tally's selected company. Requested with the Guid method, each master carries "<companyGuid>-<masterId>" too (confirmed live: 39 of 39). A response is accepted only if NO record carries another company's GUID and at least one record positively carries this company's. Records with no GUID at all are tolerated individually (some built-in masters may lack one)...
  - Calls in this file: `guidText()`, `classifyGuid()`, `shortGuid()`

## `src/services/tally/ledgerMaster.js`
**Used by:** `src/services/sync/tallySyncWorker.js`

**Tested by:** `refresh-ledger-master.js`, `verify-ledger-master.js`

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
  - Calls in this file: `collectionOf()`, `text()`
- **`parseLedgerMasterList()`** — line 55
  - Purpose: [{name, parent, guid, alterId, masterId, createdDate}] - every ledger with a name.
  - Calls in this file: `collectionOf()`, `text()`, `num()`
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
  - Purpose: Fetch this tenant's Ledger (and Group) masters from Tally, verify company ownership of BOTH lists, and only then upsert into LedgerMaster.
  - Calls in this file: `buildFailureResult()`, `parsePayload()`, `parseGroupMasterList()`, `parseLedgerMasterList()`, `derivePartyRole()`, `deriveAccountRole()`
  - Calls other files: `src/services/tally/companyOwnership.js → validateMasterOwnership()`, `src/models/ledgerMaster.model.js → find()`, `src/models/ledgerMaster.model.js → updateOne()`, `src/models/ledgerMaster.model.js → bulkWrite()`, `src/models/ledgerMaster.model.js → updateMany()`

## `src/services/tally/stockItemGst.js`
**Used by:** `src/services/tally/stockItemMaster.js`

**Tested by:** `verify-stock-item-gst.js`

**Imports:** `src/models/stockItemMaster.model.js`, `src/services/parser/gstFields.js`, `src/services/tally/companyOwnership.js`, `src/services/odbc/odbcService.js`

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
- **`mergeGst()`** — line 91
  - Purpose: Combine the stored `gst` of an item with what Tally just returned. Per section: absent Tally did not return that part -> keep stored empty returned but empty -> keep stored if it had content (never erase), else store the empty hollow entries present but without substance -> keep stored if it had substance (rate rows / HSN codes) invalid has a malformed value -> keep stored if it was clean; otherwise store it with...
  - Calls in this file: `hasContent()`, `substance()`, `capIssues()`, `hashContent()`
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
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `newSummary()`, `note()`, `parseGstResponse()`, `mergeGst()`, `validateGstBlock()`
  - Calls other files: `src/services/odbc/odbcService.js → isSafeStockGroupNameForFormula()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`, `src/models/stockItemMaster.model.js → find()`, `src/models/stockItemMaster.model.js → bulkWrite()`

## `src/services/tally/stockItemMaster.js`
**Used by:** `src/services/sync/tallySyncWorker.js`

**Tested by:** `refresh-stock-item-master.js`, `verify-query-cache.js`, `verify-stock-item-gst.js`, `verify-stock-item-master.js`

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
- **`refreshStockItemMasters()`** _(async)_ — line 84
  - Purpose: Fetch this tenant's Stock Item masters from Tally, verify company ownership, and (only if verification passes) upsert them into StockItemMaster. Fails closed: any fetch/parse/ownership problem leaves whatever StockItemMaster data already exists completely untouched - never partially written, never cleared, never guessed.
  - Calls in this file: `buildFailureResult()`, `parseStockItemMasterList()`, `findUnusableStockItemEntries()`
  - Calls other files: `src/services/tally/voucherTypeClassifier.js → parseVoucherTypeMasterList()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`, `src/models/stockItemMaster.model.js → find()`, `src/models/stockItemMaster.model.js → bulkWrite()`, `src/services/tally/stockItemGst.js → refreshStockItemGst()`

## `src/services/tally/voucherTypeClassifier.js`
**Used by:** `src/controllers/odbcController.js`, `src/services/import/tallySalesImport.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`, `src/services/tally/stockItemMaster.js`

**Tested by:** `verify-adjustment-note.js`, `verify-company-identity.js`, `verify-company-ownership.js`, `verify-query-cache.js`, `verify-reconciliation-history.js`, `verify-reconciliation-perf-and-failure.js`, `verify-sales-sync-worker.js`, `verify-security-audit.js` (+4 more)

**Imports:** `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/tally/companyOwnership.js`

**Exports:** `classifyVoucherTypes`, `parseVoucherTypeMasterList`, `resolveVoucherTypeClassification`, `clearVoucherTypeClassificationCache`, `DEFAULT_CACHE_TTL_MS`, `RESERVED_SALES`, `RESERVED_PURCHASE`, `RESERVED_CREDIT_NOTE`, `RESERVED_DEBIT_NOTE`

- **`safeString()`** — line 49
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`
- **`parseVoucherTypeMasterList()`** — line 58
  - Purpose: Extracts {name, parent, reservedName} for every voucher type Tally's "Type": "VoucherType" collection returns. Real identities only, straight off Tally's own response - never invents a value when one is missing.
  - Calls in this file: `safeString()`
- **`classifyVoucherTypes()`** — line 88
  - Purpose: Pure, synchronous core algorithm - no I/O, fully unit-testable. voucherTypeMasters: [{name, parent, reservedName}] Returns: { sales: { status: "ok" | "needs_configuration", typeNames, rootName, reason }, purchase: { status: "ok" | "needs_configuration", typeNames, rootName, reason }, totalVoucherTypes: number, unresolvedTypeNames: string[] - types whose own parent chain is broken/cyclic; excluded from both sets, n...
- **`buildFetchFailureResult()`** — line 252
  - Purpose: (no comment in code — see name and calls below)
- **`cacheKeyFor()`** — line 286
  - Purpose: (no comment in code — see name and calls below)
- **`resolveVoucherTypeClassification()`** _(async)_ — line 295
  - Purpose: Fail-closed by construction: any fetch/parse error, or a company whose Sales/Purchase root can't be uniquely resolved, comes back as a non-"ok" status - it is never translated into a fallback to the old $$VchTypeSales/$$VchTypePurchase behavior by this function or its callers.
  - Calls in this file: `buildFetchFailureResult()`, `cacheKeyFor()`, `parseVoucherTypeMasterList()`, `classifyVoucherTypes()`
  - Calls other files: `src/services/odbc/odbcService.js → getVoucherTypeMasters()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`
- **`clearVoucherTypeClassificationCache()`** — line 375
  - Purpose: (no comment in code — see name and calls below)


# 8. Parser

## `src/services/parser/adjustmentNoteParser.js`
**Used by:** `src/services/sync/adjustmentNotePersistence.js`

**Tested by:** `verify-adjustment-note.js`

**Imports:** `src/services/parser/tallyParser.js`

**Exports:** `parseAdjustmentNoteVoucher`

- **`findInventoryEntries()`** — line 31
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → findCollectionByKeywords()`
- **`findLedgerEntries()`** — line 39
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → findCollectionByKeywords()`
- **`parseAccountingAllocations()`** — line 53
  - Purpose: The single ledger an inventory line's amount is booked against. A line can in principle carry more than one accounting allocation (a split); the diagnostic's 15 sampled real vouchers never showed this, but if Tally ever returns more than one, the line is treated as having NO single resolvable ledger (classification below falls back to value_adjustment rather than guessing which allocation is authoritative).
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`, `src/services/parser/tallyParser.js → safeString()`, `src/services/parser/tallyParser.js → parseAmount()`
- **`parseBillAllocations()`** — line 65
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/parser/tallyParser.js → unwrapJsonExValue()`, `src/services/parser/tallyParser.js → safeString()`, `src/services/parser/tallyParser.js → parseAmount()`
- **`parseAdjustmentNoteVoucher()`** — line 78
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `findInventoryEntries()`, `parseAccountingAllocations()`, `findLedgerEntries()`, `parseBillAllocations()`
  - Calls other files: `src/services/parser/tallyParser.js → parseQuantity()`, `src/services/parser/tallyParser.js → parseRate()`, `src/services/parser/tallyParser.js → parseAmount()`, `src/services/parser/tallyParser.js → safeString()`, `src/services/parser/tallyParser.js → parseTallyBoolean()`, `src/services/parser/tallyParser.js → computePartyLedgerTotal()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/parser/tallyParser.js → parseTallyDate()`

## `src/services/parser/gstFields.js`
**Used by:** `src/services/parser/tallyParser.js`, `src/services/tally/stockItemGst.js`

**Tested by:** `verify-stock-item-gst.js`, `verify-voucher-line-details.js`

**Imports:** (none)

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
  - Calls in this file: `unwrap()`, `isPresent()`, `stripControl()`
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
  - Calls in this file: `objectRows()`, `cleanText()`, `pick()`, `numericField()`, `keyOf()`
- **`finaliseTimeline()`** — line 202
  - Purpose: Sort ascending by applicableFrom (undated last, original order kept for ties) and derive each entry's last effective day from the next LATER entry. The last dated entry stays open-ended.
- **`parseHsnEntries()`** — line 226
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `objectRows()`, `dayField()`, `pick()`, `cleanText()`, `finaliseTimeline()`
- **`parseGstDetailEntries()`** — line 245
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `objectRows()`, `dayField()`, `pick()`, `cleanText()`, `numericField()`, `booleanField()`, `parseRateRows()`, `keyOf()`, `finaliseTimeline()`
- **`parseStockItemGstRecord()`** — line 286
  - Purpose: One Stock Item record from the StockItem collection -> the GST view of it. applicability / hsn / details are null when Tally did not return that part at all (absent), which is different from a part that is present but empty.
  - Calls in this file: `makeContext()`, `cleanText()`, `pick()`, `keyOf()`, `isPresent()`, `parseHsnEntries()`, `parseGstDetailEntries()`
- **`parseLineTaxAmounts()`** — line 337
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `numericField()`, `pick()`
- **`parseVoucherLineGst()`** — line 350
  - Purpose: What the voucher line itself carried. Returns null when the line has no GST fields at all (so old-shaped vouchers map to exactly what they did before).
  - Calls in this file: `makeContext()`, `cleanText()`, `pick()`, `isPresent()`, `parseRateRows()`, `parseLineTaxAmounts()`, `keyOf()`
- **`toUtcDay()`** — line 390
  - Purpose: (no comment in code — see name and calls below)
- **`resolveGstAsOf()`** — line 398
  - Purpose: The dated entries in effect on a given day: the latest entry whose applicableFrom is on or before it. Undated entries are never chosen. Returns null parts when nothing was in effect.
  - Calls in this file: `toUtcDay()`

## `src/services/parser/tallyParser.js`
**Used by:** `src/services/auth/tallyCompanyGuard.js`, `src/services/parser/adjustmentNoteParser.js`, `src/services/sync/reconciliation.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherPersistence.js`, `src/services/sync/voucherRecovery.js`, `src/services/tally/companyOwnership.js`, `src/services/tally/ledgerMaster.js`, `src/services/tally/voucherTypeClassifier.js`

**Tested by:** `migrate-voucher-total-amount.js`, `verify-analysis-plan.js`, `verify-analysis-planner.js`, `verify-ask-ai-basic-questions.js`, `verify-company-guid-match.js`, `verify-insight-tools.js`, `verify-insights.js`, `verify-purchase-mapper.js` (+8 more)

**Imports:** `src/services/parser/gstFields.js`

**Exports:** `parseTallyVoucher`, `deriveDiscountAmount`, `extractOpenCompanies`, `parseTallyDate`, `parseQuantity`, `parseRate`, `parseAmount`, `parseTallyId`, `parseTallyBoolean`, `unwrapJsonExValue`, `computePartyLedgerTotal`, `safeString`, `findCollectionByKeywords`, `parseDiscountPercentage`

- **`isObject()`** — line 3
  - Purpose: (no comment in code — see name and calls below)
- **`unwrapJsonExValue()`** — line 13
  - Purpose: Tally JSONEx sometimes wraps a field's real value instead of sending a plain primitive, e.g. { value: "...", taxtype: "GST" } or the [ { metadata: true, type: "String" }, "actual value" ] pair pattern used for UDF/list fields. Unwrap those shapes down to the underlying scalar before any parsing runs, so a field being wrapped never silently breaks downstream parsing.
  - Calls in this file: `isObject()`
- **`safeString()`** — line 36
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unwrapJsonExValue()`
- **`normalizeLedgerEntryType()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `safeString()`
- **`computePartyLedgerTotal()`** — line 65
  - Purpose: The true voucher/invoice total: the absolute amount of the ledger entry(ies) whose ledgerName exactly matches partyName (a balanced voucher's party ledger line IS the full total - see the call site's comment for the audit evidence). Returns null (never a fabricated 0 or silently-wrong number) when no ledger entry matches, so the caller can apply its own defensive fallback for that edge case. Multiple entries under...
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
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `round2()`
- **`parseTallyVoucher()`** — line 286
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isObject()`, `findCollectionByKeywords()`, `parseQuantity()`, `parseRate()`, `parseAmount()`, `parseDiscountPercentage()`, `deriveDiscountAmount()`, `safeString()`, `normalizeLedgerEntryType()`, `computePartyLedgerTotal()`, `parseTallyId()`, `parseTallyBoolean()`, `parseTallyDate()`
  - Calls other files: `src/services/parser/gstFields.js → parseVoucherLineGst()`
- **`extractOpenCompanies()`** — line 435
  - Purpose: Extracts {name, guid} for every company object Tally's "Type": "Company" collection currently reports (odbcService.getCompanyInfo's raw response shape: {status, data:{collection:[{name:{value},guid:{value},...}]}}). Real identities only, straight off Tally's own response - never invents or approximates a guid when one isn't present.
  - Calls in this file: `safeString()`


# 9. Mapper

## `src/services/mapper/adjustmentNoteMapper.js`
**Used by:** `src/services/sync/adjustmentNotePersistence.js`

**Tested by:** `verify-adjustment-note.js`

**Imports:** (none)

**Exports:** `mapAdjustmentNote`

- **`ensureObject()`** — line 1
  - Purpose: (no comment in code — see name and calls below)
- **`mapAdjustmentNote()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `ensureObject()`

## `src/services/mapper/purchaseMapper.js`
**Used by:** `src/services/import/tallyPurchaseImport.js`

**Tested by:** `verify-insights.js`, `verify-purchase-mapper.js`, `verify-stock-item-gst.js`, `verify-voucher-line-details.js`

**Imports:** (none)

**Exports:** `mapTallyPurchase`, `normalizeVoucherType`

- **`ensureObject()`** — line 9
  - Purpose: (no comment in code — see name and calls below)
- **`toNumber()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeVoucherType()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`mapTallyPurchase()`** — line 27
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `ensureObject()`, `normalizeVoucherType()`, `toNumber()`

## `src/services/mapper/salesMapper.js`
**Used by:** `src/services/import/tallySalesImport.js`

**Tested by:** `verify-insights.js`, `verify-sales-mapper.js`, `verify-stock-item-gst.js`, `verify-voucher-line-details.js`

**Imports:** (none)

**Exports:** `mapTallySale`, `normalizeVoucherType`

- **`ensureObject()`** — line 1
  - Purpose: (no comment in code — see name and calls below)
- **`toNumber()`** — line 8
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeVoucherType()`** — line 14
  - Purpose: (no comment in code — see name and calls below)
- **`mapTallySale()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `ensureObject()`, `normalizeVoucherType()`, `toNumber()`


# 10. Sync / reconciliation / recovery

## `src/services/sync/adjustmentNotePersistence.js`
**Used by:** `src/services/sync/tallySyncWorker.js`

**Tested by:** `verify-adjustment-note.js`

**Imports:** `src/services/parser/adjustmentNoteParser.js`, `src/services/mapper/adjustmentNoteMapper.js`, `src/services/tally/adjustmentNoteClassifier.js`, `src/models/adjustmentNote.model.js`

**Exports:** `createAdjustmentNotePersistence`

- **`createAdjustmentNotePersistence()`** — line 22
  - Purpose: Credit Note / Debit Note persistence. Mirrors voucherPersistence.js's createVoucherPersistence (identity by {tenantId, tallyGuid}, AlterID idempotency, cancel/delete tombstone handling, ambiguous-voucherNo guard) as a SEPARATE, self-contained implementation rather than a shared abstraction - see PROJECT_CONTEXT.md's "smallest safe change" convention. The one real difference: classification needs an async LedgerMas...
  - Calls other files: `src/models/adjustmentNote.model.js → find()`, `src/models/adjustmentNote.model.js → findOneAndUpdate()`, `src/services/parser/adjustmentNoteParser.js → parseAdjustmentNoteVoucher()`, `src/services/tally/adjustmentNoteClassifier.js → resolveAccountRoles()`, `src/services/tally/adjustmentNoteClassifier.js → classifyAdjustmentNote()`, `src/services/mapper/adjustmentNoteMapper.js → mapAdjustmentNote()`, `src/models/adjustmentNote.model.js → findOne()`

## `src/services/sync/batchWindow.js`
**Used by:** `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`

**Tested by:** `verify-sync-batching.js`

**Imports:** (none)

**Exports:** `DEFAULT_BATCH_SIZE`, `resolveBatchSize`, `computeBatchWindow`, `findMissingAlterIds`

- **`resolveBatchSize()`** — line 22
  - Purpose: Positive integer from the given value, else the default. Invalid or missing config must never disable bounding or produce a zero-size batch.
- **`computeBatchWindow()`** — line 35
  - Purpose: alterIds: AlterIDs of every pending voucher (any order). Returns: pending - how many are pending in total bounded - true when the backlog exceeds one batch upToAlterId - inclusive cut-off for this batch when bounded, else null (small backlogs are fetched exactly as before: no cap) batchCount - how many pending vouchers this batch covers
  - Calls in this file: `resolveBatchSize()`
- **`findMissingAlterIds()`** — line 65
  - Purpose: Completeness check for a fetched batch: every AlterID the probe selected for the window must be present in what Tally actually returned. Returned vouchers that were NOT probed are fine (a superset is allowed - e.g. a voucher created after the probe). Any expected AlterID that is missing means the response was partial or the voucher changed between probe and fetch, so the batch must not advance the checkpoint; a re...

## `src/services/sync/reconciliation.js`
**Used by:** `src/services/sync/reconciliationWorker.js`

**Tested by:** `verify-company-ownership.js`, `verify-query-cache.js`, `verify-reconciliation-perf-and-failure.js`, `verify-reconciliation.js`

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
  - Purpose: Run one reconciliation pass for a single {tenantId, voucherType, Model}. Never throws - all outcomes are returned as a result object so callers can log/record without special-casing errors.
  - Calls in this file: `guidSetFromRows()`
  - Calls other files: `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/tally/companyOwnership.js → validateBatchOwnership()`, `src/services/tally/companyOwnership.js → logMismatch()`

## `src/services/sync/reconciliationWorker.js`
**Used by:** `server.js`

**Tested by:** `verify-company-ownership.js`, `verify-reconciliation-history.js`, `verify-reconciliation-perf-and-failure.js`, `verify-reconciliation.js`, `verify-security-audit.js`, `verify-self-heal.js`

**Imports:** `src/models/company.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/reconciliationCheckpoint.model.js`, `src/services/odbc/odbcService.js`, `src/services/sync/reconciliation.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/sync/selfHeal.js`

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
  - Calls in this file: `ensureCheckpointExists()`, `acquireLock()`, `resolveTallyBaseUrl()`, `releaseLock()`, `releaseLockWithoutResult()`
  - Calls other files: `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/sync/reconciliation.js → reconcileVoucherType()`, `src/services/sync/selfHeal.js → maybeSelfHeal()`
- **`runReconciliationForAllCompanies()`** _(async)_ — line 253
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `runReconciliationForCompanyModule()`
  - Calls other files: `src/models/company.js → find()`
- **`buildCronExpression()`** — line 309
  - Purpose: (no comment in code — see name and calls below)
- **`startReconciliationWorker()`** — line 315
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildCronExpression()`, `runReconciliationForAllCompanies()`
- **`stopReconciliationWorker()`** — line 346
  - Purpose: (no comment in code — see name and calls below)

## `src/services/sync/selfHeal.js`
**Used by:** `src/services/sync/reconciliationWorker.js`

**Tested by:** `verify-company-ownership.js`, `verify-self-heal.js`

**Imports:** `src/models/syncCheckpoint.model.js`, `src/services/sync/voucherRecovery.js`

**Exports:** `maybeSelfHeal`, `DEFAULT_CONFIG`

- **`skip()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
- **`maybeSelfHeal()`** _(async)_ — line 74
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `skip()`

## `src/services/sync/tallySyncWorker.js`
**Used by:** `server.js`

**Tested by:** `run-adjustment-note-sync.js`, `verify-adjustment-note.js`, `verify-company-identity.js`, `verify-company-ownership.js`, `verify-sales-sync-worker.js`, `verify-security-audit.js`, `verify-sync-batching.js`, `verify-sync-worker-guard.js` (+2 more)

**Imports:** `src/models/company.js`, `src/models/syncCheckpoint.model.js`, `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/sync/batchWindow.js`, `src/services/import/tallySalesImport.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/sync/adjustmentNotePersistence.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/companyOwnership.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/stockItemMaster.js`, `src/services/tally/ledgerMaster.js`, `src/services/tally/adjustmentNoteClassifier.js`

**Exports:** `startTallySyncWorker`, `stopTallySyncWorker`, `runSyncForAllCompanies`, `runSyncForCompanyModule`, `runMasterRefreshForCompany`, `resolveMasterRefreshMs`, `SALES_SYNC_MODULE`, `PURCHASE_SYNC_MODULE`, `CREDIT_NOTE_SYNC_MODULE`, `DEBIT_NOTE_SYNC_MODULE`

- **`resolveMasterRefreshMs()`** — line 142
  - Purpose: (no comment in code — see name and calls below)
- **`resolveTallyBaseUrl()`** — line 156
  - Purpose: (no comment in code — see name and calls below)
- **`ensureCheckpointExists()`** _(async)_ — line 166
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/syncCheckpoint.model.js → findOneAndUpdate()`
- **`acquireLock()`** _(async)_ — line 187
  - Purpose: Atomically acquire the per-{company, voucher type} lock. Returns the checkpoint doc if acquired, or null if another run currently holds a non-stale lock (in which case this tick simply skips that combination).
  - Calls other files: `src/models/syncCheckpoint.model.js → findOneAndUpdate()`
- **`releaseLock()`** _(async)_ — line 208
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/syncCheckpoint.model.js → findOneAndUpdate()`
- **`runSyncForCompanyModule()`** _(async)_ — line 242
  - Purpose: Runs one incremental sync pass for a single {company, sync module} combination. Never throws — failures are recorded on the checkpoint and returned in the result so the caller can log them and move on.
  - Calls in this file: `ensureCheckpointExists()`, `acquireLock()`, `resolveTallyBaseUrl()`, `releaseLock()`
  - Calls other files: `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/sync/batchWindow.js → computeBatchWindow()`, `src/services/tally/companyOwnership.js → assertBatchOwnership()`, `src/services/sync/batchWindow.js → findMissingAlterIds()`
- **`runMasterRefreshForCompany()`** _(async)_ — line 591
  - Purpose: Refreshes one company's Stock Item and Ledger masters when they are due (see MASTER_REFRESH_MS). Never throws. - The open-company guard runs first (one light read): if another company is open or Tally is unreachable nothing is requested and the refresh stays due, so the next tick looks again. Both refreshes also verify the GUID ownership of everything Tally returns, and fail closed (they write nothing, and never c...
  - Calls in this file: `resolveTallyBaseUrl()`
- **`logMasterRefresh()`** — line 633
  - Purpose: (no comment in code — see name and calls below)
- **`runSyncForAllCompanies()`** _(async)_ — line 658
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `logMasterRefresh()`, `runSyncForCompanyModule()`
  - Calls other files: `src/models/company.js → find()`
- **`buildCronExpression()`** — line 737
  - Purpose: (no comment in code — see name and calls below)
- **`startTallySyncWorker()`** — line 745
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildCronExpression()`, `runSyncForAllCompanies()`
- **`stopTallySyncWorker()`** — line 776
  - Purpose: (no comment in code — see name and calls below)

## `src/services/sync/voucherLineBackfill.js`
**Used by:** (nothing in the app requires it: entry file, or used only by tests)

**Tested by:** `backfill-voucher-line-details.js`, `verify-voucher-line-details.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/odbc/odbcService.js`, `src/services/import/tallySalesImport.js`, `src/services/parser/tallyParser.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`, `src/services/sync/batchWindow.js`, `src/services/analytics/dateRanges.js`

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
- **`backfillVoucherLineDetails()`** _(async)_ — line 124
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `emptyResult()`, `aborted()`, `clampInt()`, `asString()`, `sameLines()`, `buildSet()`
  - Calls other files: `src/services/sync/batchWindow.js → resolveBatchSize()`, `src/services/analytics/dateRanges.js → storedDayStart()`, `src/services/analytics/dateRanges.js → parseCalendarDay()`, `src/services/analytics/dateRanges.js → storedDayEnd()`, `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/tally/companyOwnership.js → validateBatchOwnership()`, `src/services/tally/companyOwnership.js → logMismatch()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/sync/batchWindow.js → findMissingAlterIds()`, `src/services/parser/tallyParser.js → parseTallyVoucher()`
- **`hostOfMongoUri()`** — line 261
  - Purpose: (no comment in code — see name and calls below)
- **`checkWriteTarget()`** — line 269
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `hostOfMongoUri()`

## `src/services/sync/voucherPersistence.js`
**Used by:** `src/services/import/tallyPurchaseImport.js`, `src/services/import/tallySalesImport.js`

**Imports:** `src/services/parser/tallyParser.js`

**Exports:** `createVoucherPersistence`

- **`createVoucherPersistence()`** — line 27
  - Purpose: The one genuinely shared piece of the sync pipeline: parse -> map -> validate -> tenant-safe upsert -> cancel/delete tombstone fallback. Extracted out of the original Sales-only implementation so Sales and Purchase (and any future voucher type) share this logic instead of each carrying their own copy — this is where real correctness bugs (duplicate writes, broken idempotency, a lost audit trail) would bite, so it'...
  - Calls other files: `src/services/parser/tallyParser.js → parseTallyVoucher()`

## `src/services/sync/voucherRecovery.js`
**Used by:** `src/controllers/syncRecoveryController.js`, `src/services/sync/selfHeal.js`

**Tested by:** `verify-company-ownership.js`, `verify-query-cache.js`, `verify-reconciliation-history.js`, `verify-security-audit.js`, `verify-self-heal.js`, `verify-voucher-recovery.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/odbc/odbcService.js`, `src/services/import/tallySalesImport.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/parser/tallyParser.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`, `src/services/sync/batchWindow.js`

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
  - Calls in this file: `emptyResult()`, `aborted()`, `asString()`, `clampInt()`
  - Calls other files: `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/import/tallySalesImport.js → extractVoucherCollection()`, `src/services/parser/tallyParser.js → parseTallyId()`, `src/services/parser/tallyParser.js → parseTallyBoolean()`, `src/services/tally/companyOwnership.js → validateBatchOwnership()`, `src/services/tally/companyOwnership.js → logMismatch()`, `src/services/sync/batchWindow.js → resolveBatchSize()`, `src/services/sync/batchWindow.js → findMissingAlterIds()`


# 11. Manual import

## `src/services/import/tallyPurchaseImport.js`
**Used by:** `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherRecovery.js`

**Tested by:** `verify-analytics-scope.js`, `verify-company-ownership.js`, `verify-query-cache.js`, `verify-reconciliation-history.js`, `verify-security-audit.js`, `verify-self-heal.js`, `verify-sync-batching.js`, `verify-voucher-lifecycle.js` (+1 more)

**Imports:** `src/models/purchase.model.js`, `src/services/mapper/purchaseMapper.js`, `src/services/sync/voucherPersistence.js`, `src/services/import/tallySalesImport.js`

**Exports:** `extractVoucherCollection`, `resolveTenantContext`, `processSinglePurchaseVoucher`


## `src/services/import/tallySalesImport.js`
**Used by:** `src/controllers/importController.js`, `src/controllers/syncRecoveryController.js`, `src/controllers/syncStatusController.js`, `src/services/import/tallyPurchaseImport.js`, `src/services/sync/reconciliation.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`

**Tested by:** `verify-company-guid-match.js`, `verify-reconciliation-history.js`, `verify-reconciliation.js`, `verify-sales-import.js`, `verify-security-audit.js`, `verify-voucher-lifecycle.js`, `verify-voucher-type-classification.js`

**Imports:** `src/models/company.js`, `src/models/sales.model.js`, `src/services/mapper/salesMapper.js`, `src/services/odbc/odbcService.js`, `src/services/sync/voucherPersistence.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/tally/voucherTypeClassifier.js`, `src/services/tally/companyOwnership.js`

**Exports:** `extractVoucherCollection`, `importTallySales`, `importTallySalesFromTally`, `resolveTenantContext`, `processSingleVoucher`

- **`sanitizeJsonText()`** — line 17
  - Purpose: (no comment in code — see name and calls below)
- **`detectJsonEncoding()`** — line 29
  - Purpose: (no comment in code — see name and calls below)
- **`decodeJsonBuffer()`** — line 140
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `detectJsonEncoding()`, `sanitizeJsonText()`
- **`extractVoucherCollection()`** — line 205
  - Purpose: (no comment in code — see name and calls below)
- **`resolveTenantContext()`** _(async)_ — line 316
  - Purpose: Resolve the tenant a Tally import should be scoped to. The tenant is always re-derived from the Company record via the companyGuId carried in the caller's JWT (see auth middleware) — never trusted directly from client input — so an authenticated user can only ever import into their own company's tenant.
  - Calls other files: `src/models/company.js → findOne()`
- **`importParsedVouchers()`** _(async)_ — line 353
  - Purpose: Run the shared parse -> map -> validate -> dedupe -> save pipeline over an array of raw Tally voucher objects, for a single resolved tenant. Used by both the file-upload import and the live Tally import.
- **`importTallySales()`** _(async)_ — line 415
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `resolveTenantContext()`, `decodeJsonBuffer()`, `sanitizeJsonText()`, `extractVoucherCollection()`, `importParsedVouchers()`
- **`importTallySalesFromTally()`** _(async)_ — line 552
  - Purpose: Fetch sales vouchers live from TallyPrime (HTTP JSON) and run them through the same parse -> map -> validate -> dedupe -> save pipeline used by the file-upload import. Tenant is resolved the same way, from the authenticated user's companyGuId - never from client input.
  - Calls in this file: `resolveTenantContext()`, `extractVoucherCollection()`, `importParsedVouchers()`
  - Calls other files: `src/services/auth/tallyCompanyGuard.js → verifyOpenTallyCompany()`, `src/services/tally/voucherTypeClassifier.js → resolveVoucherTypeClassification()`, `src/services/odbc/odbcService.js → getSalesVouchers()`, `src/services/tally/companyOwnership.js → assertBatchOwnership()`


# 12. Company / auth services

## `src/services/auth/companyContext.js`
**Used by:** `src/routes/analyticsRoutes.js`, `src/routes/authRoutes.js`, `src/routes/chatRoutes.js`, `src/routes/importRoutes.js`, `src/routes/odbcRoutes.js`, `src/routes/reportRoutes.js`, `src/routes/syncRoutes.js`, `src/routes/voucherRoutes.js`

**Tested by:** `verify-analytics-scope.js`, `verify-company-identity.js`

**Imports:** `src/middleware/errorHandler.js`, `src/models/company.js`, `src/models/user.model.js`, `src/models/userCompanyAccess.model.js`

**Exports:** `resolveAuthorizedCompany`, `activeCompanyContext`, `liveCompanyContext`

- **`resolveAuthorizedCompany()`** _(async)_ — line 50
  - Purpose: Resolve and authorize the active company context for an authenticated request.
  - Calls other files: `src/models/user.model.js → findById()`, `src/models/userCompanyAccess.model.js → findOne()`, `src/models/company.js → findOne()`
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

**Tested by:** `verify-company-identity.js`

**Imports:** `src/models/company.js`, `src/models/user.model.js`, `src/models/userCompanyAccess.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js`

**Exports:** `ensureCompanyForGuid`

- **`collectCandidateTenantIds()`** _(async)_ — line 46
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/syncCheckpoint.model.js → distinct()`, `src/models/reconciliationCheckpoint.model.js → distinct()`, `src/models/userCompanyAccess.model.js → distinct()`, `src/models/user.model.js → distinct()`, `src/models/company.js → distinct()`
- **`survivingOwnerIds()`** _(async)_ — line 68
  - Purpose: String ids of the users that still exist and belong to this company.
  - Calls other files: `src/models/userCompanyAccess.model.js → distinct()`, `src/models/user.model.js → distinct()`, `src/models/user.model.js → find()`
- **`isAllowed()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
- **`notAuthorized()`** — line 90
  - Purpose: 403 only for a company whose EXACT GUID already has a surviving owner other than the requester. The message names the company Tally reported (it is the company open in the requester's own Tally, so nothing is disclosed): the most common cause of an unexpected 403 is that Tally's SELECTED company is not the one the user meant, and the name makes that visible.
- **`proveOrFail()`** _(async)_ — line 99
  - Purpose: (no comment in code — see name and calls below)
- **`ensureCompanyForGuid()`** _(async)_ — line 136
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `survivingOwnerIds()`, `isAllowed()`, `notAuthorized()`, `proveOrFail()`, `collectCandidateTenantIds()`
  - Calls other files: `src/models/company.js → findOne()`, `src/models/company.js → create()`

## `src/services/auth/tallyCompanyGuard.js`
**Used by:** `src/controllers/authController.js`, `src/controllers/odbcController.js`, `src/services/import/tallySalesImport.js`, `src/services/sync/reconciliationWorker.js`, `src/services/sync/tallySyncWorker.js`, `src/services/sync/voucherLineBackfill.js`, `src/services/sync/voucherRecovery.js`

**Tested by:** `verify-company-guid-match.js`, `verify-company-identity.js`, `verify-security-audit.js`, `verify-sync-worker-guard.js`, `verify-voucher-lifecycle.js`, `verify-voucher-type-classification.js`

**Imports:** `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/tally/companyOwnership.js`

**Exports:** `verifyOpenTallyCompany`, `detectOpenTallyCompany`, `resolveSelectedOpenCompany`

- **`readOpenCompanies()`** _(async)_ — line 14
  - Purpose: Asks Tally directly, live, which companies are open right now. The one place that talks to Tally for company identity; both guards below use it.
  - Calls other files: `src/services/odbc/odbcService.js → getCompanyInfo()`, `src/services/parser/tallyParser.js → extractOpenCompanies()`
- **`verifyOpenTallyCompany()`** _(async)_ — line 45
  - Purpose: Central safety check reused by both "add another company" (verify the requested GUID is the one actually open in Tally before linking it to the account) and the live Sales Sync import (never import vouchers from whatever company happens to be open into the wrong TallyPulse tenant). Always asks Tally directly, live, for whichever company is open right now - never trusts a client-supplied or previously-cached GUID o...
  - Calls in this file: `readOpenCompanies()`
- **`selectedCompanyFromMasters()`** _(async)_ — line 74
  - Purpose: Which of several open companies is the SELECTED one? Tally's company list does not say, but its voucher and master queries answer for the selected company only, and every master carries "<companyGuid>-<id>". So ONE light VoucherType-master query identifies it: the open company whose GUID owns the returned masters. Reuses the same ownership rule as the classifier (validateMasterOwnership: no foreign master, at leas...
  - Calls other files: `src/services/odbc/odbcService.js → getVoucherTypeMasters()`, `src/services/tally/companyOwnership.js → validateMasterOwnership()`
- **`resolveSelectedOpenCompany()`** _(async)_ — line 96
  - Purpose: The company TallyPulse should treat as "the one open in Tally": the only open company, or - when several are open - the one Tally has SELECTED, proven by the voucher-type masters. Anything less certain is an explicit ambiguity. Returns the {ok, reason, openCompanies, match} shape verifyOpenTallyCompany uses (match = the selected company), plus `selectedBy`.
  - Calls in this file: `readOpenCompanies()`, `selectedCompanyFromMasters()`


# 13. Analytics (dashboards, periods)

## `src/services/analytics/analyticsScope.js`
**Used by:** `src/controllers/reportController.js`, `src/services/analytics/insights.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/reportAnalytics.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/compile.js`, `src/services/query/execute.js`

**Tested by:** `verify-analytics-scope.js`, `verify-query-engine.js`, `verify-timezone-boundaries.js`

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
  - Purpose: Build the mandatory MongoDB $match stage for any company-owned analytics query (Sale or Purchase).
  - Calls in this file: `assertTenantId()`, `assertValidStatuses()`, `normalizeDateBound()`

## `src/services/analytics/coverage.js`
**Used by:** `src/services/query/analysisPlan.js`, `src/services/query/answerFormatter.js`, `src/services/query/presentation.js`, `src/services/query/queryChat.js`

**Tested by:** `verify-query-chat.js`, `verify-semantic-foundation.js`, `verify-timezone-boundaries.js`

**Imports:** `src/services/analytics/dateRanges.js`

**Exports:** `classifyRange`, `assessCoverage`, `fmtDay`, `rangeText`

- **`fmtDay()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`rangeText()`** — line 17
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fmtDay()`
- **`classifyRange()`** — line 27
  - Purpose: Where [from, to] lies relative to the synced window.
  - Calls other files: `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → endOfDay()`
- **`assessCoverage()`** — line 52
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `classifyRange()`, `fmtDay()`, `rangeText()`

## `src/services/analytics/dateRanges.js`
**Used by:** `src/controllers/analyticsController.js`, `src/controllers/reportController.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/coverage.js`, `src/services/analytics/insightTools.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/referenceDate.js`, `src/services/query/execute.js`, `src/services/query/validator.js`, `src/services/sync/voucherLineBackfill.js`

**Tested by:** `verify-analytics-scope.js`, `verify-comparison-period-capability.js`, `verify-dashboard-real-data.js`, `verify-growth-comparison-capability.js`, `verify-insight-tools.js`, `verify-month-boundary-dates.js`, `verify-period-engine.js`, `verify-query-parity.js` (+6 more)

**Imports:** (none)

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
  - Calls in this file: `shiftYears()`, `shiftMonths()`, `endOfMonth()`
- **`currentMonthToDate()`** — line 97
  - Purpose: Current month, month-to-date: [1st of this month, now]. Explicitly partial unless `now` happens to be the last instant of the month.
  - Calls in this file: `startOfMonth()`, `endOfMonth()`
- **`previousFullMonth()`** — line 121
  - Purpose: The full previous calendar month: [1st, last day 23:59:59.999]. Always complete (a "previous" month, by definition, has already ended).
  - Calls in this file: `shiftMonths()`, `startOfMonth()`, `endOfMonth()`
- **`previousMonthSameRange()`** — line 137
  - Purpose: The SAME day-range in the previous month as currentMonthToDate() - i.e. if today is the 16th, this is [1st, 16th] of last month. This is the correct comparison base for "how much did sales grow vs last month" - comparing MTD to MTD, not MTD to a full month.
  - Calls in this file: `currentMonthToDate()`, `shiftPeriod()`
- **`sameMonthLastYearToDate()`** — line 152
  - Purpose: The same month-to-date window, one year earlier. E.g. if today is 16 Sep 2026, this is [1 Sep 2025, 16 Sep 2025].
  - Calls in this file: `currentMonthToDate()`, `shiftPeriod()`
- **`lastNMonthsEnding()`** — line 169
  - Purpose: The last N complete calendar months ending in referenceDate's month (inclusive) - e.g. n=6 with referenceDate in December returns [1 Jul, 31 Dec]. Used as the default window for trend charts when the caller hasn't picked an explicit range.
  - Calls in this file: `endOfMonth()`, `startOfMonth()`, `shiftMonths()`
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
  - Calls in this file: `startOfDay()`, `parseCalendarDay()`, `endOfDay()`
- **`hasDate()`** — line 237
  - Purpose: REST request periods What `period=current_month|previous_month|custom` and `comparisonType=vs_previous_month|vs_same_month_last_year` mean for the REST analytics and report endpoints (analyticsController, reportController). Relative periods are anchored to the tenant's reference date: there is no wall-clock default.
- **`resolveRequestPeriod()`** — line 239
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customRange()`, `hasDate()`, `previousFullMonth()`, `currentMonthToDate()`
- **`resolveRequestComparison()`** — line 248
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `hasDate()`, `currentMonthToDate()`, `sameMonthLastYearToDate()`, `previousMonthSameRange()`

## `src/services/analytics/freshness.js`
**Used by:** `src/controllers/syncStatusController.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/trustEnvelope.js`, `src/services/query/analysisPlan.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-findings-real.js`, `verify-sync-success-time.js`

**Imports:** `src/models/syncCheckpoint.model.js`

**Exports:** `getFreshness`, `successTimeOf`, `DEFAULT_FRESHNESS_THRESHOLD_MINUTES`

- **`successTimeOf()`** — line 27
  - Purpose: When the last SUCCESSFUL sync happened, or null when it is not known. lastSuccessAt, else - for a checkpoint written before that field existed - lastSyncedAt unless the last run failed (then lastSyncedAt is only the time of the failed attempt).
- **`getFreshness()`** _(async)_ — line 33
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `successTimeOf()`
  - Calls other files: `src/models/syncCheckpoint.model.js → findOne()`

## `src/services/analytics/insightTools.js`
**Used by:** `src/services/query/analysisPlan.js`, `src/services/query/analysisPlanner.js`, `src/services/query/queryChat.js`

**Tested by:** `verify-analysis-plan.js`, `verify-insight-tools.js`, `verify-insights.js`

**Imports:** `src/services/analytics/insights.js`, `src/services/analytics/dateRanges.js`, `src/services/analytics/referenceDate.js`, `src/services/query/entityResolver.js`

**Exports:** `runInsightTool`, `listInsightTools`, `insightToolArgsJsonSchemas`, `validateInsightArgs`, `insightToolVoucherTypes`, `resolveInsightPeriod`, `DEFAULT_MAX_TIME_MS`, `MAX_RANGE_DAYS`, `MAX_LIMIT`

- **`plural()`** — line 45
  - Purpose: Notes computed from the returned data (never from the question): what a reader must know about THESE figures.
- **`fmtAmount()`** — line 46
  - Purpose: (no comment in code — see name and calls below)
- **`unitNote()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `plural()`
- **`discountNotes()`** — line 51
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `plural()`, `fmtAmount()`
- **`uncertainNotes()`** — line 63
  - Purpose: lines left out of the average rates because their billed quantity is not known (insights PRICED_STAGES)
  - Calls in this file: `plural()`, `fmtAmount()`
- **`marginNotes()`** — line 69
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `plural()`, `uncertainNotes()`, `unitNote()`
- **`fail()`** — line 147
  - Purpose: (no comment in code — see name and calls below)
- **`dayString()`** — line 148
  - Purpose: (no comment in code — see name and calls below)
- **`listInsightTools()`** — line 150
  - Purpose: (no comment in code — see name and calls below)
- **`resolvePeriod()`** _(async)_ — line 154
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `dayString()`
  - Calls other files: `src/services/analytics/dateRanges.js → customRange()`, `src/services/analytics/dateRanges.js → resolveRequestPeriod()`
- **`resolveProduct()`** _(async)_ — line 171
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/entityResolver.js → createEntityResolver()`
- **`runInsightTool()`** _(async)_ — line 198
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fail()`, `resolvePeriod()`, `resolveProduct()`, `dayString()`
- **`insightToolArgsJsonSchemas()`** — line 256
  - Purpose: Each ready tool's argument schema as JSON Schema (input form, so defaulted fields are optional), from the same zod schemas.
- **`resolveInsightPeriod()`** _(async)_ — line 271
  - Purpose: The period a tool would read, resolved exactly as runInsightTool resolves it (no aggregation), so a caller can refuse a period outside the synced history BEFORE paying for the tool. null when the tool or its arguments are not valid (the tool itself then refuses them).
  - Calls in this file: `resolvePeriod()`
- **`insightToolVoucherTypes()`** — line 280
  - Purpose: The voucher types a tool reads (for the freshness gate), from its validated arguments; an unknown tool reads none.
- **`validateInsightArgs()`** — line 287
  - Purpose: Schema check of a tool's arguments without running it (no database): the same strict schema runInsightTool uses.

## `src/services/analytics/insights.js`
**Used by:** `src/controllers/analyticsController.js`, `src/services/analytics/insightTools.js`

**Tested by:** `verify-analysis-planner.js`, `verify-insight-tools.js`, `verify-insights.js`, `verify-query-parity-synthetic.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/analytics/analyticsScope.js`

**Exports:** `discountSummary`, `ratesByProduct`, `productMargin`, `productTrend`, `supplierRates`, `MAX_GROUP_ROWS`, `DISCOUNT_NOTE`, `RATE_NOTE`, `MARGIN_NOTE`, `TREND_NOTE`, `SUPPLIER_MARGIN_NOTE`

- **`round2()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
- **`daysBefore()`** — line 58
  - Purpose: Calendar-day arithmetic on the local-midnight Dates the period engine produces (buildVoucherMatchStage reads the local day).
- **`clampLimit()`** — line 59
  - Purpose: (no comment in code — see name and calls below)
- **`escapeRegex()`** — line 63
  - Purpose: (no comment in code — see name and calls below)
- **`modelFor()`** — line 64
  - Purpose: (no comment in code — see name and calls below)
- **`isTimeout()`** — line 73
  - Purpose: The same test as services/query/execute.js isTimeout: MongoDB code 50 (MaxTimeMSExpired) or its message.
- **`readMaxTimeMS()`** — line 75
  - Purpose: (no comment in code — see name and calls below)
- **`aggregate()`** — line 84
  - Purpose: Every aggregation in this file goes through here: the optional time limit, and a timeout turned into "query_timeout".
  - Calls in this file: `isTimeout()`
- **`capRows()`** — line 92
  - Purpose: (no comment in code — see name and calls below)
- **`tolerance()`** — line 109
  - Purpose: one quantity basis per item line (after $unwind of inventory) The stored `quantity` is Tally's ACTUAL quantity: free goods included ("10 + 2 free" is stored as 12). The billed quantity is not stored. What the parser stores instead is the discount it could VERIFY (tallyParser deriveDiscountAmount): billed quantity x rate - net amount, accepted only when it agrees with the percentage Tally states (else 0). So for a...
- **`shapeDiscount()`** — line 165
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `round2()`
- **`usable()`** — line 195
  - Purpose: (no comment in code — see name and calls below)
- **`discountSummary()`** _(async)_ — line 203
  - Purpose: Discount given (sales) or received (purchase): totals, and optionally a breakdown.
  - Calls in this file: `readMaxTimeMS()`, `modelFor()`, `aggregate()`, `shapeDiscount()`, `clampLimit()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`sideTotals()`** _(async)_ — line 248
  - Purpose: One side (sales or purchases) per product: billed lines only (a rate needs a billed amount), weighted by the BILLED quantity (PRICED_STAGES). Ambiguous lines are counted per product (ambLines, ambNet) and kept out of qty, billed and the rates; a product with only ambiguous lines comes back with qty 0 (no rate). At most MAX_GROUP_ROWS products come back; one more is refused (result_too_large) before any in-memory s...
  - Calls in this file: `aggregate()`, `usable()`, `capRows()`
- **`priced()`** — line 272
  - Purpose: (no comment in code — see name and calls below)
- **`uncertainOf()`** — line 273
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `round2()`
- **`ratesByProduct()`** _(async)_ — line 280
  - Purpose: Per-product sale and purchase rates for the period, side by side.
  - Calls in this file: `readMaxTimeMS()`, `escapeRegex()`, `sideTotals()`, `priced()`, `clampLimit()`, `round2()`, `uncertainOf()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`productMargin()`** _(async)_ — line 329
  - Purpose: Indicative margin per product sold in the period: average sale rate vs average purchase cost (see MARGIN_NOTE).
  - Calls in this file: `readMaxTimeMS()`, `daysBefore()`, `sideTotals()`, `priced()`, `round2()`, `uncertainOf()`, `clampLimit()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`productTrend()`** _(async)_ — line 404
  - Purpose: Month-by-month quantity bought and sold for ONE product, with the net movement (bought − sold) and its running total. Months with no voucher between the first and the last active month are shown with zeros. See TREND_NOTE.
  - Calls in this file: `readMaxTimeMS()`, `aggregate()`, `escapeRegex()`, `round2()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`supplierRates()`** _(async)_ — line 485
  - Purpose: What each supplier charged per unit for the same product, and who is cheapest.
  - Calls in this file: `readMaxTimeMS()`, `escapeRegex()`, `capRows()`, `aggregate()`, `clampLimit()`, `round2()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`

## `src/services/analytics/periodEngine.js`
**Used by:** `src/controllers/analyticsController.js`, `src/services/query/queryChat.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/semanticCatalog.js`, `src/services/query/validator.js`

**Tested by:** `verify-comparison-period-capability.js`, `verify-growth-comparison-capability.js`, `verify-month-boundary-dates.js`, `verify-period-engine.js`, `verify-query-dsl.js`, `verify-query-engine.js`, `verify-query-parity.js`, `verify-stock-group-analytics.js`

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
  - Calls in this file: `financialYearStartYear()`, `fyMonthOffset()`
- **`endOfQuarter()`** — line 120
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `startOfQuarter()`
- **`shiftQuarters()`** — line 135
  - Purpose: Day fixed at 1 deliberately: the only thing ever read off this anchor downstream is its year/month (via startOfQuarter/endOfQuarter), never its day-of-month. Carrying the original day through (as a naive "new Date(y, m+delta, day)" would) risks a silent month rollover when the target month has fewer days than `day` (e.g. day 31 shifted into a 30-day month) - which would corrupt which quarter this resolves to.
- **`safeShiftMonths()`** — line 148
  - Purpose: Shifts a date by whole months/years, clamping the day-of-month to the target month's real last day instead of letting it silently roll into the next month (JS's plain `new Date(y, m, day)` does this rollover, e.g. 29 Feb 2024 shifted +1 year becomes 1 Mar 2025, not 28 Feb 2025 - confirmed live in this investigation). dateRanges.shiftMonths/shiftYears now clamp the same way (they used to roll over, which broke prev...
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
  - Calls in this file: `startOfWeek()`, `endOfWeek()`, `isBeforeNaturalEnd()`, `startOfQuarter()`, `endOfQuarter()`, `shiftQuarters()`, `financialYearStartYear()`, `financialYearRange()`, `financialYearLabel()`, `parseFinancialYearInput()`, `lastNDays()`
  - Calls other files: `src/services/analytics/dateRanges.js → endOfDay()`, `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → shiftDays()`, `src/services/analytics/dateRanges.js → currentMonthToDate()`, `src/services/analytics/dateRanges.js → previousFullMonth()`, `src/services/analytics/dateRanges.js → sameMonthLastYearToDate()`, `src/services/analytics/dateRanges.js → customRange()`
- **`resolveComparisonPeriod()`** — line 338
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `resolvePeriod()`, `safeShiftMonths()`, `shiftQuarters()`, `startOfQuarter()`, `endOfQuarter()`, `safeShiftYears()`, `financialYearStartYear()`, `financialYearRange()`, `parseFinancialYearInput()`
  - Calls other files: `src/services/analytics/dateRanges.js → shiftDays()`, `src/services/analytics/dateRanges.js → startOfDay()`, `src/services/analytics/dateRanges.js → endOfDay()`, `src/services/analytics/dateRanges.js → previousMonthSameRange()`, `src/services/analytics/dateRanges.js → shiftMonths()`, `src/services/analytics/dateRanges.js → startOfMonth()`, `src/services/analytics/dateRanges.js → endOfMonth()`
- **`resolveSamePeriodLastYear()`** — line 447
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `resolvePeriod()`, `safeShiftYears()`
- **`resolvePeriodWithComparison()`** — line 459
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `resolvePeriod()`, `resolveComparisonPeriod()`

## `src/services/analytics/purchaseAnalytics.js`
**Used by:** `src/controllers/analyticsController.js`

**Tested by:** `verify-dashboard-real-data.js`, `verify-query-dsl.js`, `verify-query-parity-synthetic.js`, `verify-query-parity.js`, `verify-reconciliation-history.js`, `verify-reconciliation.js`, `verify-voucher-lifecycle.js`

**Imports:** `src/models/purchase.model.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/salesAnalytics.js`

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
**Used by:** `src/controllers/analyticsController.js`, `src/controllers/reportController.js`, `src/services/analytics/insightTools.js`, `src/services/query/analysisPlan.js`, `src/services/query/execute.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-findings-real.js`, `verify-ai-telemetry.js`, `verify-comparison-period-capability.js`, `verify-cost-forensic.js`, `verify-dashboard-real-data.js`, `verify-growth-comparison-capability.js`, `verify-presentation.js`, `verify-query-chat.js` (+4 more)

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/services/analytics/freshness.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/dateRanges.js`

**Exports:** `getTenantReferenceDate`, `getTenantDateContext`, `buildDateContext`

- **`DAY()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
- **`valid()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`endOfLocalDay()`** — line 40
  - Purpose: Voucher dates are stored as UTC midnight of the Tally date and every period boundary is a LOCAL calendar day. Everything this module hands out (coverage window, latest voucher, the REST anchor) is therefore the calendar day of the stored date as a local-midnight Date (dateRanges.calendarDayOfStored), so it compares with period boundaries and with "today" by calendar day in any server zone.
- **`voucherDateBounds()`** _(async)_ — line 43
  - Purpose: The earliest and latest active voucher date of one collection (two indexed lookups).
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`lastSuccessfulSync()`** _(async)_ — line 57
  - Purpose: The last SUCCESSFUL incremental sync of this tenant (any voucher type). The incremental sync fetches every voucher altered in Tally up to that moment, whatever its date, so data is complete up to it. A FAILED attempt is not one: it also sets lastSyncedAt, and counting it made the data look complete through today whenever Tally was unreachable (the coverage then called a month with no data a real zero instead of mi...
  - Calls other files: `src/models/syncCheckpoint.model.js → find()`, `src/services/analytics/freshness.js → successTimeOf()`
- **`buildDateContext()`** — line 69
  - Purpose: The rule (pure). referenceDate = the end of today's local calendar day. Coverage = the first active voucher of either type .. the later of the last active voucher and the last successful sync.
  - Calls in this file: `valid()`, `endOfLocalDay()`, `DAY()`
  - Calls other files: `src/services/analytics/dateRanges.js → calendarDayOfStored()`
- **`getTenantDateContext()`** _(async)_ — line 99
  - Purpose: The per-turn tenant date context: reference date (today) + synced coverage window.
  - Calls in this file: `voucherDateBounds()`, `lastSuccessfulSync()`, `buildDateContext()`
- **`getTenantReferenceDate()`** _(async)_ — line 105
  - Purpose: REST dashboard/report anchor (unchanged rule, see the header): latest active voucher, else the wall clock.
  - Calls in this file: `voucherDateBounds()`
  - Calls other files: `src/services/analytics/dateRanges.js → calendarDayOfStored()`

## `src/services/analytics/reportAnalytics.js`
**Used by:** `src/controllers/reportController.js`

**Tested by:** `verify-reports.js`

**Imports:** `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/analytics/analyticsScope.js`

**Exports:** `getCustomerReport`, `getProductReport`, `escapeRegex`

- **`escapeRegex()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
- **`getCustomerReport()`** _(async)_ — line 26
  - Purpose: True single-query server-side pagination: customers only ever come from ONE collection (Sale), so a single $facet aggregation (count + page) is both correct and efficient - no in-memory merge needed.
  - Calls in this file: `escapeRegex()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getProductReport()`** _(async)_ — line 81
  - Purpose: Products live in BOTH Sale and Purchase inventory - two different collections - so this can't be a single $facet the way the customer report is. Sales are paginated at the database level (true $skip/ $limit on the primary, sorted list); the purchase-side amount is then looked up ONLY for the current page's item names (at most `limit` items), never for the full purchase collection - bounded, not a full second colle...
  - Calls in this file: `escapeRegex()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`, `src/models/purchase.model.js → aggregate()`

## `src/services/analytics/salesAnalytics.js`
**Used by:** `src/controllers/analyticsController.js`, `src/services/analytics/purchaseAnalytics.js`, `src/services/analytics/stockGroupAnalytics.js`, `src/services/query/execute.js`

**Tested by:** `verify-analytics-scope.js`, `verify-calculation.js`, `verify-comparison-period-capability.js`, `verify-dashboard-real-data.js`, `verify-query-dsl.js`, `verify-query-parity-synthetic.js`, `verify-query-parity.js`, `verify-reconciliation-history.js` (+3 more)

**Imports:** `src/models/sales.model.js`, `src/services/analytics/analyticsScope.js`

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
  - Purpose: Monthly sales totals across a date range - the real aggregation behind the Sales Trend chart. Grouped by calendar month of header.voucherDate (the corrected voucher total, same field every other Sales metric uses), scoped to the requested window. Empty months within the range are NOT synthesized as zero-filled points - only months with at least one active voucher appear, so the chart never implies data exists wher...
  - Calls in this file: `monthLabel()`
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`getCustomerCounts()`** _(async)_ — line 402
  - Purpose: Distinct-customer counts, all legitimately derivable from header.partyName on real Sale vouchers - no invented "customer" concept beyond "a distinct party name we've sold to": totalCustomers - distinct parties across the tenant's ENTIRE history (not scoped to `period` - a stable, always-available headline number). activeCustomers - distinct parties with at least one sale WITHIN `period`. newCustomers - of those ac...
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → distinct()`, `src/models/sales.model.js → aggregate()`

## `src/services/analytics/stockGroupAnalytics.js`
**Used by:** `src/controllers/analyticsController.js`

**Tested by:** `verify-query-dsl.js`, `verify-query-parity.js`, `verify-stock-group-analytics.js`

**Imports:** `src/models/sales.model.js`, `src/models/stockItemMaster.model.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/salesAnalytics.js`

**Exports:** `aggregateStockGroupSales`, `getTopStockGroups`, `AMOUNT_BASIS`

- **`aggregateStockGroupSales()`** _(async)_ — line 38
  - Purpose: One tenant-scoped period's worth of {stockGroupName -> {salesAmount, salesQuantity}}, plus mapped/unmapped diagnostics for that same period. Pure aggregation, no growth math here - growth is computed by the caller once it has two or three of these results to compare.
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`, `src/models/sales.model.js → aggregate()`
- **`sumBy()`** — line 116
  - Purpose: (no comment in code — see name and calls below)
- **`getTopStockGroups()`** _(async)_ — line 134
  - Purpose: Top-N Stock Groups by sales amount for `currentPeriod`, with MoM-style growth vs `previousPeriod` and YoY growth vs `samePeriodLastYear` - both OPTIONAL (pass null when the caller's period kind has no natural comparison, e.g. a custom range's MoM - see periodEngine.js). Never guesses a comparison when one wasn't given.
  - Calls in this file: `aggregateStockGroupSales()`, `sumBy()`
  - Calls other files: `src/services/analytics/salesAnalytics.js → computeGrowth()`

## `src/services/analytics/trustEnvelope.js`
**Used by:** `src/controllers/analyticsController.js`, `src/controllers/reportController.js`

**Tested by:** `verify-analytics-scope.js`

**Imports:** `src/services/analytics/freshness.js`

**Exports:** `wrapAnalyticsResult`

- **`wrapAnalyticsResult()`** _(async)_ — line 23
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/freshness.js → getFreshness()`


# 14. AI query engine

## `src/services/query/aiPricing.js`
**Used by:** `src/services/query/usageStore.js`

**Tested by:** `eval-ai-cost-live.js`, `eval-ai-cost-report.js`, `verify-ai-cost-path.js`

**Imports:** (none)

**Exports:** `estimateCost`, `familyOf`, `PRICES`, `PRICING_VERSION`

- **`familyOf()`** — line 20
  - Purpose: "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5" (a dated snapshot id has the price of its family).
- **`n()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`usd()`** — line 23
  - Purpose: (no comment in code — see name and calls below)
- **`estimateCost()`** — line 32
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `familyOf()`, `n()`, `usd()`

## `src/services/query/analysisAnswer.js`
**Used by:** `src/services/query/analysisPresentation.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-findings-real.js`, `verify-analysis-presentation.js`, `verify-decline-investigation.js`, `verify-evidence.js`, `verify-insights.js`, `verify-investigation-loop.js`, `verify-overall-direction.js`, `verify-plain-answer.js` (+1 more)

**Imports:** `src/services/query/answerFormatter.js`, `src/services/query/semanticCatalog.js`, `src/services/query/evidence.js`, `src/services/query/plainAnswer.js`

**Exports:** `formatAnalysisAnswer`, `noActionText`, `ACTION_KIND_LABELS`, `MAX_INSIGHT_ROWS`, `unavailableText`, `FINDING_LABELS`, `LABEL_NOTE`, `INSIGHT_FIELDS`, `TOOL_TITLES`, `SUMMARIES`, `fmt`

- **`unavailableText()`** — line 19
  - Purpose: The parts of the question the data cannot answer (the analysis planner's validated `unavailable` catalog ids), stated first with the catalog's own reasons, and the scope of everything below: the whole company, not that breakdown. Ids the catalog does not list as `partial` are dropped (never rendered).
- **`stepRef()`** — line 30
  - Purpose: (no comment in code — see name and calls below)
- **`noActionText()`** — line 33
  - Purpose: Asked what to do, but no action follows from these results: the evidence record's specific reason, never an invented action.
- **`actionsText()`** — line 38
  - Purpose: The next steps as a prioritized list: kind, step, and the finding (figures) it follows from.
  - Calls in this file: `noActionText()`, `stepRef()`
- **`findingsText()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `stepRef()`, `actionsText()`
- **`fmt()`** — line 64
  - Purpose: (no comment in code — see name and calls below)
- **`insightText()`** — line 87
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fmt()`
- **`formatAnalysisAnswer()`** — line 114
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `unavailableText()`, `stepRef()`, `findingsText()`, `actionsText()`, `insightText()`
  - Calls other files: `src/services/query/evidence.js → buildEvidence()`, `src/services/query/answerFormatter.js → plainMetricNames()`, `src/services/query/plainAnswer.js → plainSummary()`

## `src/services/query/analysisPlan.js`
**Used by:** `src/services/query/analysisPlanner.js`, `src/services/query/investigation.js`

**Tested by:** `eval-findings-real.js`, `verify-analysis-plan.js`, `verify-investigation-loop.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/answerFormatter.js`, `src/services/analytics/coverage.js`, `src/services/analytics/insightTools.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/freshness.js`, `src/services/query/entityResolver.js`, `src/services/query/answerCache.js`

**Exports:** `parseAnalysisPlan`, `executeAnalysisPlan`, `analysisPlanSchema`, `MAX_STEPS`, `MAX_INPUT_VALUES`, `DEFAULT_DEADLINE_MS`

- **`changeRanking()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
- **`keepsSign()`** — line 48
  - Purpose: (no comment in code — see name and calls below)
- **`directionWord()`** — line 53
  - Purpose: (no comment in code — see name and calls below)
- **`parseAnalysisPlan()`** — line 75
  - Purpose: Structural validation of a whole plan (no database): shape, ids, dependencies, query-plan schemas.
  - Calls in this file: `changeRanking()`, `keepsSign()`, `directionWord()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`
- **`stepOut()`** — line 109
  - Purpose: (no comment in code — see name and calls below)
- **`stripDiagnostics()`** — line 110
  - Purpose: (no comment in code — see name and calls below)
- **`freshnessGate()`** _(async)_ — line 117
  - Purpose: never_synced blocks the step; stale or failed syncs are disclosed with the step (as the single-query answer does)
- **`resolveNames()`** _(async)_ — line 131
  - Purpose: (no comment in code — see name and calls below)
- **`runQueryStep()`** _(async)_ — line 146
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `stepOut()`, `changeRanking()`, `directionWord()`, `resolveNames()`, `freshnessGate()`, `stripDiagnostics()`
  - Calls other files: `src/services/query/validator.js → validateQueryPlan()`, `src/services/analytics/coverage.js → assessCoverage()`, `src/services/query/answerFormatter.js → formatQueryAnswer()`
- **`runInsightStep()`** _(async)_ — line 200
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `freshnessGate()`, `stepOut()`
  - Calls other files: `src/services/analytics/insightTools.js → insightToolVoucherTypes()`, `src/services/analytics/insightTools.js → resolveInsightPeriod()`, `src/services/analytics/coverage.js → assessCoverage()`
- **`executeAnalysisPlan()`** _(async)_ — line 227
  - Purpose: Run an analysis plan. Steps run in order (an input always refers to an earlier step); a refused or failed step does not stop independent later steps, and a step that depends on it is skipped.
  - Calls in this file: `parseAnalysisPlan()`, `defaultExecutor()`, `stepOut()`, `runQueryStep()`, `runInsightStep()`
  - Calls other files: `src/services/query/entityResolver.js → createEntityResolver()`
- **`defaultExecutor()`** — line 275
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/answerCache.js → createDefaultCachedExecutor()`

## `src/services/query/analysisPlanner.js`
**Used by:** `src/services/query/queryChat.js`

**Tested by:** `eval-ai-cost-live.js`, `eval-cache-baseline.js`, `eval-investigations.js`, `verify-analysis-followup.js`, `verify-analysis-planner.js`, `verify-analysis-presentation.js`, `verify-ask-ai-basic-questions.js`, `verify-ask-ai-ux-fixes.js` (+3 more)

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/planner.js`, `src/services/query/analysisPlan.js`, `src/services/analytics/insightTools.js`, `src/services/query/semanticCatalog.js`, `src/services/query/followUp.js`, `src/services/query/plannerResponseCache.js`

**Exports:** `planAnalysis`, `getAnalysisPrompt`, `checkAnalysis`, `ANALYSIS_TOOL_NAME`, `ANALYSIS_TOOL_IDS`, `ANALYSIS_MAX_TOKENS`, `EVIDENCE_LEAD`

- **`isPlainObject()`** — line 47
  - Purpose: (no comment in code — see name and calls below)
- **`cleanText()`** — line 48
  - Purpose: (no comment in code — see name and calls below)
- **`newUsage()`** — line 49
  - Purpose: (no comment in code — see name and calls below)
- **`addUsage()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
- **`failed()`** — line 54
  - Purpose: (no comment in code — see name and calls below)
- **`buildAnalysisPrompt()`** — line 60
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/planner.js → buildCatalogDigest()`, `src/services/analytics/insightTools.js → listInsightTools()`, `src/services/query/semanticCatalog.js → unsupportedLabel()`
- **`buildAnalysisTool()`** — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/insightTools.js → insightToolArgsJsonSchemas()`, `src/services/query/queryPlan.schema.js → queryPlanJsonSchema()`, `src/services/query/semanticCatalog.js → nameDimensionIds()`
- **`getAnalysisPrompt()`** — line 140
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildAnalysisPrompt()`, `buildAnalysisTool()`
- **`revenueGuard()`** — line 159
  - Purpose: The revenue basis for an ANALYSIS (the question says "revenue"). "Revenue" has one meaning: sales + lineAmount (planner.isRevenuePlan). An analysis is several steps, and only its headline is the revenue figure, so the steps are judged together, not each as revenue: - at least one step is a revenue step (sales + only line-grain metrics incl. lineAmount) - unless `requirePrimary` is false (a later investigation roun...
  - Calls other files: `src/services/query/planner.js → mentionsRevenue()`, `src/services/analytics/insightTools.js → insightToolVoucherTypes()`, `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/planner.js → isRevenuePlan()`
- **`checkAnalysis()`** — line 181
  - Purpose: Everything that can be checked before execution. Returns { errors } (repairable: our own codes), { refusal } (a decided rule: final, never repaired) or { plan, notes } (the plan after the decided rewrites; definition notes by step id). options.requirePrimary: false for the supporting steps of a later investigation round (see revenueGuard).
  - Calls in this file: `revenueGuard()`
  - Calls other files: `src/services/query/analysisPlan.js → parseAnalysisPlan()`, `src/services/query/planner.js → mentionsAccountingProfit()`, `src/services/analytics/insightTools.js → validateInsightArgs()`, `src/services/query/planner.js → checkPlannedQuery()`, `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/validator.js → validateQueryPlan()`, `src/services/query/planner.js → mentionsRevenue()`, `src/services/query/planner.js → applyPlanRules()`, `src/services/query/planner.js → isRevenuePlan()`
- **`planAnalysis()`** _(async)_ — line 240
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `newUsage()`, `getAnalysisPrompt()`, `failed()`, `addUsage()`, `isPlainObject()`, `cleanText()`, `checkAnalysis()`
  - Calls other files: `src/services/query/followUp.js → readScope()`, `src/services/query/followUp.js → scopeMessage()`, `src/services/query/plannerResponseCache.js → isCachedResponse()`

## `src/services/query/analysisPresentation.js`
**Used by:** `src/services/query/queryChat.js`

**Tested by:** `verify-analysis-presentation.js`, `verify-decline-investigation.js`, `verify-overall-direction.js`, `verify-plain-answer.js`

**Imports:** `src/services/query/presentation.js`, `src/services/query/answerFormatter.js`, `src/services/query/analysisAnswer.js`, `src/services/query/semanticCatalog.js`

**Exports:** `buildAnalysisPresentation`

- **`queryView()`** — line 17
  - Purpose: One query step's single-query view, built from its own plan and result exactly as a one-query answer would be.
  - Calls other files: `src/services/query/answerFormatter.js → formatQueryAnswer()`, `src/services/query/presentation.js → buildPresentation()`
- **`insightView()`** — line 23
  - Purpose: An insight tool's rows as a table: the tool's own fields (INSIGHT_FIELDS), its own numbers, formatted like the text.
  - Calls other files: `src/services/query/presentation.js → col()`, `src/services/query/analysisAnswer.js → fmt()`
- **`kpisOf()`** — line 48
  - Purpose: The KPI cards of the analysis: current, previous, change and % change of the primary metric of the FIRST step that ran a comparison and returned its totals. Every value is the engine's own (totals.values / totals.comparison), formatted by the same functions as the text; nothing when no step compared two periods.
  - Calls other files: `src/services/query/presentation.js → primaryOf()`, `src/services/query/presentation.js → shortLabel()`, `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/presentation.js → compareLabel()`, `src/services/query/answerFormatter.js → fmtSigned()`, `src/services/query/answerFormatter.js → pctOf()`
- **`featuredOf()`** — line 79
  - Purpose: The one visual shown open: the step behind the first contributor finding (the breakdown of the change), else the first trend or ranking, else the KPI step's own comparison, else the first step with a view. Steps without a chart or table (a single figure) are never featured over one that has them.
- **`same()`** — line 93
  - Purpose: (no comment in code — see name and calls below)
- **`pairable()`** — line 94
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `same()`
  - Calls other files: `src/services/query/presentation.js → primaryOf()`
- **`pairView()`** — line 110
  - Purpose: One aligned table (and two-series chart) of a sales step and a purchase step of the same products: a row per product in either list, by sales then purchases. A product absent from a COMPLETE list had no activity on that side ("none in this period"); absent from a list cut at its limit, its value is unknown ("not in the top N returned"). Never a zero for either, never a difference (sales and purchase line values ar...
  - Calls other files: `src/services/query/presentation.js → primaryOf()`, `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/presentation.js → col()`, `src/services/query/presentation.js → shortLabel()`
- **`pairsOf()`** — line 158
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `pairable()`, `pairView()`
- **`buildAnalysisPresentation()`** — line 181
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `queryView()`, `insightView()`, `kpisOf()`, `pairsOf()`, `featuredOf()`
  - Calls other files: `src/services/query/answerFormatter.js → plainMetricNames()`, `src/services/query/analysisAnswer.js → unavailableText()`, `src/services/query/analysisAnswer.js → noActionText()`

## `src/services/query/answerCache.js`
**Used by:** `src/services/query/analysisPlan.js`, `src/services/query/plannerResponseCache.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-cache-baseline.js`, `verify-ai-telemetry.js`, `verify-analysis-plan.js`, `verify-cost-forensic.js`, `verify-planner-live-eval.js`, `verify-planner-response-cache.js`, `verify-product-return-analytics.js`, `verify-query-cache.js` (+3 more)

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/semanticCatalog.js`, `src/services/query/dataVersion.js`, `src/services/query/execute.js`, `src/services/query/turnTelemetry.js`

**Exports:** `createAnswerCache`, `createDefaultCachedExecutor`, `stableStringify`, `DEFAULTS`

- **`stableStringify()`** — line 29
  - Purpose: (no comment in code — see name and calls below)
- **`deepFreeze()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`createAnswerCache()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `stableStringify()`, `deepFreeze()`
  - Calls other files: `src/services/query/semanticCatalog.js → computeFingerprint()`, `src/services/query/queryPlan.schema.js → parseQueryPlan()`
- **`createDefaultCachedExecutor()`** — line 192
  - Purpose: Production wiring: real executor + Mongo-backed version. Not used by chat yet.
  - Calls in this file: `createAnswerCache()`
  - Calls other files: `src/services/query/dataVersion.js → onBump()`, `src/services/query/turnTelemetry.js → timeEngineDeps()`

## `src/services/query/answerFormatter.js`
**Used by:** `src/services/query/analysisAnswer.js`, `src/services/query/analysisPlan.js`, `src/services/query/analysisPresentation.js`, `src/services/query/basicAnalysis.js`, `src/services/query/evidence.js`, `src/services/query/groupComparison.js`, `src/services/query/presentation.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-findings-real.js`, `verify-analysis-planner.js`, `verify-analysis-presentation.js`, `verify-calculation.js`, `verify-customer-count.js`, `verify-plain-query-answer.js`, `verify-presentation.js`, `verify-query-chat.js` (+3 more)

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/analytics/coverage.js`

**Exports:** `formatQueryAnswer`, `formatNonAnswer`, `plainMetricNames`, `fmtMoney`, `fmtNumber`, `fmtValue`, `fmtSigned`, `pctOf`, `periodText`, `isZero`, `SCOPE_HINT`, `MAX_DISPLAY_ROWS`

- **`isMoney()`** — line 21
  - Purpose: (no comment in code — see name and calls below)
- **`fmtMoney()`** — line 26
  - Purpose: (no comment in code — see name and calls below)
- **`fmtNumber()`** — line 29
  - Purpose: (no comment in code — see name and calls below)
- **`fmtValue()`** — line 32
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isMoney()`, `fmtMoney()`, `fmtNumber()`
- **`fmtSigned()`** — line 36
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fmtValue()`
- **`fmtPct()`** — line 40
  - Purpose: (no comment in code — see name and calls below)
- **`pctOf()`** — line 44
  - Purpose: A % change against a zero comparison value is undefined (never 0% and never infinite): say why.
  - Calls in this file: `fmtPct()`
- **`datesOf()`** — line 49
  - Purpose: The resolved dates of a relative period, so the range actually measured is always visible.
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`label()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
- **`isoParts()`** — line 55
  - Purpose: (no comment in code — see name and calls below)
- **`customRangeText()`** — line 59
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isoParts()`
- **`plainMetricNames()`** — line 73
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `label()`
- **`periodText()`** — line 75
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customRangeText()`, `datesOf()`
- **`keyText()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
- **`compareText()`** — line 88
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customRangeText()`, `datesOf()`
- **`isZero()`** — line 98
  - Purpose: (no comment in code — see name and calls below)
- **`productLevelNote()`** — line 116
  - Purpose: (no comment in code — see name and calls below)
- **`touchesProduct()`** — line 117
  - Purpose: (no comment in code — see name and calls below)
- **`formatQueryAnswer()`** — line 122
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `periodText()`, `isZero()`, `compareText()`, `fmtMoney()`, `label()`, `fmtValue()`, `fmtSigned()`, `pctOf()`, `keyText()`, `plainMetricNames()`, `touchesProduct()`, `productLevelNote()`
  - Calls other files: `src/services/analytics/coverage.js → fmtDay()`
- **`formatNonAnswer()`** — line 205
  - Purpose: (no comment in code — see name and calls below)

## `src/services/query/basicAnalysis.js`
**Used by:** `src/services/query/queryChat.js`, `server.js`

**Tested by:** `verify-ask-ai-basic-questions.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/answerFormatter.js`

**Exports:** `analysisMode`, `analysisModeUnrecognised`, `basicShape`, `salesVsPurchaseText`, `salesVsPurchaseMismatch`, `salesVsPurchaseMismatchText`, `BASIC_INSIGHT_TOOLS`, `DEFAULT_MODE`

- **`analysisMode()`** — line 30
  - Purpose: The analysis mode of this turn: a test's deps.analysisMode / deps.analysisEnabled, else ASK_AI_ANALYSIS (unset: on).
- **`analysisModeUnrecognised()`** — line 40
  - Purpose: True when ASK_AI_ANALYSIS holds a value that is not on/basic/off (the server warns at start).
- **`empty()`** — line 45
  - Purpose: (no comment in code — see name and calls below)
- **`plainTotal()`** — line 46
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `empty()`
- **`basicShape()`** — line 53
  - Purpose: Which basic shape an analysis plan has, or null when it is outside basic analysis.
  - Calls in this file: `empty()`, `plainTotal()`
- **`AMOUNT_BASIS_LABEL()`** — line 65
  - Purpose: (no comment in code — see name and calls below)
- **`salesVsPurchaseMismatch()`** — line 74
  - Purpose: A plan of exactly one plain sales total and one plain purchase total that is NOT a comparable pair: why (different periods, different amount bases). Null for a comparable pair and for any other plan.
  - Calls in this file: `empty()`, `plainTotal()`, `basicShape()`, `AMOUNT_BASIS_LABEL()`
- **`salesVsPurchaseMismatchText()`** — line 89
  - Purpose: The note for a non-comparable sales/purchase pair: no difference, and never profit.
  - Calls in this file: `profitReason()`
- **`totalOf()`** — line 96
  - Purpose: (no comment in code — see name and calls below)
- **`profitReason()`** — line 100
  - Purpose: (no comment in code — see name and calls below)
- **`salesVsPurchaseText()`** — line 106
  - Purpose: The side-by-side block for a sales_vs_purchase shape: both totals, their difference, and why the difference is not profit. Null when either step did not produce a total (each step already says why).
  - Calls in this file: `totalOf()`, `profitReason()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtMoney()`

## `src/services/query/calculation.js`
**Used by:** `src/services/query/queryChat.js`

**Tested by:** `verify-calculation.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/evidence.js`

**Exports:** `buildCalculation`, `CALCULATION_VERSION`

- **`canonical()`** — line 32
  - Purpose: canonical JSON (key order free), so a filter is "the same" only when every part of it is
- **`num()`** — line 37
  - Purpose: (no comment in code — see name and calls below)
- **`metricLabel()`** — line 38
  - Purpose: (no comment in code — see name and calls below)
- **`definitionOf()`** — line 41
  - Purpose: How a metric is computed, from the catalog's structured fields only (its planner-facing description is not used).
  - Calls in this file: `metricLabel()`
- **`filtersOf()`** — line 55
  - Purpose: Where each filter came from, only where the stored previous scope proves it: "same_as_previous" when the previous turn's plan (or an analysis turn's carried scope) holds exactly the same filter; "this_question" when there was no previous scope (the planner had nothing else to take it from) or the previous one did not hold it. Never "inherited" by guess.
  - Calls in this file: `canonical()`
- **`periodOf()`** — line 66
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/evidence.js → dayOf()`
- **`changeOf()`** — line 72
  - Purpose: The change formula, exactly as computeGrowth computed the engine's values: change = current − previous; % change = change ÷ |previous| × 100, not defined when previous is 0 (the engine returns null; never shown as 0% or infinite).
  - Calls in this file: `num()`
- **`ratioInputs()`** — line 84
  - Purpose: A derived ratio's inputs, only when the same plan measured both of them (else stated unavailable, never recomputed).
  - Calls in this file: `num()`
- **`keyOf()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`buildCalculation()`** — line 108
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `periodOf()`, `filtersOf()`, `num()`, `changeOf()`, `ratioInputs()`, `keyOf()`
  - Calls other files: `src/services/query/evidence.js → dayOf()`

## `src/services/query/compile.js`
**Used by:** `src/services/query/execute.js`

**Tested by:** `verify-customer-count.js`, `verify-product-return-analytics.js`, `verify-query-engine.js`, `verify-return-analytics.js`, `verify-timezone-boundaries.js`, `nluScoring.js`

**Imports:** `src/services/analytics/analyticsScope.js`, `src/services/query/semanticCatalog.js`, `src/services/query/validator.js`

**Exports:** `compileQuery`, `assertPipelineSafe`, `escapeRegex`, `regexCondition`, `hasDistinctMetric`, `ALLOWED_STAGES`

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
  - Calls in this file: `isDerived()`
- **`baseMetricsNeeded()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
- **`signFactor()`** — line 108
  - Purpose: A metric may declare `entitySign: { <entity>: -1 }`: Tally books that entity's stock entries with the opposite sign (purchase item amounts are stored negative), so the figure is negated to read as a positive value. A plain sign flip - NOT abs - so opposite-signed lines still net.
- **`signedPath()`** — line 109
  - Purpose: (no comment in code — see name and calls below)
- **`accumulators()`** — line 111
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `baseMetricsNeeded()`, `signedPath()`, `signFactor()`
- **`derivedFields()`** — line 123
  - Purpose: (no comment in code — see name and calls below)
- **`projectValues()`** — line 135
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueRef()`
- **`scopeStage()`** — line 151
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`buildPrefix()`** — line 161
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `scopeStage()`, `regexCondition()`
- **`sortStages()`** — line 190
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueRef()`
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`havingMatch()`** — line 211
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueRef()`
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`rowsPipeline()`** — line 221
  - Purpose: finalize=true : non-comparison, non-rolled -> having/sort/limit run in MongoDB. limit+1 detects truncation without a second count query. finalize=false : the executor needs the FULL group set (comparison, or a product-group roll-up) and does having/sort/limit itself.
  - Calls in this file: `buildPrefix()`, `signedPath()`, `signFactor()`, `groupId()`, `accumulators()`, `derivedFields()`, `havingMatch()`, `sortStages()`, `projectValues()`
- **`totalsPipeline()`** — line 243
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildPrefix()`, `accumulators()`, `derivedFields()`, `projectValues()`
- **`listPipeline()`** — line 254
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildPrefix()`
- **`walk()`** — line 278
  - Purpose: (no comment in code — see name and calls below)
- **`assertPipelineSafe()`** — line 292
  - Purpose: Throws unless the pipeline is provably scoped and uses only allow-listed constructs. Exported so tests can prove it rejects tampered pipelines.
  - Calls in this file: `walk()`
- **`compileQuery()`** — line 325
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `hasDistinctMetric()`, `listPipeline()`, `rowsPipeline()`, `totalsPipeline()`, `assertPipelineSafe()`
  - Calls other files: `src/services/query/validator.js → isValidatedPlan()`
- **`hasDistinctMetric()`** — line 370
  - Purpose: (no comment in code — see name and calls below)

## `src/services/query/dataVersion.js`
**Used by:** `src/models/adjustmentNote.model.js`, `src/models/ledgerMaster.model.js`, `src/models/purchase.model.js`, `src/models/sales.model.js`, `src/models/stockItemMaster.model.js`, `src/services/query/answerCache.js`, `src/services/query/queryChat.js`

**Tested by:** `verify-cost-forensic.js`, `verify-planner-live-eval.js`, `verify-query-cache.js`, `verify-query-chat.js`, `verify-query-planner.js`, `verify-stock-item-gst.js`, `verify-stock-item-master.js`

**Imports:** `src/models/tenantDataVersion.model.js`

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
  - Calls in this file: `tenantsOfWrite()`, `bumpFor()`, `tenantFrom()`, `bumpTenantVersion()`, `tenantsFromOps()`, `finishBulk()`
- **`finishBulk()`** _(async)_ — line 218
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bumpFor()`

## `src/services/query/entityResolver.js`
**Used by:** `src/services/analytics/insightTools.js`, `src/services/query/analysisPlan.js`, `src/services/query/queryChat.js`

**Tested by:** `verify-ai-telemetry.js`, `verify-analysis-plan.js`, `verify-entity-resolver.js`, `verify-planner-live-eval.js`, `verify-presentation.js`, `verify-query-chat.js`, `verify-query-planner.js`, `verify-return-analytics.js` (+2 more)

**Imports:** `src/services/query/semanticCatalog.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/stockItemMaster.model.js`

**Exports:** `createEntityResolver`, `defaultSources`, `ENTITY_RESOLVER_UNAVAILABLE`

- **`normalizeText()`** — line 18
  - Purpose: Lower-case, punctuation-free, single-spaced form used to compare entity names.
- **`searchedDims()`** — line 37
  - Purpose: The catalog's name dimensions a typed name is matched against: those of the entity for sales or purchase, all of them otherwise (no entity, or a return entity).
  - Calls other files: `src/services/query/semanticCatalog.js → nameDimensionIds()`
- **`defaultSources()`** — line 40
  - Purpose: `models` is injectable for tests ({Sale, Purchase, StockItemMaster}); production loads the real ones.
- **`editDistance()`** — line 62
  - Purpose: Edit distance between two short words (two-row dynamic programming).
- **`wordSimilarity()`** — line 74
  - Purpose: 0..1: how alike two words are. A typed word that is the start of a stored word (or the reverse) counts as a near match.
  - Calls in this file: `editDistance()`
- **`nameScore()`** — line 84
  - Purpose: How well a stored name fits what was typed: every typed word is matched to its closest stored word and the results are averaged; a stored name with many more words than were typed scores a little lower.
  - Calls in this file: `wordSimilarity()`
- **`createEntityResolver()`** — line 95
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `defaultSources()`, `normalizeText()`, `searchedDims()`, `nameScore()`

## `src/services/query/evidence.js`
**Used by:** `src/services/query/analysisAnswer.js`, `src/services/query/calculation.js`, `src/services/query/investigation.js`, `src/services/query/plainAnswer.js`, `src/services/query/presentation.js`

**Tested by:** `eval-findings-real.js`, `verify-evidence.js`, `verify-investigation-eval.js`, `verify-investigation-loop.js`, `verify-overall-direction.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/answerFormatter.js`

**Exports:** `buildEvidence`, `dayOf`, `dataDayOf`, `round2`, `MAX_SERIES`, `MAX_CONTRIBUTORS`, `MATERIAL_FALL_PCT`, `CONCENTRATION_TOP`, `CONCENTRATION_SHARE`

- **`round2()`** — line 31
  - Purpose: Currency precision: half away from zero, so -0.005 and 0.005 round alike.
- **`pad()`** — line 32
  - Purpose: (no comment in code — see name and calls below)
- **`localDay()`** — line 33
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `pad()`
- **`dayOf()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `localDay()`
- **`dataDayOf()`** — line 36
  - Purpose: The latest voucher's calendar day: a Date (dc.latestVoucher, local midnight of that day) or a "YYYY-MM-DD" string; else null.
  - Calls in this file: `localDay()`
- **`isMoney()`** — line 40
  - Purpose: (no comment in code — see name and calls below)
- **`metricLabel()`** — line 42
  - Purpose: "Line amount (pre-tax)" -> "line amount, pre-tax" (it is shown inside the finding's own brackets)
- **`signed()`** — line 43
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`
- **`pct()`** — line 44
  - Purpose: (no comment in code — see name and calls below)
- **`addMonths()`** — line 47
  - Purpose: calendar buckets (the engine cuts date buckets in UTC; their keys are YYYY-MM-DD starts)
- **`addDays()`** — line 52
  - Purpose: (no comment in code — see name and calls below)
- **`bucketEnd()`** — line 54
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `addDays()`
- **`bucketName()`** — line 55
  - Purpose: (no comment in code — see name and calls below)
- **`periodName()`** — line 59
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bucketEnd()`, `bucketName()`
- **`productScope()`** — line 71
  - Purpose: The one product a step is restricted to (a single-value product filter), else null.
- **`sameName()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`listNames()`** — line 78
  - Purpose: (no comment in code — see name and calls below)
- **`filtersText()`** — line 80
  - Purpose: Every filter of a step except its single product (named separately), so a finding never reads wider than its step.
  - Calls in this file: `productScope()`, `dimPlural()`, `listNames()`
- **`scopeText()`** — line 91
  - Purpose: "Sales of Apple for customers A, B" - the entity, its product and every other filter of the step.
  - Calls in this file: `filtersText()`
- **`valueMetric()`** — line 92
  - Purpose: (no comment in code — see name and calls below)
- **`dimPlural()`** — line 94
  - Purpose: (no comment in code — see name and calls below)
- **`seriesGroups()`** — line 98
  - Purpose: (no comment in code — see name and calls below)
- **`completePairs()`** — line 117
  - Purpose: Every adjacent pair of complete buckets of one series, oldest first, and why any bucket was left out. Only the latest bucket can be incomplete (no data exists after `completeThrough`); a missing bucket is never bridged.
  - Calls in this file: `bucketEnd()`, `bucketName()`
- **`seriesFindings()`** — line 134
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueMetric()`, `productScope()`, `seriesGroups()`, `completePairs()`, `round2()`, `scopeText()`, `metricLabel()`, `bucketName()`, `signed()`, `pct()`, `bucketEnd()`, `decompose()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`
- **`decompose()`** — line 175
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `bucketName()`, `round2()`, `signed()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtNumber()`, `src/services/query/answerFormatter.js → fmtMoney()`
- **`rec()`** — line 209
  - Purpose: one product carrying this share of a ranked sales fall is examined for purchase evidence (rule 5) Next steps (shown only when the question asks what to do) come only from evidence that points at something specific (rule 5: purchase evidence for a product's fall) - never from a contributor's size alone. Each says which finding it follows from: its `because` holds that finding's own figures, `weight` the amount it c...
- **`comparisonFindings()`** — line 211
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueMetric()`, `round2()`, `productScope()`, `periodName()`, `dayOf()`, `scopeText()`, `metricLabel()`, `sameName()`, `signed()`, `pct()`, `isMoney()`, `dimPlural()`, `comparisonKey()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`
- **`comparisonKey()`** — line 323
  - Purpose: Two comparison steps measure the SAME change when entity, dimension, metric, both periods and every filter agree.
  - Calls in this file: `dayOf()`
- **`dropRedundantBreakdowns()`** — line 328
  - Purpose: A list ordered against a change adds nothing next to another step that ranks the same change in its own direction.
- **`salesMinusPurchases()`** — line 338
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueMetric()`, `dayOf()`, `round2()`, `periodName()`
  - Calls other files: `src/services/query/answerFormatter.js → isZero()`, `src/services/query/answerFormatter.js → fmtMoney()`
- **`purchaseSeries()`** — line 370
  - Purpose: The first hypothesis family of an investigation: did purchases of a product fall with its sales? For every COMPLETE sales fall of ONE product (a step filtered to it, or the dominant product of a product breakdown ranked by its fall - see comparisonFindings; a multi-product fall never qualifies), over the window from the month before its comparison period to its end: fresh purchase evidence that fell >= MATERIAL_FA...
  - Calls in this file: `valueMetric()`, `productScope()`, `seriesGroups()`, `bucketEnd()`
- **`pairsIn()`** — line 388
  - Purpose: Adjacent month pairs of a purchase series whose later month lies in [from, to].
- **`possibleCauses()`** — line 391
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `purchaseSeries()`, `addMonths()`, `bucketName()`, `periodName()`, `sameName()`, `pairsIn()`, `rec()`, `signed()`, `productScope()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`
- **`concentrationFindings()`** — line 471
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `valueMetric()`, `round2()`, `periodName()`, `dayOf()`, `scopeText()`, `productScope()`, `dimPlural()`, `pct()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`
- **`overallOf()`** — line 511
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `pct()`, `signed()`, `dimPlural()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`
- **`buildEvidence()`** — line 530
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `localDay()`, `dataDayOf()`, `dayOf()`, `seriesFindings()`, `comparisonFindings()`, `concentrationFindings()`, `salesMinusPurchases()`, `possibleCauses()`, `dropRedundantBreakdowns()`, `signed()`, `overallOf()`
  - Calls other files: `src/services/query/answerFormatter.js → isZero()`

## `src/services/query/execute.js`
**Used by:** `src/services/query/answerCache.js`

**Tested by:** `verify-comparison-period-capability.js`, `verify-customer-count.js`, `verify-growth-comparison-capability.js`, `verify-ledger-master.js`, `verify-planner-live-eval.js`, `verify-product-return-analytics.js`, `verify-query-cache.js`, `verify-query-engine.js` (+10 more)

**Imports:** `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/compile.js`, `src/services/query/semanticCatalog.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/dateRanges.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/adjustmentNote.model.js`, `src/models/stockItemMaster.model.js`, `src/models/ledgerMaster.model.js`, `src/services/analytics/referenceDate.js`

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
  - Calls other files: `src/models/stockItemMaster.model.js → find()`, `src/services/query/compile.js → regexCondition()`
- **`defaultFindNewParties()`** _(async)_ — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/ledgerMaster.model.js → findOne()`, `src/models/ledgerMaster.model.js → find()`, `src/services/analytics/dateRanges.js → storedDayStart()`, `src/services/analytics/dateRanges.js → storedDayEnd()`, `src/models/ledgerMaster.model.js → countDocuments()`, `src/models/ledgerMaster.model.js → aggregate()`
- **`newPartyActivity()`** _(async)_ — line 116
  - Purpose: One bounded read: for the candidate names, first/last voucher up to the period end. Tells who actually traded in the period and who already traded BEFORE their ledger's creation period.
  - Calls other files: `src/services/analytics/analyticsScope.js → buildVoucherMatchStage()`
- **`nameList()`** — line 125
  - Purpose: (no comment in code — see name and calls below)
- **`newPartyWarnings()`** — line 127
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `nameList()`
  - Calls other files: `src/services/analytics/dateRanges.js → storedDayStart()`
- **`defaultFindPartyLedgers()`** _(async)_ — line 163
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/models/ledgerMaster.model.js → findOne()`, `src/models/ledgerMaster.model.js → find()`
- **`distinctMetricIds()`** — line 179
  - Purpose: (no comment in code — see name and calls below)
- **`partyNamesIn()`** — line 181
  - Purpose: (no comment in code — see name and calls below)
- **`classifyParties()`** — line 188
  - Purpose: name -> "debtor" | "non_debtor" | "unmatched" | "ambiguous"
- **`applyPartyCounts()`** — line 204
  - Purpose: Replaces every distinct metric's name set with the number of its debtor names, in place, before any assembly (so totals, deltas, having, sort and limit all see the resolved count).
- **`customerCountWarnings()`** — line 208
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `nameList()`
- **`isTimeout()`** — line 226
  - Purpose: (no comment in code — see name and calls below)
- **`iso()`** — line 232
  - Purpose: (no comment in code — see name and calls below)
- **`rd6()`** — line 233
  - Purpose: (no comment in code — see name and calls below)
- **`periodOut()`** — line 235
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `iso()`
- **`comparisonOut()`** — line 239
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `iso()`
- **`unmappedWarning()`** — line 245
  - Purpose: Lines of items with no Stock Group in the synced master (or whose name differs from the master's) are left out of a productGroup breakdown and of its total. The count and amount were always in `mapping`; this puts them in front of the user as a warning.
- **`fyLabel()`** — line 254
  - Purpose: (no comment in code — see name and calls below)
- **`formatDateKey()`** — line 260
  - Purpose: Bucket keys come back from MongoDB as Dates (day/week/month/quarter) or an integer FY start year; turn them into stable, readable keys.
  - Calls in this file: `fyLabel()`
- **`outKey()`** — line 273
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `formatDateKey()`
- **`metricValues()`** — line 282
  - Purpose: (no comment in code — see name and calls below)
- **`toRows()`** — line 283
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `outKey()`, `metricValues()`
- **`sumValues()`** — line 285
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricValues()`
- **`amountBasisOut()`** — line 291
  - Purpose: (no comment in code — see name and calls below)
- **`growthFor()`** — line 297
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/salesAnalytics.js → computeGrowth()`
- **`refValue()`** — line 306
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`rollupProductGroups()`** — line 325
  - Purpose: Raw rows are per ITEM (key.productGroup holds the item name). Sum them into their Stock Groups; items with no master record are excluded and counted.
  - Calls in this file: `metricValues()`
- **`finalizeInMemory()`** — line 352
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricValues()`, `growthFor()`, `refValue()`, `rd6()`
  - Calls other files: `src/services/query/validator.js → parseRef()`
- **`assembleScalarComparison()`** — line 416
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricValues()`, `growthFor()`
- **`assemblePlain()`** — line 422
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricValues()`, `outKey()`
- **`assembleList()`** — line 431
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `iso()`
- **`fail()`** — line 440
  - Purpose: (no comment in code — see name and calls below)
- **`executeQuery()`** _(async)_ — line 455
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `fail()`, `defaultFindGroupItemNames()`, `defaultFindNewParties()`, `distinctMetricIds()`, `partyNamesIn()`, `defaultFindPartyLedgers()`, `classifyParties()`, `applyPartyCounts()`, `assembleList()`, `defaultLoadStockGroupMap()`, `rollupProductGroups()`, `toRows()`, `sumValues()`, `finalizeInMemory()`, `assembleScalarComparison()`, `metricValues()`, `assemblePlain()`, `unmappedWarning()`, `newPartyActivity()`, `newPartyWarnings()`, `customerCountWarnings()`, `periodOut()`, `comparisonOut()`, `amountBasisOut()`, `isTimeout()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/analytics/referenceDate.js → getTenantDateContext()`, `src/services/query/validator.js → validateQueryPlan()`, `src/services/query/compile.js → compileQuery()`

## `src/services/query/followUp.js`
**Used by:** `src/services/query/analysisPlanner.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-investigations.js`, `verify-analysis-followup.js`, `verify-ask-ai-ux-fixes.js`, `verify-followup-context.js`, `verify-group-comparison.js`, `verify-query-chat.js`, `verify-semantic-foundation.js`

**Imports:** `src/services/query/queryPlan.schema.js`

**Exports:** `readScope`, `scopeMessage`, `analysisScopeOf`, `dataWindow`, `buildQueryState`, `buildAnalysisState`, `scopeOf`, `readQueryState`, `withPendingQuestion`, `clarifiedQuestion`, `basisOf`, `STATE_VERSION`, `MAX_PENDING_CHARS`, `CARRY_KEYS`

- **`basisOf()`** — line 23
  - Purpose: What the measure of a plan was, in the user's terms. `revenue` comes from a stated definition.
- **`buildQueryState()`** — line 33
  - Purpose: The structured state persisted on the assistant message. Plain JSON; no tenant, no figures.
  - Calls in this file: `basisOf()`
- **`pad2()`** — line 38
  - Purpose: (no comment in code — see name and calls below)
- **`dataWindow()`** — line 44
  - Purpose: Where the tenant's data ends, for a follow-up to an empty answer ("take it from the last synced data"): the latest voucher's calendar day and the last COMPLETE month of data (that month when the latest voucher is its last day, else the month before). From the tenant date context (local midnight of the voucher day), never from the model.
  - Calls in this file: `pad2()`
- **`canonical()`** — line 61
  - Purpose: schema filler only: `period` is absent from `carried`, so it is never read
- **`buildAnalysisState()`** — line 72
  - Purpose: The follow-up state of an analysis turn (executed steps), or null when its steps share nothing. Steps over sales AND purchases share no entity (and so no metric: a metric's meaning depends on its entity), but still share their period: "Compare sales vs purchase ... Aug 2025" carries August 2025 (the entity is then a schema filler, outside `carried`).
  - Calls in this file: `canonical()`, `basisOf()`
- **`scopeOf()`** — line 92
  - Purpose: The carried scope of a state as a compact plain object (entity, then only the parts a follow-up may use).
- **`cleanPending()`** — line 108
  - Purpose: A question the assistant answered with a clarification ("financial or calendar year?") is kept as `pending` on that turn, so the user's reply ("2024-25") is planned TOGETHER with it - the chat sends no text history to Claude, so without it the reply would be planned alone and its metric and subject lost. Only the user's own earlier words; capped like any question. the planner's own question limit (planner.PLANNER_...
- **`withPendingQuestion()`** — line 111
  - Purpose: The state stored on a clarification turn: the earlier plan (if any) plus the question that is still open.
  - Calls in this file: `cleanPending()`
- **`clarifiedQuestion()`** — line 120
  - Purpose: The reply to a clarification, joined to the question it clarifies (unchanged when nothing is pending or it would be too long).
- **`readQueryState()`** — line 127
  - Purpose: A stored state is untrusted input: strict schema re-parse, known basis, else ignored.
  - Calls in this file: `cleanPending()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`
- **`analysisScopeOf()`** — line 167
  - Purpose: The scope handed to the ANALYSIS planner: the carried scope, plus - for a single-query state with a breakdown - its ranking.
  - Calls in this file: `scopeOf()`
- **`readScope()`** — line 179
  - Purpose: A scope as a planner may receive it: a small plain object of known keys (at least one); anything else is no scope.
- **`scopeMessage()`** — line 186
  - Purpose: (no comment in code — see name and calls below)

## `src/services/query/groupComparison.js`
**Used by:** `src/services/query/queryChat.js`

**Tested by:** `verify-group-comparison.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/answerFormatter.js`, `src/services/query/presentation.js`

**Exports:** `intentOf`, `topNOf`, `rankingOf`, `sameRanking`, `rankingPlan`, `comparisonPlan`, `computeGroups`, `formatGroupAnswer`, `buildGroupPresentation`, `groupState`, `MAX_TOP`

- **`topNOf()`** — line 40
  - Purpose: The explicit "top N" of a question, or null.
- **`intentOf()`** — line 51
  - Purpose: A top-versus-others request, or null. `pure`: nothing but the request (no period, filter or measure), so the previous ranking can be reused as it is, without a planner call. `dim`: the grouping the words name, if any.
  - Calls in this file: `topNOf()`
- **`rankingOf()`** — line 59
  - Purpose: The ranking rule of a plan ({dim, metric, n}), or null when the plan is not a ranking a top group can be cut from.
- **`sameRanking()`** — line 70
  - Purpose: (no comment in code — see name and calls below)
- **`rankingPlan()`** — line 73
  - Purpose: The ranking plan a follow-up carries: one metric, highest first, limited to the top N.
- **`comparisonPlan()`** — line 78
  - Purpose: The plan that is executed: the same ranking with every group the engine may return, plus the overall total.
  - Calls in this file: `rankingPlan()`
- **`nameOf()`** — line 80
  - Purpose: (no comment in code — see name and calls below)
- **`cents()`** — line 84
  - Purpose: (no comment in code — see name and calls below)
- **`computeGroups()`** — line 91
  - Purpose: The two groups from an executed comparison plan. {ok:false, reason} when the figures cannot be stated honestly.
  - Calls in this file: `nameOf()`, `cents()`
- **`pctText()`** — line 129
  - Purpose: (no comment in code — see name and calls below)
- **`groupLabels()`** — line 130
  - Purpose: (no comment in code — see name and calls below)
- **`countText()`** — line 131
  - Purpose: (no comment in code — see name and calls below)
- **`sameMembers()`** — line 132
  - Purpose: (no comment in code — see name and calls below)
- **`samePeriod()`** — line 133
  - Purpose: (no comment in code — see name and calls below)
- **`formatGroupAnswer()`** — line 150
  - Purpose: Text + presentation of a top-versus-others answer, from the executed comparison plan's result.
  - Calls in this file: `groupLabels()`, `computeGroups()`, `samePeriod()`, `sameMembers()`, `countText()`, `pctText()`, `buildGroupPresentation()`
  - Calls other files: `src/services/query/answerFormatter.js → formatQueryAnswer()`, `src/services/query/presentation.js → shortLabel()`, `src/services/query/presentation.js → buildPresentation()`, `src/services/query/answerFormatter.js → fmtValue()`
- **`buildGroupPresentation()`** — line 192
  - Purpose: The structured view (kind "groups"): a one-line caption (share and difference: the two things the table does not say at a glance), the two-bar chart, the group table and the top N - all from `g`. The KPI cards hold the same figures for any view that wants them; the full sentence stays in the text answer.
  - Calls in this file: `pctText()`, `countText()`
  - Calls other files: `src/services/query/presentation.js → buildPresentation()`, `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/answerFormatter.js → fmtSigned()`, `src/services/query/presentation.js → shortLabel()`, `src/services/query/presentation.js → col()`
- **`groupState()`** — line 241
  - Purpose: The follow-up state of a comparison turn: the ranking plan (limit N) and the group, as a normal query state plus `group`.

## `src/services/query/investigation.js`
**Used by:** `src/services/query/queryChat.js`

**Tested by:** `verify-decline-investigation.js`, `verify-investigation-loop.js`

**Imports:** `src/services/query/analysisPlan.js`, `src/services/query/evidence.js`

**Exports:** `investigate`, `proposeFollowUps`, `evidenceSummary`, `fingerprint`, `MAX_ROUNDS`, `MAX_TOTAL_STEPS`, `MAX_FOLLOW_UPS`, `MAX_MODEL_CALLS`, `SUMMARY_MAX_CHARS`, `OVERALL_DEADLINE_MS`

- **`canonical()`** — line 45
  - Purpose: Stable serialization (sorted keys): two plans with the same content have the same fingerprint.
- **`fingerprint()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `canonical()`
- **`freshId()`** — line 53
  - Purpose: A step id that is valid for the analysis-plan schema ([a-z][a-z0-9_]{0,23}) and not already used.
- **`remedyFor()`** — line 75
  - Purpose: The deterministic remedy of one need, built from the executed steps and the need itself (never from the question): {plan, idBase, reason} to run, or {code, reason} when none applies. rank_toward_change the same query re-ordered toward its change (not for a having-filtered step) purchases_for_fall purchases of the same product by month over the fall's window (dates from the executed steps): pre-tax line value and q...
- **`remeasures()`** — line 97
  - Purpose: What would change the decision is the model's to choose; the bounds are not: a step that only re-measures values an executed step already shows - the same entity, periods and measure, narrowed to rows that step returned, or the same breakdown again - adds nothing to the decision and is not run. Sort, limit and having are ignored (they reorder or cut the same values).
  - Calls in this file: `canonical()`
- **`proposeFollowUps()`** — line 119
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `remedyFor()`, `fingerprint()`, `freshId()`
- **`needText()`** — line 147
  - Purpose: An open need in plain words (for the model's summary and the stated limitations).
- **`stepScope()`** — line 154
  - Purpose: One executed step as the model sees it: its scope only (entity, metrics, grouping, periods, filters, order) - never rows.
- **`evidenceSummary()`** — line 169
  - Purpose: What the model is told: the open points first, then the steps already run, then the findings - capped, so the open points always survive. Built from step scopes and finding texts only (no rows, no tenant).
  - Calls in this file: `needText()`, `stepScope()`
- **`renameSteps()`** — line 183
  - Purpose: Renames a model plan's step ids so they never collide with steps already run (inputs follow the rename).
  - Calls in this file: `freshId()`
- **`proposeWithModelOnce()`** _(async)_ — line 200
  - Purpose: Asks the injected model proposer once; returns the steps to run, or the reason none run (always stated).
  - Calls in this file: `evidenceSummary()`, `fingerprint()`, `remeasures()`, `renameSteps()`
- **`addUsage()`** — line 236
  - Purpose: (no comment in code — see name and calls below)
- **`investigate()`** _(async)_ — line 251
  - Purpose: Runs an analysis plan as a bounded investigation.
  - Calls in this file: `fingerprint()`, `proposeFollowUps()`, `proposeWithModelOnce()`, `addUsage()`
  - Calls other files: `src/services/query/analysisPlan.js → executeAnalysisPlan()`, `src/services/query/evidence.js → buildEvidence()`

## `src/services/query/plainAnswer.js`
**Used by:** `src/services/query/analysisAnswer.js`, `src/services/query/queryChat.js`

**Tested by:** `verify-ask-ai-ux-fixes.js`, `verify-plain-answer.js`, `verify-plain-query-answer.js`, `verify-presentation.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/evidence.js`

**Exports:** `plainSummary`, `plainQuerySummary`, `shortMoney`, `periodWords`

- **`isMoney()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
- **`trimZeros()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`shortMoney()`** — line 19
  - Purpose: Indian short form of a money value: ₹4.77 lakh, ₹1.2 crore, ₹24,538.
  - Calls in this file: `trimZeros()`
- **`amount()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isMoney()`, `shortMoney()`
- **`pctOf()`** — line 36
  - Purpose: (no comment in code — see name and calls below)
- **`monthEnd()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
- **`dayWords()`** — line 44
  - Purpose: A day in words: "2025-08-20" -> "20 August 2025" ("20 अगस्त 2025" in hi); anything else unchanged.
- **`periodWords()`** — line 50
  - Purpose: A period in words: a whole month -> "July 2025" (Hindi month names in hi); otherwise its two dates in words.
  - Calls in this file: `monthEnd()`, `dayWords()`
- **`nounOf()`** — line 73
  - Purpose: (no comment in code — see name and calls below)
- **`dimsText()`** — line 74
  - Purpose: (no comment in code — see name and calls below)
- **`nameList()`** — line 81
  - Purpose: (no comment in code — see name and calls below)
- **`scopeName()`** — line 83
  - Purpose: What a step's filters narrow it to, in words (the names exactly as stored); null when it has none.
  - Calls in this file: `nameList()`
- **`sameFilters()`** — line 92
  - Purpose: (no comment in code — see name and calls below)
- **`subjectOf()`** — line 95
  - Purpose: Who a figure is about: the whole business only when the step has no filter; otherwise its scope by name.
  - Calls in this file: `nounOf()`, `scopeName()`
- **`plainSummary()`** — line 205
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `nounOf()`, `periodWords()`, `subjectOf()`, `amount()`, `pctOf()`, `dayWords()`, `dimsText()`, `isMoney()`, `sameFilters()`, `scopeName()`, `lastDay()`
- **`rowName()`** — line 318
  - Purpose: (no comment in code — see name and calls below)
- **`bucketWords()`** — line 320
  - Purpose: A date bucket in words: a month by name, any other bucket by the engine's own label.
  - Calls in this file: `periodWords()`, `lastDay()`
- **`plainQuerySummary()`** — line 329
  - Purpose: The plain-language opening of a single-query answer, in the question's language. Built ONLY from the engine result the text below it formats: the first metric's value (and its comparison), the first rows in the engine's own order, a trend's highest bucket. Figures are the engine's, rounded (₹4.77 lakh); no figure is derived, no model call.
  - Calls in this file: `periodWords()`, `scopeName()`, `nounOf()`, `amount()`, `subjectOf()`, `dayWords()`, `bucketWords()`, `dimsText()`, `rowName()`
  - Calls other files: `src/services/query/evidence.js → dayOf()`, `src/services/query/evidence.js → dataDayOf()`
- **`lastDay()`** — line 394
  - Purpose: The last day of the month that starts on `start` (YYYY-MM-01).
  - Calls in this file: `monthEnd()`

## `src/services/query/planner.js`
**Used by:** `src/services/query/analysisPlanner.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-ai-cost-live.js`, `eval-cache-baseline.js`, `eval-investigations.js`, `eval-nlu-models.js`, `verify-ai-cost-path.js`, `verify-ai-telemetry.js`, `verify-analysis-planner.js`, `verify-analysis-presentation.js` (+23 more)

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/query/providerAttempts.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/followUp.js`, `src/services/query/plannerResponseCache.js`

**Exports:** `planQuestion`, `uncalculableTermRefusal`, `createAnthropicPlannerClient`, `plannerRequestSettings`, `getPlannerPrompt`, `buildCatalogDigest`, `PLANNER_TOOL_NAME`, `PLANNER_MAX_TOKENS`, `PLANNER_MAX_QUESTION_CHARS`, `PLANNER_ATTEMPT_TIMEOUT_MS`, `PLANNER_MAX_RETRIES`, `PLANNER_DEADLINE_MS`, `DECLINE_CODES`, `REVENUE_ASSUMPTION`, `PRODUCT_UNIT_WORDS`, `checkPlannedQuery`, `applyPlanRules`, `mentionsRevenue`, `isRevenuePlan`, `REVENUE_BASIS_REFUSAL`, `mentionsAccountingProfit`

- **`isUnsafeQuestion()`** — line 55
  - Purpose: The safety gate applied before any Claude call.
- **`unsafeReason()`** — line 63
  - Purpose: (no comment in code — see name and calls below)
- **`mentionsRevenue()`** — line 76
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeTerms()`** — line 86
  - Purpose: Product decisions D1-D3 (final). Net sales / turnover = invoice sales AFTER returns and BEFORE tax; invoice sales = BEFORE tax and BEFORE returns. The engine has no invoice-level total before tax and cannot combine sales with returns in one figure, so these terms are REFUSED with the catalog's own reason - never answered with a nearby number (the sales total includes tax; revenue is the item lines only). An "order...
- **`carriesVoucherTotal()`** — line 126
  - Purpose: The amounts that are invoice TOTALS including tax (catalog amountBasis): a list shows them as its amount column.
- **`mentionsOrders()`** — line 136
  - Purpose: (no comment in code — see name and calls below)
- **`catalogReason()`** — line 155
  - Purpose: (no comment in code — see name and calls below)
- **`uncalculableTermRefusal()`** — line 165
  - Purpose: A refusal when the question uses a term the engine cannot calculate (D1-D3, or a supplier / different-product count) and the model nevertheless produced a plan; else null.
  - Calls in this file: `normalizeTerms()`, `catalogReason()`, `mentionsRevenue()`, `isRevenuePlan()`, `carriesVoucherTotal()`, `mentionsOrders()`
- **`withDefaultSort()`** — line 189
  - Purpose: (no comment in code — see name and calls below)
- **`catalogAmountMetric()`** — line 202
  - Purpose: (no comment in code — see name and calls below)
- **`withProductValueMetric()`** — line 205
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `catalogAmountMetric()`
- **`needsLastYearNote()`** — line 227
  - Purpose: (no comment in code — see name and calls below)
- **`isProductPlan()`** — line 242
  - Purpose: (no comment in code — see name and calls below)
- **`withProductValueDefault()`** — line 243
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isProductPlan()`, `normalizeTerms()`
- **`withProductValueSort()`** — line 259
  - Purpose: (no comment in code — see name and calls below)
- **`plannerRequestSettings()`** — line 282
  - Purpose: The request settings the real client adds to every model request (also part of the response cache's key).
- **`needsMeaning()`** — line 309
  - Purpose: A metric carries its catalog description when it is a summed amount or quantity (the basis - tax-inclusive invoice total vs pre-tax item value - matters) or a distinct count (what is counted and how it cannot be grouped). Plain counts and ratios are self-explanatory.
- **`buildCatalogDigest()`** — line 311
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `needsMeaning()`
  - Calls other files: `src/services/query/semanticCatalog.js → unsupportedLabel()`
- **`getPlannerPrompt()`** — line 353
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildCatalogDigest()`
  - Calls other files: `src/services/query/queryPlan.schema.js → queryPlanJsonSchema()`
- **`cleanText()`** — line 389
  - Purpose: Anything Claude wrote is untrusted display text: no control chars, bounded, never fed to the engine.
- **`isPlainObject()`** — line 393
  - Purpose: (no comment in code — see name and calls below)
- **`addUsage()`** — line 397
  - Purpose: (no comment in code — see name and calls below)
- **`newUsage()`** — line 404
  - Purpose: (no comment in code — see name and calls below)
- **`isRevenuePlan()`** — line 410
  - Purpose: (no comment in code — see name and calls below)
- **`statedYears()`** — line 416
  - Purpose: Years the user actually wrote: 2025, '25, 2025-26, 24-25 (both years of an FY label).
- **`readPreviousPlan()`** — line 430
  - Purpose: The previous STRUCTURED plan of the conversation (follow-ups). It is untrusted input: it must pass the same strict schema as any plan, otherwise it is ignored (the question is then planned exactly as without one). Only the plan - never chat text, answers, tool results or figures - and it is shown to Claude without its default fields.
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`
- **`readDataWindow()`** — line 445
  - Purpose: (no comment in code — see name and calls below)
- **`previousPlanMessage()`** — line 450
  - Purpose: (no comment in code — see name and calls below)
- **`plannedYears()`** — line 462
  - Purpose: Years in the previous plan's own dates were stated by the user in an earlier turn (and validated then), so a follow-up that keeps that period is not "inventing" a year.
- **`datesStated()`** — line 480
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `statedYears()`, `plannedYears()`
- **`isNewPartyPlan()`** — line 497
  - Purpose: (no comment in code — see name and calls below)
- **`failed()`** — line 501
  - Purpose: (no comment in code — see name and calls below)
- **`checkPlannedQuery()`** — line 511
  - Purpose: The question-level checks a model-written query plan must pass, as planQuestion applies them after the model answers: the decided terms (D1-D3, counts), the revenue basis, years the user never wrote, and new-party comparisons. Exported so the analysis planner applies the SAME checks to each query step; it composes the existing functions and changes none of them.
  - Calls in this file: `uncalculableTermRefusal()`, `mentionsRevenue()`, `isRevenuePlan()`, `datesStated()`, `isNewPartyPlan()`
- **`applyPlanRules()`** — line 528
  - Purpose: The decided rules that rewrite or annotate a valid, name-verified query plan, as planQuestion applies them: the complete previous month (decision 2), the product value default and value sort, and the "last year" note. Exported so the analysis planner applies the SAME rules to each query step (one implementation; the same numbers and notes for the same plan).
  - Calls in this file: `withProductValueDefault()`, `withProductValueSort()`, `needsLastYearNote()`
  - Calls other files: `src/services/query/validator.js → validateQueryPlan()`, `src/services/query/queryPlan.schema.js → parseQueryPlan()`
- **`planQuestion()`** _(async)_ — line 579
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `planQuestionCore()`, `normalizeTerms()`, `catalogReason()`
- **`planQuestionCore()`** _(async)_ — line 589
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `readPreviousPlan()`, `readDataWindow()`, `newUsage()`, `isUnsafeQuestion()`, `unsafeReason()`, `getPlannerPrompt()`, `previousPlanMessage()`, `failed()`, `addUsage()`, `isPlainObject()`, `cleanText()`, `withDefaultSort()`, `withProductValueMetric()`, `uncalculableTermRefusal()`, `mentionsRevenue()`, `isRevenuePlan()`, `datesStated()`, `isNewPartyPlan()`, `applyPlanRules()`
  - Calls other files: `src/services/query/followUp.js → readScope()`, `src/services/query/followUp.js → scopeMessage()`, `src/services/query/plannerResponseCache.js → isCachedResponse()`, `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/validator.js → validateQueryPlan()`
- **`createAnthropicPlannerClient()`** — line 799
  - Purpose: Production planner client: same request shape the fake client receives. Lazily reads the key. Bounded: explicit maxRetries (never the SDK default), a per-attempt timeout, and an overall deadline that aborts the in-flight request and rejects with code PLANNER_DEADLINE_EXCEEDED. `sdkOptions` exists only so tests can point a real SDK client at a local stub (never api.anthropic.com).
  - Calls in this file: `plannerRequestSettings()`
  - Calls other files: `src/services/query/providerAttempts.js → countingFetch()`, `src/services/query/providerAttempts.js → countedCall()`

## `src/services/query/plannerResponseCache.js`
**Used by:** `src/services/query/analysisPlanner.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-cache-baseline.js`, `verify-ai-cost-path.js`, `verify-cost-forensic.js`, `verify-planner-response-cache.js`, `harness.js`

**Imports:** `src/services/query/answerCache.js`

**Exports:** `createPlannerResponseCache`, `getSharedPlannerResponseCache`, `isCachedResponse`, `isCacheableResponse`, `CACHED_RESPONSE`, `DEFAULTS`

- **`isCachedResponse()`** — line 33
  - Purpose: True for a reply served from this cache (it was not a model call).
- **`isPlainObject()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`isCacheableResponse()`** — line 38
  - Purpose: A reply worth remembering: exactly one call of the forced tool with an object input, not cut off.
  - Calls in this file: `isPlainObject()`
- **`untilAborted()`** — line 47
  - Purpose: Resolves/rejects like `promise`, but rejects at once when `signal` aborts (a waiting request that was cancelled stops waiting).
  - Calls in this file: `abortError()`
- **`abortError()`** — line 60
  - Purpose: (no comment in code — see name and calls below)
- **`createPlannerResponseCache()`** — line 70
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `abortError()`, `isPlainObject()`, `untilAborted()`, `isCacheableResponse()`
  - Calls other files: `src/services/query/answerCache.js → stableStringify()`
- **`getSharedPlannerResponseCache()`** — line 219
  - Purpose: The process-wide cache used by the production planner client (PLANNER_RESPONSE_CACHE=off disables it).
  - Calls in this file: `createPlannerResponseCache()`

## `src/services/query/presentation.js`
**Used by:** `src/services/query/analysisPresentation.js`, `src/services/query/groupComparison.js`, `src/services/query/queryChat.js`

**Tested by:** `verify-analysis-presentation.js`, `verify-ask-ai-ux-fixes.js`, `verify-plain-query-answer.js`, `verify-presentation.js`

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/analytics/coverage.js`, `src/services/query/evidence.js`, `src/services/query/answerFormatter.js`

**Exports:** `buildPresentation`, `displayIntent`, `primaryOf`, `shortLabel`, `compareLabel`, `col`, `PRESENTATION_VERSION`

- **`shortLabel()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`isMoney()`** — line 36
  - Purpose: (no comment in code — see name and calls below)
- **`primaryOf()`** — line 37
  - Purpose: (no comment in code — see name and calls below)
- **`customLabel()`** — line 50
  - Purpose: "2025-08-01".."2025-08-31" -> "August 2025"; other ranges stay explicit.
- **`currentLabel()`** — line 59
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customLabel()`
  - Calls other files: `src/services/query/answerFormatter.js → periodText()`
- **`currentRange()`** — line 66
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`compareLabel()`** — line 73
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `customLabel()`
- **`compareRange()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/analytics/coverage.js → rangeText()`
- **`scopeOf()`** — line 92
  - Purpose: (no comment in code — see name and calls below)
- **`keyName()`** — line 96
  - Purpose: (no comment in code — see name and calls below)
- **`bucketLabel()`** — line 102
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `keyName()`
- **`money()`** — line 113
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isMoney()`
- **`col()`** — line 114
  - Purpose: (no comment in code — see name and calls below)
- **`change()`** — line 115
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `shortLabel()`
  - Calls other files: `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/answerFormatter.js → fmtSigned()`, `src/services/query/answerFormatter.js → pctOf()`
- **`build()`** — line 129
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `currentLabel()`, `currentRange()`, `scopeOf()`, `col()`, `entity()`, `primaryOf()`, `shortLabel()`, `compareLabel()`, `compareRange()`, `change()`, `money()`, `bucketLabel()`, `keyName()`
  - Calls other files: `src/services/query/evidence.js → dataDayOf()`, `src/services/query/answerFormatter.js → fmtValue()`, `src/services/query/answerFormatter.js → fmtSigned()`, `src/services/query/answerFormatter.js → pctOf()`
- **`entity()`** — line 269
  - Purpose: (no comment in code — see name and calls below)
- **`captionOf()`** — line 274
  - Purpose: The one-line reading of a chart the user asked for, from the chart's own points and formatted values (no new figure).
- **`buildPresentation()`** — line 291
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `build()`, `captionOf()`
- **`displayIntent()`** — line 306
  - Purpose: (no comment in code — see name and calls below)

## `src/services/query/providerAttempts.js`
**Used by:** `src/services/query/planner.js`

**Imports:** (none)

**Exports:** `countingFetch`, `countedCall`

- **`countingFetch()`** — line 16
  - Purpose: A fetch that counts each request it sends into the current counted call (a plain fetch outside one).
- **`countedCall()`** — line 25
  - Purpose: Runs `fn` as one counted call and marks its result (or the error it throws) with `providerAttempts`.

## `src/services/query/queryChat.js`
**Used by:** `src/controllers/chatController.js`

**Tested by:** `eval-cache-baseline.js`, `eval-investigations.js`, `verify-ai-telemetry.js`, `verify-analysis-followup.js`, `verify-analysis-planner.js`, `verify-analysis-presentation.js`, `verify-ask-ai-basic-questions.js`, `verify-calculation.js` (+14 more)

**Imports:** `src/services/query/validator.js`, `src/services/analytics/coverage.js`, `src/services/query/followUp.js`, `src/services/query/semanticCatalog.js`, `src/services/query/planner.js`, `src/services/query/plannerResponseCache.js`, `src/services/query/entityResolver.js`, `src/services/query/answerFormatter.js`, `src/services/query/presentation.js`, `src/services/query/plainAnswer.js`, `src/services/query/calculation.js`, `src/services/query/turnTelemetry.js`, `src/services/query/groupComparison.js`, `src/services/query/answerCache.js`, `src/services/query/dataVersion.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/periodEngine.js`, `src/services/query/basicAnalysis.js`, `src/services/query/analysisPlanner.js`, `src/services/query/investigation.js`, `src/services/query/analysisAnswer.js`, `src/services/query/analysisPresentation.js`, `src/services/analytics/insightTools.js`, `src/services/analytics/freshness.js`

**Exports:** `tryAnswerWithQueryEngine`, `getTenantResolver`, `createTurnDates`, `chatTelemetry`

- **`getSharedExecutor()`** — line 45
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/answerCache.js → createDefaultCachedExecutor()`
- **`getPlannerClient()`** — line 51
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/planner.js → createAnthropicPlannerClient()`
- **`turnPlannerClient()`** — line 61
  - Purpose: The model client for one turn of one tenant: every planner call of the turn (query planner, analysis planner and its repair, the investigation's follow-up) goes through it. The production client is fronted by the planner response cache (plannerResponseCache.js); an injected client (tests) is not, unless the test injects a cache too (deps.plannerResponseCache).
  - Calls in this file: `getPlannerClient()`
  - Calls other files: `src/services/query/plannerResponseCache.js → getSharedPlannerResponseCache()`
- **`getTenantResolver()`** — line 87
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `src/services/query/dataVersion.js → onBump()`, `src/services/query/entityResolver.js → createEntityResolver()`
- **`createTurnDates()`** — line 107
  - Purpose: ONE tenant date context per chat turn (reference date + coverage window), read lazily and at most once, then shared by planner validation, coverage, the executor and telemetry.
- **`baseResponse()`** — line 125
  - Purpose: (no comment in code — see name and calls below)
- **`NO_PLANNER_USAGE()`** — line 151
  - Purpose: (no comment in code — see name and calls below)
- **`RELATIVE_KIND()`** — line 157
  - Purpose: (no comment in code — see name and calls below)
- **`DAY()`** — line 158
  - Purpose: (no comment in code — see name and calls below)
- **`completePeriodNote()`** — line 165
  - Purpose: Month-end (P-SF, disclosure only - the comparison itself is unchanged): a COMPLETE current period compared like-for-like can meet a SHORTER previous period (30 Apr -> 1-30 Mar). Say so instead of hiding it.
  - Calls in this file: `DAY()`
  - Calls other files: `src/services/analytics/periodEngine.js → resolvePeriod()`, `src/services/analytics/coverage.js → rangeText()`
- **`futureVouchersNote()`** — line 179
  - Purpose: Future-dated vouchers (decision 1): relative periods end TODAY; vouchers dated later exist and are not in them.
  - Calls in this file: `RELATIVE_KIND()`
  - Calls other files: `src/services/analytics/coverage.js → fmtDay()`
- **`plannerFailureMessage()`** — line 189
  - Purpose: Honest, fixed text for a planner that failed. Only the entity-check message carries planner output, and that text is already sanitised and length-capped by the planner.
- **`ASKS_PROFIT()`** — line 213
  - Purpose: profit or margin asked next to a sales/purchase comparison: the answer says profit is not calculated
  - Calls other files: `src/services/query/planner.js → mentionsAccountingProfit()`
- **`answerAnalysis()`** _(async)_ — line 215
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `baseResponse()`, `plannerFailureMessage()`, `getSharedExecutor()`, `countingExecute()`, `countingInsight()`, `completePeriodNote()`, `futureVouchersNote()`, `questionLanguage()`, `ASKS_PROFIT()`
  - Calls other files: `src/services/query/analysisPlanner.js → planAnalysis()`, `src/services/query/basicAnalysis.js → basicShape()`, `src/services/query/investigation.js → investigate()`, `src/services/query/analysisAnswer.js → formatAnalysisAnswer()`, `src/services/query/basicAnalysis.js → salesVsPurchaseText()`, `src/services/query/basicAnalysis.js → salesVsPurchaseMismatch()`, `src/services/query/basicAnalysis.js → salesVsPurchaseMismatchText()`, `src/services/query/followUp.js → buildAnalysisState()`, `src/services/query/followUp.js → readQueryState()`, `src/services/query/analysisPresentation.js → buildAnalysisPresentation()`, `src/services/query/presentation.js → displayIntent()`
- **`countExecution()`** — line 320
  - Purpose: (no comment in code — see name and calls below)
- **`countingExecute()`** — line 324
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `countExecution()`
- **`countingInsight()`** — line 330
  - Purpose: (no comment in code — see name and calls below)
- **`recordExecution()`** — line 335
  - Purpose: (no comment in code — see name and calls below)
- **`tryAnswerWithQueryEngine()`** _(async)_ — line 361
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `answerTurn()`, `finishTurnMetrics()`
  - Calls other files: `src/services/query/followUp.js → readQueryState()`, `src/services/query/followUp.js → withPendingQuestion()`, `src/services/query/followUp.js → clarifiedQuestion()`
- **`finishTurnMetrics()`** — line 394
  - Purpose: Classifies the finished turn from what the turn itself reported (meta) - no re-derivation of routing.
- **`answerTurn()`** _(async)_ — line 420
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `turnPlannerClient()`, `getTenantResolver()`, `createTurnDates()`, `baseResponse()`, `NO_PLANNER_USAGE()`, `plannerFailureMessage()`, `answerAnalysis()`, `completePeriodNote()`, `futureVouchersNote()`, `countingExecute()`, `getSharedExecutor()`, `recordExecution()`, `questionLanguage()`, `withCalculation()`, `withPlain()`
  - Calls other files: `src/services/query/followUp.js → readQueryState()`, `src/services/query/followUp.js → clarifiedQuestion()`, `src/services/query/groupComparison.js → intentOf()`, `src/services/query/groupComparison.js → rankingOf()`, `src/services/query/planner.js → planQuestion()`, `src/services/query/followUp.js → dataWindow()`, `src/services/query/followUp.js → scopeOf()`, `src/services/query/basicAnalysis.js → analysisMode()`, `src/services/query/followUp.js → analysisScopeOf()`, `src/services/query/answerFormatter.js → formatNonAnswer()`, `src/services/query/groupComparison.js → topNOf()`, `src/services/query/groupComparison.js → sameRanking()`, `src/services/query/followUp.js → buildQueryState()`, `src/services/query/groupComparison.js → rankingPlan()`, `src/services/query/groupComparison.js → groupState()`, `src/services/query/groupComparison.js → comparisonPlan()`, `src/services/query/validator.js → validateQueryPlan()`, `src/services/analytics/coverage.js → assessCoverage()`, `src/services/query/groupComparison.js → formatGroupAnswer()`, `src/services/query/presentation.js → displayIntent()`, `src/services/query/answerFormatter.js → formatQueryAnswer()`, `src/services/query/plainAnswer.js → plainQuerySummary()`, `src/services/query/presentation.js → buildPresentation()`, `src/services/query/calculation.js → buildCalculation()`
- **`questionLanguage()`** — line 650
  - Purpose: The question's language: the planner's structured field; without it, Devanagari script means Hindi, otherwise English.
- **`withPlain()`** — line 654
  - Purpose: the view opens with the same plain sentences as the text (an analysis step's view never gets them)
- **`withCalculation()`** — line 655
  - Purpose: (no comment in code — see name and calls below)

## `src/services/query/queryPlan.schema.js`
**Used by:** `src/services/query/analysisPlan.js`, `src/services/query/analysisPlanner.js`, `src/services/query/answerCache.js`, `src/services/query/execute.js`, `src/services/query/followUp.js`, `src/services/query/planner.js`, `src/services/query/validator.js`

**Tested by:** `verify-comparison-period-capability.js`, `verify-ledger-master.js`, `verify-nlu-eval.js`, `verify-planner-digest.js`, `verify-query-dsl.js`, `verify-query-planner.js`, `verify-return-query.js`, `verify-semantic-foundation.js` (+2 more)

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
- **`normalizeNewPartyFilters()`** — line 245
  - Purpose: new_in_period has exactly one legal value, "period" (the rule is "created inside the query's own period"). The planner model sometimes sends an EMPTY value with it (nothing to say), which made the whole plan invalid ("New customers in November 2025" failed on that alone). A blank value carries no meaning, so it is set to "period" here. Any other value (a name, a month, a number) is NOT guessed at: it is still refu...
- **`parseQueryPlan()`** — line 258
  - Purpose: Structural validation of a candidate plan (an object - never a string). Returns {ok:true, plan} with defaults applied, or {ok:false, errors:[{path, code, message}]} - a stable shape safe to feed back to a planner or log. Never throws.
  - Calls in this file: `fail()`, `findForbiddenKey()`, `normalizeNewPartyFilters()`, `flattenIssues()`
- **`queryPlanJsonSchema()`** — line 288
  - Purpose: JSON Schema for the planner tool input (Phase 1F). Input-io so defaulted fields are optional.

## `src/services/query/semanticCatalog.js`
**Used by:** `src/services/query/analysisAnswer.js`, `src/services/query/analysisPlan.js`, `src/services/query/analysisPlanner.js`, `src/services/query/analysisPresentation.js`, `src/services/query/answerCache.js`, `src/services/query/answerFormatter.js`, `src/services/query/basicAnalysis.js`, `src/services/query/calculation.js`, `src/services/query/compile.js`, `src/services/query/entityResolver.js`, `src/services/query/evidence.js`, `src/services/query/execute.js`, `src/services/query/groupComparison.js`, `src/services/query/plainAnswer.js`, `src/services/query/planner.js`, `src/services/query/presentation.js`, `src/services/query/queryChat.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`

**Tested by:** `verify-analysis-planner.js`, `verify-ask-ai-basic-questions.js`, `verify-comparison-period-capability.js`, `verify-cost-forensic.js`, `verify-customer-count.js`, `verify-planner-digest.js`, `verify-query-dsl.js`, `verify-query-engine.js` (+6 more)

**Imports:** `src/services/analytics/periodEngine.js`

**Exports:** `CATALOG`, `CATALOG_VERSION`, `AMOUNT_BASIS`, `PERIOD_KINDS`, `COMPARISON_SUPPORT`, `LIMITS`, `COMPLEXITY_WEIGHTS`, `LIST_MODE`, `COMPARE`, `UNSUPPORTED_CAPABILITIES`, `PARITY_ORACLES`, `QUERY_RULES`, `computeFingerprint`, `metricsForEntity`, `dimensionsForEntity`, `nameDimensionIds`, `metricRefs`, `unsupportedLabel`, `buildCompatibilityMatrix`

- **`deepFreeze()`** — line 631
  - Purpose: (no comment in code — see name and calls below)
- **`stableStringify()`** — line 656
  - Purpose: Stable serialization (sorted keys) so the fingerprint is deterministic.
- **`computeFingerprint()`** — line 670
  - Purpose: Content hash: the answer cache (Phase 1E) keys on this, so a catalog edit invalidates cached answers automatically even if CATALOG_VERSION is forgotten.
  - Calls in this file: `stableStringify()`
- **`metricsForEntity()`** — line 676
  - Purpose: (no comment in code — see name and calls below)
- **`dimensionsForEntity()`** — line 679
  - Purpose: (no comment in code — see name and calls below)
- **`nameDimensionIds()`** — line 683
  - Purpose: Ids of the name dimensions (see DIMENSIONS), in catalog order: all of them, or only those that exist for `entityId`.
- **`unsupportedLabel()`** — line 689
  - Purpose: How an unsupported capability is named in the planner prompts: its label, else its id in plain words.
- **`metricRefs()`** — line 691
  - Purpose: (no comment in code — see name and calls below)
- **`compatibilityCell()`** — line 703
  - Purpose: (no comment in code — see name and calls below)
- **`buildCompatibilityMatrix()`** — line 728
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `metricsForEntity()`, `dimensionsForEntity()`, `compatibilityCell()`

## `src/services/query/turnTelemetry.js`
**Used by:** `src/services/query/answerCache.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-cache-baseline.js`, `verify-ai-telemetry.js`, `verify-ai-usage-persist.js`, `verify-analysis-planner.js`, `verify-cache-telemetry.js`, `verify-chat-management.js`, `verify-planner-response-cache.js`, `verify-revenue-analysis-guard.js` (+1 more)

**Imports:** `src/services/query/usageStore.js`

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
- **`newTurnMetrics()`** — line 46
  - Purpose: Mutable per-turn metrics bag filled in by queryChat; plain numbers/codes only.
- **`timeResolver()`** — line 51
  - Purpose: Pass-through resolver wrapper: same arguments, same result, same error - only timed and counted.
  - Calls in this file: `now()`
- **`timeEngineDeps()`** — line 74
  - Purpose: Answer-cache deps with the engine call timed (same functions, arguments and results).
  - Calls in this file: `now()`
- **`sink()`** — line 89
  - Purpose: (no comment in code — see name and calls below)
- **`setTelemetrySink()`** — line 91
  - Purpose: Tests only: replace the sink (returns the previous one).
- **`buildTurnEvent()`** — line 98
  - Purpose: Build the allow-listed event. Pure; exported so tests can inspect exactly what would be logged.
- **`emitTurnEvent()`** — line 116
  - Purpose: Emit one event. Never throws: telemetry failure must not affect the chat turn.
  - Calls in this file: `buildTurnEvent()`, `sink()`
  - Calls other files: `src/services/query/usageStore.js → persistTurnUsage()`
- **`emitChatTurn()`** — line 135
  - Purpose: Controller hook: adds the turn-level facts (latency, status, date context) to the query-engine metrics and emits once. Never throws.
  - Calls in this file: `emitTurnEvent()`

## `src/services/query/usageStore.js`
**Used by:** `src/services/query/turnTelemetry.js`

**Tested by:** `eval-cache-baseline.js`, `verify-ai-cost-path.js`, `verify-ai-usage-persist.js`, `verify-analysis-planner.js`, `verify-cache-telemetry.js`, `harness.js`

**Imports:** `src/services/query/aiPricing.js`, `src/models/aiTurnUsage.model.js`

**Exports:** `buildUsageRecord`, `persistTurnUsage`, `setUsageWriter`, `plannerModel`

- **`model()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
- **`plannerModel()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `model()`
- **`n()`** — line 18
  - Purpose: (no comment in code — see name and calls below)
- **`aiPathOf()`** — line 20
  - Purpose: (no comment in code — see name and calls below)
- **`failureCategoryOf()`** — line 25
  - Purpose: (no comment in code — see name and calls below)
- **`buildUsageRecord()`** — line 32
  - Purpose: Pure: the persisted document, built only from the already-sanitised telemetry event.
  - Calls in this file: `n()`, `aiPathOf()`, `plannerModel()`, `failureCategoryOf()`
  - Calls other files: `src/services/query/aiPricing.js → estimateCost()`
- **`writer()`** _(async)_ — line 87
  - Purpose: Default writer: upsert on requestId ($setOnInsert) so a repeated emit for one request never duplicates; no request id -> plain insert. Dropped when Mongo is not connected, so it can never block on buffering.
  - Calls other files: `src/models/aiTurnUsage.model.js → updateOne()`, `src/models/aiTurnUsage.model.js → create()`
- **`setUsageWriter()`** — line 96
  - Purpose: Tests only: replace the writer (returns the previous one).
- **`persistTurnUsage()`** — line 103
  - Purpose: Fire-and-forget. Never throws; the caller never awaits it.
  - Calls in this file: `buildUsageRecord()`, `writer()`

## `src/services/query/validator.js`
**Used by:** `src/services/query/analysisPlan.js`, `src/services/query/analysisPlanner.js`, `src/services/query/compile.js`, `src/services/query/execute.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`

**Tested by:** `eval-cache-baseline.js`, `eval-findings-real.js`, `verify-comparison-period-capability.js`, `verify-customer-count.js`, `verify-group-comparison.js`, `verify-growth-comparison-capability.js`, `verify-ledger-master.js`, `verify-month-boundary-dates.js` (+10 more)

**Imports:** `src/services/query/semanticCatalog.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/dateRanges.js`, `src/services/query/queryPlan.schema.js`

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
  - Calls other files: `src/services/analytics/dateRanges.js → customRange()`, `src/services/analytics/periodEngine.js → resolvePeriod()`
- **`sameRange()`** — line 77
  - Purpose: (no comment in code — see name and calls below)
- **`resolveComparison()`** — line 79
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `sameRange()`
  - Calls other files: `src/services/analytics/periodEngine.js → resolveComparisonPeriod()`, `src/services/analytics/periodEngine.js → resolvePeriod()`, `src/services/analytics/dateRanges.js → customRange()`, `src/services/analytics/periodEngine.js → resolveSamePeriodLastYear()`
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
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `refuse()`, `parseRef()`, `isMetricId()`, `isDimensionId()`, `NEEDS_REFERENCE_DATE()`, `resolvePlanPeriod()`, `spanDays()`, `resolveComparison()`, `estimateBuckets()`, `defaultSort()`, `deepFreeze()`
  - Calls other files: `src/services/query/queryPlan.schema.js → parseQueryPlan()`, `src/services/query/semanticCatalog.js → metricsForEntity()`, `src/services/query/semanticCatalog.js → dimensionsForEntity()`, `src/services/query/semanticCatalog.js → buildCompatibilityMatrix()`, `src/services/analytics/dateRanges.js → customRange()`
- **`deepFreeze()`** — line 401
  - Purpose: A validated plan is immutable: the brand above proves the compiler is handed exactly what the validator approved, not something edited since.


# 15. Frontend: pages

## `frontend/src/pages/Analytics.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/Card.jsx`

**Exports:** `Analytics (default)`

- **`Analytics()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/Card.jsx → <Card>`

## `frontend/src/pages/AskAI.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/chat/ChatSidebarList.jsx`, `frontend/src/components/chat/ChatBubble.jsx`, `frontend/src/components/chat/ChatInput.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/api/chat.js`, `frontend/src/api/client.js`

**Exports:** `AskAI (default)`

- **`isWide()`** — line 14
  - Purpose: (no comment in code — see name and calls below)
- **`initialHistoryOpen()`** — line 20
  - Purpose: Narrow screens always start with the drawer closed. Wide screens use the user's last choice, else open only when there is room to spare (2xl), so a 1280px laptop starts with the full width for the conversation.
  - Calls in this file: `isWide()`
- **`AskAI()`** — line 34
  - Purpose: Local turn state is one of: a message ({role, text, ...} as stored in the backend's Chat model), a "stopped" note after the user pressed Stop, or an "error" with a Retry. Answers only ever come back from the backend.
  - Calls in this file: `isWide()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/api/chat.js → listChats()`, `frontend/src/api/chat.js → getChat()`, `frontend/src/api/chat.js → deleteChat()`, `frontend/src/api/chat.js → renameChat()`, `frontend/src/api/chat.js → sendChatMessage()`
  - Renders: `frontend/src/components/chat/ChatSidebarList.jsx → <ChatSidebarList>`, `frontend/src/components/chat/ChatBubble.jsx → <ChatBubble>`, `frontend/src/components/chat/ChatInput.jsx → <ChatInput>`

## `frontend/src/pages/CustomersAnalytics.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/components/ui/MiniStatCard.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/components/charts/DonutChart.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/lib/useAsync.js`, `frontend/src/lib/usePersistedRange.js`, `frontend/src/lib/format.js`, `frontend/src/lib/dateRange.js`, `frontend/src/api/analytics.js`

**Exports:** `CustomersAnalytics (default)`

- **`loadCustomersAnalytics()`** _(async)_ — line 32
  - Purpose: Exact definitions used below (deliberately explicit, all derived from Sale.header.partyName — no invented "customer" concept): Total Customers - distinct parties across this tenant's ENTIRE sales history (all-time, ignores the picker). Active Customers - distinct parties with >=1 sale in the picked range. New Customers - of those active-in-range parties, how many had their first-ever sale (all-time) fall inside th...
  - Calls other files: `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/api/analytics.js → getTopCustomers()`, `frontend/src/api/analytics.js → getCustomerCounts()`
- **`CustomersAnalytics()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `loadCustomersAnalytics()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/usePersistedRange.js → usePersistedRange()`, `frontend/src/lib/useAsync.js → useAsync()`, `frontend/src/lib/format.js → formatNumber()`, `frontend/src/lib/format.js → formatCurrency()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/FilterBar.jsx → <FilterBar>`, `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/MiniStatCard.jsx → <MiniStatCard>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <StaleDataBanner>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <AnalyticsNotice>`, `frontend/src/components/ui/Table.jsx → <Table>`, `frontend/src/components/charts/DonutChart.jsx → <DonutChart>`

## `frontend/src/pages/Dashboard.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/FreshnessBadge.jsx`, `frontend/src/components/ui/KpiCard.jsx`, `frontend/src/components/ui/Skeleton.jsx`, `frontend/src/components/charts/ComparisonBarChart.jsx`, `frontend/src/components/charts/DonutChart.jsx`, `frontend/src/components/charts/LineTrendChart.jsx`, `frontend/src/components/dashboard/RecentActivity.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/lib/useAsync.js`, `frontend/src/lib/format.js`, `frontend/src/lib/period.js`, `frontend/src/api/analytics.js`, `frontend/src/api/sync.js`

**Exports:** `Dashboard (default)`

- **`loadDashboard()`** _(async)_ — line 49
  - Purpose: Real (Analytics Engine + sync status, via REST), all anchored to this tenant's own most recent synced voucher date rather than the wall clock (see backend referenceDate.js — a tenant whose Tally sync is months behind the system clock would otherwise show an empty "current month" forever, which is misleading, not honest): - Total Sales / Total Purchases + growth deltas - Avg Invoice Value (Sales Summary's own avera...
  - Calls other files: `frontend/src/api/analytics.js → getSalesSummary()`, `frontend/src/api/analytics.js → getPurchaseSummary()`, `frontend/src/api/analytics.js → getSalesComparison()`, `frontend/src/api/analytics.js → getPurchaseComparison()`, `frontend/src/api/analytics.js → getTopProducts()`, `frontend/src/api/analytics.js → getSalesTrend()`, `frontend/src/api/analytics.js → getCustomerCounts()`, `frontend/src/api/sync.js → getSyncStatus()`
- **`buildRecentActivity()`** — line 82
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/format.js → formatCompactCurrency()`, `frontend/src/lib/format.js → formatRelativeTime()`
- **`kpiHint()`** — line 108
  - Purpose: A short, honest caption for why a KPI shows "—" instead of a number - never invents a reason, just clarifies the backend's own state. The Dashboard's "current month" is anchored to this tenant's own latest synced voucher (see loadDashboard's comment above), so a zero_result here means there's genuinely no data in that most-recent period, not that the query missed real data - not an error. Other states show the bac...
- **`reportLink()`** — line 117
  - Purpose: {to, label} for a KPI's report link, or undefined when the envelope carries no usable period (the card then stays a plain, non-clickable card).
  - Calls other files: `frontend/src/lib/period.js → calendarDatesOf()`, `frontend/src/lib/period.js → buildReportsLink()`, `frontend/src/lib/period.js → formatIsoRange()`
- **`Dashboard()`** — line 123
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `reportLink()`, `kpiHint()`, `buildRecentActivity()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/useAsync.js → useAsync()`, `frontend/src/lib/format.js → formatCompactCurrency()`, `frontend/src/lib/format.js → formatCurrency()`, `frontend/src/lib/format.js → formatNumber()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/FreshnessBadge.jsx → <FreshnessBadge>`, `this file → <DashboardSkeleton>`, `frontend/src/components/ui/KpiCard.jsx → <KpiCard>`, `frontend/src/components/charts/ComparisonBarChart.jsx → <ComparisonBarChart>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <AnalyticsNotice>`, `frontend/src/components/charts/DonutChart.jsx → <DonutChart>`, `frontend/src/components/charts/LineTrendChart.jsx → <LineTrendChart>`, `frontend/src/components/dashboard/RecentActivity.jsx → <RecentActivity>`
- **`DashboardSkeleton()`** — line 268
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/Skeleton.jsx → <KpiCardSkeleton>`, `frontend/src/components/ui/Skeleton.jsx → <ChartCardSkeleton>`

## `frontend/src/pages/ProductsAnalytics.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/components/ui/Tabs.jsx`, `frontend/src/components/ui/Badge.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/components/charts/SimpleBarChart.jsx`, `frontend/src/components/charts/ComparisonBarChart.jsx`, `frontend/src/components/ui/Select.jsx`, `frontend/src/components/ui/Skeleton.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/lib/useAsync.js`, `frontend/src/lib/usePersistedRange.js`, `frontend/src/lib/format.js`, `frontend/src/lib/dateRange.js`, `frontend/src/api/analytics.js`

**Exports:** `ProductsAnalytics (default)`

- **`loadProductsAnalytics()`** _(async)_ — line 35
  - Purpose: Real (Analytics Engine, via REST): Top Products follows the date range picked above (period=custom). Growing/Declining Products compare this month to last month — the Analytics Engine's growth comparisons are fixed month-over-month, not tied to an arbitrary picked range, so those two tabs don't move with the picker (noted inline). Product Performance below reuses the same Top Products result — no separate chart-on...
  - Calls other files: `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/api/analytics.js → getTopProducts()`, `frontend/src/api/analytics.js → getGrowingProducts()`, `frontend/src/api/analytics.js → getDecliningProducts()`
- **`signed()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/format.js → formatCurrency()`
- **`tone()`** — line 57
  - Purpose: (no comment in code — see name and calls below)
- **`qtyTone()`** — line 59
  - Purpose: a net quantity of exactly zero is neither good nor bad
- **`signedQty()`** — line 60
  - Purpose: (no comment in code — see name and calls below)
- **`normalizeRows()`** — line 65
  - Purpose: Normalizes the three tabs' different real shapes into one row shape: Top Products: {itemName, totalAmount, totalQuantity, orderCount} Growing/Declining: {itemName, current, previous, growthAmount, growthPercentage, isNew}
- **`ProductsAnalytics()`** — line 109
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `loadProductsAnalytics()`, `normalizeRows()`, `tone()`, `signed()`, `qtyTone()`, `signedQty()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/usePersistedRange.js → usePersistedRange()`, `frontend/src/lib/useAsync.js → useAsync()`, `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/api/analytics.js → getProductMargin()`, `frontend/src/api/analytics.js → getProductTrend()`, `frontend/src/lib/format.js → formatCurrency()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/FilterBar.jsx → <FilterBar>`, `frontend/src/components/ui/Tabs.jsx → <Tabs>`, `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Skeleton.jsx → <TableSkeleton>`, `frontend/src/components/ui/Skeleton.jsx → <ChartCardSkeleton>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <StaleDataBanner>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <AnalyticsNotice>`, `frontend/src/components/ui/Table.jsx → <Table>`, `frontend/src/components/ui/Select.jsx → <Select>`, `frontend/src/components/ui/Badge.jsx → <Badge>`, `frontend/src/components/charts/ComparisonBarChart.jsx → <ComparisonBarChart>`, `frontend/src/components/charts/SimpleBarChart.jsx → <SimpleBarChart>`

## `frontend/src/pages/PurchaseAnalytics.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/components/ui/MiniStatCard.jsx`, `frontend/src/components/ui/Tabs.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/components/charts/LineTrendChart.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/lib/useAsync.js`, `frontend/src/lib/usePersistedRange.js`, `frontend/src/lib/format.js`, `frontend/src/lib/dateRange.js`, `frontend/src/api/analytics.js`, `frontend/src/api/vouchers.js`, `frontend/src/components/vouchers/VoucherRegister.jsx`

**Exports:** `PurchaseAnalytics (default)`

- **`loadPurchaseAnalytics()`** _(async)_ — line 46
  - Purpose: Real (Analytics Engine, via REST): Total Purchases, Total Bills, Avg Bill Value (from Purchase Summary, scoped to the date range above), Growth (Purchase Comparison, fixed vs last month — same month-over-month-only limitation as Sales Analytics), Top Suppliers (getTopSuppliers, mirrors Sales' getTopCustomers on the Purchase collection's party/supplier ledger name), and a real monthly Trend (GET /analytics/purchase...
  - Calls other files: `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/api/analytics.js → getPurchaseSummary()`, `frontend/src/api/analytics.js → getPurchaseComparison()`, `frontend/src/api/analytics.js → getTopSuppliers()`, `frontend/src/api/analytics.js → getPurchaseTrend()`, `frontend/src/api/analytics.js → getSupplierRates()`, `frontend/src/api/analytics.js → getDiscountSummary()`
- **`PurchaseAnalytics()`** — line 64
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `loadPurchaseAnalytics()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/usePersistedRange.js → usePersistedRange()`, `frontend/src/lib/useAsync.js → useAsync()`, `frontend/src/lib/format.js → formatCompactCurrency()`, `frontend/src/lib/format.js → formatNumber()`, `frontend/src/lib/format.js → formatCurrency()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/FilterBar.jsx → <FilterBar>`, `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <StaleDataBanner>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <AnalyticsNotice>`, `frontend/src/components/ui/MiniStatCard.jsx → <MiniStatCard>`, `frontend/src/components/ui/Tabs.jsx → <Tabs>`, `frontend/src/components/charts/LineTrendChart.jsx → <LineTrendChart>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/Table.jsx → <Table>`, `frontend/src/components/vouchers/VoucherRegister.jsx → <VoucherRegister>`

## `frontend/src/pages/Reports.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/components/ui/Tabs.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/MiniStatCard.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/components/ui/EmptyState.jsx`, `frontend/src/components/reports/ReportTable.jsx`, `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/lib/usePersistedRange.js`, `frontend/src/lib/useDebouncedValue.js`, `frontend/src/lib/format.js`, `frontend/src/lib/dateRange.js`, `frontend/src/lib/period.js`, `frontend/src/api/analytics.js`, `frontend/src/api/vouchers.js`, `frontend/src/api/reports.js`

**Exports:** `Reports (default)`

- **`Reports()`** — line 60
  - Purpose: Real, generated on demand from the same Analytics Engine/voucher infrastructure every other screen uses — nothing here is precomputed or sample data. Sales/Purchase Report reuse the existing summary endpoints (GET /analytics/sales|purchases/summary) for the header KPIs and the existing paginated/searched voucher listing (GET /api/vouchers/sales|purchases, via VoucherRegister) for the line items — no new backend wo...
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/period.js → readReportsDeepLink()`, `frontend/src/lib/usePersistedRange.js → usePersistedRange()`, `frontend/src/lib/dateRange.js → parseDateInputValue()`, `frontend/src/lib/useDebouncedValue.js → useDebouncedValue()`, `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/api/reports.js → exportSalesReport()`, `frontend/src/api/reports.js → exportPurchaseReport()`, `frontend/src/api/reports.js → exportProductReport()`, `frontend/src/api/reports.js → exportCustomerReport()`, `frontend/src/lib/period.js → formatIsoRange()`, `frontend/src/lib/format.js → formatCompactCurrency()`, `frontend/src/lib/format.js → formatNumber()`, `frontend/src/lib/format.js → formatCurrency()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/Tabs.jsx → <Tabs>`, `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/EmptyState.jsx → <EmptyState>`, `frontend/src/components/ui/FilterBar.jsx → <FilterBar>`, `frontend/src/components/ui/Button.jsx → <Button>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <AnalyticsNotice>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <StaleDataBanner>`, `frontend/src/components/ui/MiniStatCard.jsx → <MiniStatCard>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/vouchers/VoucherRegister.jsx → <VoucherRegister>`, `frontend/src/components/reports/ReportTable.jsx → <ReportTable>`

## `frontend/src/pages/SalesAnalytics.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/components/ui/MiniStatCard.jsx`, `frontend/src/components/ui/Tabs.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/components/charts/LineTrendChart.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/lib/useAsync.js`, `frontend/src/lib/usePersistedRange.js`, `frontend/src/lib/format.js`, `frontend/src/lib/dateRange.js`, `frontend/src/api/analytics.js`, `frontend/src/api/vouchers.js`, `frontend/src/components/vouchers/VoucherRegister.jsx`

**Exports:** `SalesAnalytics (default)`

- **`loadSalesAnalytics()`** _(async)_ — line 51
  - Purpose: Real (Analytics Engine, via REST): Total Sales, Total Invoices, Avg Invoice Value (all from Sales Summary, scoped to the date range picked above), Top Customers and Top Products (same range). Growth compares this month to last month — the Analytics Engine only supports fixed month-over-month/year-over-year comparisons, not an arbitrary-range-vs-arbitrary-range one, so it does not follow the picker above (noted inl...
  - Calls other files: `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/api/analytics.js → getSalesSummary()`, `frontend/src/api/analytics.js → getSalesComparison()`, `frontend/src/api/analytics.js → getTopProducts()`, `frontend/src/api/analytics.js → getTopCustomers()`, `frontend/src/api/analytics.js → getSalesTrend()`, `frontend/src/api/analytics.js → getDiscountSummary()`
- **`SalesAnalytics()`** — line 70
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `loadSalesAnalytics()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/usePersistedRange.js → usePersistedRange()`, `frontend/src/lib/useAsync.js → useAsync()`, `frontend/src/lib/format.js → formatCompactCurrency()`, `frontend/src/lib/format.js → formatNumber()`, `frontend/src/lib/format.js → formatCurrency()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/FilterBar.jsx → <FilterBar>`, `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <StaleDataBanner>`, `frontend/src/components/ui/AnalyticsNotice.jsx → <AnalyticsNotice>`, `frontend/src/components/ui/MiniStatCard.jsx → <MiniStatCard>`, `frontend/src/components/ui/Tabs.jsx → <Tabs>`, `frontend/src/components/charts/LineTrendChart.jsx → <LineTrendChart>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/Table.jsx → <Table>`, `frontend/src/components/vouchers/VoucherRegister.jsx → <VoucherRegister>`

## `frontend/src/pages/Settings.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/Badge.jsx`, `frontend/src/context/useAuth.js`, `frontend/src/context/useCompany.js`, `frontend/src/lib/useTallyConnectionTest.js`, `frontend/src/api/auth.js`, `frontend/src/api/client.js`, `frontend/src/components/company/AddCompanyModal.jsx`

**Exports:** `Settings (default)`

- **`Settings()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `this file → <CompanyTab>`, `this file → <ProfileTab>`, `this file → <PreferencesTab>`, `this file → <TallyTab>`
- **`CompanyTab()`** — line 57
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/api/auth.js → renameActiveCompany()`
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/Input.jsx → <Input>`, `frontend/src/components/ui/Button.jsx → <Button>`, `frontend/src/components/ui/Badge.jsx → <Badge>`, `frontend/src/components/company/AddCompanyModal.jsx → <AddCompanyModal>`
- **`ProfileTab()`** — line 150
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/Input.jsx → <Input>`
- **`PreferencesTab()`** — line 168
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `this file → <Toggle>`
- **`TallyTab()`** — line 183
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/useTallyConnectionTest.js → useTallyConnectionTest()`
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/Button.jsx → <Button>`, `frontend/src/components/ui/Badge.jsx → <Badge>`
- **`Toggle()`** — line 209
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/pages/SyncData.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/ui/PageHeader.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/Badge.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/Tabs.jsx`, `frontend/src/components/ui/EmptyState.jsx`, `frontend/src/components/ui/Skeleton.jsx`, `frontend/src/api/imports.js`, `frontend/src/api/sync.js`, `frontend/src/api/client.js`, `frontend/src/lib/usePolling.js`, `frontend/src/lib/useTallyConnectionTest.js`, `frontend/src/context/useCompany.js`, `frontend/src/lib/format.js`, `frontend/src/lib/dateRange.js`

**Exports:** `SyncData (default)`

- **`todayLocal()`** — line 35
  - Purpose: Local midnight for "today" — never toISOString()/UTC, which would silently shift the default range back a day for anyone east of UTC (the exact bug already found and fixed on the Analytics pages' FilterBar). This is what makes "today" genuinely the user's local today, not a UTC-shifted one.
- **`formatTimestamp()`** — line 40
  - Purpose: (no comment in code — see name and calls below)
- **`IncrementalStatusBadge()`** — line 53
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/Badge.jsx → <Badge>`
- **`ReconciliationStatusBadge()`** — line 60
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/Badge.jsx → <Badge>`
- **`SyncData()`** — line 91
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `todayLocal()`, `formatTimestamp()`
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/useTallyConnectionTest.js → useTallyConnectionTest()`, `frontend/src/lib/usePolling.js → usePolling()`, `frontend/src/lib/dateRange.js → toDateInputValue()`, `frontend/src/lib/dateRange.js → parseDateInputValue()`, `frontend/src/api/imports.js → importTallyLive()`, `frontend/src/lib/dateRange.js → formatRangeLabel()`
  - Renders: `frontend/src/components/ui/PageHeader.jsx → <PageHeader>`, `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/Button.jsx → <Button>`, `frontend/src/components/ui/Badge.jsx → <Badge>`, `this file → <IncrementalStatusBadge>`, `this file → <Row>`, `frontend/src/components/ui/Input.jsx → <Input>`, `this file → <ReconciliationStatusBadge>`, `frontend/src/components/ui/Tabs.jsx → <Tabs>`, `frontend/src/components/ui/Skeleton.jsx → <TableSkeleton>`, `frontend/src/components/ui/EmptyState.jsx → <EmptyState>`, `frontend/src/components/ui/Table.jsx → <Table>`
- **`Row()`** — line 341
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/pages/auth/AuthLayout.jsx`
**Used by:** `frontend/src/pages/auth/ConnectCompany.jsx`, `frontend/src/pages/auth/Login.jsx`, `frontend/src/pages/auth/Register.jsx`

**Imports:** (none)

**Exports:** `AuthLayout (default)`

- **`AuthLayout()`** — line 10
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/pages/auth/ConnectCompany.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/pages/auth/AuthLayout.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/context/useAuth.js`, `frontend/src/api/client.js`

**Exports:** `ConnectCompany (default)`

- **`ConnectCompany()`** — line 12
  - Purpose: "Connect Tally": the last onboarding step. The user opens their company in TallyPrime and clicks one button - the backend detects which company is open and connects it. Nothing about the company is typed here.
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`
  - Renders: `frontend/src/pages/auth/AuthLayout.jsx → <AuthLayout>`, `frontend/src/components/ui/Button.jsx → <Button>`

## `frontend/src/pages/auth/Login.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/pages/auth/AuthLayout.jsx`, `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/context/useAuth.js`, `frontend/src/api/client.js`

**Exports:** `Login (default)`

- **`Login()`** — line 10
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`
  - Renders: `frontend/src/pages/auth/AuthLayout.jsx → <AuthLayout>`, `frontend/src/components/ui/Input.jsx → <Input>`, `frontend/src/components/ui/Button.jsx → <Button>`

## `frontend/src/pages/auth/Register.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/pages/auth/AuthLayout.jsx`, `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/context/useAuth.js`, `frontend/src/api/client.js`

**Exports:** `Register (default)`

- **`Register()`** — line 13
  - Purpose: Just an account: name, email, password. Registering signs the user in and the app then sends them to "Connect Tally", where their TallyPrime company is detected automatically - no company name, ID or GUID is ever typed.
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`
  - Renders: `frontend/src/pages/auth/AuthLayout.jsx → <AuthLayout>`, `frontend/src/components/ui/Input.jsx → <Input>`, `frontend/src/components/ui/Button.jsx → <Button>`


# 15. Frontend: components

## `frontend/src/components/charts/ComparisonBarChart.jsx`
**Used by:** `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`

**Exports:** `ComparisonBarChart (default)`

- **`CustomTooltip()`** — line 4
  - Purpose: (no comment in code — see name and calls below)
- **`ComparisonBarChart()`** — line 19
  - Purpose: data: [{ label, sales, purchases }]; valueFormat: "currency" (default: rupees, axis in k) or "number" (plain quantities)
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `this file → <CustomTooltip>`

## `frontend/src/components/charts/DonutChart.jsx`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`

**Exports:** `DonutChart (default)`

- **`defaultValueFormatter()`** — line 6
  - Purpose: (no comment in code — see name and calls below)
- **`CustomTooltip()`** — line 8
  - Purpose: (no comment in code — see name and calls below)
- **`DonutChart()`** — line 22
  - Purpose: data: [{ name, value }], centerLabel/centerValue shown in the donut hole. `value` is a currency amount by default (valueFormatter); pass a plain formatter (e.g. a count) for non-currency data.
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `this file → <CustomTooltip>`

## `frontend/src/components/charts/LineTrendChart.jsx`
**Used by:** `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`

**Exports:** `LineTrendChart (default)`

- **`CustomTooltip()`** — line 12
  - Purpose: (no comment in code — see name and calls below)
- **`LineTrendChart()`** — line 27
  - Purpose: data: [{ label, value }] or with a second series via valueKey2
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `this file → <CustomTooltip>`

## `frontend/src/components/charts/SimpleBarChart.jsx`
**Used by:** `frontend/src/pages/ProductsAnalytics.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`

**Exports:** `SimpleBarChart (default)`

- **`CustomTooltip()`** — line 4
  - Purpose: (no comment in code — see name and calls below)
- **`SimpleBarChart()`** — line 15
  - Purpose: data: [{ label, value, negative? }] — negative entries render in red
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `this file → <CustomTooltip>`

## `frontend/src/components/chat/ChatBubble.jsx`
**Used by:** `frontend/src/pages/AskAI.jsx`

**Imports:** `frontend/src/components/ui/FreshnessBadge.jsx`, `frontend/src/components/chat/MarkdownMessage.jsx`, `frontend/src/components/chat/present/PresentationView.jsx`, `frontend/src/components/chat/present/AnalysisView.jsx`, `frontend/src/components/chat/present/isPresentation.js`, `frontend/src/components/chat/present/CalculationPanel.jsx`, `frontend/src/lib/cn.js`

**Exports:** `ChatBubble (default)`

- **`variantOf()`** — line 22
  - Purpose: Visual variant from fields the backend already sends - nothing is re-requested or inferred from the text. `details` exists only on a live turn (not persisted), so a reloaded clarification shows as a normal answer.
- **`ChatBubble()`** — line 41
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `variantOf()`
  - Calls other files: `frontend/src/components/chat/present/isPresentation.js → isPresentation()`, `frontend/src/components/chat/present/isPresentation.js → hasCalculation()`, `frontend/src/lib/cn.js → cn()`
  - Renders: `frontend/src/components/chat/present/AnalysisView.jsx → <AnalysisView>`, `frontend/src/components/chat/present/PresentationView.jsx → <PresentationView>`, `frontend/src/components/chat/MarkdownMessage.jsx → <MarkdownMessage>`, `frontend/src/components/chat/present/CalculationPanel.jsx → <CalculationPanel>`, `frontend/src/components/ui/FreshnessBadge.jsx → <FreshnessBadge>`

## `frontend/src/components/chat/ChatInput.jsx`
**Used by:** `frontend/src/pages/AskAI.jsx`

**Imports:** (none)

**Exports:** `ChatInput (default)`

- **`ChatInput()`** — line 6
  - Purpose: While a request is running the Send button becomes Stop (same size and place: no layout jump). The text field stays editable so the next question can be typed, but Enter does nothing until the turn ends.

## `frontend/src/components/chat/ChatSidebarList.jsx`
**Used by:** `frontend/src/pages/AskAI.jsx`

**Imports:** `frontend/src/api/chat.js`, `frontend/src/lib/cn.js`

**Exports:** `ChatSidebarList (default)`

- **`ChatSidebarList()`** — line 9
  - Purpose: Per-chat actions (⋯ → Rename / Delete) open inline under the row, so they are never clipped by the scrolling list. Selecting a chat, renaming it and deleting it are three separate controls: clicking the row only ever opens the chat.
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/chat/MarkdownMessage.jsx`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`, `frontend/src/components/chat/present/AnalysisView.jsx`

**Imports:** `frontend/src/lib/markdownText.js`

**Exports:** `MarkdownMessage (default)`

- **`MarkdownMessage()`** — line 78
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/markdownText.js → separateListTrailers()`

## `frontend/src/components/chat/present/AnalysisView.jsx`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`

**Imports:** `frontend/src/components/chat/present/PresentationView.jsx`, `frontend/src/components/chat/present/direction.js`, `frontend/src/components/chat/present/DataTable.jsx`, `frontend/src/components/chat/MarkdownMessage.jsx`, `frontend/src/lib/cn.js`

**Exports:** `AnalysisView (default)`

- **`stepRef()`** — line 13
  - Purpose: (no comment in code — see name and calls below)
- **`StepRef()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `stepRef()`
- **`KpiCards()`** — line 21
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`
- **`FindingList()`** — line 45
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`
  - Renders: `this file → <StepRef>`
- **`InsightStep()`** — line 71
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/chat/present/DataTable.jsx → <DataTable>`
- **`StepBody()`** — line 99
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `this file → <InsightStep>`, `frontend/src/components/chat/present/PresentationView.jsx → <PresentationView>`, `frontend/src/components/chat/MarkdownMessage.jsx → <MarkdownMessage>`
- **`AnalysisView()`** — line 109
  - Purpose: Default view: the visuals first (a sales/purchases pair, else the featured step; then any other part of a multi-part question), the KPI cards, then only the findings the visuals do not already show, and every accounting basis once. Interpretation lines, numbered steps, step references, the label legend and findings the KPI cards repeat are in Details.
  - Renders: `this file → <FindingList>`, `frontend/src/components/chat/present/PresentationView.jsx → <PlainSummary>`, `frontend/src/components/chat/MarkdownMessage.jsx → <MarkdownMessage>`, `frontend/src/components/chat/present/PresentationView.jsx → <PresentationView>`, `this file → <StepBody>`, `this file → <KpiCards>`, `frontend/src/components/chat/present/PresentationView.jsx → <Fold>`

## `frontend/src/components/chat/present/CalculationPanel.jsx`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`

**Imports:** (none)

**Exports:** `CalculationView`, `CalculationPanel (default)`

- **`day()`** — line 9
  - Purpose: (no comment in code — see name and calls below)
- **`range()`** — line 13
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `day()`
- **`money()`** — line 14
  - Purpose: (no comment in code — see name and calls below)
- **`plainNum()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
- **`pct()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`Section()`** — line 33
  - Purpose: (no comment in code — see name and calls below)
- **`Row()`** — line 41
  - Purpose: (no comment in code — see name and calls below)
- **`ruleText()`** — line 50
  - Purpose: (no comment in code — see name and calls below)
- **`MetricValues()`** — line 57
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `money()`, `plainNum()`, `range()`, `pct()`
  - Renders: `this file → <Row>`
- **`CalculationView()`** — line 89
  - Purpose: The record's sections; pure (no state), so it can be checked without a browser.
  - Calls in this file: `range()`, `ruleText()`, `day()`
  - Renders: `this file → <Section>`, `this file → <Row>`, `this file → <MetricValues>`
- **`CalculationPanel()`** — line 167
  - Purpose: A right-side panel over the page (full width on phones): Escape, the backdrop or ✕ closes it; focus moves in and back.
  - Renders: `this file → <CalculationView>`

## `frontend/src/components/chat/present/DataTable.jsx`
**Used by:** `frontend/src/components/chat/present/AnalysisView.jsx`, `frontend/src/components/chat/present/PresentationView.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `DataTable (default)`

- **`DataTable()`** — line 11
  - Purpose: Exact-value table for a presentation model. Every cell is a string the backend already formatted (Indian grouping, currency, signs); nothing is re-computed or re-formatted here. Names wrap instead of truncating; numeric columns are right-aligned and never wrap; the wrapper scrolls horizontally on narrow screens.
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/chat/present/PresentationView.jsx`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`, `frontend/src/components/chat/present/AnalysisView.jsx`

**Imports:** `frontend/src/components/chat/present/DataTable.jsx`, `frontend/src/components/chat/present/direction.js`, `frontend/src/components/chat/present/charts.jsx`, `frontend/src/lib/cn.js`

**Exports:** `PlainSummary`, `Fold`, `PresentationView (default)`

- **`PlainSummary()`** — line 12
  - Purpose: The plain-language opening (backend plainAnswer.js, in the question's language): the first line is the main result; a line ending in ":" introduces the lines after it. Every sentence and figure is the backend's own.
- **`hasPlain()`** — line 28
  - Purpose: a single-query view opens with its plain sentences when the backend sent them (an analysis step's view never has them)
- **`Header()`** — line 30
  - Purpose: (no comment in code — see name and calls below)
- **`Footer()`** — line 52
  - Purpose: hideBasis: an analysis view states each accounting basis once for all its steps, so a step's own footer leaves it out.
- **`MetricCard()`** — line 64
  - Purpose: (no comment in code — see name and calls below)
- **`ChangeCard()`** — line 83
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`
- **`Empty()`** — line 107
  - Purpose: (no comment in code — see name and calls below)
- **`MoreRows()`** — line 134
  - Purpose: (no comment in code — see name and calls below)
- **`Fold()`** — line 144
  - Purpose: A folded section (closed by default): what the user did not ask to see first, one click away.
- **`chartBox()`** — line 156
  - Purpose: (no comment in code — see name and calls below)
- **`GroupsView()`** — line 160
  - Purpose: A top group against all the others (kind "groups"): one caption line, the two-bar chart, the group table (totals, shares, counts), then the members of the top group folded. Every figure is the backend's own string, from one executed result.
  - Calls in this file: `chartBox()`
  - Renders: `frontend/src/components/chat/present/charts.jsx → <ComparisonChart>`, `frontend/src/components/chat/present/DataTable.jsx → <DataTable>`, `this file → <Fold>`
- **`PresentationView()`** — line 179
  - Purpose: display is the user's own "chart" / "table" request (read by the backend from the question): "chart" puts the chart first and folds the exact figures, "table" puts the table first and folds the chart, none keeps the default order. Without a chart nothing is folded: the table is shown and says why there is no chart. hideChange: the analysis view already shows this comparison's change as KPI cards above it.
  - Calls in this file: `hasPlain()`, `chartBox()`
  - Renders: `this file → <PlainSummary>`, `this file → <Empty>`, `this file → <Footer>`, `this file → <Header>`, `this file → <GroupsView>`, `frontend/src/components/chat/present/charts.jsx → <PairedChart>`, `frontend/src/components/chat/present/DataTable.jsx → <DataTable>`, `this file → <ChangeCard>`, `this file → <Fold>`, `this file → <MetricCard>`, `this file → <MoreRows>`

## `frontend/src/components/chat/present/charts.jsx`
**Used by:** `frontend/src/components/chat/present/PresentationView.jsx`

**Imports:** (none)

**Exports:** `RankingChart`, `TrendChart`, `ComparisonChart`, `PairedChart`

- **`trim()`** — line 11
  - Purpose: Axis ticks only (the exact values are in the table and tooltips): Indian short units, trailing zeros trimmed.
- **`compact()`** — line 12
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `trim()`
- **`tick()`** — line 20
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `compact()`
- **`PointTooltip()`** — line 22
  - Purpose: (no comment in code — see name and calls below)
- **`shorten()`** — line 40
  - Purpose: (no comment in code — see name and calls below)
- **`CategoryTick()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `shorten()`
- **`RankingChart()`** — line 53
  - Purpose: Horizontal bars: long customer/product names stay readable (the full name is in the table and the tooltip).
  - Calls in this file: `tick()`
  - Renders: `this file → <CategoryTick>`, `this file → <PointTooltip>`
- **`TrendChart()`** — line 74
  - Purpose: One line of the actual monthly (or daily/weekly) values; x labels are the backend's own period labels.
  - Calls in this file: `tick()`
  - Renders: `this file → <PointTooltip>`
- **`ComparisonChart()`** — line 91
  - Purpose: Previous vs current: two bars, current period highlighted (or the bar `chart.highlight` names, e.g. a top group).
  - Calls in this file: `tick()`
  - Renders: `this file → <PointTooltip>`
- **`PairTooltip()`** — line 111
  - Purpose: (no comment in code — see name and calls below)
- **`PairedChart()`** — line 127
  - Purpose: Two series per name (sales and purchases of the same products, same measure and basis). A missing value is no bar, never 0.
  - Calls in this file: `tick()`
  - Renders: `this file → <CategoryTick>`, `this file → <PairTooltip>`

## `frontend/src/components/chat/present/direction.js`
**Used by:** `frontend/src/components/chat/present/AnalysisView.jsx`, `frontend/src/components/chat/present/PresentationView.jsx`

**Imports:** (none)

**Exports:** `DIRECTION`

**Purpose:** Icon and colours of a change's direction (the backend's own "up" / "down" / "flat"), shared by the change and KPI cards.


## `frontend/src/components/chat/present/isPresentation.js`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`

**Imports:** (none)

**Exports:** `isPresentation`, `hasCalculation`

- **`isPresentation()`** — line 3
  - Purpose: A stored/live message.visualization that this renderer understands (presentation model v1). An analysis view must carry its steps and findings; anything else falls back to the text answer.
- **`hasCalculation()`** — line 11
  - Purpose: A saved calculation record ("View calculation", backend calculation.js v1); an unknown version shows no button.

## `frontend/src/components/company/AddCompanyModal.jsx`
**Used by:** `frontend/src/components/company/CompanySwitcher.jsx`, `frontend/src/components/layout/Sidebar.jsx`, `frontend/src/pages/Settings.jsx`

**Imports:** `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/context/useCompany.js`, `frontend/src/api/client.js`

**Exports:** `AddCompanyModal (default)`

- **`AddCompanyModal()`** — line 12
  - Purpose: "Connect another company": the SAME logged-in account, re-authorized with its EXISTING password - never a new email/account. The company itself is never typed: it is whichever company is open in TallyPrime right now, and the backend detects it.
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`
  - Renders: `frontend/src/components/ui/Input.jsx → <Input>`, `frontend/src/components/ui/Button.jsx → <Button>`

## `frontend/src/components/company/CompanyList.jsx`
**Used by:** `frontend/src/components/company/CompanySwitcher.jsx`, `frontend/src/components/layout/Sidebar.jsx`

**Imports:** `frontend/src/context/useCompany.js`, `frontend/src/lib/cn.js`

**Exports:** `CompanyList (default)`

- **`CompanyList()`** — line 7
  - Purpose: The "Your companies" list + "Connect another company" shared by the top-bar switcher and the sidebar account menu. Render only: the caller owns the switch call, the busy state and the Add Company modal.
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/company/CompanySwitcher.jsx`
**Used by:** `frontend/src/components/layout/Topbar.jsx`

**Imports:** `frontend/src/context/useCompany.js`, `frontend/src/components/company/AddCompanyModal.jsx`, `frontend/src/components/company/CompanyList.jsx`, `frontend/src/lib/cn.js`

**Exports:** `CompanySwitcher (default)`

- **`CompanySwitcher()`** — line 13
  - Purpose: Real company switching (product rule #7): picking another company you already have access to calls POST /api/auth/switch-company directly — no re-login, no intermediate "Company B name + Company A data" flash, since AppLayout fully remounts routed content on CompanyContext's switchNonce right after the switch resolves.
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/cn.js → cn()`
  - Renders: `frontend/src/components/company/CompanyList.jsx → <CompanyList>`, `frontend/src/components/company/AddCompanyModal.jsx → <AddCompanyModal>`

## `frontend/src/components/dashboard/RecentActivity.jsx`
**Used by:** `frontend/src/pages/Dashboard.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/EmptyState.jsx`, `frontend/src/lib/cn.js`

**Exports:** `RecentActivity (default)`

- **`RecentActivity()`** — line 16
  - Purpose: items: the 10 most-recently-updated Sale/Purchase vouchers for this tenant (see Dashboard.jsx) - real data, not sample. "View all" links to the Sync & Data page, which shows the same recent-voucher lists.
  - Calls other files: `frontend/src/lib/cn.js → cn()`
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`, `frontend/src/components/ui/Card.jsx → <CardHeader>`, `frontend/src/components/ui/EmptyState.jsx → <EmptyState>`

## `frontend/src/components/layout/AppLayout.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/components/layout/Sidebar.jsx`, `frontend/src/components/layout/Topbar.jsx`, `frontend/src/context/useCompany.js`

**Exports:** `AppLayout (default)`

- **`AppLayout()`** — line 8
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useCompany.js → useCompany()`
  - Renders: `frontend/src/components/layout/Sidebar.jsx → <Sidebar>`, `frontend/src/components/layout/Topbar.jsx → <Topbar>`

## `frontend/src/components/layout/GuestRoute.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/context/useAuth.js`

**Exports:** `GuestRoute (default)`

- **`GuestRoute()`** — line 7
  - Purpose: Mirrors ProtectedRoute in the other direction: found by QA that typing /login or /register in the URL bar while already signed in rendered the auth form instead of the app, with no redirect.
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`

## `frontend/src/components/layout/NotificationsMenu.jsx`
**Used by:** `frontend/src/components/layout/Topbar.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `NotificationsMenu (default)`

- **`NotificationsMenu()`** — line 9
  - Purpose: The backend has no notifications feature (no model, no route) - so this deliberately does NOT show a fake unread dot or invent sample alerts. Clicking it opens an honest "not available yet" panel instead of being a dead, clickable-looking icon that does nothing.
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/layout/ProfileMenu.jsx`
**Used by:** `frontend/src/components/layout/Topbar.jsx`

**Imports:** `frontend/src/context/useAuth.js`, `frontend/src/lib/cn.js`

**Exports:** `ProfileMenu (default)`

- **`ProfileMenu()`** — line 11
  - Purpose: A real, functional profile menu — was previously a plain <span> with no click handler at all. Shows what's actually known about the session (role — the backend has no "get current user" endpoint for name/email, see docs §16) and two real actions.
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`, `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/layout/ProtectedRoute.jsx`
**Used by:** `frontend/src/App.jsx`

**Imports:** `frontend/src/context/useAuth.js`

**Exports:** `ProtectedRoute (default)`

- **`ProtectedRoute()`** — line 4
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`

## `frontend/src/components/layout/Sidebar.jsx`
**Used by:** `frontend/src/components/layout/AppLayout.jsx`

**Imports:** `frontend/src/components/layout/navConfig.js`, `frontend/src/context/useAuth.js`, `frontend/src/context/useCompany.js`, `frontend/src/components/company/CompanyList.jsx`, `frontend/src/components/company/AddCompanyModal.jsx`, `frontend/src/lib/cn.js`

**Exports:** `Sidebar (default)`

- **`Sidebar()`** — line 11
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/components/layout/navConfig.js → NAV_ITEMS.map()`, `frontend/src/lib/cn.js → cn()`
  - Renders: `this file → <AccountMenu>`
- **`AccountMenu()`** — line 58
  - Purpose: The account block at the foot of the sidebar: shows the open company, and opens a menu (upwards) to switch company, connect another one, open Settings or sign out - so pages can do without the top bar's switcher.
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`, `frontend/src/context/useCompany.js → useCompany()`, `frontend/src/lib/cn.js → cn()`
  - Renders: `frontend/src/components/company/CompanyList.jsx → <CompanyList>`, `frontend/src/components/company/AddCompanyModal.jsx → <AddCompanyModal>`

## `frontend/src/components/layout/Topbar.jsx`
**Used by:** `frontend/src/components/layout/AppLayout.jsx`

**Imports:** `frontend/src/components/company/CompanySwitcher.jsx`, `frontend/src/components/layout/NotificationsMenu.jsx`, `frontend/src/components/layout/ProfileMenu.jsx`

**Exports:** `Topbar (default)`

- **`Topbar()`** — line 6
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/company/CompanySwitcher.jsx → <CompanySwitcher>`, `frontend/src/components/layout/NotificationsMenu.jsx → <NotificationsMenu>`, `frontend/src/components/layout/ProfileMenu.jsx → <ProfileMenu>`

## `frontend/src/components/layout/navConfig.js`
**Used by:** `frontend/src/components/layout/Sidebar.jsx`

**Imports:** (none)

**Exports:** `NAV_ITEMS`


## `frontend/src/components/reports/ReportTable.jsx`
**Used by:** `frontend/src/pages/Reports.jsx`

**Imports:** `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/Select.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/EmptyState.jsx`, `frontend/src/components/ui/Skeleton.jsx`

**Exports:** `ReportTable (default)`

- **`ReportTable()`** — line 16
  - Purpose: Generic server-side-paginated, server-side-searched report table — same interaction model as VoucherRegister (search box, page-size select, Prev/Next) but parameterized over `columns` so it can render the Product and Customer reports' different row shapes, without touching VoucherRegister itself (that component stays exactly as built for the Sales/Purchase Invoices tabs).
  - Renders: `frontend/src/components/ui/Select.jsx → <Select>`, `frontend/src/components/ui/Skeleton.jsx → <TableSkeleton>`, `frontend/src/components/ui/EmptyState.jsx → <EmptyState>`, `frontend/src/components/ui/Table.jsx → <Table>`, `frontend/src/components/ui/Button.jsx → <Button>`

## `frontend/src/components/ui/AnalyticsNotice.jsx`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/components/ui/EmptyState.jsx`

**Exports:** `AnalyticsNotice (default)`, `StaleDataBanner`

- **`AnalyticsNotice()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/ui/EmptyState.jsx → <EmptyState>`
- **`StaleDataBanner()`** — line 22
  - Purpose: A non-blocking warning strip shown ABOVE real (but stale) data — the data itself still renders normally underneath this.

## `frontend/src/components/ui/Badge.jsx`
**Used by:** `frontend/src/components/ui/FreshnessBadge.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Badge (default)`

- **`Badge()`** — line 11
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/ui/Button.jsx`
**Used by:** `frontend/src/components/company/AddCompanyModal.jsx`, `frontend/src/components/reports/ReportTable.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`, `frontend/src/pages/auth/ConnectCompany.jsx`, `frontend/src/pages/auth/Login.jsx`, `frontend/src/pages/auth/Register.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Button (default)`


## `frontend/src/components/ui/Card.jsx`
**Used by:** `frontend/src/components/charts/ComparisonBarChart.jsx`, `frontend/src/components/charts/DonutChart.jsx`, `frontend/src/components/charts/LineTrendChart.jsx`, `frontend/src/components/charts/SimpleBarChart.jsx`, `frontend/src/components/dashboard/RecentActivity.jsx`, `frontend/src/components/ui/KpiCard.jsx`, `frontend/src/components/ui/MiniStatCard.jsx`, `frontend/src/pages/Analytics.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Card (default)`, `CardHeader`

- **`Card()`** — line 3
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`
- **`CardHeader()`** — line 18
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/ui/DateInput.jsx`
**Used by:** `frontend/src/components/ui/FilterBar.jsx`

**Imports:** `frontend/src/lib/cn.js`, `frontend/src/lib/dateRange.js`

**Exports:** `DateInput (default)`

- **`DateInput()`** — line 12
  - Purpose: A date field you can type into directly ("1-May-2025") or pick from a native calendar, overlaid transparently on the right so clicking that edge opens it without needing browser support for `showPicker()`. Typing is free-form while focused; it's only parsed on blur/Enter, falling back to the last valid value if it doesn't parse (rejects nonsense dates too, e.g. "31-Feb-2025").
  - Calls other files: `frontend/src/lib/dateRange.js → formatTypedDate()`, `frontend/src/lib/dateRange.js → parseTypedDate()`, `frontend/src/lib/dateRange.js → parseDateInputValue()`, `frontend/src/lib/cn.js → cn()`, `frontend/src/lib/dateRange.js → toDateInputValue()`

## `frontend/src/components/ui/EmptyState.jsx`
**Used by:** `frontend/src/components/dashboard/RecentActivity.jsx`, `frontend/src/components/reports/ReportTable.jsx`, `frontend/src/components/ui/AnalyticsNotice.jsx`, `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** (none)

**Exports:** `EmptyState (default)`

- **`EmptyState()`** — line 3
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/components/ui/FilterBar.jsx`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/DateInput.jsx`, `frontend/src/lib/dateRange.js`

**Exports:** `FilterBar (default)`

- **`FilterBar()`** — line 10
  - Purpose: A controlled date-range filter: changing the dates updates state, which the page re-derives its displayed figures from, and Reset restores the default range.
  - Calls other files: `frontend/src/lib/dateRange.js → formatRangeLabel()`
  - Renders: `frontend/src/components/ui/DateInput.jsx → <DateInput>`, `frontend/src/components/ui/Button.jsx → <Button>`

## `frontend/src/components/ui/FreshnessBadge.jsx`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`, `frontend/src/pages/Dashboard.jsx`

**Imports:** `frontend/src/components/ui/Badge.jsx`

**Exports:** `FreshnessBadge (default)`

- **`formatDataAsOf()`** — line 17
  - Purpose: (no comment in code — see name and calls below)
- **`FreshnessBadge()`** — line 29
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `formatDataAsOf()`
  - Renders: `frontend/src/components/ui/Badge.jsx → <Badge>`

## `frontend/src/components/ui/Input.jsx`
**Used by:** `frontend/src/components/company/AddCompanyModal.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`, `frontend/src/pages/auth/Login.jsx`, `frontend/src/pages/auth/Register.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Input`, `Input (default)`


## `frontend/src/components/ui/KpiCard.jsx`
**Used by:** `frontend/src/pages/Dashboard.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`, `frontend/src/lib/cn.js`

**Exports:** `KpiCard (default)`

- **`KpiCard()`** — line 10
  - Purpose: Matches the reference dashboard's KPI tiles: label, big value, small icon chip, and a "+12.5% vs previous period" delta line underneath. `to` (optional) makes the whole card one real link (keyboard focusable, Enter opens it, middle-click works); `linkLabel` is its accessible name / tooltip. Without `to` the card is exactly what it always was.
  - Calls other files: `frontend/src/lib/cn.js → cn()`
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`

## `frontend/src/components/ui/MiniStatCard.jsx`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/components/ui/Card.jsx`, `frontend/src/lib/cn.js`

**Exports:** `MiniStatCard (default)`

- **`MiniStatCard()`** — line 5
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`
  - Renders: `frontend/src/components/ui/Card.jsx → <Card>`

## `frontend/src/components/ui/PageHeader.jsx`
**Used by:** `frontend/src/pages/Analytics.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** (none)

**Exports:** `PageHeader (default)`

- **`PageHeader()`** — line 1
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/components/ui/Select.jsx`
**Used by:** `frontend/src/components/reports/ReportTable.jsx`, `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Select (default)`

- **`Select()`** — line 4
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/ui/Skeleton.jsx`
**Used by:** `frontend/src/components/reports/ReportTable.jsx`, `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Skeleton (default)`, `KpiCardSkeleton`, `ChartCardSkeleton`, `TableSkeleton`

- **`Skeleton()`** — line 3
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/lib/cn.js → cn()`
- **`KpiCardSkeleton()`** — line 7
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `this file → <Skeleton>`
- **`ChartCardSkeleton()`** — line 17
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `this file → <Skeleton>`
- **`TableSkeleton()`** — line 26
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `this file → <Skeleton>`

## `frontend/src/components/ui/Table.jsx`
**Used by:** `frontend/src/components/reports/ReportTable.jsx`, `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Table (default)`

- **`Table()`** — line 4
  - Purpose: columns: [{ key, header, align?, render? }]
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/ui/Tabs.jsx`
**Used by:** `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/lib/cn.js`

**Exports:** `Tabs (default)`

- **`Tabs()`** — line 4
  - Purpose: tabs: [{ key, label }]
  - Calls other files: `frontend/src/lib/cn.js → cn()`

## `frontend/src/components/vouchers/VoucherRegister.jsx`
**Used by:** `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/Select.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/EmptyState.jsx`, `frontend/src/components/ui/Skeleton.jsx`, `frontend/src/lib/useDebouncedValue.js`, `frontend/src/lib/format.js`

**Exports:** `VoucherRegister (default)`

- **`VoucherRegister()`** — line 22
  - Purpose: Shared server-side-paginated, server-side-searched voucher list, used for both the Sales Invoices tab and the Purchase Bills tab — only the fetcher function and the "party" column label differ between the two. `fetcher({page, limit, search})` must return `{data, pagination: {page, limit, total, totalPages}}` — see api/vouchers.js. Nothing here fetches the whole collection: every page turn and every search keystrok...
  - Calls other files: `frontend/src/lib/useDebouncedValue.js → useDebouncedValue()`, `frontend/src/lib/format.js → formatCurrency()`
  - Renders: `frontend/src/components/ui/Select.jsx → <Select>`, `frontend/src/components/ui/Skeleton.jsx → <TableSkeleton>`, `frontend/src/components/ui/EmptyState.jsx → <EmptyState>`, `frontend/src/components/ui/Table.jsx → <Table>`, `frontend/src/components/ui/Button.jsx → <Button>`


# 15. Frontend: context

## `frontend/src/context/AuthContext.jsx`
**Used by:** `frontend/src/main.jsx`

**Imports:** `frontend/src/api/auth.js`, `frontend/src/api/client.js`, `frontend/src/context/AuthContextObject.js`

**Exports:** `AuthProvider`

- **`sessionFromToken()`** — line 12
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/auth.js → decodeJwtPayload()`
- **`AuthProvider()`** — line 27
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `sessionFromToken()`
  - Calls other files: `frontend/src/api/client.js → getStoredToken()`, `frontend/src/api/auth.js → loginAccount()`, `frontend/src/api/client.js → setStoredToken()`, `frontend/src/api/auth.js → registerAccount()`, `frontend/src/api/auth.js → connectCompany()`, `frontend/src/api/auth.js → switchActiveCompany()`

## `frontend/src/context/AuthContextObject.js`
**Used by:** `frontend/src/context/AuthContext.jsx`, `frontend/src/context/useAuth.js`

**Imports:** (none)

**Exports:** `AuthContext`

**Purpose:** Split out of AuthContext.jsx/useAuth.js so each of those files exports only one kind of thing (a component / a hook) - Vite's Fast Refresh only hot-reloads a module cleanly when it doesn't mix component and non-component exports.


## `frontend/src/context/CompanyContext.jsx`
**Used by:** `frontend/src/main.jsx`

**Imports:** `frontend/src/context/useAuth.js`, `frontend/src/api/auth.js`, `frontend/src/context/CompanyContextObject.js`

**Exports:** `CompanyProvider`

- **`CompanyProvider()`** — line 6
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/context/useAuth.js → useAuth()`, `frontend/src/api/auth.js → listAccessibleCompanies()`

## `frontend/src/context/CompanyContextObject.js`
**Used by:** `frontend/src/context/CompanyContext.jsx`, `frontend/src/context/useCompany.js`

**Imports:** (none)

**Exports:** `CompanyContext`

**Purpose:** Split out of CompanyContext.jsx/useCompany.js - see AuthContextObject.js for why.


## `frontend/src/context/useAuth.js`
**Used by:** `frontend/src/components/layout/GuestRoute.jsx`, `frontend/src/components/layout/ProfileMenu.jsx`, `frontend/src/components/layout/ProtectedRoute.jsx`, `frontend/src/components/layout/Sidebar.jsx`, `frontend/src/context/CompanyContext.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/auth/ConnectCompany.jsx`, `frontend/src/pages/auth/Login.jsx`, `frontend/src/pages/auth/Register.jsx`

**Imports:** `frontend/src/context/AuthContextObject.js`

**Exports:** `useAuth`

- **`useAuth()`** — line 4
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/context/useCompany.js`
**Used by:** `frontend/src/components/company/AddCompanyModal.jsx`, `frontend/src/components/company/CompanyList.jsx`, `frontend/src/components/company/CompanySwitcher.jsx`, `frontend/src/components/layout/AppLayout.jsx`, `frontend/src/components/layout/Sidebar.jsx`, `frontend/src/pages/AskAI.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/context/CompanyContextObject.js`

**Exports:** `useCompany`

- **`useCompany()`** — line 4
  - Purpose: (no comment in code — see name and calls below)


# 15. Frontend: api (backend calls)

## `frontend/src/api/analytics.js`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `getSalesSummary`, `getSalesComparison`, `getTopProducts`, `getGrowingProducts`, `getDecliningProducts`, `getTopCustomers`, `getSalesTrend`, `getDiscountSummary`, `getProductRates`, `getProductMargin`, `getProductTrend`, `getSupplierRates`, `getCustomerCounts`, `getPurchaseSummary`, `getPurchaseComparison`, `getTopSuppliers`, `getPurchaseTrend`

- **`buildPeriodParams()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
- **`get()`** _(async)_ — line 21
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → get()`
- **`getSalesSummary()`** — line 26
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getSalesComparison()`** — line 30
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`
- **`getTopProducts()`** — line 34
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getGrowingProducts()`** — line 38
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`
- **`getDecliningProducts()`** — line 42
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`
- **`getTopCustomers()`** — line 46
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getSalesTrend()`** — line 53
  - Purpose: Monthly totals over a range - the default (no from/to) is the backend's own last-6-months-of-real-data window, not a wall-clock assumption made here.
  - Calls in this file: `get()`
- **`getDiscountSummary()`** — line 59
  - Purpose: Discount given (entity "sales", by customer|product|month) or received (entity "purchase", by supplier|product|month). Same calculation the Ask AI chat uses (backend/src/services/analytics/insights.js).
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getProductRates()`** — line 64
  - Purpose: Per product: average sale rate, average purchase rate and the gap between them (a price gap, not a profit).
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getProductMargin()`** — line 70
  - Purpose: Per product sold: average sale rate vs average purchase cost, margin per unit, margin % and indicative profit (not Tally stock valuation). sortBy: "profit" | "marginPct"; order: "desc" | "asc".
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getProductTrend()`** — line 75
  - Purpose: One product, month by month: quantity bought and sold, net movement and its running total (a movement, not a stock balance).
  - Calls in this file: `get()`
- **`getSupplierRates()`** — line 80
  - Purpose: Per product: what each supplier charged per unit, and who is cheapest.
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getCustomerCounts()`** — line 84
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getPurchaseSummary()`** — line 88
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getPurchaseComparison()`** — line 92
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`
- **`getTopSuppliers()`** — line 96
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`, `buildPeriodParams()`
- **`getPurchaseTrend()`** — line 100
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `get()`

## `frontend/src/api/auth.js`
**Used by:** `frontend/src/context/AuthContext.jsx`, `frontend/src/context/CompanyContext.jsx`, `frontend/src/pages/Settings.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `registerAccount`, `loginAccount`, `connectCompany`, `listAccessibleCompanies`, `switchActiveCompany`, `renameActiveCompany`, `decodeJwtPayload`

- **`registerAccount()`** _(async)_ — line 7
  - Purpose: POST /api/auth/register — backend/src/controllers/authController.js Account only: name, email, password. No company, GUID or tenant is entered here — the company is connected afterwards with connectCompany() below, straight from whatever is open in TallyPrime.
  - Calls other files: `frontend/src/api/client.js → post()`
- **`loginAccount()`** _(async)_ — line 15
  - Purpose: POST /api/auth/login — email + password. The token opens on the account's default company; an account that has not connected one yet gets a company-less token ({ hasCompany: false }).
  - Calls other files: `frontend/src/api/client.js → post()`
- **`connectCompany()`** _(async)_ — line 25
  - Purpose: POST /api/auth/companies — "Connect Tally": the backend detects the company that is open in TallyPrime and connects it to the current account; nothing about the company is typed by the user. The very first company needs no password; any further company also needs the account password (re-authorization). Never a new email/account.
  - Calls other files: `frontend/src/api/client.js → post()`
- **`listAccessibleCompanies()`** _(async)_ — line 33
  - Purpose: GET /api/auth/companies — every company the current account can access (their default company + anything connected via connectCompany above). companyGuid is only an opaque key for switching; it is never shown.
  - Calls other files: `frontend/src/api/client.js → get()`
- **`switchActiveCompany()`** _(async)_ — line 42
  - Purpose: POST /api/auth/switch-company — re-scopes the session's JWT to a different company the account already has access to. No password needed (the account itself is already authenticated) — this only changes which authorized company that session acts as.
  - Calls other files: `frontend/src/api/client.js → post()`
- **`renameActiveCompany()`** _(async)_ — line 50
  - Purpose: PATCH /api/auth/company — renames the CURRENT active company (the one the caller's JWT is scoped to). A real backend save, replacing what used to be a browser-local-only "Update Company" mock.
  - Calls other files: `frontend/src/api/client.js → patch()`
- **`decodeJwtPayload()`** — line 61
  - Purpose: The backend issues a JWT but has no GET /me endpoint. Decoding the payload client-side (no verification needed — it's the token we just received) is the only way to read {id, companyGuId, tenantId, role} back out for display; it is never used as an authorization decision, only for showing the right label in the UI. Every actual authorization check still happens server-side per request.

## `frontend/src/api/chat.js`
**Used by:** `frontend/src/components/chat/ChatSidebarList.jsx`, `frontend/src/pages/AskAI.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `listChats`, `getChat`, `MAX_CHAT_TITLE_CHARS`, `renameChat`, `deleteChat`, `sendChatMessage`, `AI_NOT_CONFIGURED_STATUS`

- **`listChats()`** _(async)_ — line 6
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → get()`
- **`getChat()`** _(async)_ — line 11
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → get()`
- **`renameChat()`** _(async)_ — line 18
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → patch()`
- **`deleteChat()`** _(async)_ — line 23
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → delete()`
- **`sendChatMessage()`** _(async)_ — line 44
  - Purpose: `signal` (AbortController): aborting it cancels the HTTP request; the backend sees the disconnect and stops the turn (no further Claude call, nothing saved). It rejects with ApiError code "CANCELED".
  - Calls other files: `frontend/src/api/client.js → post()`

## `frontend/src/api/client.js`
**Used by:** `frontend/src/api/analytics.js`, `frontend/src/api/auth.js`, `frontend/src/api/chat.js`, `frontend/src/api/imports.js`, `frontend/src/api/odbc.js`, `frontend/src/api/reports.js`, `frontend/src/api/sync.js`, `frontend/src/api/vouchers.js`, `frontend/src/components/company/AddCompanyModal.jsx`, `frontend/src/context/AuthContext.jsx`, `frontend/src/lib/useTallyConnectionTest.js`, `frontend/src/pages/AskAI.jsx`, `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`, `frontend/src/pages/auth/ConnectCompany.jsx`, `frontend/src/pages/auth/Login.jsx`, `frontend/src/pages/auth/Register.jsx`

**Imports:** (none)

**Exports:** `getStoredToken`, `setStoredToken`, `ApiError`, `client (default)`

- **`getStoredToken()`** — line 21
  - Purpose: (no comment in code — see name and calls below)
- **`setStoredToken()`** — line 29
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/api/imports.js`
**Used by:** `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `importTallyJsonFile`, `importTallyLive`

- **`importTallyJsonFile()`** _(async)_ — line 6
  - Purpose: POST /api/import/tally-json — backend/src/routes/importRoutes.js. multipart/form-data, field name must be exactly "file" (multer config in src/middleware/upload.js).
  - Calls other files: `frontend/src/api/client.js → post()`
- **`importTallyLive()`** _(async)_ — line 27
  - Purpose: POST /api/import/tally-live?fromDate&toDate — live Sales-only fetch straight from TallyPrime. No Purchase equivalent exists on the backend today (docs §7.5, §16). Root cause of a real bug found in QA: passing `null` as the axios body here got JSON-stringified to the literal text "null" (because the client sets a default application/json Content-Type), and Express's body-parser runs in "strict" mode by default — it...
  - Calls other files: `frontend/src/api/client.js → post()`

## `frontend/src/api/odbc.js`
**Used by:** `frontend/src/lib/useTallyConnectionTest.js`

**Imports:** `frontend/src/api/client.js`

**Exports:** `testTallyConnection`, `fetchRawTallySales`, `extractTallyCompanyName`, `evaluateTallyConnection`

- **`testTallyConnection()`** _(async)_ — line 13
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → get()`
- **`fetchRawTallySales()`** _(async)_ — line 18
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → get()`
- **`extractTallyCompanyName()`** — line 30
  - Purpose: Best-effort extraction of a company name out of Tally's raw JSONEx company list, ONLY when exactly one company is listed. With several open companies the list does not say which is selected, so this deliberately answers null rather than guessing the first entry - the backend's `detected` field (see evaluateTallyConnection) is the authoritative answer. Tally's export format is intentionally loosely-typed (see tally...
- **`normalize()`** — line 53
  - Purpose: (no comment in code — see name and calls below)
- **`evaluateTallyConnection()`** _(async)_ — line 74
  - Purpose: The real limit of what this backend can verify, found empirically during QA (2026-09-17): the "RTS Company Report" TDL request only asks Tally for $Name, never a company GUID - and Tally's response can come back with an EMPTY collection ({success:true, data:{}}) even when the HTTP call itself succeeds, e.g. when no company (or a company the report can't resolve) is open in TallyPrime right now. A 200 OK from GET /...
  - Calls in this file: `testTallyConnection()`, `extractTallyCompanyName()`, `normalize()`

## `frontend/src/api/reports.js`
**Used by:** `frontend/src/pages/Reports.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `getProductReport`, `getCustomerReport`, `exportSalesReport`, `exportPurchaseReport`, `exportProductReport`, `exportCustomerReport`

- **`buildPeriodParams()`** — line 8
  - Purpose: (no comment in code — see name and calls below)
- **`getProductReport()`** — line 13
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildPeriodParams()`
  - Calls other files: `frontend/src/api/client.js → get()`
- **`getCustomerReport()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `buildPeriodParams()`
  - Calls other files: `frontend/src/api/client.js → get()`
- **`downloadCsv()`** _(async)_ — line 28
  - Purpose: Export endpoints stream a file, not JSON — an authenticated request (the JWT header) can't be a plain <a href>, so this fetches the CSV as a blob and triggers the browser's normal save-file flow from it.
  - Calls other files: `frontend/src/api/client.js → get()`
- **`exportSalesReport()`** — line 40
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `downloadCsv()`, `buildPeriodParams()`
- **`exportPurchaseReport()`** — line 44
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `downloadCsv()`, `buildPeriodParams()`
- **`exportProductReport()`** — line 48
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `downloadCsv()`, `buildPeriodParams()`
- **`exportCustomerReport()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `downloadCsv()`, `buildPeriodParams()`

## `frontend/src/api/sync.js`
**Used by:** `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `getSyncStatus`

- **`getSyncStatus()`** _(async)_ — line 9
  - Purpose: GET /api/sync/status — backend/src/routes/syncRoutes.js. Real SyncCheckpoint/ReconciliationCheckpoint rows and the actual synced Sale/Purchase documents for the caller's active company (tenant re-derived server-side from the JWT's companyGuId, never trusted from the client). A checkpoint that hasn't run yet for this tenant comes back as `null`, not a fake placeholder.
  - Calls other files: `frontend/src/api/client.js → get()`

## `frontend/src/api/vouchers.js`
**Used by:** `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** `frontend/src/api/client.js`

**Exports:** `listSalesVouchers`, `listPurchaseVouchers`

- **`list()`** _(async)_ — line 10
  - Purpose: (no comment in code — see name and calls below)
  - Calls other files: `frontend/src/api/client.js → get()`
- **`listSalesVouchers()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `list()`
- **`listPurchaseVouchers()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `list()`


# 15. Frontend: lib (hooks and helpers)

## `frontend/src/lib/cn.js`
**Used by:** `frontend/src/components/chat/ChatBubble.jsx`, `frontend/src/components/chat/ChatSidebarList.jsx`, `frontend/src/components/chat/present/AnalysisView.jsx`, `frontend/src/components/chat/present/DataTable.jsx`, `frontend/src/components/chat/present/PresentationView.jsx`, `frontend/src/components/company/CompanyList.jsx`, `frontend/src/components/company/CompanySwitcher.jsx`, `frontend/src/components/dashboard/RecentActivity.jsx`, `frontend/src/components/layout/NotificationsMenu.jsx`, `frontend/src/components/layout/ProfileMenu.jsx`, `frontend/src/components/layout/Sidebar.jsx`, `frontend/src/components/ui/Badge.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/Card.jsx`, `frontend/src/components/ui/DateInput.jsx`, `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/KpiCard.jsx`, `frontend/src/components/ui/MiniStatCard.jsx`, `frontend/src/components/ui/Select.jsx`, `frontend/src/components/ui/Skeleton.jsx`, `frontend/src/components/ui/Table.jsx`, `frontend/src/components/ui/Tabs.jsx`

**Imports:** (none)

**Exports:** `cn`

- **`cn()`** — line 6
  - Purpose: Thin wrapper so every component imports one tiny helper instead of clsx directly — keeps the door open for tailwind-merge later without touching every call site.

## `frontend/src/lib/dateRange.js`
**Used by:** `frontend/src/components/ui/DateInput.jsx`, `frontend/src/components/ui/FilterBar.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** (none)

**Exports:** `DEFAULT_RANGE`, `toDateInputValue`, `parseDateInputValue`, `formatRangeLabel`, `formatTypedDate`, `parseTypedDate`

- **`currentFinancialYearToDate()`** — line 6
  - Purpose: The default range of every screen with a date filter: the current Indian financial year to date (1 April of the running FY through today).
- **`toDateInputValue()`** — line 20
  - Purpose: Builds the yyyy-mm-dd string from LOCAL date parts. `toISOString()` converts to UTC first, which silently shifts the displayed date back a day for anyone east of UTC (e.g. IST) — found by QA: opening the picker on a 01 Apr range showed 31 Mar in the input.
- **`parseDateInputValue()`** — line 30
  - Purpose: Parses a yyyy-mm-dd input value as a LOCAL date, matching toDateInputValue above. `new Date("yyyy-mm-dd")` parses as UTC midnight instead, which shifts the day for anyone west of UTC.
- **`formatRangeLabel()`** — line 35
  - Purpose: (no comment in code — see name and calls below)
- **`formatTypedDate()`** — line 44
  - Purpose: Formats a Date as "1-May-2025" — the typed format the date-range fields display and accept (see parseTypedDate below).
- **`parseTypedDate()`** — line 55
  - Purpose: Parses text like "1-May-2025", "1 may 2025" or "01/May/2025" as a LOCAL date. Returns null for anything that doesn't match or isn't a real calendar date (e.g. "31-Feb-2025"), so callers can fall back to the last known-good value instead of silently accepting garbage.

## `frontend/src/lib/format.js`
**Used by:** `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** (none)

**Exports:** `formatCurrency`, `formatCompactCurrency`, `formatNumber`, `formatPercent`, `formatRelativeTime`

- **`formatCurrency()`** — line 1
  - Purpose: (no comment in code — see name and calls below)
- **`formatCompactCurrency()`** — line 10
  - Purpose: (no comment in code — see name and calls below)
- **`formatNumber()`** — line 18
  - Purpose: (no comment in code — see name and calls below)
- **`formatPercent()`** — line 23
  - Purpose: (no comment in code — see name and calls below)
- **`formatRelativeTime()`** — line 29
  - Purpose: (no comment in code — see name and calls below)

## `frontend/src/lib/markdownText.js`
**Used by:** `frontend/src/components/chat/MarkdownMessage.jsx`

**Imports:** (none)

**Exports:** `separateListTrailers`

- **`separateListTrailers()`** — line 7
  - Purpose: CommonMark reads an unindented line right after a list item as a "lazy continuation" of that item, so the engine's "Total: ..." line would be folded into the last row. Ending the list with a blank line there is a layout-only change: no character of the answer is added, removed or altered. Code fences are left alone.

## `frontend/src/lib/period.js`
**Used by:** `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/Reports.jsx`

**Imports:** (none)

**Exports:** `calendarDatesOf`, `isIsoDay`, `formatIsoDay`, `formatIsoRange`, `REPORT_TABS`, `buildReportsLink`, `readReportsDeepLink`

- **`utcTimeOfDay()`** — line 15
  - Purpose: (no comment in code — see name and calls below)
- **`offsetMs()`** — line 16
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `utcTimeOfDay()`
- **`isoDay()`** — line 21
  - Purpose: (no comment in code — see name and calls below)
- **`startDay()`** — line 23
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `isoDay()`, `offsetMs()`
- **`endDay()`** — line 27
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `utcTimeOfDay()`, `isoDay()`, `offsetMs()`
- **`calendarDatesOf()`** — line 36
  - Purpose: {from, to} instants of an analytics period -> {from, to} "YYYY-MM-DD" (or null when it has no usable range).
  - Calls in this file: `startDay()`, `endDay()`
- **`isIsoDay()`** — line 44
  - Purpose: (no comment in code — see name and calls below)
- **`formatIsoDay()`** — line 52
  - Purpose: "2025-08-01" -> "01 Aug 2025", read as a calendar day (never shifted by the browser's timezone).
- **`formatIsoRange()`** — line 56
  - Purpose: (no comment in code — see name and calls below)
  - Calls in this file: `formatIsoDay()`
- **`buildReportsLink()`** — line 61
  - Purpose: The Reports URL for a KPI's period. Only tab / from / to / source travel in the URL - never a tenant or company.
- **`readReportsDeepLink()`** — line 66
  - Purpose: Reads and strictly validates the Reports deep link; anything unexpected -> null (normal Reports behaviour).
  - Calls in this file: `isIsoDay()`

## `frontend/src/lib/useAsync.js`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** (none)

**Exports:** `useAsync`, `mockDelay`

- **`useAsync()`** — line 8
  - Purpose: Minimal async-fetch hook shared by every page: {data, loading, error, reload}. Re-runs whenever `deps` changes (e.g. the active company), and ignores a stale response that resolves after a newer call has already started — relevant once real per-company API calls replace the mock loaders below.
- **`mockDelay()`** — line 33
  - Purpose: A tiny artificial delay so mock-data screens still exercise their real loading skeletons instead of resolving instantly.

## `frontend/src/lib/useDebouncedValue.js`
**Used by:** `frontend/src/components/vouchers/VoucherRegister.jsx`, `frontend/src/pages/Reports.jsx`

**Imports:** (none)

**Exports:** `useDebouncedValue`

- **`useDebouncedValue()`** — line 7
  - Purpose: Returns `value` delayed by `delayMs`, resetting the timer on every change — the standard debounce-a-value pattern for a controlled search input. Cleans up its own timer on unmount/re-run, so no stale timeout ever fires after the component using it is gone.

## `frontend/src/lib/usePersistedRange.js`
**Used by:** `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/SalesAnalytics.jsx`

**Imports:** (none)

**Exports:** `usePersistedRange`

- **`readStored()`** — line 10
  - Purpose: Persists a page's date-range filter selection to localStorage, keyed per page (`storageKey`), so a browser refresh restores exactly what the user last picked instead of silently resetting to the default range. Per-viewer convenience only (never synced, never read back by the backend) - wrapped in try/catch since localStorage can throw in a private window or with site data blocked, and the page must still work corr...
- **`writeStored()`** — line 24
  - Purpose: (no comment in code — see name and calls below)
- **`usePersistedRange()`** — line 39
  - Purpose: Returns {range, setRange, reset} - same shape as a useState call for `range`, so call sites barely change, but the setter also persists. `override` (optional, e.g. a Dashboard deep link) wins over the stored range and is stored itself, so a refresh keeps what is on screen exactly like a range the user picked. Writing here is idempotent.
  - Calls in this file: `writeStored()`, `readStored()`

## `frontend/src/lib/usePolling.js`
**Used by:** `frontend/src/pages/SyncData.jsx`

**Imports:** (none)

**Exports:** `usePolling`

- **`usePolling()`** — line 13
  - Purpose: Fetches once immediately (with a loading state, like useAsync), then quietly re-fetches on a fixed interval without flipping `loading` back on — background ticks swap `data` in place so the UI never flickers back to a skeleton every poll cycle. A failed tick keeps the last good `data` (the failure is surfaced separately via `pollError`, never thrown away) and backs off (doubling, capped at `maxIntervalMs`) instead...

## `frontend/src/lib/useTallyConnectionTest.js`
**Used by:** `frontend/src/pages/Settings.jsx`, `frontend/src/pages/SyncData.jsx`

**Imports:** `frontend/src/api/odbc.js`, `frontend/src/api/client.js`

**Exports:** `useTallyConnectionTest`

- **`useTallyConnectionTest()`** — line 10
  - Purpose: Shared by the Sync & Data page and the Settings "Tally Connection" tab. `expectedCompanyName` (the active company's real name from CompanyContext) lets this distinguish "connected" from "wrong company open in Tally" — see api/odbc.js's evaluateTallyConnection for exactly what is and isn't verifiable given the current backend.
  - Calls other files: `frontend/src/api/odbc.js → evaluateTallyConnection()`


# 15. Frontend: app entry

## `frontend/src/App.jsx`
**Used by:** `frontend/src/main.jsx`

**Imports:** `frontend/src/pages/auth/Login.jsx`, `frontend/src/pages/auth/Register.jsx`, `frontend/src/pages/auth/ConnectCompany.jsx`, `frontend/src/components/layout/ProtectedRoute.jsx`, `frontend/src/components/layout/GuestRoute.jsx`, `frontend/src/components/layout/AppLayout.jsx`, `frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/SalesAnalytics.jsx`, `frontend/src/pages/PurchaseAnalytics.jsx`, `frontend/src/pages/ProductsAnalytics.jsx`, `frontend/src/pages/CustomersAnalytics.jsx`, `frontend/src/pages/Analytics.jsx`, `frontend/src/pages/AskAI.jsx`, `frontend/src/pages/SyncData.jsx`, `frontend/src/pages/Reports.jsx`, `frontend/src/pages/Settings.jsx`

**Exports:** `App (default)`

- **`App()`** — line 19
  - Purpose: (no comment in code — see name and calls below)
  - Renders: `frontend/src/components/layout/GuestRoute.jsx → <GuestRoute>`, `frontend/src/pages/auth/Login.jsx → <Login>`, `frontend/src/pages/auth/Register.jsx → <Register>`, `frontend/src/pages/auth/ConnectCompany.jsx → <ConnectCompany>`, `frontend/src/components/layout/ProtectedRoute.jsx → <ProtectedRoute>`, `frontend/src/components/layout/AppLayout.jsx → <AppLayout>`, `frontend/src/pages/Dashboard.jsx → <Dashboard>`, `frontend/src/pages/SalesAnalytics.jsx → <SalesAnalytics>`, `frontend/src/pages/PurchaseAnalytics.jsx → <PurchaseAnalytics>`, `frontend/src/pages/ProductsAnalytics.jsx → <ProductsAnalytics>`, `frontend/src/pages/CustomersAnalytics.jsx → <CustomersAnalytics>`, `frontend/src/pages/Analytics.jsx → <Analytics>`, `frontend/src/pages/AskAI.jsx → <AskAI>`, `frontend/src/pages/SyncData.jsx → <SyncData>`, `frontend/src/pages/Reports.jsx → <Reports>`, `frontend/src/pages/Settings.jsx → <Settings>`

## `frontend/src/main.jsx`
**Used by:** (nothing in the app requires it: entry file, or used only by tests)

**Imports:** `frontend/src/index.css`, `frontend/src/App.jsx`, `frontend/src/context/AuthContext.jsx`, `frontend/src/context/CompanyContext.jsx`


# 16. Backend scripts (operator tools, evaluations, verification suites)

Ye sab `backend/` ke root me (aur `backend/eval/`) hain. `verify-*.js` offline tests hain jinka `check()` helper har file me apna hai; kuch scripts DB likhti hain (migrate-*, refresh-*, backfill-*), unhe bina padhe mat chalana. Har line: file, kya karti hai (file ke upar ke comment se), aur kaun si app files require karti hai.

## Verification suites (`verify-*.js`)

- `verify-adjustment-note.js` (470 lines) — Credit Note / Debit Note -> AdjustmentNote pipeline (LedgerMaster phase follow-on). Sections: PARSE (adjustmentNoteParser, pure), CLASSIFY (adjustmentNoteClassifier, pure + one Mongo lookup), MODEL (schema), PERSISTENCE (idempotency/tombstone/ambiguity/tenant isolation, real Mongo), SYNC/SECURITY (runSyncForCompanyModule end-to-end against a local Tally-shaped HTTP stub - ownership rejection, checkpoint behavior, minimal-field requests - mirrors verify-sync-batching.js's pattern). Fixtures match _Uses:_ `src/config/db.js`, `src/models/adjustmentNote.model.js`, `src/models/ledgerMaster.model.js`, `src/models/syncCheckpoint.model.js`, `src/services/parser/adjustmentNoteParser.js` (+5 more)
- `verify-ai-cost-path.js` (189 lines) — AI cost path, end to end through the REAL chat controller, queryChat, the shared planner response cache, the real planner client and the real Anthropic SDK - pointed at a LOCAL stand-in endpoint (eval/cost/harness.js). What this proves: the application's own behaviour (what is sent, how often, what telemetry records). What it CANNOT prove: anything about the provider (prompt-cache reads/writes, real token counts, real charges) - the stand-in's usage numbers are simulated. Those need the live run _Uses:_ `src/services/query/plannerResponseCache.js`, `src/services/query/aiPricing.js`, `src/services/query/usageStore.js`, `src/services/query/planner.js`
- `verify-ai-telemetry.js` (271 lines) — P1-1: per-turn AI/query telemetry (`tallypulse.ai.turn`). Fakes only: no MongoDB connection, no Anthropic, no Tally, no network. The controller tests stub the Chat model, the date context and freshness in require.cache, so nothing is read or written anywhere. Run: node verify-ai-telemetry.js _Uses:_ `src/services/query/turnTelemetry.js`, `src/services/query/queryChat.js`, `src/services/analytics/referenceDate.js`, `src/services/query/entityResolver.js`, `src/services/query/answerCache.js` (+2 more)
- `verify-ai-usage-persist.js` (171 lines) — P0 persisted AI usage telemetry. Offline: the writer is replaced by an in-memory fake (and the Mongoose model by a stub for the default-writer idempotency check) - no MongoDB, no Anthropic, no Tally, no network. Run: node verify-ai-usage-persist.js _Uses:_ `src/services/query/turnTelemetry.js`, `src/services/query/usageStore.js`, `src/models/aiTurnUsage.model.js`
- `verify-analysis-followup.js` (165 lines) — Follow-up context after an ANALYSIS turn (Phase 2): the scope every executed query step shares is saved as the turn's queryContext (followUp.buildAnalysisState), re-read strictly (readQueryState) on the next turn, and given to the analysis planner (planAnalysis previousScope), whose per-step guards read it like a previous plan. The REAL controller (sendChatMessage), chat turn, planners' checks and executor run; the model replies are scripted, the engine is in memory and the Chat model's database _Uses:_ `src/services/query/followUp.js`, `src/services/query/analysisPlanner.js`, `src/services/query/queryChat.js`, `src/models/chat.model.js`, `src/controllers/chatController.js`
- `verify-analysis-plan.js` (221 lines) — Analysis plans (services/query/analysisPlan.js), Milestone 1: a general multi-step plan over the existing query engine and insight tools, run by a deterministic executor. No model, no chat wiring. The end-to-end case is a 3-step analysis plus one insight step on synthetic data with hand-computed values: s1 total sales, October vs September -> s2 customers by change (largest fall first, top 2) -> s3 product change for exactly s2's customers (an input binding) ; s4 discount by product in October ( _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/tenantDataVersion.model.js`, `src/services/query/analysisPlan.js`, `src/services/analytics/insightTools.js` (+3 more)
- `verify-analysis-planner.js` (489 lines) — Analysis planner (Milestone 2): a question the query planner declines with `needs_analysis` gets an analysis plan from a second forced tool call, validated with the existing checks, then run by the analysis executor and answered with the measured results only. MOCKED model provider only: no network, no Anthropic call, no Tally. Covers: the generated prompt and tool schema and their budgets; output parsing and protocol checks; valid plans of different shapes (a decline explained by customers and  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/tenantDataVersion.model.js`, `src/services/query/analysisPlanner.js` (+8 more)
- `verify-analysis-presentation.js` (213 lines) — Structured view of an analysis answer (services/query/analysisPresentation.js) and the display intent read from the question (presentation.displayIntent). Checks that: - an answered analysis gets a presentation (kind "analysis") with a headline, KPI cards, one featured visual, labelled findings, gaps, suggested next actions and every step - not only the long text; - the headline, the KPI cards, the featured chart and the table carry the SAME values (the engine's, formatted once); - a contributor _Uses:_ `src/services/query/analysisPresentation.js`, `src/services/query/analysisAnswer.js`, `src/services/query/presentation.js`, `src/services/query/answerFormatter.js`, `src/services/query/queryChat.js` (+2 more)
- `verify-analytics-scope.js` (265 lines) — Analytics data-layer verification (synthetic data only; no Claude, no Tally): - voucher identity (tenantId + tallyGuid, not voucherNo) - analytics scope (tenant + active-only filtering, fails closed) - trust envelope states (valid/zero/stale/failed/never-synced/error) - company-context authorization Every fixture is a clearly-labelled synthetic document (VERIFY-* voucher numbers, a synthetic Company/User) created and removed around each test, regardless of pass/fail. The one write under TENANT_A _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/models/purchase.model.js`, `src/models/sales.model.js`, `src/models/syncCheckpoint.model.js` (+7 more)
- `verify-ask-ai-basic-questions.js` (296 lines) — The five basic business questions a reviewer asked Ask AI (2026-10-24), through the real chat turn (queryChat.tryAnswerWithQueryEngine): the query planner, ASK_AI_ANALYSIS modes, the analysis planner, the executor, the insight tools, freshness and the answer text. Questions 1, 2, 3 and 5 were refused ("needs several separate analyses") because ASK_AI_ANALYSIS was off; question 4 answered with a failed-Purchase-sync warning. ASK_AI_ANALYSIS unset now means on; basic and off are still checked. 1.  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/tenantDataVersion.model.js` (+6 more)
- `verify-ask-ai-ux-fixes.js` (117 lines) — Ask AI follow-up fixes (offline: no database, no network, no real model; every name and figure is SYNTHETIC): - an empty answer's follow-up ("take the last synced data") is told where the data ends, and the year guard accepts that month - a long ranking says how many moved (100+ products fell), not just "biggest drops" - an analysis follow-up carries the previous ranking, so "these products" needs no question - one bounded retry when the analysis planner asks for what the scope already holds Run _Uses:_ `src/services/query/followUp.js`, `src/services/query/planner.js`, `src/services/query/analysisPlanner.js`, `src/services/query/plainAnswer.js`, `src/services/query/presentation.js`
- `verify-cache-telemetry.js` (66 lines) — Cache and AI-cost measurement (Phase 0): the per-turn counters are truthful, tenant-scoped and private. - reported model calls (claudeCalls / plannerCalls) = the scripted model's actual calls, in every turn, caches on or off; a planner-cache hit is counted as a hit, never as a call; - engine executions are counted by the answer cache's own status, for single queries AND every analysis step; engine computes = misses + bypasses; insight tool runs are counted; - the counters reach the persisted AiT _Uses:_ `src/services/query/usageStore.js`, `src/services/query/turnTelemetry.js`, `src/models/aiTurnUsage.model.js`
- `verify-calculation.js` (169 lines) — The calculation record of a single-query answer (calculation.buildCalculation, attached to visualization.calculation by queryChat): what executed, with the engine's own values only. Checks the reported July/August example, both accounting bases, the % change rule of computeGrowth (zero previous), filters proven by the previous turn's scope, zero / missing totals, cut lists, incomplete periods, and that no number appears that the engine did not return. Every name is SYNTHETIC; the July/August tot _Uses:_ `src/services/query/calculation.js`, `src/services/analytics/salesAnalytics.js`, `src/services/query/answerFormatter.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`
- `verify-chat-management.js` (435 lines) — Ask AI chat management + Stop (cancellation), at the real controller level. - STOP: a client disconnect (the browser's AbortController) before the planner, during the in-flight planner call, or right after the planner answered ends the turn: no further planner call, no save, telemetry clientAborted=true / httpStatus 499. The in-flight planner request receives the abort signal. A real SDK planner client pointed at a local stub (never api.anthropic.com) is aborted mid-request and makes exactly one _Uses:_ `src/services/query/planner.js`, `src/models/chat.model.js`, `src/config/db.js`, `src/controllers/chatController.js`, `src/services/query/turnTelemetry.js`
- `verify-company-guid-match.js` (291 lines) — Company-GUID-match safety gate verification (2026-09-18). Product rule under test: adding a company to a TallyPulse account, and running Sales Sync, must both verify LIVE against Tally that the GUID being acted on is the company Tally actually has open right now - never trusted from the client, never inferred from company name alone. This uses the REAL live Tally instance (http://localhost:9000) and the REAL existing MongoDB company records already in this environment - not fabricated data - bec _Uses:_ `src/services/auth/tallyCompanyGuard.js`, `src/config/db.js`, `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/import/tallySalesImport.js` (+4 more)
- `verify-company-identity.js` (598 lines) — Company registration WITHOUT a manual Tally GUID, and company identity (authController.js "Connect Tally" + companyIdentity.js + tallyCompanyGuard.js). Product flow under test: register (name/email/password) -> login -> Connect Tally -> the backend detects the company open in Tally and uses ITS GUID internally. Also: the same GUID keeps the same tenant (reactivation / orphan reuse, sync checkpoints preserved), and knowing or being able to open a company never grants access to another account's c _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/models/user.model.js`, `src/models/userCompanyAccess.model.js`, `src/models/syncCheckpoint.model.js` (+7 more)
- `verify-company-ownership.js` (412 lines) — Company ownership / tenant-context guard (companyOwnership.js) across every path that consumes Tally data: incremental sync, recovery, reconciliation, self-heal and voucher-type master data. Scenario (confirmed live): two companies are open in TallyPrime and one is SELECTED. The open-company guard passes for BOTH tenants, but voucher and master queries answer for the selected company only - so a tenant can be handed the other company's data. The invariant under test: data may only change a tenan _Uses:_ `src/config/db.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js`, `src/services/tally/companyOwnership.js` (+7 more)
- `verify-comparison-period-capability.js` (611 lines) — Comparison & period capability AUDIT - characterizes what TallyPulse can answer today about period comparisons and growth/decline. It changes no production code and asserts CURRENT behaviour (surprising-but-correct behaviour is documented; defects are reported as KNOWN DEFECT, not fixed). A. period x comparison resolution matrix at two anchors (pure) B. known period-engine defects, characterized (pure) C. growth semantics: what the DSL/validator can and cannot represent (pure) D. planner represe _Uses:_ `src/services/query/validator.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/planner.js`, `src/services/query/semanticCatalog.js`, `src/services/analytics/periodEngine.js` (+8 more)
- `verify-cost-forensic.js` (192 lines) — Cost-path regression at the REAL exported chatController.js `sendChatMessage` HTTP-handler level (not tryAnswerWithQueryEngine in isolation). The planner is the only interpreter, so the contract is: - every question that passes the safety gate costs exactly ONE planner call (a scripted fake here); - conversation history never reaches Claude - only the previous STRUCTURED plan reaches the planner, never the chat text; - the answer cache saves the ENGINE (cacheKey equality, executor skipped), not  _Uses:_ `src/config/db.js`, `src/models/chat.model.js`, `src/services/query/planner.js`, `src/controllers/chatController.js`, `src/services/query/answerCache.js` (+6 more)
- `verify-customer-count.js` (281 lines) — customerCount (Slice 3): distinct sales customers, counted only when the party name matches EXACTLY ONE live ledger of the tenant's own Ledger master and that ledger is a debtor (Sundry Debtors). NO Claude / Anthropic, no Tally, no network: synthetic tenants on the loopback test database only (the test-mode guard in connectDB refuses anything else). All synthetic data is removed at the end. The fixtures are built so that the RAW distinct-name count (before Ledger-master resolution) differs from  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/ledgerMaster.model.js`, `src/models/tenantDataVersion.model.js`, `src/services/query/semanticCatalog.js` (+5 more)
- `verify-dashboard-real-data.js` (186 lines) — Regression tests for the Dashboard/Analytics "no fabricated data" remediation: tenant-reference-date anchoring (referenceDate.js), the new monthly trend aggregations (getSalesTrend/getPurchaseTrend), and the new distinct-customer-count aggregation (getCustomerCounts). Every number is independently cross-checked against a raw Mongo aggregation computed a different way in this file, for both real tenants (WE FOUR, Nirmal) - never "trust the function under test to grade itself". Run: node verify-da _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/company.js`, `src/models/user.model.js` (+4 more)
- `verify-db-connection-guard.js` (237 lines) — DB-free tests for the connection guard in src/config/db.js. Nothing here connects to MongoDB: the guard is a pure decision function. Run: node verify-db-connection-guard.js _Uses:_ `src/config/db.js`
- `verify-decline-investigation.js` (239 lines) — "Why did sales decline in August 2025?" - the bounded investigation connects the measured fall to its customer and product contributors and, when ONE product carries a material share of a fall its step ranked by that fall, to that product's purchase evidence (evidence.js rule 5, reached through the investigation's existing purchases_for_fall follow-up). The REAL investigation loop (investigate), executor, evidence and answer formatter run, and the chat turn once end to end; the engine is in memo _Uses:_ `src/services/query/investigation.js`, `src/services/query/analysisAnswer.js`, `src/services/query/analysisPresentation.js`, `src/services/query/queryChat.js`
- `verify-entity-resolver.js` (224 lines) — Tenant-scoped entity resolver (services/query/entityResolver.js): the one component that confirms a typed customer / supplier / product / group name exists for THIS tenant. The planner re-verifies every name Claude used through it. Fully offline: injected sources / fake models only - no MongoDB, no Tally, no Anthropic, no network. (These checks used to live inside the router suite; the router is gone, the resolver is not.) Run: node verify-entity-resolver.js _Uses:_ `src/services/query/entityResolver.js`
- `verify-evidence.js` (388 lines) — Evidence record of an analysis plan (services/query/evidence.js) and its findings in the answer text (analysisAnswer.js). Pure: the evidence is built from step results only, so every case here hands formatAnalysisAnswer / buildEvidence an execution object shaped exactly like executeAnalysisPlan's (query steps carry the engine's rows, totals, period and comparison). Checks: - arithmetic: changes, shares, and the quantity/rate split add up EXACTLY (2 decimals), including a seeded property run; - l _Uses:_ `src/services/query/evidence.js`, `src/services/query/analysisAnswer.js`
- `verify-followup-context.js` (198 lines) — Follow-up context across an analysis turn that measured BOTH sales and purchases, then into a single-query follow-up and a deeper analysis. The regression: "Compare sales vs purchase product wise and customer wise of Aug 2025" followed by "customers jiske wajah se sale giri" was planned with no context (month to date vs last month, no records), because 1. followUp.buildAnalysisState saved NO state when the steps differed in entity (sales and purchase), and 2. the query planner was never given an _Uses:_ `src/services/query/followUp.js`, `src/services/query/queryChat.js`, `src/models/chat.model.js`, `src/controllers/chatController.js`
- `verify-group-comparison.js` (227 lines) — Top N versus the others (groupComparison.js) and its follow-ups, on synthetic data: "top 3 suppliers which give me best price" -> "Compare with others" -> "Compare top 3 suppliers with others" -> "Aug 2025". The REAL controller (sendChatMessage), chat turn, query planner checks, validator, follow-up state and presentation run; the model replies are scripted, the engine is in memory (per-month purchases by supplier, honouring period, sort, limit and the overall total) and the Chat model's databas _Uses:_ `src/services/query/groupComparison.js`, `src/services/query/followUp.js`, `src/services/query/validator.js`, `src/services/query/queryChat.js`, `src/models/chat.model.js` (+1 more)
- `verify-growth-comparison-capability.js` (438 lines) — Real-user growth & comparison semantics AUDIT (read-only). Written as a snapshot of the audit findings; updated by the Semantic Foundation checkpoint (P-SF, 2026-09-28): the defects it pinned (three "todays", % totals refused, no coverage model) are asserted FIXED. The month-end and new/lost facts in B are unchanged on purpose (product decisions, docs/SEMANTIC_FOUNDATION.md). There is no deterministic router: the planner interprets every question (verify-query-planner.js, verify-nlu-eval.js). Th _Uses:_ `src/services/query/validator.js`, `src/services/query/planner.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/dateRanges.js`, `src/services/analytics/referenceDate.js` (+6 more)
- `verify-insight-tools.js` (198 lines) — Insight tools (services/analytics/insightTools.js): the validated registry over the existing insight functions. Proves: each tool returns the insight function's OWN result unchanged (compared with a direct call), plus a consistent evidence envelope (period, arguments, disclosures, coverage, limitations); strict argument validation (a tenant in the arguments is rejected); the tenant comes from the context only and never leaks across tenants; every aggregation gets an explicit maxTimeMS; timeouts, _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/tenantDataVersion.model.js`, `src/services/analytics/insights.js` (+3 more)
- `verify-insights.js` (672 lines) — Insights (services/analytics/insights.js): discount, product rates, supplier rates, indicative margin per product and per supplier, and the month-by-month product trend, and their REST handlers. Every figure is checked against an INDEPENDENT oracle: plain JavaScript loops over the same synthetic vouchers, written from the definitions in insights.js (not from its pipeline), with dates compared as YYYY-MM-DD strings. Also checked: cancelled vouchers and other tenants never count, both period edge  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/services/analytics/insights.js` (+7 more)
- `verify-investigation-eval.js` (176 lines) — Self-test of the planted-cause investigation evaluation (eval/investigation/, eval-investigations.js). It proves the harness, not the product: the ground truth equals hand-derived figures; the grader reads numbers correctly (dates are not figures), passes a handwritten ideal answer on EVERY criterion (no criterion is impossible) and fails wrong answers (missed causes, a profit claim, another tenant's figures, an unhedged hypothesis, no context); and the offline ceiling run through the real chat  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/tenantDataVersion.model.js` (+1 more)
- `verify-investigation-loop.js` (280 lines) — Bounded investigation loop (services/query/investigation.js), first slice. The REAL loop and the REAL executeAnalysisPlan (plan parser, query validator, name re-resolution, freshness and coverage gates) run against an in-memory engine stub that answers like the query engine (rows ordered and cut by the plan's sort and limit, totals over every row). Checks: a breakdown ordered against its change triggers ONE validated follow-up that re-orders it toward the change; the answer then names the larges _Uses:_ `src/services/query/investigation.js`, `src/services/query/analysisPlan.js`, `src/services/query/analysisAnswer.js`, `src/services/query/queryChat.js`, `src/services/query/evidence.js`
- `verify-ledger-master.js` (314 lines) — LedgerMaster phase: Tally Ledger/Group master sync + "new customer/supplier" (= Tally ledger CreatedDate inside the period, and traded in it). A. parsing + party role from the group chain (pure) B. refreshLedgerMasters: ownership rejection, persistence, unchanged skip, rename, removal, mass-removal guard, tenant isolation (Mongo) C. schema / validator rules for the new_in_period filter (pure) E. executor end-to-end on synthetic Mongo data (engine vs hand-computed oracle), disclosures, missing ma _Uses:_ `src/config/db.js`, `src/models/ledgerMaster.model.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/tally/ledgerMaster.js` (+3 more)
- `verify-migrate-voucher-total-amount.js` (215 lines) — Migration tests for migrate-voucher-total-amount.js, against a fully isolated synthetic fixture - NEVER real WE FOUR/Nirmal data. Invokes the actual CLI (child process) exactly as an operator would, so argument parsing, dry-run gating, and the --export requirement are all exercised for real, not bypassed. Run: node verify-migrate-voucher-total-amount.js _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`
- `verify-month-boundary-dates.js` (179 lines) — Month-boundary date regression: "previous month" and every other month/year shift must land in the right calendar month on EVERY anchor day - including 29-31 Mar, 31 May/Jul/Oct/Dec, 31 Jan, 29-30 Apr, 31 Aug and 29 Feb, where a plain `new Date(y, m - 1, day)` rolls over into the wrong month. Checked on every surface that resolves periods: dateRanges (shared helpers) -> periodEngine -> Query DSL validator (planner/engine) REST analytics/report API (dateRanges.resolveRequestPeriod / resolveReques _Uses:_ `src/services/analytics/dateRanges.js`, `src/services/analytics/periodEngine.js`, `src/services/query/validator.js`
- `verify-multi-company.js` (256 lines) — Multi-company-per-account verification, over the real HTTP routes, with the "Connect Tally" flow (no GUID typed anywhere). Product rules under test: - one TallyPulse account (email) can hold several companies; connecting one never needs a second email - the company connected is whichever one TallyPrime has open - detected by the backend, never supplied by the client - the first company needs only the session, further ones re-check the password - switching between the account's own companies need _Uses:_ `src/config/db.js`, `src/models/user.model.js`, `src/models/company.js`, `src/models/userCompanyAccess.model.js`, `src/routes/authRoutes.js` (+1 more)
- `verify-nlu-eval.js` (539 lines) — NLU evaluation harness: measures how well TallyPulse understands natural-language questions, against eval/nlu-corpus.json (synthetic names, expected plans in the existing queryPlan v1 contract). The planner is the only interpreter (there is no deterministic router), so the evaluation is of the planner. node verify-nlu-eval.js FREE: corpus self-check + scoring self-tests with fake providers (period mutations, a one-field-at-a-time mutation test of the comparator, the UTC pin, and the 380-row buck _Uses:_ `src/services/query/planner.js`, `src/services/query/queryPlan.schema.js`
- `verify-nvidia-eval.js` (201 lines) — Offline tests of the evaluation-only NVIDIA client (eval/nvidiaClient.js) and its CLI wiring. No network: every request goes to a local stub server on 127.0.0.1; any other fetch throws. No API key is read from backend/.env (a synthetic marker key is used). Covers: the reproducible reasoning switch (--nvidia-thinking / NVIDIA_THINKING), requested vs verified structured output, redaction of everything persisted or thrown, and isolation from OpenRouter. Run: node verify-nvidia-eval.js _Uses:_ `src/services/query/planner.js`
- `verify-openrouter-eval.js` (752 lines) — The multi-model NLU evaluation (eval-nlu-models.js, eval/openRouterClient.js, eval/nluModelRunner.js, eval/nluScoring.js). Offline and free: OpenRouter is a local stub HTTP server, the key is a fake, no Claude call is made, and nothing touches a database or Tally. It proves: the OpenRouter request is built correctly and identically for every model, the key never leaks, malformed / rejected / failed / timed-out answers are told apart, concurrency is bounded, scoring marks a plan that executes but _Uses:_ `src/services/query/planner.js`
- `verify-overall-direction.js` (102 lines) — The overall result governs the answer (evidence.overallOf): the measured total's direction is stated first, in words, and when the plan's own breakdowns look the other way (ranked by / filtered to falls while the total rose, or the reverse) the answer says the comparison does not show the opposite. Customer/product declines and zero sales stay secondary findings. Grounded fixture: the reported June -> July 2025 comparison - sales invoice amount ₹40,85,714.10 -> ₹57,16,599.12 (+₹16,30,885.02, +39 _Uses:_ `src/services/query/evidence.js`, `src/services/query/analysisAnswer.js`, `src/services/query/analysisPresentation.js`, `src/services/query/queryChat.js`
- `verify-period-engine.js` (235 lines) — Regression tests for periodEngine.js - the new, deterministic, LLM-independent date-period resolver (Part 1 of the Stock Group analytics foundation). Every expected value below was independently computed (printed via a throwaway script, cross-checked by hand against the calendar) BEFORE being hardcoded here - never generated by calling the function under test and trusting its own output. All comparisons use .toISOString(). The engine resolves calendar days in the server's local timezone, and the _Uses:_ `src/services/analytics/periodEngine.js`, `src/services/analytics/dateRanges.js`
- `verify-plain-answer.js` (128 lines) — The plain-language opening of an analysis answer (plainAnswer.js): the same verified facts as the detailed findings, in the question's language (en / hinglish / hi, from the analysis planner's structured `language`), short and in business words - without changing a figure or turning a possibility into a fact. Grounded fixture (reported): Ashok Traders sales ₹4,77,389.87 (Jul 2025) -> ₹1,34,075.39 (Aug 2025), -₹3,43,314.48 (71.9%); RANGEELA TEMPRA CLR 36ML sales ₹1,45,463.04 -> none recorded; its _Uses:_ `src/services/query/analysisAnswer.js`, `src/services/query/analysisPresentation.js`, `src/services/query/plainAnswer.js`, `src/services/query/queryChat.js`
- `verify-plain-query-answer.js` (168 lines) — The plain-language opening of a SINGLE-query answer (plainAnswer.plainQuerySummary, wired in queryChat): a few short sentences in the question's language (en / hinglish / hi - the query planner's optional `language` field, else Devanagari script -> hi, else en), built only from the engine result the detailed text formats. The detailed text (exact figures, basis, notes) follows unchanged; no figure is derived (rounding only). Every name and figure here is SYNTHETIC. Run: node verify-plain-query-a _Uses:_ `src/services/query/plainAnswer.js`, `src/services/query/answerFormatter.js`, `src/services/query/presentation.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`
- `verify-planner-digest.js` (351 lines) — The planner prompt's catalog digest (planner.js buildCatalogDigest): it must be GENERATED from semanticCatalog.js, carry the meaning the model needs to choose the right metric (each summed metric's own catalog description: the tax-inclusive voucher total vs the pre-tax item value, with its grain), state the validator rules the schema cannot express (including that voucher-grain metrics cannot be grouped by product), list what cannot be answered, and stay small. Offline and free: no model is call _Uses:_ `src/services/query/planner.js`, `src/services/query/semanticCatalog.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`
- `verify-planner-live-eval.js` (447 lines) — Phase 1G - CONTROLLED LIVE PLANNER EVALUATION (manual; makes real Anthropic calls). For each representative Sales/Purchase question (the planner interprets every question; there is no router), this script: 1. asks the real Claude planner (exactly one call per question, no repair), 2. compares Claude's plan SEMANTICALLY against an independently written expectation, 3. executes the validated plan through the real engine + answer cache, 4. compares the final answer with an independent oracle (raw M _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/query/planner.js` (+4 more)
- `verify-planner-response-cache.js` (286 lines) — Planner response cache (plannerResponseCache.js): a remembered model REPLY for an identical model request, per tenant. Offline, scripted models only (no network, no database, no paid call). Checks: hits/misses/bypasses, tenant isolation, the key (model, temperature, system, tools, tool_choice, max_tokens, messages), what is never stored (errors, timeouts, aborts, malformed / unexpected / truncated replies), bounds (per tenant, total, bytes, TTL, deterministic eviction), truthful usage (a hit is  _Uses:_ `src/services/query/plannerResponseCache.js`, `src/services/query/planner.js`, `src/services/query/analysisPlanner.js`, `src/services/query/answerCache.js`, `src/services/query/validator.js` (+2 more)
- `verify-presentation.js` (222 lines) — Presentation model (services/query/presentation.js): a deterministic description of how an ENGINE RESULT is shown (KPI / ranking / trend / comparison / table / empty). Proves that: - every figure in the model is a value the engine returned, formatted exactly like the text answer - nothing is computed except the marked, derived "Avg invoice" (amount / invoices of two returned values) - the text answer is byte-for-byte what formatQueryAnswer produces (presentation never changes it) - clarification _Uses:_ `src/services/query/presentation.js`, `src/services/query/answerFormatter.js`, `src/services/query/plainAnswer.js`, `src/services/query/queryChat.js`, `src/services/query/planner.js` (+2 more)
- `verify-product-return-analytics.js` (218 lines) — Product-Level Return Analytics: which products are returned (quantity and pre-tax value), reusing the existing sales_return/purchase_return entities, the generic "product" dimension (raw inventory.itemName, no StockItemMaster merge - same identity convention as sales/purchase), and the generic groupBy+sort+limit ranking machinery. No second DSL, no second classifier. ACCOUNTING BASIS (established from real WE FOUR data before writing any code - see docs/PROJECT_CONTEXT.md): inventory.quantity is _Uses:_ `src/config/db.js`, `src/models/adjustmentNote.model.js`, `src/services/query/execute.js`, `src/services/query/answerCache.js`, `src/services/query/compile.js` (+1 more)
- `verify-purchase-mapper.js` (170 lines) — Tally Purchase voucher -> Purchase document: parser (tallyParser.parseTallyVoucher) -> mapper (purchaseMapper.mapTallyPurchase) -> the Purchase schema. The same path processSinglePurchaseVoucher (voucherPersistence.js) runs before every Purchase write, for the sync worker, recovery and the import. Every expected amount below is worked out by hand from the fixture's own numbers (see the comment next to each), never read back from the mapper. Contract (docs/PROJECT_CONTEXT.md, "Stored signs"; tall _Uses:_ `src/services/parser/tallyParser.js`, `src/services/mapper/purchaseMapper.js`, `src/models/purchase.model.js`
- `verify-query-cache.js` (576 lines) — Phase 1E verification: answer cache + TenantDataVersion. Sections A-B are deterministic (no database). Sections C-F use MongoDB with clearly synthetic tenants (removed at the end) and a local stub standing in for Tally; they never touch real business data, Tally, or Anthropic. A. cache behaviour (fake executor/version) B. tenant isolation + fail-closed rules of the cache C. TenantDataVersion bumps on every write kind (model plugin) D. invalidation through the REAL write paths: sync, cancel/delet _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/stockItemMaster.model.js`, `src/models/tenantDataVersion.model.js` (+9 more)
- `verify-query-chat.js` (909 lines) — Production chat wiring: question (+ the previous structured plan) -> planner -> validator -> cache -> engine. There is no deterministic router: the planner is the only interpreter and every turn that passes the safety gate costs exactly one planner call, and every turn ends in an honest answer (a figure, a clarification, a refusal or a fixed failure message) - there is no other chat path. NO Anthropic call and no network: the planner client is a scripted fake and fetch/http are poisoned for the  _Uses:_ `src/config/db.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js`, `src/services/analytics/referenceDate.js`, `src/services/analytics/coverage.js` (+10 more)
- `verify-query-dsl.js` (566 lines) — Phase 1A verification: Sales/Purchase semantic catalog + strict Query DSL schema. Fully deterministic - NO database, NO Tally, NO Anthropic call. (It require()s existing analytics modules only to guard the catalog against drifting from production constants/functions; requiring them loads Mongoose models but never connects.) Run: node verify-query-dsl.js _Uses:_ `src/services/query/semanticCatalog.js`, `src/services/query/queryPlan.schema.js`, `src/services/analytics/periodEngine.js`, `src/services/analytics/salesAnalytics.js`, `src/services/analytics/purchaseAnalytics.js` (+1 more)
- `verify-query-engine.js` (985 lines) — Phase 1B verification: validator + compiler + executor for the Sales/Purchase Query DSL. NO Claude / Anthropic anywhere. Uses MongoDB with two clearly-labelled SYNTHETIC tenants (TEST-TENANT-A/B-query-engine) whose expected values are hand-computed, plus a small real-data smoke check on WE FOUR (independent aggregation). All synthetic data is removed at the end, pass or fail. This is NOT the parity suite (Phase 1C). Run: node verify-query-engine.js (SHOW_COMPILED=1 prints example pipelines) _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/stockItemMaster.model.js`, `src/models/company.js` (+6 more)
- `verify-query-parity-synthetic.js` (222 lines) — The PARITY SUITE (verify-query-parity.js) on synthetic data, so it runs in CI. verify-query-parity.js compares the generic Query Engine with the existing analytics (salesAnalytics, purchaseAnalytics, stockGroupAnalytics) and with independently written JS oracles. Its comparisons are data-driven (customer/product names, periods and rankings all come from the tenant's own vouchers), but its real-data run needs the WE FOUR tenant, so it is NOT RUN in CI. This suite seeds two synthetic tenants into  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/stockItemMaster.model.js`, `src/models/company.js` (+5 more)
- `verify-query-parity.js` (976 lines) — Phase 1C - PARITY SUITE: generic Query Engine vs the existing analytics. READ-ONLY against real data (WE FOUR = the large tenant, Nirmal = a small second tenant). Writes nothing. No Claude/Anthropic calls. Oracle policy (from the semantic catalog's PARITY_ORACLES): existing - the current analytics function is the ground truth (salesAnalytics / purchaseAnalytics / stockGroupAnalytics). independent - no existing function covers the shape, so the oracle is an INDEPENDENTLY written JavaScript comput _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/stockItemMaster.model.js`, `src/models/company.js` (+8 more)
- `verify-query-planner.js` (1238 lines) — Phase 1F verification: Claude planner (question -> Query DSL). EVERY Claude interaction here is a scripted FAKE client. No Anthropic call, no network, no Tally. Sections A-M are deterministic; section N is read-only against MongoDB (real tenant, real engine + cache, fake Claude). Run: node verify-query-planner.js _Uses:_ `src/services/query/planner.js`, `src/services/query/entityResolver.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/semanticCatalog.js` (+6 more)
- `verify-reconciliation-history.js` (353 lines) — Historical-deletion behavior of the EXISTING reconciliation (reconciliation.js + reconciliationWorker.js), end to end. Scenario: a voucher synced a month ago is later deleted in Tally. The incremental AlterID checkpoint is far ahead, so incremental sync never sees the deletion. Reconciliation must catch it: Tally current GUID registry -> compare with Mongo active GUIDs -> missing -> mark deleted (never physically removed) -> analytics excludes it without touching the incremental SyncCheckpoint.  _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js` (+8 more)
- `verify-reconciliation-perf-and-failure.js` (340 lines) — Reconciliation performance + Mongo-failure verification. Two things verify-reconciliation.js does NOT cover: 1. Behavior at a realistic voucher volume (a few thousand active vouchers) - confirms the GUID diff stays a single Mongo find + single bulk updateMany (no N+1) and completes in a reasonable time. 2. What happens when MongoDB itself fails mid-reconciliation, AFTER a successful Tally GUID fetch (e.g. write blip) - does it fail safely, leave state uncorrupted, and allow the next run to retry _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/reconciliationCheckpoint.model.js`, `src/services/sync/reconciliation.js`, `src/services/sync/reconciliationWorker.js` (+1 more)
- `verify-reconciliation.js` (482 lines) — Reconciliation safety-net verification. Test categories (2026-09-18 revision - see below for why): LIVE TALLY INTEGRATION (testRealDeletionDetection, testAnalyticsExcludesReconciledVouchers): genuinely need a reachable Tally, because they exercise reconcileVoucherType against the REAL current Sales/Purchase guid set. Previously these hardcoded two specific historical voucher numbers (Sales SA/49/2025-26, Purchase SA/54/2025-26) as "known to be deleted" fixtures. That broke silently: this dev ten _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js` (+8 more)
- `verify-reports.js` (290 lines) — Regression tests for the Reports module (Product Report, Customer Report, and the CSV export endpoints for all four report types). Sales Report and Purchase Report have no dedicated backend logic to test here - they reuse getSalesSummary/getPurchaseSummary (already covered by verify-dashboard-real-data.js) and the voucher-listing endpoints (already covered by verify-voucher-pagination.js). This file covers exactly what's new: reportAnalytics.js and reportController.js. Every number is independen _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/company.js`, `src/models/user.model.js` (+2 more)
- `verify-return-analytics.js` (235 lines) — Return Analytics Phase 1: query engine, chat integration (freshness + coverage, both fixed in this phase), tenant security, answer cache, and a real-data oracle check against WE FOUR / Nirmal (read-only). Complements verify-return-query.js (engine basics) and verify-adjustment-note.js (sync pipeline). This suite covers trend, comparison, the queryChat freshness/coverage entity-label fixes, cache-hit behaviour, and a forged tenant/company rejection. Phrasing -> plan is the planner's job (verify-q _Uses:_ `src/config/db.js`, `src/models/adjustmentNote.model.js`, `src/services/query/entityResolver.js`, `src/services/query/execute.js`, `src/services/query/queryChat.js` (+5 more)
- `verify-return-query.js` (101 lines) — Sales/purchase return query capability (LedgerMaster phase follow-on): the sales_return/purchase_return catalog entities end-to-end against real synthetic AdjustmentNote documents (engine vs a hand-computed oracle). (Phrasing -> plan is the planner's job; see verify-query-planner.js.) Complements verify-adjustment-note.js (sync pipeline) and verify-query-engine.js/verify-query-dsl.js (unaffected regression, already re-run for this phase). Synthetic tenant only. Run: node verify-return-query.js _Uses:_ `src/config/db.js`, `src/models/adjustmentNote.model.js`, `src/services/query/execute.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/semanticCatalog.js`
- `verify-return-ranking.js` (159 lines) — Return Analytics: Top-N customer/supplier ranking by sales/purchase return amount (execute.js/compile.js unchanged - groupBy+sort+limit, already generic). Complements verify-return-analytics.js (totals/trend/comparison) and verify-return-query.js. This suite is the ranking-specific checklist: top 1/5/10, no-N default, both directions, date filtering, tenant isolation, zero vs missing coverage, deterministic ties and cache hits. (Phrasing -> plan is the planner's job; see verify-query-planner.js. _Uses:_ `src/config/db.js`, `src/models/adjustmentNote.model.js`, `src/services/query/execute.js`, `src/services/query/answerCache.js`
- `verify-revenue-analysis-guard.js` (103 lines) — The revenue basis inside an ANALYSIS (analysisPlanner.revenueGuard). "Revenue" means sales + lineAmount (pre-tax item value). An analysis is judged as a whole: it needs one revenue step, may carry supporting steps (quantity, counts, breakdowns, sales-side insight tools) under their own labels, and must never show a tax-inclusive voucher total or a non-sales entity beside "revenue". Offline: no database, no network, no model; every name and figure is SYNTHETIC. Run: node verify-revenue-analysis-g _Uses:_ `src/services/query/analysisPlanner.js`, `src/services/query/planner.js`, `src/services/query/turnTelemetry.js`
- `verify-sales-import.js` (197 lines) — Sales import pipeline, end to end against MongoDB: importTallySales (the function behind POST /api/import/tally-json) -> resolveTenantContext (Company) -> extractVoucherCollection -> importParsedVouchers -> processSingleVoucher (voucherPersistence.js, Sale model). The background sync worker and "Run Sales Sync Now" (importTallySalesFromTally) end in the same processSingleVoucher. Covers: a multi-voucher file is persisted, the stored document matches the mapper contract, a re-import is idempotent _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/models/sales.model.js`, `src/services/import/tallySalesImport.js`
- `verify-sales-mapper.js` (112 lines) — Tally voucher -> Sale document: parser (tallyParser.parseTallyVoucher) -> mapper (salesMapper.mapTallySale) -> the Sale schema, with the guarantees the sync and the manual import rely on. Pure and offline: synthetic vouchers defined inline, no MongoDB connection, no Tally, no network. Run: node verify-sales-mapper.js _Uses:_ `src/services/parser/tallyParser.js`, `src/services/mapper/salesMapper.js`, `src/models/sales.model.js`
- `verify-sales-sync-worker.js` (204 lines) — Sales sync worker, end to end: runSyncForCompanyModule(company, SALES_SYNC_MODULE) with the REAL module - the real odbcService fetchers (getPendingVoucherAlterIds, getSalesVouchersSinceAlterId) talking HTTP to a Tally-shaped stub on 127.0.0.1, the open-company guard, voucher-type classification, batch ownership, and the real Sales persistence (processSingleVoucher -> Sale). verify-sync-batching.js covers batching with injected Purchase fetchers; this suite covers the Sales module itself, which n _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/syncCheckpoint.model.js`, `src/services/sync/tallySyncWorker.js`, `src/services/tally/voucherTypeClassifier.js`
- `verify-security-audit.js` (577 lines) — TallyPulse security audit - executable probes (no production code is changed). Each probe states the SECURE behaviour it expects and reports either [SECURE] the application behaved securely, or [VULNERABLE] the application did NOT (this is an audit finding, not a test bug - the run does not fail the process unless --strict). It backs the evidence in docs/TallyPulse-Security-Audit.md (probe ids SEC-xx). Safe by construction: an in-process copy of the API (same routers/middleware as server.js, no  _Uses:_ `src/config/db.js`, `src/models/user.model.js`, `src/models/company.js`, `src/models/userCompanyAccess.model.js`, `src/models/sales.model.js` (+23 more)
- `verify-self-heal.js` (444 lines) — Data/checkpoint self-heal (selfHeal.js, wired into reconciliationWorker.js). Scenario: the incremental SyncCheckpoint is far ahead, but MongoDB lost vouchers Tally still has (manual delete, restore...). The normal sync will never fetch them again. After a SUCCESSFUL reconciliation pass the worker compares Tally's voucher GUIDs with the tenant's MongoDB GUIDs (identities, never counts) and repairs the difference through the existing recovery service - bounded, on a cooldown, never touching SyncCh _Uses:_ `src/config/db.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/reconciliationCheckpoint.model.js`, `src/services/sync/selfHeal.js` (+4 more)
- `verify-semantic-foundation.js` (682 lines) — Semantic Foundation & Context (P-SF) - focused deterministic suite. There is no deterministic router: the planner interprets every question. This suite pins what the product does with a correct interpretation (the plan fixtures below), independent of the language that produced it: A. ONE tenant reference date per turn: the rule, future-dated vouchers (rule kept + disclosed), memoisation, and the SAME period boundaries through the engine and the planner B. relative periods: engine boundaries vs a _Uses:_ `src/services/query/validator.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/entityResolver.js`, `src/services/query/planner.js`, `src/services/query/queryChat.js` (+13 more)
- `verify-stock-group-analytics.js` (474 lines) — Regression tests for stockGroupAnalytics.js - deterministic Top-10 Stock Group sales analytics (Sale.inventory -> StockItemMaster -> stockGroupName, no LLM anywhere). Structure: A. Synthetic-tenant tests (1-19 from the task spec) - isolated, controlled fixtures, cleaned up before and after. B. Real WE FOUR verification - independent MongoDB aggregations written SEPARATELY from stockGroupAnalytics.js's own code (never "call the function, then compare its output to itself"). No Anthropic/Claude ca _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/stockItemMaster.model.js`, `src/models/company.js`, `src/services/analytics/stockGroupAnalytics.js` (+2 more)
- `verify-stock-item-gst.js` (822 lines) — Stock Item GST data, end to end. Two parts, one run: PART 1 - parsing and rules (no MongoDB, no Tally, no network): the Tally request, parsing of the observed raw field names and nested arrays, whitespace / control-character / numeric normalisation, the merge rules (idempotence, corrections, partial / malformed / empty / hollow responses), voucher-line GST, and the guarantee that no tax figure is derived from it. PART 2 - persistence and sync (MongoDB, injected Tally-shaped fetchers): the full d _Uses:_ `src/config/db.js`, `src/services/parser/gstFields.js`, `src/services/parser/tallyParser.js`, `src/services/mapper/salesMapper.js`, `src/services/mapper/purchaseMapper.js` (+11 more)
- `verify-stock-item-master.js` (303 lines) — Regression tests for the Stock Item -> Stock Group master layer (Part 2 of the Stock Group analytics foundation): - stockItemMaster.js's parsing (reuses voucherTypeClassifier's parseVoucherTypeMasterList - proven to work on this exact shape against a real, live TallyPrime instance, see the investigation report) - Stock Group extraction from Tally's own $Parent - missing-Parent / malformed-record handling - company GUID ownership validation (validateMasterOwnership, reused unchanged from companyO _Uses:_ `src/config/db.js`, `src/models/stockItemMaster.model.js`, `src/services/tally/stockItemMaster.js`, `src/services/tally/companyOwnership.js`, `src/services/query/dataVersion.js`
- `verify-sync-batching.js` (610 lines) — Bounded incremental sync batches (batchWindow.js + tallySyncWorker.js + odbcService AlterID window). Problem this guards against: a large backlog made the worker request EVERY pending voucher (with inventory/ledger detail) in one Tally call, which timed out, never advanced the checkpoint, and repeated every tick, keeping Tally busy. Each tick must now request a bounded slice, advance the checkpoint only after the whole slice persists, and drain the rest over later ticks. Fully offline and determ _Uses:_ `src/config/db.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/services/sync/batchWindow.js`, `src/services/sync/tallySyncWorker.js` (+4 more)
- `verify-sync-success-time.js` (26 lines) — A failed sync attempt must never look like a successful one: freshness and the data coverage read the SUCCESS time (lastSuccessAt), not the attempt time (lastSyncedAt). Offline: pure function + the model, no database needed. _Uses:_ `src/services/analytics/freshness.js`, `src/models/syncCheckpoint.model.js`
- `verify-sync-worker-guard.js` (151 lines) — Background incremental sync worker: company-GUID guard verification (2026-09-18). Product rule under test: the automatic Sales/Purchase sync worker (tallySyncWorker.js), which iterates EVERY active company on a timer against the one shared Tally URL, must never import the currently-open company's vouchers into a DIFFERENT tenant. Uses the REAL live Tally instance and a REAL throwaway Company document (not mocked) so the guard is proven against Tally's actual current state. Run: node verify-sync- _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js` (+4 more)
- `verify-tally-parser-voucher-total.js` (304 lines) — Parser unit tests for the corrected header.voucherTotalAmount formula (financial-data-correctness fix, tallyParser.js computePartyLedgerTotal / parseTallyVoucher). Pure unit tests - no MongoDB, no Tally, no network. Run: node verify-tally-parser-voucher-total.js _Uses:_ `src/services/parser/tallyParser.js`
- `verify-timezone-boundaries.js` (205 lines) — Period boundaries vs stored voucher dates must not depend on the server's time zone. The contract being verified (docs/PROJECT_CONTEXT.md, "Date boundaries"): - a voucher's date is stored as UTC midnight of its Tally calendar date (parseTallyDate), whatever the server's zone; - "today" and every period are calendar days of the server's calendar (periodEngine builds them from local dates); - so for a given calendar reference day, the SAME business dates must fall inside "Aug 1-31", "this month",  _Uses:_ `src/services/analytics/dateRanges.js`, `src/services/query/validator.js`, `src/services/query/compile.js`, `src/services/analytics/analyticsScope.js`, `src/services/analytics/referenceDate.js` (+2 more)
- `verify-unavailable-concepts.js` (107 lines) — Location and people concepts the data does not record (semanticCatalog `partial` unsupported entries) and how a question that asks for one of them ALONGSIDE something measurable is answered: the analysis planner declares the catalog ids in `unavailable` (validated against the catalog), the measurable part runs company-wide, and the answer states each reason first with an explicit company-wide scope - never a store or place figure. Offline: scripted model replies, the real planners' checks, the r _Uses:_ `src/services/query/semanticCatalog.js`, `src/services/query/analysisPlanner.js`, `src/services/query/planner.js`, `src/services/query/queryPlan.schema.js`, `src/services/query/analysisAnswer.js` (+1 more)
- `verify-voucher-lifecycle.js` (702 lines) — Voucher lifecycle hardening test matrix (Tests A-M from the task spec). Test categories in this file (2026-09-18 revision - see below for why): UNIT/SYNTHETIC (A, B, C, D, E, F, G, K, M, CONC): call processSingleVoucher/processSinglePurchaseVoucher DIRECTLY with hand-built voucher objects shaped like real Tally JSONEx output. These never touch Tally, never call verifyOpenTallyCompany, and never go through runSyncForCompanyModule - they exercise persistence/ analytics logic only, scoped under TEN _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/services/import/tallySalesImport.js` (+8 more)
- `verify-voucher-line-details.js` (500 lines) — Voucher item-line discount and computed GST amounts, end to end. Two parts, one run: PART 1 - requests, parsing and mapping (no MongoDB, no Tally, no network: axios.post is blocked except for a capturing stub): the sync and recovery requests ask for the computed GST group; the discount percentage and the derived discount amount (every rule, a 2,000-line property test, hostile values); the computed GST amounts; the reconciliation seen live; and that no financial field moves. PART 2 - the back-fil _Uses:_ `src/config/db.js`, `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/parser/gstFields.js`, `src/services/mapper/salesMapper.js` (+5 more)
- `verify-voucher-pagination.js` (246 lines) — Regression tests for the paginated/searchable voucher-list endpoints (GET /api/vouchers/sales, GET /api/vouchers/purchases) added as part of the frontend production-readiness work. Two layers: A. Direct controller calls (mock req/res, no HTTP/JWT) against REAL synced data for both real tenants (WE FOUR, Nirmal) - pagination math, search correctness, date filtering, tenant isolation, all independently cross-checked against raw Mongo aggregations. B. A real HTTP round-trip (against a live `node se _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/user.model.js`, `src/controllers/voucherController.js`
- `verify-voucher-recovery.js` (432 lines) — Missing-data recovery (voucherRecovery.js + odbcService recovery queries + POST /api/sync/recovery contract helpers). Scenario: Tally still has vouchers whose MongoDB documents are gone while the incremental checkpoint has already moved past them. Recovery must find exactly those, re-import them through the existing pipeline, never duplicate, never touch the checkpoint, and fail safe. Fully offline and deterministic - NO live Tally: a local stub answers the company-GUID guard and the VoucherType _Uses:_ `src/config/db.js`, `src/models/purchase.model.js`, `src/models/company.js`, `src/controllers/syncRecoveryController.js`, `src/models/syncCheckpoint.model.js` (+5 more)
- `verify-voucher-type-classification.js` (863 lines) — Generic Sales/Purchase voucher-type classification verification (2026-09-18). Replaces the old hardcoded "Child Of": "$$VchTypeSales"/"$$VchTypePurchase" sync queries. Confirmed live (see the investigation this implements) that "Child Of" on the "Vouchers:VoucherType" collection only matches vouchers whose OWN VoucherTypeName is an exact match - it never walks the voucher-type parent hierarchy. voucherTypeClassifier.js instead walks each voucher type's own parent chain to its self-parented root  _Uses:_ `src/services/tally/voucherTypeClassifier.js`, `src/services/odbc/odbcService.js`, `src/services/parser/tallyParser.js`, `src/services/auth/tallyCompanyGuard.js`, `src/services/import/tallySalesImport.js`

## Evaluations and corpora (`eval-*`, `backend/eval/`)

- `eval-ai-cost-live.js` (132 lines) — LIVE provider verification of the AI cost path (paid, small, capped). It answers what no offline test can: does the provider's prompt cache actually write and read for TallyPulse's requests, and what do real turns cost? ANTHROPIC_API_KEY=<your key> node eval-ai-cost-live.js --confirm-spend [--max-usd=0.50] [--ttl-probe] Guards (all enforced before the first paid call): - refuses without --confirm-spend; prints the plan and the worst-case spend first; - the key must already be in the process envi _Uses:_ `src/services/query/aiPricing.js`, `src/services/query/planner.js`, `src/services/query/analysisPlanner.js`
- `eval-ai-cost-report.js` (70 lines) — Read-only cost report from the persisted per-turn usage records (AiTurnUsage): what the AI flow cost and whether the prompt cache and the planner response cache paid. ONE aggregation, aggregates only - no document, prompt, answer, tenant id or request id is printed, and nothing is written. MONGODB_URI=mongodb://127.0.0.1:27017/tallypulse_test node eval-ai-cost-report.js [--since=2026-10-01] (a non-loopback URI, e.g. production Atlas, is refused unless --confirm-read-only-aggregate is also given) _Uses:_ `src/services/query/aiPricing.js`
- `eval-cache-baseline.js` (179 lines) — Cache and AI-cost baseline (Phase 0, measurement only): one fixed, scripted conversation run through the REAL chat turn (queryChat.tryAnswerWithQueryEngine), twice - with the planner response cache and the answer cache OFF, then ON - and the per-turn counters the turn itself reports (telemetry event -> AiTurnUsage record): model calls, planner-cache hits/misses/bypasses, engine executions by answer-cache status, insight runs. Offline and deterministic: a scripted model (no network, no paid call) _Uses:_ `src/services/query/queryChat.js`, `src/services/query/plannerResponseCache.js`, `src/services/query/answerCache.js`, `src/services/query/validator.js`, `src/services/query/turnTelemetry.js` (+3 more)
- `eval-findings-real.js` (619 lines) — REAL-DATA VALIDATION of the analysis findings (services/query/evidence.js), READ-ONLY. Fixed, scripted analysis plans (no model) run through the real executeAnalysisPlan and formatAnalysisAnswer on ONE real company, and every figure is checked against an INDEPENDENTLY written aggregate (its own date bounds, grouping and sums; no engine code). Acceptance criteria: A1 numbers - figures in findings equal the reference aggregates to the paisa; breakdowns add up to their change A2 incomplete - a peri _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js` (+7 more)
- `eval-investigations.js` (211 lines) — Planted-cause investigation evaluation (manual; never part of Ask AI). Seeds the synthetic company of eval/investigation/scenarios.js (known, planted causes) into a LOCAL test database, asks each scenario's questions through the real chat turn (queryChat.tryAnswerWithQueryEngine: planner -> analysis plan -> validator -> engine / insight tools -> answer), grades every answer with eval/investigation/grader.js and writes a report to eval/results/ (git-ignored). The data is removed at the end. Modes _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/models/syncCheckpoint.model.js`, `src/models/tenantDataVersion.model.js` (+4 more)
- `eval-nlu-models.js` (332 lines) — Multi-model NLU evaluation: measures how well each model turns the corpus questions into TallyPulse Query Plans, with the existing Claude planner as the baseline. EVALUATION ONLY - the production Ask AI path never uses OpenRouter. Every model is run through the production planQuestion() (same prompt, Query Plan contract, validator and guards) and every answer is scored by the same semantic comparator (eval/nluScoring.js) against eval/nlu-corpus.json. The questions and plans are synthetic: nothin _Uses:_ `src/services/query/planner.js`
- `eval/cost/harness.js` (132 lines) — AI cost-path harness: drives the REAL chat controller (sendChatMessage) -> queryChat -> the shared planner response cache -> the REAL planner client and Anthropic SDK -> an HTTP endpoint. The endpoint is either a local stand-in (createStub: free, deterministic, records the exact wire payload - application behaviour only, NEVER provider evidence) or the real provider (live runs, see eval-ai-cost-live.js). Only the DATA side is injected (engine execution, freshness, date context, name resolution)  _Uses:_ `src/services/query/turnTelemetry.js`, `src/services/query/usageStore.js`, `src/services/query/queryChat.js`, `src/models/chat.model.js`, `src/controllers/chatController.js` (+1 more)
- `eval/cost/run-baseline.js` (16 lines) — Prints what the ORIGINAL code does for Tests A-I and the SDK-retry check, through the real chat controller, against a local stand-in endpoint (no provider, no spend). Run: node eval/cost/run-baseline.js [--json=<file>]
- `eval/cost/scenarios.js` (125 lines) — The cost-path scenarios (Tests A-I of the AI cost audit), run through the real controller by harness.js. A scenario returns plain observations: what the HTTP endpoint ACTUALLY received (stub.calls = every request the SDK sent, including SDK-internal retries) next to what telemetry REPORTED for the same turn. Nothing is asserted here.
- `eval/cost/stub-server.js` (22 lines) — A local stand-in for the provider, for DRY-RUNNING eval-ai-cost-live.js (it spends nothing). `--simulate-cache` makes it behave like a 5-minute prompt cache (first request of a prefix writes, later ones read) - a SIMULATION to exercise the live script's arithmetic, never evidence about the real provider. Run: node eval/cost/stub-server.js [--simulate-cache] (prints its URL)
- `eval/evalTimezone.js` (33 lines) — The NLU evaluation's time zone: UTC, set explicitly. The scorer resolves relative periods ("previous month", "this FY") and explicit custom ranges to concrete dates and compares those dates. Both resolutions use the machine's LOCAL time zone, so on a machine west of UTC the same two plans - a relative period and the custom range that means the same days - resolve to different dates and one is scored wrong (observed under America/New_York). CI happens to run in UTC; the evaluator must not depend
- `eval/investigation/grader.js` (103 lines) — Deterministic grader for investigation answers (evaluation only). No model is involved: every criterion is a check on the answer text (or, for "context", on what the chat turn carried forward), so the same answer always gets the same grade. Criterion kinds: mentions - the text contains one of anyOf (string: case-insensitive substring; RegExp: tested as is) number - the text contains the number (Indian or plain digit grouping, ₹ optional, sign ignored) within tolerance discloses - the text matche
- `eval/investigation/scenarios.js` (285 lines) — Planted-cause investigation scenarios (evaluation only; nothing under src/ requires this file). One synthetic company, anchored to the FOUR complete calendar months before the run date (M1 oldest .. M4 = the previous month), so undated questions ("where are orange sales declining?") have data in the periods the assistant would choose. The causes are planted on purpose and every expected figure is computed from the plan below (and hand-checked in verify-investigation-eval.js): - Apple: stable for
- `eval/nluModelRunner.js` (482 lines) — Library behind eval-nlu-models.js: runs the SAME corpus rows through the production planner (planQuestion, unchanged) with different models behind the planner's client seam, scores every answer with the shared semantic scorer, and aggregates the measurements. NLU only: nothing here touches a database, Tally or real business data - the corpus is synthetic. Pure logic and file caching live here so they can be tested offline; the CLI only wires arguments, keys and output. _Uses:_ `src/services/query/planner.js`
- `eval/nluScoring.js` (333 lines) — The NLU scoring used by every evaluation of the planner (verify-nlu-eval.js and eval-nlu-models.js): the corpus, the semantic plan comparator and the outcome scoring. One implementation, so Claude and every other model are judged by exactly the same rules. Plans are compared SEMANTICALLY: both go through the real validator (relative periods resolve against the corpus reference date, defaults are applied) and are compared field by field - never as JSON text. A plan that validates and compiles but _Uses:_ `src/services/query/queryPlan.schema.js`, `src/services/query/validator.js`, `src/services/query/compile.js`, `src/services/query/semanticCatalog.js`, `src/services/query/entityResolver.js`
- `eval/nvidiaClient.js` (298 lines) — NVIDIA API Catalog adapter for the planner's model seam - EVALUATION ONLY. Nothing under src/ requires this file: the production Ask AI path never reaches NVIDIA. Same seam as eval/openRouterClient.js: claudeClient(request, { signal, meta }) -> an Anthropic-shaped response ({ content: [{ type: "tool_use", name, input }], usage }). The request is sent to NVIDIA's hosted, OpenAI-compatible endpoint (official API reference for nvidia/nemotron-3-super-120b-a12b: POST https://integrate.api.nvidia.com
- `eval/openRouterClient.js` (434 lines) — OpenRouter adapter for the planner's client seam - EVALUATION ONLY. The planner (src/services/query/planner.js) talks to its model through ONE seam: claudeClient(request, { signal }) -> an Anthropic-shaped response where `request` is { system, messages, tools, tool_choice, max_tokens } and the response carries `content: [{type:"tool_use", name, input}]` and `usage`. This adapter implements the same seam on top of OpenRouter's OpenAI-compatible chat-completions API, so planQuestion() runs unchang
- `eval/promptAblations.js` (47 lines) — Evaluation-only prompt ablations. Each one changes ONE thing in the system text of the planner request, so a live run of the same corpus rows shows which sentence a behaviour depends on. They are applied by eval-nlu-models.js (--ablate=<name>) to the request just before it is sent; planner.js and the catalog are never modified, and nothing under src/ imports this file. History: the 77-call ablation (no-limit-bounded, restore-product-rule, no-headline) was run against the prompt of that time; its

## Operator and migration scripts

- `backfill-voucher-line-details.js` (96 lines) — Back-fill the discount and the computed GST amounts of vouchers that are already stored. Why this exists: the voucher parser used to drop the item-line discount percentage (Tally's `discount` field) and ignore the computed GST group, so every voucher synced before that fix has discount 0/0 and no `gst.amounts`. The incremental sync will not re-read them (their AlterID did not change). This reads them once more from Tally, by explicit AlterID, and sets ONLY: inventory[].discountPercentage, invent _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/services/sync/voucherLineBackfill.js`
- `drop-stale-indexes.js` (64 lines) — Drop stale MongoDB indexes from the sales collection _Uses:_ `src/config/db.js`
- `list-indexes.js` (73 lines) — List all MongoDB indexes on the sales collection _Uses:_ `src/config/db.js`, `src/models/sales.model.js`
- `migrate-voucher-identity.js` (263 lines) — Voucher identity migration: tenantId + voucherNo -> tenantId + tallyGuid WHY --- Tally voucher numbers are a manual/business field, not a stable identity. Two distinct voucher masters (different GUID, different AlterID) can legitimately carry the same VoucherNumber - confirmed empirically against a real TallyPrime instance (see PURCHASE_SYNC notes / conversation history). Worse: this company's numbering series is shared ACROSS voucher types (a real Purchase voucher in this database is numbered " _Uses:_ `src/config/db.js`
- `migrate-voucher-total-amount.js` (290 lines) — header.voucherTotalAmount backfill: inventory-subtotal -> party-ledger total WHY --- tallyParser.js previously derived header.voucherTotalAmount from the pre-tax inventory subtotal whenever a voucher had inventory, silently excluding GST/freight/rounding. Fixed in tallyParser.js (computePartyLedgerTotal) for vouchers synced FROM NOW ON. This script corrects documents that were already stored under the old, wrong formula - see the financial-data-correctness audit for the full investigation and ev _Uses:_ `src/config/db.js`, `src/models/sales.model.js`, `src/models/purchase.model.js`, `src/services/parser/tallyParser.js`
- `refresh-ledger-master.js` (70 lines) — On-demand Tally Ledger master refresh (feeds "new customer/supplier"). Writes only to the LedgerMaster collection - never Sale, Purchase or SyncCheckpoint. Reads two Tally master collections (Group, Ledger), one at a time. Safe to re-run: idempotent upsert keyed by the ledger GUID, and a no-op when Tally's list is unchanged (pass --force to rewrite anyway). The selected Tally company must be this tenant's: a foreign company's masters fail the GUID ownership check and nothing is written. USAGE no _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/services/tally/ledgerMaster.js`
- `refresh-stock-item-master.js` (84 lines) — On-demand Stock Item -> Stock Group master refresh. NOT a migration and NOT the incremental voucher sync: this writes only to the new, previously-empty StockItemMaster collection - it never reads or writes Sale, Purchase, or SyncCheckpoint, and never contacts Tally for voucher/transactional data. Safe to re-run at any time (idempotent upsert, keyed by {tenantId, tallyGuid}). There is no scheduled worker for this yet, by design (see the Stock Item master investigation report) - this script is the _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/services/tally/stockItemMaster.js`
- `run-adjustment-note-sync.js` (62 lines) — One-off / manual Credit Note + Debit Note sync for a single tenant. Reuses the EXACT same code path as the background worker (runSyncForCompanyModule + CREDIT_NOTE_SYNC_MODULE/DEBIT_NOTE_SYNC_MODULE from tallySyncWorker.js) - same ownership guard, same completeness check, same checkpoint semantics, same minimal-field Tally request. Not a parallel implementation. USAGE node run-adjustment-note-sync.js --tenant <tenantId> _Uses:_ `src/config/db.js`, `src/models/company.js`, `src/services/sync/tallySyncWorker.js`

# TallyPulse: Project Context

Compact navigation file for AI coding sessions. **Read this first.** Then read only the files the task needs.
Durable knowledge only: no logs, no test counts, no local run state. Keep it to about 5k tokens.

## A. Overview
- **Purpose:** multi-tenant SaaS. It syncs TallyPrime accounting data (Sales/Purchase vouchers and masters) into MongoDB and serves dashboards, reports and an AI chat that answers business questions deterministically.
- **Stack:**
  - backend: Node + Express 5 + Mongoose 9 + MongoDB Atlas (`backend/`);
  - frontend: React/Vite (`frontend/src`, not coupled to sync internals);
  - Claude: only as the query planner (turns a question into a structured Query Plan); it never computes or writes an answer.
- **Tally:** HTTP JSONEx at `http://localhost:9000`. Only one *selected* company answers at a time.
- **Tenant model:** tenant = one Tally company, identified by its `companyGuid`. Users reach companies through `UserCompanyAccess`.

## B. System flow
```
TallyPrime -> odbcService (HTTP JSONEx) -> company guard + GUID ownership validation
  -> parser/mapper -> voucherPersistence / master refresh -> MongoDB (tenant-scoped)
  -> Query Engine (planner -> DSL -> validator -> compiler -> executor -> answer cache)
  -> deterministic formatted answer   (Claude = planner only)
```

## C. Directory map (backend/src)
| Path | Purpose | Read when |
|---|---|---|
| `services/odbc/odbcService.js` | Every Tally request: company info; VoucherType, StockItem, Ledger and Group masters; AlterID probe; incremental voucher fetches; GUID lists; manual date-range fetch | Changing a Tally query or adding a fetch |
| `services/tally/voucherTypeClassifier.js` | Sales/Purchase type names from the VoucherType master (parent chain + reservedname). Cache is keyed by companyGuid. `NEEDS_CONFIGURATION` when ambiguous | Voucher-type classification |
| `services/tally/companyOwnership.js` | `validateBatchOwnership`, `assertBatchOwnership`, `validateMasterOwnership`. GUIDs are `<companyGuid>-<hex>`; one foreign GUID rejects the whole batch | Any new Tally ingest |
| `services/tally/stockItemMaster.js` | Stock Item → Stock Group master refresh: full read, only new / changed items are written (an unchanged list writes nothing and keeps the answer cache); run by `tallySyncWorker` (without the GST phase) and by the manual script (with it) | Product-group features |
| `services/tally/stockItemGst.js`, `services/parser/gstFields.js`, `models/gstSchemas.js` | Stock Item GST/HSN history: one Stock Group per Tally request, ownership check, GUID match, per-section merge that never erases valid stored data; pure parser/normaliser (also reads voucher-line GST) | Stock Item GST data, voucher-line GST |
| `services/tally/ledgerMaster.js` | Ledger master refresh. Full read of Group + Ledger, ownership check, role (`partyRole`, `accountRole`) from reserved groups, unchanged-skip, `removedAt`, >50% removal refused | New-party features, ledger data, return classification |
| `services/parser/adjustmentNoteParser.js`, `services/mapper/adjustmentNoteMapper.js`, `services/tally/adjustmentNoteClassifier.js`, `services/sync/adjustmentNotePersistence.js` | Credit/Debit Note pipeline: richer parse (accounting/bill allocations), map, deterministic return classification (LedgerMaster.accountRole lookup), idempotent persistence. Self-contained, not sharing voucherPersistence.js | Credit/Debit Note sync or classification |
| `services/auth/tallyCompanyGuard.js` | `verifyOpenTallyCompany`, `resolveSelectedOpenCompany` (selected-company tiebreak via master GUIDs) | Company connection/selection |
| `services/auth/companyIdentity.js` | `ensureCompanyForGuid`: GUID → tenant reuse and ownership | Registration / connect company |
| `services/auth/companyContext.js` | Request's tenant/company context (from the JWT, never from Claude) | Auth-scoped routes |
| `services/sync/tallySyncWorker.js` | 60 s cron: AlterID probe → bounded slice (`batchWindow.js`) → completeness check → persist → advance `SyncCheckpoint`, for Sales, Purchase, Credit Note, Debit Note; preceded, per company and only when due (default every 6 h, `TALLY_MASTER_REFRESH_HOURS`, 0 = off; also on the first tick after a start), by a full Stock Item + Ledger master refresh (`runMasterRefreshForCompany`: open-company guard, one request at a time, 30 min retry after a failure, an error never stops the vouchers). Masters go FIRST because a Credit/Debit Note is classified from the Ledger master's `accountRole` when it is stored | Incremental sync |
| `services/sync/voucherPersistence.js` | Idempotent upsert by `{tenantId, tallyGuid}` | Voucher writes |
| `services/sync/reconciliation*.js`, `selfHeal.js`, `voucherRecovery.js` | 20 min GUID reconciliation (marks deleted, never removes); self-heal; recovery of vouchers missing from Mongo (dry run by default) | Deletion/gap handling |
| `services/import/tallySalesImport.js` | Manual "Run Sales Sync Now" (`POST /api/import/tally-live`) | Manual import |
| `services/parser/tallyParser.js`, `services/mapper/*` | JSONEx unwrap, `parseTallyDate` (UTC midnight), voucher mapping | Voucher shape changes |
| `services/analytics/*` | `analyticsScope.buildVoucherMatchStage` (tenant + active + date); `periodEngine` / `dateRanges`; `referenceDate.getTenantDateContext`; `coverage.js`; `freshness`; `trustEnvelope`; sales/purchase/report/stockGroup analytics; `insights.js` (discount, per-product sale/purchase rate, indicative margin, monthly product trend, best supplier rate and margin: plain functions over stored item lines, no catalog, shared by the REST pages `GET /api/analytics/discounts`, `/products/rates`, `/products/margin`, `/products/trend`, `/purchases/supplier-rates` and, later, the Ask AI tool) | Period math, REST analytics, discount / rate / margin / trend questions |
| `services/query/*` | AI query engine (section G); the only answer path of `POST /api/chat/message` | AI answers |
| `controllers/`, `routes/` | Express layer: auth, analytics, chat, import, odbc, report, sync, voucher | API changes |
| `middleware/` | auth, httpSecurity, rateLimit, requestId, upload, errorHandler | Security/API plumbing |

Backend root scripts: `verify-*.js` (tests), `refresh-stock-item-master.js`, `refresh-ledger-master.js --tenant <id>`, `backfill-voucher-line-details.js` (dry run by default; `--apply` to a non-local database needs `--confirm-host <host>`).
Run git from the repository root (`D:\TallyPulse`), never from `backend/`. Configuration: `backend/.env` (git-ignored); the committed template is `backend/.env.example`.

## D. Data models (`backend/src/models`)
| Model | Key fields / identity | Indexes / notes |
|---|---|---|
| `Sale`, `Purchase` | `tenantId`, `tallyGuid`, `tallyAlterId`, `voucherStatus` (active/cancelled/deleted), `header{voucherNo, voucherDate, voucherType, voucherTotalAmount, partyName}`, `inventory[{itemName, quantity, rate, amount, discountPercentage, discountAmount, gst}]`, `ledgers[]` | Unique `{tenantId, tallyGuid}`. Party is a name only (no GUID). `rate` is BEFORE discount and `amount` AFTER it (so revenue is already net of discount). `discountAmount` = list value (qty × rate) − `amount`, kept only when plausible next to the percentage (never above it, at most 20% below it), else 0. `gst` = the line's snapshot: HSN, taxability, rate rows, `amounts` (taxable value and CGST/SGST/UTGST/IGST/Cess in rupees, as Tally sends them), `provenance`. Lines synced before these existed read discount 0 and have no `gst.amounts` until back-filled |
| `StockItemMaster` | `tenantId`, `itemName`, `stockGroupName`, `tallyGuid`; optional `gst` (see below) | Unique `{tenantId, itemName}` and `{tenantId, tallyGuid}` |
| `StockItemMaster.gst` | The item's CURRENT master GST configuration with its full dated history: `applicability`, `hsn[]` (code string, applicableFrom, derived effectiveTo), `details[]` (applicableFrom, effectiveTo, taxability + key, reverseChargeRate, ineligibleItc true/null, `stateRates[]` → `rates[]` per duty head with `rate` and `ratePerUnit`), `issues[]`, `contentHash` | Optional; absent until a GST refresh. A rate is `{value, status: value/missing/malformed, raw}`: 0 is a value, missing/malformed are null, never 0. Duty heads are separate rows and are never summed. Nothing reads it for an answer. Sale/Purchase `inventory[].gst` is the separate snapshot a voucher line carried when posted |
| `LedgerMaster` | `tenantId`, `companyGuid`, `ledgerGuid`, `name`, `parentGroup`, `partyRole` (debtor/creditor/other), `accountRole` (sales_accounts/purchase_accounts/other - which ledgers an item's amount is booked to), `alterId`, `masterId`, `createdDate` (null if Tally has none), `syncedAt`, `removedAt` | Unique `{tenantId, companyGuid, ledgerGuid}`; `{tenantId, name}` (not unique: ambiguous names are refused); `{tenantId, createdDate}` |
| `AdjustmentNote` | Credit/Debit Notes, normalized (one model). `tenantId`, `companyGuid`, `header{...,voucherTotalAmount}`, `noteType` (credit/debit - the raw Tally family), `classification` (sales_return/purchase_return/value_adjustment/unclassified - deterministic, never from noteType alone), `inventory[{...,accountingAllocationLedger}]`, `originalVoucherNumber` (only a real Tally "Agst Ref", else null), `tallyGuid`, `voucherStatus` | Unique `{tenantId, tallyGuid}` (partial); `{tenantId, noteType, classification, header.voucherDate}`; scope index matches `analyticsScope` |
| `SyncCheckpoint` | Per tenant + voucherType last AlterID; `lastSyncedAt` | Advanced only after a whole slice succeeds |
| `ReconciliationCheckpoint` | Separate from SyncCheckpoint; self-heal fields | — |
| `Company`, `User`, `UserCompanyAccess` | Company carries `tenantId`, `companyGuid`, `tallyConnection.baseUrl` | — |
| `TenantDataVersion` | Per-tenant counter bumped by `dataVersion.tenantDataVersionPlugin` on every write | Invalidates the answer cache. Add the plugin to every model that feeds answers |
| `Chat` | Messages + `queryContext` (the stored structured plan, for follow-ups) | `{tenantId, userId, updatedAt}` |
| `AiTurnUsage` | One record per AI turn: `requestId`, `aiPath`, planner model, token counters, latencies, `ok`, `failureCategory`. Counters only; written fire-and-forget by `usageStore.js` | `AI_USAGE_PERSIST=off` disables |

## E. Tally integration rules
- One request at a time, narrow ranges, bounded timeouts, no polling loops. The gateway hangs under wide or concurrent queries.
- Incremental sync: probe AlterIDs → fetch by AlterID → the completeness check must return every probed ID. A failed voucher blocks the checkpoint (no quarantine yet).
- Cancelled vouchers are not stored. Deletions are found only by reconciliation, and deleted vouchers are marked, never removed.
- Deleting Mongo docs by hand strands them, because the checkpoint stays ahead. Fix with `recoverMissingVouchers`, never with a checkpoint reset.
- Master pattern: flat `Type: <Master>` collection with a minimal `Native Method` field list → `validateMasterOwnership` on the FULL raw list → tenant-scoped upsert keyed by GUID.
- Voucher item lines (verified live, WE FOUR): Tally sends the discount as a PERCENTAGE in `discount` (text with a leading space, 55% of lines non-zero) and no discount-amount field. `inventoryentries.computedigst` in the request makes Tally add its whole computed-GST group to every line (no extra time, about +43% payload); `computedhsn` / `computedgst` return nothing. Checked over August 2025: for Sales invoices the lines' CGST/SGST equal the voucher's own CGST/SGST ledgers (627 of 631) and line amounts + line taxes + rounding equal the invoice total (625 of 631); for Purchase vouchers they do NOT reconcile (CGST 20 of 62, totals 0 of 62), so purchase line tax amounts are not to be relied on. `computedutgst` repeats `computedsgst` (one head shown twice; never add them). In 557 of 3,092 discounted lines the real net is a further 1-12% below gross × (1 − percentage) (an unlabelled extra reduction), so `discountAmount` is the whole reduction (list value − line amount) when plausible, and `discountPercentage` stays as Tally shows it. The request carries it in the Sales/Purchase incremental sync, the recovery/back-fill fetch and the manual import (not Credit/Debit Notes).
- Existing vouchers are not re-read by the sync (same AlterID), so `backfill-voucher-line-details.js` sets ONLY `discountPercentage`, `discountAmount` and `gst` on stored lines (whitelisted paths, conditional on the stored AlterID, company-ownership checked, bounded, resumable). It never changes an amount, quantity, rate, header, ledger or status.
- Insights meanings (`services/analytics/insights.js`): list value of a line = |quantity × rate| (rate is BEFORE discount), billed value = |amount| (after discount, pre-tax). Discount = list − billed per line, counted only for lines that have a rate and quantity and are free or billed at ≥ 5% of list (others are left out and counted, a likely unit mismatch). It needs no back-fill: it reads the stored rate/quantity/amount, so it covers all history. Net rate = billed ÷ quantity. No unit is stored, so a rate assumes one unit per product; `rateSpread` (> 5× within sales or within purchases) raises `unitWarning`. "Price gap" = average sale rate − average purchase rate of the same product and period: not a profit (no stock cost). The best supplier is the cheapest one with ≥ 5% of the product's quantity; the saving is indicative. Indicative margin (`productMargin`, and per supplier in `supplierRates`) = average sale rate − average purchase cost per unit; the cost is the same-period average purchase rate, else the 12 months before the period (`costSource`). It is not Tally's stock valuation (no opening/closing stock, no valuation method), so it is a direction, not accounting profit; a product with no cost has null margin and profit (never 0) and sorts last. `productTrend` = quantity bought and sold per month for ONE product (free goods count as quantity), with net movement (bought − sold) and a running total from the first month shown: a movement, never a stock balance.
- Test databases: `connectDB` refuses (in test mode, i.e. any `verify-*.js`) anything but a loopback host and a database named `tallypulse_ci*` or `tallypulse_test*`.
- Stock Item GST: separate from the core Name/Parent/Guid request. `GSTDetails.*`, `HSNDetails.*` and their nested state/rate lists are fetched one Stock Group per request (`$Parent` filter), sequentially. Values arrive with a leading space and sometimes `` (Tally enum marker); dates are `YYYYMMDD`; rates are strings; `gstineligibleitc` appears only when true; `calculationtype` is optional.
- Stock Item GST merge: the stored history mirrors Tally's current dated history and is replaced as a whole. A section (applicability / hsn / details) that comes back absent, empty, hollow (history entries without rate rows, HSN rows without a code) or with a malformed value does NOT overwrite a stored valid one. A well-formed but shorter history is applied (a row deleted in Tally) and counted as `shrunk`. A failed, empty or unsafe-named group leaves its items as they were and is reported.
- Credit/Debit Note classification (`sales_return` / `purchase_return` vs `value_adjustment`) is decided when the note is STORED, from the `accountRole` of its allocation ledgers in the Ledger master. With the master empty every note became `value_adjustment` and every return question read zero (found on WE FOUR: 150 notes, 0 returns). So the Ledger master must be refreshed before the note modules run (the worker does), and notes stored earlier stay wrong until reclassified.
- Period-bound stock balances do NOT work through this API (verified on WE FOUR, 2026-10-14): a `StockItem` collection asking for `OpeningBalance` / `ClosingBalance` / `Inward*` / `Outward*` (and the `*Value` fields) with `svFromDate` / `svToDate` timed out and left Tally unresponsive for minutes, for a whole 184-item group and for a single item, with or without the value fields. Light requests (company, item names, GUID lists) are fine. Do not retry without the user's say; stock balance, closing stock and Tally valuation are therefore not available, and margins/trends come from the stored vouchers.
- Ledger masters: the AlterID filter works, but deletions are invisible, so a periodic full refresh is required (about 0.5 s for about 2k ledgers). `CreatedDate` is present.
- With two companies open, Tally answers for the SELECTED one. Every ingest must pass the ownership check.
- Restart the backend (`node server.js`) after code changes.

## F. Security invariants (never break)
1. `tenantId` / `companyGuid` come from the authenticated context or Company record only. Never from Tally data, the request body or Claude.
2. Validate GUID ownership BEFORE any write. Reject the whole batch on any foreign, missing or malformed GUID. No cross-company batch writes.
3. Every Mongo read and write is tenant-filtered. Compiled pipelines must start with the tenant + active-status `$match` (`compile.assertPipelineSafe`).
4. Fail closed: ambiguous or unreachable state → refuse or abort, never guess.
5. Claude never picks the tenant or company, never runs raw Mongo, and never computes financial figures.
6. Bulk-mutation guards (reconciliation and ledger removal): abort above a 50% change ratio.
7. No real tenant data in test fixtures. Use synthetic names and GUIDs.

## G. AI / query architecture (`services/query`)
```
queryChat.tryAnswerWithQueryEngine
  -> planner.js (Claude = the ONLY natural-language interpreter; there is no deterministic router. One forced `submit_query_plan` call per question, plus the previous turn's STRUCTURED plan for follow-ups (`followUp.js` state read from `queryContext`); server-side guards live in planner.js)
  -> queryPlan.schema (zod) -> validator (semanticCatalog-driven) -> compile (safe pipelines) -> execute
  -> answerCache (keyed by plan + TenantDataVersion) -> answerFormatter (text + notes + warnings)
  -> turnTelemetry (allow-listed codes only; each event is also persisted fire-and-forget as one `AiTurnUsage` record by `usageStore.js`, usage counters only, no cost - no pricing config exists; `AI_USAGE_PERSIST=off` disables)
```
- **Planner outcomes:** `supported` → plan; `unsupported` (decline, unsafe-input gate, new-party guard) → final honest answer; `needs_clarification` (decline or the year guard) → a question back; `planner_failed` → the fixed "planner unavailable" message; entity resolver down while the planner's names are verified → `planner_failed` / `planner_entity_check_failed` (the fixed "couldn't look up names, try again" message; never "not found"). An unexpected exception or a query that is too slow ends in the fixed `execution_failed` message. There is no second answer path.
- **The planner prompt is generated from the catalog** (`planner.js` `buildCatalogDigest`, tested by `verify-planner-digest.js`): per metric its scope, grain and - for summed amounts/quantities - the catalog's own description; the `QUERY_RULES` the schema cannot express (sort for high-cardinality groupings, list-mode shape, voucher-grain metrics cannot be grouped by product), worded as the catalog words them; and the unsupported list from `UNSUPPORTED_CAPABILITIES`. Storage paths, formulas, parity oracles and developer notes are never sent. Planner-owned wording stays in `planner.js`: output format, the "revenue" definition, name copying, period vocabulary, forecasts/explanations.
- **Claude is called exactly once per question that passes the safety gate (the planner), with no repair on the engine path.** It is NOT called for: unsafe/empty/oversized text, an aborted request, or the revenue guard. Validation, coverage, freshness and execution refusals happen after that one call (`ledger_master_missing` too). Raw chat history is never sent: a follow-up carries only the previous STRUCTURED plan, added to the user message as JSON, and only when a valid stored plan exists. The planner's year guard accepts years present in the previous plan's own dates.
- **Planner guards (planner.js, after Claude answers):** unsafe-input gate before any call; revenue guard (`mentionsRevenue` → pre-tax `lineAmount` + `REVENUE_ASSUMPTION` note); year guard (a year the user never wrote → `year_missing`); new-customer/supplier comparison refused (`unsupported_new_party`); month comparison rule (decision 2, below); term guards (`term_guard`, decisions D1-D3 below, on the normalised question text and independent of the plan's shape: net sales / turnover / "after returns" and invoice sales / "excluding tax" are refused with the catalog's own reason, and any "orders" question without the word invoice is clarified, whatever plan the model produced; a follow-up that names no noun ("now exclude tax") is judged against the plan the model produced AND the previous turn's plan); every entity name re-resolved against the tenant's own data. Small repairs instead of refusals: a grouped customer/supplier/product plan with no sort gets the first metric, highest first (`default_sort_applied` note), only when that is the plan's only validator error; a blank `new_in_period` value becomes `"period"` (any other value is still refused). A profit/margin question for which the model returned nothing usable (protocol violation or invalid plan) gets the catalog's fixed "no cost data" answer (`profit_guard`, unambiguous words only: profit, COGS, cost of goods, gross/net margin). The gate's refusal text says which kind of input it was (operator characters vs. an out-of-scope request); square brackets are allowed (Tally item names contain them).
- **Stop / client disconnect:** `chatController` turns the response closing before it is written (checked at entry too - a Stop during auth middleware closes the socket before the listener exists) into an AbortSignal passed to `queryChat` (skips the planner), and `planner.js` (aborts the in-flight SDK call, no repair). An aborted turn is never saved and nothing is written to the closed connection; telemetry records `clientAborted: true`, `httpStatus: 499`.
- **Structured answers (presentation):** `presentation.js` builds a deterministic model (KPI / ranking / trend / comparison / table / empty) from the plan + engine result and returns it in the existing `visualization` slot (persisted on the message); the text `answer` is unchanged. Figures are the engine's own formatted values (only the comparison "Avg invoice" is derived: amount ÷ invoices, marked). `ChatBubble` → `present/PresentationView` (recharts bar-h / line / bar + exact-value `DataTable`). Not-found answers, clarifications and refusals stay Markdown text.
- **Answer rendering is frontend-only and ₹0:** `ChatBubble` → `MarkdownMessage` (react-markdown + remark-gfm + remark-breaks; no raw HTML, no images, sanitised links) renders the engine's line-oriented text. The user's own question is shown as plain text. No AI call or backend change is involved in formatting.
- **DSL:** entity (sales/purchase/sales_return/purchase_return), mode (aggregate/list - list not wired for the return entities), metrics, groupBy (customer, supplier, product, productGroup, voucherType, date buckets), filters (`eq_ci`, `in_ci`, `contains_ci`, and `new_in_period` on customer/supplier), compare, having, sort, limit. `sales_return`/`purchase_return` bake a hard `classification` match into the compiled pipeline (`compile.js` `scopeStage`'s `forcedMatch`) - never a user-controlled filter, so a value_adjustment note can never be counted as a return.
- **Executor pre-resolutions** (one bounded read each, no N+1):
  - a productGroup filter → item names (StockItemMaster);
  - `new_in_period` → party names (LedgerMaster).
- **Revenue:** pre-tax `lineAmount`. "Sales" = tax-inclusive `invoiceAmount`.
- **Decided meanings (final product decisions D1-D6):**
  - Counts and averages are of INVOICES, never "orders" (there is no order data; labels say "Invoices" / "Avg invoice").
  - "Invoice sales" (before tax, before returns) and "Net sales" / "Turnover" (invoice sales after returns, before tax) are NOT calculable: no invoice-level total before tax is stored, and one query cannot combine sales with returns. They are refused with the catalog's `tax_breakdown` / `net_of_returns` reason, never approximated by `invoiceAmount` or `lineAmount`.
  - Bare "returns" and "credit notes" mean `sales_return`; `purchase_return` only when purchases, suppliers or debit notes are named. Return answers state that only the Credit/Debit Notes classified as returns are counted and that sales/purchase totals are not reduced by them.
  - "Product sales" / product-level amounts are pre-tax item values (`lineAmount`); the answer says they do not add up to the invoice totals.
- **Stored signs:** `inventory.amount` is stored as Tally sends it (sales +, purchase NEGATIVE, sales_return ≤ 0, purchase_return ≥ 0). The catalog's `entitySign` makes the compiler negate a PURCHASE `lineAmount` (a plain flip, so netting is preserved); `header.voucherTotalAmount` is already absolute. Item lines that map to no Stock Group are left out of a `productGroup` breakdown and its total and are disclosed (`warn_unmapped_product_group_lines`). `returnQuantity` carries the same mixed-units warning as `quantity`.

## H. Period and semantic rules (final)
- **Reference date:**
  - It is TODAY (end of the local day), shared per turn by every AI layer.
  - Future-dated vouchers never move it; answers disclose them (`future_vouchers_excluded`); explicit date ranges still return them.
- **Coverage:**
  - The window ends at the later of the last voucher and `SyncCheckpoint.lastSyncedAt`.
  - Outside the window → refusal; partly outside → caveat.
- **Month comparison:**
  - "This month vs last month" = month to date vs the COMPLETE previous month (on 28 Sep: 1–28 Sep vs 1–31 Aug).
  - "Same period", LMTD and like-for-like → like-for-like.
  - Quarters, weeks and FYs → like-for-like.
  - Every answer shows both ranges.
- **New customer/supplier:**
  - A party whose LedgerMaster `createdDate` falls in the period AND who traded in it (exact-name match).
  - No comparison period; never "absent in the previous period".
  - Disclosed caveats: traded before its ledger was created, bulk-created batch (50 or more on one day), ambiguous same-name ledgers (excluded), undated ledgers, master refreshed before the period end.
  - No master → `ledger_master_missing`.
  - The role comes from the transaction side (sales = customer, purchase = supplier), not from the ledger group.
- **New products:** still "sold now, not in the comparison period".
- **Names:** an exact normalized match wins. Otherwise a typed name that is the leading whole word(s) (first word 4+ chars) of EXACTLY ONE stored name resolves to it (`entityResolver`, flagged `partial`; the planner path does not add a note for it). Two or more candidates → not resolved. Product names come from the item names on this tenant's own sales and purchase lines (the query engine's product identity) plus the Stock Item master, so product questions work before the master is synced. The planner re-resolves every name it puts in a filter and replaces it with the stored spelling, or refuses; when nothing matched, the refusal lists up to 3 closest stored names ("Did you mean ...?", `entityResolver.suggest`; never picked for the user).
- **Not representable (the planner declines or asks):** first-ever purchase, reactivated/returning customers, rolling windows beyond the DSL's 7/30/90 days, "N months ago". Whether a given phrasing is declined, clarified or answered is the planner's call (see `verify-nlu-eval.js`); no deterministic code decides it. Meanings in detail: `docs/SEMANTIC_FOUNDATION.md`.
- **Date boundaries:** "today" and every period are calendar days of the SERVER's calendar (`periodEngine` builds them from local dates; `PERIOD_RULES.dayBoundaries`). A voucher or ledger date is stored as UTC midnight of its Tally date and is matched by CALENDAR DAY, never by raw instant: `dateRanges.storedDayStart/storedDayEnd` turn a period bound into the stored form of its day (applied once, in `analyticsScope.buildVoucherMatchStage`, and for the ledger created-date filter), `calendarDayOfStored` turns a stored date into its calendar day (coverage window, future-voucher check, REST reference date), and a `YYYY-MM-DD` string is a calendar day (`dateRanges.parseCalendarDay`). So the server's time zone never moves a voucher across a period edge (`verify-timezone-boundaries.js` runs six zones). Which calendar day "today" is still follows the server's clock (no per-tenant time zone). Buckets use `$dateTrunc` in UTC; empty buckets are not zero-filled; there is no calendar-year bucket.
- **Follow-ups:** the planner receives the previous structured plan (`queryContext`, strictly re-parsed by `followUp.readQueryState`) and interprets the new question against it. A conversation with no valid stored plan is planned as a fresh question.
- **Unchanged (open decision):** REST dashboard/reports anchor to the latest voucher; REST `vs_previous_month` cards keep the old comparison.

## I. Capabilities
- Incremental Sales/Purchase/Credit Note/Debit Note sync (own checkpoint each), reconciliation, self-heal, recovery (Sales/Purchase only), multi-company isolation, GUID-free registration.
- Masters: voucher types, stock items → stock groups, ledgers (party role + account role).
- REST dashboard, reports and analytics with trust/freshness envelopes.
- Ask AI chat management: Stop (real HTTP abort), rename (`PATCH /api/chat/:chatId` - title only, trimmed, 1–100 chars, no control characters, tenant+user scoped, does not reorder the list), delete with confirmation.
- Deterministic AI answers: totals, rankings, breakdowns, series, comparisons, grew/declined/stopped, product groups, new parties, follow-ups, coverage/future-voucher disclosures, answer cache, telemetry.
- Return analytics (`sales_return`/`purchase_return`): total amount/count, top-N customer/supplier ranking by return amount (any N, or the product's own default of 10 when none is stated - `LIMITS.defaultLimit`, same rule every grouped query already gets), a month-by-month trend, and one comparison (current period vs its decision-2 default - complete previous month, or like-for-like for a quarter). Ties break deterministically on the party name (reused, unmodified `compile.js`). A question with no period defaults to all history for a ranking/trend (matching the main grammar's own rule) but still requires one for a plain total. Freshness/coverage correctly track the Credit Note/Debit Note sync checkpoints (fixed in the analytics phase - they used to check Sales/Purchase's).
- Product-level return analytics: returned quantity (`returnQuantity`) and returned pre-tax value (`returnLineAmount`, line grain), by product name (raw `inventory.itemName`, same no-StockItemMaster-merge identity as the existing `product` dimension) - a specific product (filtered) or a top-N ranking. Accounting basis, confirmed against real WE FOUR data before implementing: `inventory.quantity` is always positive on both sides; `inventory.amount` is Tally's own signed entry (<=0 on every sales_return line, >=0 on every purchase_return line), so `returnLineAmount` sums its absolute value (`compile.js` accumulator gained a generic `abs: true` option) - this is the pre-tax LINE value, distinct from `returnAmount` (tax-inclusive voucher total, cannot be split across lines). Which return direction a phrasing means is now the planner's interpretation (there is no router grammar); the engine only accepts a valid `sales_return`/`purchase_return` plan.

## J. Known limitations
- No stock balance, closing stock or Tally stock valuation (see the Tally rule above): margins are indicative and trends are movements, not balances.
- Stock-item and ledger masters refresh automatically in `tallySyncWorker` (see its row); Stock Item GST history (about 74 reads) stays a manual command (`refresh-stock-item-master.js` without `--skip-gst`). An item removed in Tally stays in the stock item master. Voucher-line GST is stored only on vouchers synced after it was added; older vouchers are not backfilled. Credit/Debit Notes do not store line GST.
- Voucher-line GST (`inventory[].gst`, from the `gstovrdn*` and `ratedetails` fields) is Tally's resolved per-line value, marked "System Inferred" in every sample seen. Its source differs per line (`provenance`: Stock Item, Company settings, or "Specify Details Here" on the voucher), so it is not always the item master's. What a manual user override looks like is unverified. It is stored verbatim. No answer uses it yet: discount analysis and tax/before-tax questions stay unsupported until a metric is added on purpose (the data is now there; the D2/D3 decisions are unchanged).
- Stock Item GST is stored but used by NO answer: there is no tax-inclusive product amount, tax amount, HSN or GST-rate breakdown, and none may be derived from a master rate (rates are dated, state- and duty-head-specific, and a voucher's own tax lines, rounding and charges decide the invoice). Such questions stay under the `tax_breakdown` limitation.
- No poison-voucher quarantine: one unmappable voucher blocks the checkpoint.
- Credit/Debit Note (`AdjustmentNote`) recovery/reconciliation workers don't exist yet (only incremental sync) - a manually deleted note strands like a manually deleted Sale would.
- Returns: no product GROUP analytics (`productGroup` - StockItemMaster-based), no product-level return COUNT (voucher count vs line count is ambiguous), no return reasons/rate, no partial/full status, no GST-head impact, no net sales/purchases after returns, no list mode, no day/week trend (month only). The engine executes any plan the schema and validator accept (a limit above `LIMITS.maxLimit` is rejected by the schema; a customer/supplier/product breakdown needs an explicit sort), so keeping a question to what the user asked (for example not turning a ranking into a growth ranking, one return direction per question) is the planner's job, not a deterministic refusal. The planner prompt no longer declines returns/credit notes (its decline list is generated from the catalog's `UNSUPPORTED_CAPABILITIES`); how well a model answers return questions is measured by the evaluation corpus (`returns` group).
- Totals are tax-inclusive and gross of returns; there is no tax breakdown, no invoice-level total before tax and no net-of-returns figure (see decided meanings in H). Product-level amounts are pre-tax item values and do not reconcile to invoice totals.
- Stop cannot undo provider work already done: tokens Anthropic processed before the abort may still be billed. If the server finished and saved the turn before the disconnect reached it, the stopped question/answer appears when the chat is reopened.
- No invitation system for multi-user access to one company.
- The planner has no cache; the entity resolver cold-loads all name lists after a refresh.

## K. Test map (`backend/`, plain `node <file>`)
| Area | Suite |
|---|---|
| Entity resolver | `verify-entity-resolver.js` |
| Planner | `verify-query-planner.js` |
| Chat integration / follow-ups | `verify-query-chat.js`, `verify-semantic-foundation.js` |
| DSL / validator / compile / execute | `verify-query-dsl.js`, `verify-query-engine.js` |
| Answer cache / data version | `verify-query-cache.js` |
| Period math | `verify-period-engine.js`, `verify-month-boundary-dates.js` |
| Comparison semantics corpus | `verify-comparison-period-capability.js`, `verify-growth-comparison-capability.js` |
| Telemetry | `verify-ai-telemetry.js` |
| NL understanding evaluation | `verify-nlu-eval.js` over `eval/nlu-corpus.json` (synthetic names, expected queryPlan v1): default = corpus self-check + scoring self-tests with fake providers (free, no DB, no network); `--live --limit=N` = one existing-planner call per question. Scoring lives in `eval/nluScoring.js` (shared). Multi-model comparison: `eval-nlu-models.js` runs the same rows through the unchanged `planQuestion` with Claude (baseline) and OpenRouter models (`eval/openRouterClient.js` implements the planner's `claudeClient` seam; evaluation only - nothing under `src/` can reach OpenRouter; FREE-ONLY: exact `:free` ids whose live catalogue prices are all 0, price cap 0, no fallbacks/routers, halt on any reported cost; free accounts get ~50 requests/day), bounded concurrency, response cache, report in `eval/results/` (git-ignored); tested offline by `verify-openrouter-eval.js` |
| Ledger master + new parties | `verify-ledger-master.js` |
| Credit/Debit Note sync + classification + security | `verify-adjustment-note.js` |
| Sales/purchase return query engine | `verify-return-query.js`, `verify-return-analytics.js` (trend, comparison, chat freshness/coverage, cache, real WE FOUR/Nirmal oracle), `verify-return-ranking.js` (top-N customer/supplier ranking, real oracle) |
| Product-level return analytics | `verify-product-return-analytics.js` (quantity/value semantics, engine, security, cache, real WE FOUR/Nirmal oracle) |
| Stock item master / group analytics | `verify-stock-item-master.js`, `verify-stock-group-analytics.js` |
| REST analytics scope / sales mapping | `verify-analytics-scope.js`, `verify-sales-mapper.js` |
| Structured answer presentation | `verify-presentation.js` |
| Ownership / identity / multi-company | `verify-company-ownership.js`, `verify-company-identity.js`, `verify-multi-company.js` |
| Sync / recovery / reconciliation | `verify-sync-batching.js`, `verify-voucher-recovery.js`, `verify-reconciliation*.js`, `verify-self-heal.js` |
| Security | `verify-security-audit.js` |
| Cost path through the real chat handler | `verify-cost-forensic.js` |
| Ask AI rendering (0 network calls, XSS, tables) | `frontend/verify-chat-rendering.mjs` (run from `frontend/`) |
| Stop / rename / delete (cancellation, ownership, validation, 0 AI calls) | `verify-chat-management.js`, `frontend/verify-chat-api.mjs` |

- **Needs live Tally** (run with the company under test SELECTED): `verify-voucher-type-classification`, `verify-voucher-lifecycle`, `verify-sync-worker-guard`, `verify-company-guid-match`.
- **Do not run without an explicit request:** `verify-planner-live-eval.js`, `verify-nlu-eval.js --live` and `eval-nlu-models.js` call real Claude (billed) and, for the latter, OpenRouter (free-only models, but a real external call).
- **CI** (`.github/workflows/ci.yml`) runs the self-contained backend suites against a throwaway MongoDB, plus the frontend lint, build and checks. Suites with a "REAL DATA" section print SKIPPED when the real tenants do not exist. Run suites that exercise telemetry with `AI_USAGE_PERSIST=off` (except `verify-ai-usage-persist.js`).

## L. Open items
- Planner prompt: the catalog-derived digest (section G) is verified offline only; measure its effect with a live evaluation of the rows that failed before (the `lineAmount`-for-sales plans, validator-rejected plans, `returns`) before relying on it.
- Not built: product-group returns, return rate, net sales/purchases after returns, Credit/Debit Note recovery/reconciliation, a planner cache, an invitation system for multi-user companies. Ask AI does not yet reach the Insights (discount, indicative margin, product trend, GST): the planner declines those questions (planned: a `run_insight` planner tool).
- Security: `TallyPulse-Security-Audit.md` is the register of audit findings and the runnable probes (`verify-security-audit.js`).
- Detail docs: `docs/SEMANTIC_FOUNDATION.md` (what the engine's time/comparison/party terms mean), `docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md` (full reference).

# TallyPulse: Project Context

Compact navigation file for AI coding sessions. **Read this first.** Then read only the files the task needs.
Durable knowledge only: no logs, no test counts, no local run state. Keep it to about 5k tokens.

## A. Overview
- **Purpose:** multi-tenant SaaS. It syncs TallyPrime accounting data (Sales/Purchase vouchers and masters) into MongoDB and serves dashboards, reports and an AI chat that answers business questions deterministically.
- **Stack:**
  - backend: Node + Express 5 + Mongoose 9 + MongoDB Atlas (`backend/`);
  - frontend: React/Vite (`frontend/src`, not coupled to sync internals);
  - Claude: only for the planner and legacy explanations.
- **Tally:** HTTP JSONEx at `http://localhost:9000`. Only one *selected* company answers at a time.
- **Tenant model:** tenant = one Tally company, identified by its `companyGuid`. Users reach companies through `UserCompanyAccess`.

## B. System flow
```
TallyPrime -> odbcService (HTTP JSONEx) -> company guard + GUID ownership validation
  -> parser/mapper -> voucherPersistence / master refresh -> MongoDB (tenant-scoped)
  -> Query Engine (router -> [planner] -> DSL -> validator -> compiler -> executor -> answer cache)
  -> deterministic formatted answer   (Claude = planner / legacy explanation only)
```

## C. Directory map (backend/src)
| Path | Purpose | Read when |
|---|---|---|
| `services/odbc/odbcService.js` | Every Tally request: company info; VoucherType, StockItem, Ledger and Group masters; AlterID probe; incremental voucher fetches; GUID lists; manual date-range fetch | Changing a Tally query or adding a fetch |
| `services/tally/voucherTypeClassifier.js` | Sales/Purchase type names from the VoucherType master (parent chain + reservedname). Cache is keyed by companyGuid. `NEEDS_CONFIGURATION` when ambiguous | Voucher-type classification |
| `services/tally/companyOwnership.js` | `validateBatchOwnership`, `assertBatchOwnership`, `validateMasterOwnership`. GUIDs are `<companyGuid>-<hex>`; one foreign GUID rejects the whole batch | Any new Tally ingest |
| `services/tally/stockItemMaster.js` | Stock Item → Stock Group master refresh (on demand) | Product-group features |
| `services/tally/ledgerMaster.js` | Ledger master refresh. Full read of Group + Ledger, ownership check, role (`partyRole`, `accountRole`) from reserved groups, unchanged-skip, `removedAt`, >50% removal refused | New-party features, ledger data, return classification |
| `services/parser/adjustmentNoteParser.js`, `services/mapper/adjustmentNoteMapper.js`, `services/tally/adjustmentNoteClassifier.js`, `services/sync/adjustmentNotePersistence.js` | Credit/Debit Note pipeline: richer parse (accounting/bill allocations), map, deterministic return classification (LedgerMaster.accountRole lookup), idempotent persistence. Self-contained, not sharing voucherPersistence.js | Credit/Debit Note sync or classification |
| `services/auth/tallyCompanyGuard.js` | `verifyOpenTallyCompany`, `resolveSelectedOpenCompany` (selected-company tiebreak via master GUIDs) | Company connection/selection |
| `services/auth/companyIdentity.js` | `ensureCompanyForGuid`: GUID → tenant reuse and ownership | Registration / connect company |
| `services/auth/companyContext.js` | Request's tenant/company context (from the JWT, never from Claude) | Auth-scoped routes |
| `services/sync/tallySyncWorker.js` | 60 s cron: AlterID probe → bounded slice (`batchWindow.js`) → completeness check → persist → advance `SyncCheckpoint` | Incremental sync |
| `services/sync/voucherPersistence.js` | Idempotent upsert by `{tenantId, tallyGuid}` | Voucher writes |
| `services/sync/reconciliation*.js`, `selfHeal.js`, `voucherRecovery.js` | 20 min GUID reconciliation (marks deleted, never removes); self-heal; recovery of vouchers missing from Mongo (dry run by default) | Deletion/gap handling |
| `services/import/tallySalesImport.js` | Manual "Run Sales Sync Now" (`POST /api/import/tally-live`) | Manual import |
| `services/parser/tallyParser.js`, `services/mapper/*` | JSONEx unwrap, `parseTallyDate` (UTC midnight), voucher mapping | Voucher shape changes |
| `services/analytics/*` | `analyticsScope.buildVoucherMatchStage` (tenant + active + date); `periodEngine` / `dateRanges`; `referenceDate.getTenantDateContext`; `coverage.js`; `freshness`; `trustEnvelope`; sales/purchase/report/stockGroup analytics | Period math, REST analytics |
| `services/query/*` | AI query engine (section G) | AI answers |
| `services/ai/*` | Legacy Claude chat (`chatOrchestrator`, `tools`, `toolRouter`); REST comparison helpers | Legacy chat / tools |
| `controllers/`, `routes/` | Express layer: auth, analytics, chat, import, odbc, report, sync, voucher | API changes |
| `middleware/` | auth, httpSecurity, rateLimit, requestId, upload, errorHandler | Security/API plumbing |

Backend root scripts: `verify-*.js` (tests), `refresh-stock-item-master.js`, `refresh-ledger-master.js --tenant <id>`.
GOTCHA: `backend/` contains a leftover nested `.git`. Always run git from `D:\TallyPulse`.

## D. Data models (`backend/src/models`)
| Model | Key fields / identity | Indexes / notes |
|---|---|---|
| `Sale`, `Purchase` | `tenantId`, `tallyGuid`, `tallyAlterId`, `voucherStatus` (active/cancelled/deleted), `header{voucherNo, voucherDate, voucherType, voucherTotalAmount, partyName}`, `inventory[{itemName, quantity, rate, amount}]`, `ledgers[]` | Unique `{tenantId, tallyGuid}`. Party is a name only (no GUID) |
| `StockItemMaster` | `tenantId`, `itemName`, `stockGroupName`, `tallyGuid` | Unique `{tenantId, itemName}` and `{tenantId, tallyGuid}` |
| `LedgerMaster` | `tenantId`, `companyGuid`, `ledgerGuid`, `name`, `parentGroup`, `partyRole` (debtor/creditor/other), `accountRole` (sales_accounts/purchase_accounts/other - which ledgers an item's amount is booked to), `alterId`, `masterId`, `createdDate` (null if Tally has none), `syncedAt`, `removedAt` | Unique `{tenantId, companyGuid, ledgerGuid}`; `{tenantId, name}` (not unique: ambiguous names are refused); `{tenantId, createdDate}` |
| `AdjustmentNote` | Credit/Debit Notes, normalized (one model). `tenantId`, `companyGuid`, `header{...,voucherTotalAmount}`, `noteType` (credit/debit - the raw Tally family), `classification` (sales_return/purchase_return/value_adjustment/unclassified - deterministic, never from noteType alone), `inventory[{...,accountingAllocationLedger}]`, `originalVoucherNumber` (only a real Tally "Agst Ref", else null), `tallyGuid`, `voucherStatus` | Unique `{tenantId, tallyGuid}` (partial); `{tenantId, noteType, classification, header.voucherDate}`; scope index matches `analyticsScope` |
| `SyncCheckpoint` | Per tenant + voucherType last AlterID; `lastSyncedAt` | Advanced only after a whole slice succeeds |
| `ReconciliationCheckpoint` | Separate from SyncCheckpoint; self-heal fields | — |
| `Company`, `User`, `UserCompanyAccess` | Company carries `tenantId`, `companyGuid`, `tallyConnection.baseUrl` | — |
| `TenantDataVersion` | Per-tenant counter bumped by `dataVersion.tenantDataVersionPlugin` on every write | Invalidates the answer cache. Add the plugin to every model that feeds answers |
| `Chat` | Messages + `queryContext` for follow-ups | — |

## E. Tally integration rules
- One request at a time, narrow ranges, bounded timeouts, no polling loops. The gateway hangs under wide or concurrent queries.
- Incremental sync: probe AlterIDs → fetch by AlterID → the completeness check must return every probed ID. A failed voucher blocks the checkpoint (no quarantine yet).
- Cancelled vouchers are not stored. Deletions are found only by reconciliation, and deleted vouchers are marked, never removed.
- Deleting Mongo docs by hand strands them, because the checkpoint stays ahead. Fix with `recoverMissingVouchers`, never with a checkpoint reset.
- Master pattern: flat `Type: <Master>` collection with a minimal `Native Method` field list → `validateMasterOwnership` on the FULL raw list → tenant-scoped upsert keyed by GUID.
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
  -> followUp.js (uses the previous turn's queryContext)  |  localRouter.routeQuestion (deterministic)
  -> planner.js (Claude, only on needs_planner; server-side guards)
  -> queryPlan.schema (zod) -> validator (semanticCatalog-driven) -> compile (safe pipelines) -> execute
  -> answerCache (keyed by plan + TenantDataVersion) -> answerFormatter (text + notes + warnings)
  -> turnTelemetry (allow-listed codes only)
```
- **Router statuses:**
  - `supported` → plan;
  - `unsupported` → final honest answer;
  - `needs_planner` → Claude;
  - `temporarily_unavailable` → entity resolver down.
- **Claude is NOT called for:** supported and unsupported routes, follow-ups, validation or execution refusals, `ledger_master_missing`, or revenue questions (no legacy fallback).
- **Claude MAY be called for:** the planner (`needs_planner`), and the legacy chat when the engine declines a non-revenue question.
- **DSL:** entity (sales/purchase/sales_return/purchase_return), mode (aggregate/list - list not wired for the return entities), metrics, groupBy (customer, supplier, product, productGroup, voucherType, date buckets), filters (`eq_ci`, `in_ci`, `contains_ci`, and `new_in_period` on customer/supplier), compare, having, sort, limit. `sales_return`/`purchase_return` bake a hard `classification` match into the compiled pipeline (`compile.js` `scopeStage`'s `forcedMatch`) - never a user-controlled filter, so a value_adjustment note can never be counted as a return.
- **Executor pre-resolutions** (one bounded read each, no N+1):
  - a productGroup filter → item names (StockItemMaster);
  - `new_in_period` → party names (LedgerMaster).
- **Revenue:** pre-tax `lineAmount`. "Sales" = tax-inclusive `invoiceAmount`.

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
- **Refused:** first-ever purchase, reactivated/returning customers, % growth ranking, rolling windows, "N months ago".
- **Follow-ups:** answered by `followUp.js` from the stored `queryContext`. "Which of them are new?" is refused (ask it directly with a period).
- **Unchanged (open decision):** REST dashboard/reports anchor to the latest voucher; REST `vs_previous_month` cards keep the old comparison.

## I. Capabilities
- Incremental Sales/Purchase/Credit Note/Debit Note sync (own checkpoint each), reconciliation, self-heal, recovery (Sales/Purchase only), multi-company isolation, GUID-free registration.
- Masters: voucher types, stock items → stock groups, ledgers (party role + account role).
- REST dashboard, reports and analytics with trust/freshness envelopes.
- Deterministic AI answers: totals, rankings, breakdowns, series, comparisons, grew/declined/stopped, product groups, new parties, follow-ups, coverage/future-voucher disclosures, answer cache, telemetry.
- Return analytics (`sales_return`/`purchase_return`): total amount/count, top-N customer/supplier ranking by return amount (any N, or the product's own default of 10 when none is stated - `LIMITS.defaultLimit`, same rule every grouped query already gets), a month-by-month trend, and one comparison (current period vs its decision-2 default - complete previous month, or like-for-like for a quarter). Ties break deterministically on the party name (reused, unmodified `compile.js`). A question with no period defaults to all history for a ranking/trend (matching the main grammar's own rule) but still requires one for a plain total. Freshness/coverage correctly track the Credit Note/Debit Note sync checkpoints (fixed in the analytics phase - they used to check Sales/Purchase's).
- Product-level return analytics: returned quantity (`returnQuantity`) and returned pre-tax value (`returnLineAmount`, line grain), by product name (raw `inventory.itemName`, same no-StockItemMaster-merge identity as the existing `product` dimension) - a specific product (filtered) or a top-N ranking. Accounting basis, confirmed against real WE FOUR data before implementing: `inventory.quantity` is always positive on both sides; `inventory.amount` is Tally's own signed entry (<=0 on every sales_return line, >=0 on every purchase_return line), so `returnLineAmount` sums its absolute value (`compile.js` accumulator gained a generic `abs: true` option) - this is the pre-tax LINE value, distinct from `returnAmount` (tax-inclusive voucher total, cannot be split across lines). Router: passive "X were/was returned" reads as a sales return, active "we/did we return(ed)" as a purchase return (a real grammatical signal, not a guessed default) - genuinely bare phrasing with no direction word at all ("Product returns", "Top 10 returned products") stays refused, deliberately, per the ambiguity rule.

## J. Known limitations
- Stock-item and ledger masters refresh on demand only (scripts); no scheduled job.
- No poison-voucher quarantine: one unmappable voucher blocks the checkpoint.
- Credit/Debit Note (`AdjustmentNote`) recovery/reconciliation workers don't exist yet (only incremental sync) - a manually deleted note strands like a manually deleted Sale would.
- Returns: no product GROUP analytics (`productGroup` - StockItemMaster-based, deliberately separate from this phase), no product-level return COUNT (voucher count vs line count is ambiguous - refused explicitly, not guessed), no return reasons/rate, no partial/full status, no GST-head impact, no net sales/purchases after returns, no list mode, no day/week trend (month only) - all refused explicitly, not guessed. A customer/supplier or product breakdown/ranking cannot be combined with a comparison or a trend in one question yet (refused, `unsupported_combination`, so a ranking can never silently become a growth-ranking question); a product breakdown cannot combine with a customer/supplier breakdown either; over `LIMITS.maxLimit` refuses (`limit_too_large`); both directions in one question refuses (`return_direction_ambiguous`). Router phrasing coverage is deliberately narrow (see `routeReturnQuestion` in `localRouter.js`); unmatched return wording (including genuinely direction-less product phrasing like "Product returns") falls back to the general `net_of_returns` refusal rather than the planner (which doesn't know these entities yet).
- No invitation system for multi-user access to one company.
- The planner has no cache; the entity resolver cold-loads all name lists after a refresh.

## K. Test map (`backend/`, plain `node <file>`)
| Area | Suite |
|---|---|
| Router | `verify-query-router.js` |
| Planner | `verify-query-planner.js` |
| Chat integration / follow-ups | `verify-query-chat.js`, `verify-semantic-foundation.js` |
| DSL / validator / compile / execute | `verify-query-dsl.js`, `verify-query-engine.js` |
| Answer cache / data version | `verify-query-cache.js` |
| Period math | `verify-period-engine.js`, `verify-month-boundary-dates.js` |
| Comparison semantics corpus | `verify-comparison-period-capability.js`, `verify-growth-comparison-capability.js` |
| Telemetry | `verify-ai-telemetry.js` |
| Ledger master + new parties | `verify-ledger-master.js` |
| Credit/Debit Note sync + classification + security | `verify-adjustment-note.js` |
| Sales/purchase return router + query engine | `verify-return-query.js`, `verify-return-analytics.js` (trend, comparison, chat freshness/coverage, cache, real WE FOUR/Nirmal oracle), `verify-return-ranking.js` (top-N customer/supplier ranking, real oracle) |
| Product-level return analytics | `verify-product-return-analytics.js` (quantity/value semantics, router, engine, security, cache, real WE FOUR/Nirmal oracle) |
| Stock item master / group analytics | `verify-stock-item-master.js`, `verify-stock-group-analytics.js`, `verify-stock-group-ai-tool.js` |
| Ownership / identity / multi-company | `verify-company-ownership.js`, `verify-company-identity.js`, `verify-multi-company.js` |
| Sync / recovery / reconciliation | `verify-sync-batching.js`, `verify-voucher-recovery.js`, `verify-reconciliation*.js`, `verify-self-heal.js` |
| Security | `verify-security-audit.js` |

- **Needs live Tally** (run with the company under test SELECTED): `verify-voucher-type-classification`, `verify-voucher-lifecycle`, `verify-sync-worker-guard`, `verify-company-guid-match`.
- **Do not run without an explicit request:**
  - `*-live*.js` and `verify-ai-data-accuracy.js` call real Claude;
  - `verify-analytics-and-ai.js` writes temporary docs under a real tenant id.
- **Obsolete:** `verify-import-flow/final`, `verify-duplicate-protection`, `verify-real-multi-voucher`.

## L. Current work
- Branch `security/audit-and-hardening`. `9526bdf` is unpushed. Everything since then is UNCOMMITTED: Semantic Foundation, final decisions 1–3, the LedgerMaster phase, the Credit/Debit Note (`AdjustmentNote`) phase, and Return Analytics Phase 1.
- LedgerMaster and Credit/Debit Note sync are LIVE and validated for both real tenants: WE FOUR (1,979 ledgers; 249 Credit Notes / 42 Debit Notes synced, matched to an independent Mongo oracle) and Nirmal (39 ledgers; genuine 0 Credit/Debit Notes). No scheduled refresh yet - rerun `refresh-ledger-master.js`/`run-adjustment-note-sync.js --tenant <id>` manually.
- Return Analytics done: total/count/by-customer-or-supplier/top-N ranking/month-trend/one-comparison for `sales_return`/`purchase_return`, reusing the existing router→DSL→validator→compile→execute→cache→formatter pipeline unchanged (no new DSL fields - ranking is `groupBy`+`sort`+`limit`, already generic). Fixed two pre-existing bugs the new entities exposed: `queryChat.js` was checking Purchase's (not Credit/Debit Note's) sync freshness for return questions, and `coverage.js` labelled every return message "sales"/"Sales" regardless of direction.
- Product-Level Return Analytics done: `returnQuantity`/`returnLineAmount` metrics (line grain, `product` dimension reused on `sales_return`/`purchase_return`), ranking and a specific-product filter, both via the existing groupBy+sort+limit machinery - no new DSL. `compile.js`'s accumulator gained a generic `abs: true` aggregation option (reused wherever a metric's raw sign isn't already positive).
- Next candidates (not started): product-group returns, return rate, net sales/purchases after returns, Credit/Debit Note recovery/reconciliation, planner support for return entities.
- Details: `docs/SEMANTIC_FOUNDATION.md` §0 and `docs/GROWTH_COMPARISON_SEMANTICS_AUDIT.md`.

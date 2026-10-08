# Semantic foundation: what the AI engine's terms mean

The Ask AI engine must never answer a different question than the one asked, and must never show missing data as zero. This document fixes the meaning of the time, comparison and party terms the engine uses. The rules are enforced in code, not by prompt: the planner (`planner.js`) applies them to what Claude returns, the validator (`validator.js`) and the engine apply them to every plan, and the answer always states the resolved ranges. Pipeline overview: [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) §G, [`TALLYPULSE_TECHNICAL_DOCUMENTATION.md`](TALLYPULSE_TECHNICAL_DOCUMENTATION.md) §11.

## 1. One "today" per turn

`analytics/referenceDate.js` → `getTenantDateContext(tenantId)` returns the reference date and the synced coverage window. `queryChat` reads it once per turn (`createTurnDates`) and shares it with the validator, the coverage gate, the executor and telemetry. The date is never sent to Claude.

- **The reference date is today** (the end of the current local day).
- **Future-dated vouchers** never move "today" and are never inside a relative period ("this month" ends today). Every answer that excludes some says so (`future_vouchers_excluded`). An explicit date range that names those dates still returns them.
- A plan whose year the user never wrote (for example `2025-01-01..2025-03-31` for "last quarter") is refused as `year_missing` and turned into a question (`planner.js`). The year guard accepts years present in the previous plan's own dates, so follow-ups keep working.
- **Unchanged:** the REST dashboard and reports (`getTenantReferenceDate`) still anchor to the latest voucher; their `vs_previous_month` cards keep the same-days comparison. Ask AI and the REST screens can therefore disagree about "this month" for a tenant whose data lags.

## 2. Coverage: "no data" is never "zero"

- **Window:** from the first active voucher to the **later of the last voucher and the last successful sync** (`SyncCheckpoint.lastSyncedAt`). The incremental sync fetches every voucher altered up to that moment, so a synced day without vouchers is a real zero.
- `analytics/coverage.js` classifies a requested period as `covered`, `partly_before_history`, `before_history`, `partly_after_latest_data`, `after_latest_data`, `no_history` or `unbounded` (all time).
- `queryChat` runs the gate after the plan and freshness checks and before the engine. A subject or comparison **entirely outside** the window is refused (`outside_coverage`, tool state `no_usable_data`) with the missing range and the synced window named, and the engine does not run. A period **partly outside** is answered with a deterministic "Coverage: …" caveat in the text and in `warnings`.
- **Known limit:** gaps inside the window (a month never imported) cannot be detected; there is no ledger of imported ranges.

## 3. Comparing periods

- **"This month vs last month"** compares the **month to date with the complete previous calendar month** (on 28 Sep: 1–28 Sep against 1–31 Aug). This is enforced on the planner's plan (`planner.js`), and the answer carries the note `month_vs_complete_previous_month`.
- Explicit wording keeps its meaning: "same period last month", "same days", "like for like", "LMTD" → like-for-like (same number of days); "full last month" → the complete previous month; "same month last year" → the same days a year earlier; literal date ranges → exactly as written.
- Quarters, weeks and financial years compare like-for-like.
- When the current period is already complete (for example 30 April) but is compared with only the same days of the previous period (1–30 March, dropping 31 March), the answer says so (`complete_period_vs_same_days`) and names the "full last month" alternative.
- Every comparison answer prints both resolved ranges.
- **Growth %:** `null` (printed "% change n/a: the comparison value is zero") when the baseline is 0, never 0% or infinity. A zero current period against a non-zero baseline is a −100% comparison.

## 4. Parties and products

- **New customer / supplier:** a party whose Tally ledger `CreatedDate` (`LedgerMaster`) falls in the period **and** who traded in it as a customer (sales) or supplier (purchase), matched by exact name. The question has one period and no comparison; the planner refuses a "new customers vs the previous period" shape (`unsupported_new_party`) because "absent in the previous period" is not "new". Caveats disclosed with the answer: parties that traded before their ledger was created, bulk-created batches (50 or more ledgers on one day), ambiguous same-name ledgers (excluded), undated ledgers, and a master refreshed before the period end. A tenant without a ledger master gets `ledger_master_missing`. The ledger master is filled on demand by `refresh-ledger-master.js`.
- **New / lost products:** "sold in this period but not in the comparison period" and the reverse. The answer states that this is not necessarily a first-ever sale (full history is not checked).
- **Not representable** (the planner declines or asks): first-ever purchase, reactivated or returning customers, rolling windows beyond 7/30/90 days, "N months ago".
- **Names:** every customer, supplier, product or group name in a plan is re-resolved against the tenant's own data. An exact normalized match wins; otherwise a typed name that is the leading whole word(s) (first word 4+ characters) of exactly one stored name resolves to it; two or more candidates, or none, are refused ("check the spelling"). An outage of the name lists is reported as "couldn't look up names, try again", never as "not found".
- **Revenue vs sales:** "sales" is the tax-inclusive voucher amount (`invoiceAmount`); "revenue" is the pre-tax item value (`lineAmount`) and the answer carries the assumption `revenue_is_pre_tax_item_value`. Questions that mention revenue are forced onto the pre-tax basis by the planner regardless of what Claude returned.
- **Returns:** `sales_return` / `purchase_return` are Credit and Debit Notes classified by the ledger the item amounts were booked to (`AdjustmentNote.classification`), never by the note type alone. See `PROJECT_CONTEXT.md` §I.

## 5. Follow-ups

The chat stores the previous answer's validated plan on the assistant message (`queryContext`, strictly re-parsed by `followUp.readQueryState`; unknown keys, operators or versions make it ignored). A follow-up question is sent to the planner together with that structured plan — never the chat history — and Claude interprets the new question against it ("and by customer?", "what about suppliers?", "compare with last year"). A conversation without a valid stored plan is planned as a fresh question. The merged plan passes the same validator and guards as any other.

## 6. Remaining gaps

- Typos ("custmers", "grwoth") are the planner's to interpret; an unknown name gets the spelling clarification.
- Gaps inside the synced window are not detectable (§2).
- The planner prompt is generated from the catalog and no longer declines returns; whether a model now picks the tax-inclusive invoice total for generic "sales" and answers return questions correctly is measured by the evaluation corpus, not assumed.
- The planner itself is not cached: every question costs one Claude call.

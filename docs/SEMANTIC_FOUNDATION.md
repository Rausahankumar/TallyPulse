# Semantic Foundation & Context (P-SF) — decisions and behaviour

Checkpoint date: 2026-09-28. Branch `security/audit-and-hardening`, uncommitted. It follows up on
`GROWTH_COMPARISON_SEMANTICS_AUDIT.md`. The goal was to stop the AI from silently answering a different question than
the one the user asked. Planner caching, new DSL capabilities and rolling or multi-comparison windows were deliberately
not built.

## 0. FINAL product decisions (2026-09-28): these supersede §1, §5 and §6 below

**Decision 1: the reference date is today.**

- `getTenantDateContext` returns the end of the current local day as `referenceDate` (source `today`). Every AI layer
  shares it for the turn.
- Vouchers dated after today never move "today" and are never inside a relative period. Answers disclose them
  (`future_vouchers_excluded`), and an explicit date range that names those dates still returns them.
- The coverage window now ends at the **later of the last voucher and the last successful sync**
  (`SyncCheckpoint.lastSyncedAt`). The incremental sync fetches every voucher altered up to that moment, so a synced day
  with no vouchers is a real zero, not "no data".
- **Unchanged (needs confirmation):** the REST dashboard and reports (`getTenantReferenceDate`) still anchor to the
  latest voucher. Moving them to today is one line. It was left out because it is not in the decision's consumer list,
  and it empties the dashboard's "this month" for tenants whose data lags.

**Decision 2: this month vs last month compares the month to date with the complete previous calendar month.**

- On 28-Sep-2026 that is 1–28 Sep vs 1–31 Aug. It is the default everywhere:
  - router ("this month vs last month", "growth over last month", "MoM", change and new/lost intents, and the reversed
    "previous month vs current month");
  - follow-ups;
  - planner (enforced server-side, not left to Claude);
  - legacy tools (`vs_previous_month`, purchase growth, the stock-group month baseline).
- Explicit wording keeps its meaning:
  - "same period last month", "same days", "like for like", "same number of days", "LMTD" → like-for-like;
  - "full last month" → complete previous month;
  - "same month last year" → the same days last year;
  - literal ranges → exactly as written.
- Quarters, weeks and FYs keep like-for-like (the decision covers months). Every answer shows both resolved ranges.
- **Unchanged:** the REST dashboard's `vs_previous_month` comparison cards (`tools.resolveComparisonPeriods`, used only
  by REST now).

**Decision 3: "new customer" means absent from the party/ledger master. STOPPED at the design point.**

> **Implemented (LedgerMaster phase, 2026-09-28; uncommitted).** A new customer/supplier is a party whose Tally ledger
> `CreatedDate` falls in the period **and** who traded in it. `LedgerMaster` (`src/models/ledgerMaster.model.js`) is filled on demand by
> `refresh-ledger-master.js --tenant <id>` (`src/services/tally/ledgerMaster.js`: Group + Ledger fetch, GUID ownership check, role from
> the reserved-group chain, unchanged-skip, removals marked `removedAt`, >50% removal refused). The router turns new-party questions
> into a `new_in_period` filter on one period (a comparison is dropped). The executor resolves the names once from the master and discloses:
> parties that traded before their ledger was created, bulk-created batches (>=50 ledgers on one day), ambiguous same-name ledgers,
> undated ledgers, and a master refreshed before the period end. A tenant without a master gets `ledger_master_missing`, a final answer
> with no legacy fallback. The follow-up and the planner comparison-shape guard still refuse, with the new wording. No GSTIN is stored.
> Tests: `verify-ledger-master.js`. The text below is the original design note.

- **What is missing:**
  1. There is no party or ledger master model or collection. Only `StockItemMaster` exists.
  2. Vouchers store only `header.partyName` (Tally `PartyLedgerName`), with no party GUID.
  3. The Tally fetch (`odbcService`) pulls Stock Item masters (Name, Parent, Guid) but no Ledger masters.
- Any "new" classification would therefore be name-only, or would need a full history scan; both are ruled out.
- **What is implemented:** "new customers / suppliers" questions are refused honestly (`unsupported_new_party`) on
  every path:
  - router;
  - follow-up;
  - a planner plan shaped "absent in the comparison period" (server-side guard).
  So a returning 2024 customer is never labelled new. "New products" keep the comparison reading; the decision covers
  parties only.
- **Proposed design** (needs sign-off, Tally access for verification, and a sync change):
  - a tenant+company-scoped `LedgerMaster` (`tenantId`, `companyGuid`, `ledgerGuid`, `name`, `parent` group, `alterId`),
    synced like `StockItemMaster` and ownership-validated against the company GUID;
  - vouchers keep `partyName`, and the party GUID is resolved through the master (Tally ledger names are unique within
    a company);
  - classification loads the tenant's master once into a `Map` (name → GUID) and does an O(1) membership check per
    current-period party, with no history scan;
  - if the master is empty or its lookup fails, classification refuses rather than labelling everyone new.

## 1. One "today" per turn

**Before:** there were three anchors.

- The query engine used the tenant's latest voucher.
- The legacy chat prompt and legacy tools used the wall clock (except the stock-group tool).
- The planner had no date and validated against a fixed 2025-01-15.

**Now:** `analytics/referenceDate.js` provides `getTenantDateContext(tenantId)`, which returns the reference date plus
the synced coverage window. The rule is **unchanged**: the latest active voucher date across Sales and Purchase, or the
wall clock only when the tenant has no vouchers at all.

- The chat controller creates **one** memoised getter per turn (`queryChat.createTurnDates`). It is read at most once
  and shared by:
  - router validation;
  - planner validation (the date is never sent to Claude);
  - the coverage gate;
  - the executor (`{ tenantId, referenceDate }`);
  - the legacy chat prompt ("today");
  - every legacy tool (`context.referenceDate`);
  - telemetry (`referenceDateSource`, `referenceAheadOfClock`).
- Legacy `tools.resolvePeriod` / `resolveComparisonPeriods` and `buildSystemPromptBlocks` have **no wall-clock default**
  any more. Without the tenant date they throw instead of silently using `new Date()`.
- The planner date guard: a custom range or specific FY whose year the user never wrote is refused as `year_missing`.
  Example: the planner guesses `2025-01-01..2025-03-31` for "last quarter".

Tested by `verify-semantic-foundation.js` A/B: the same four questions give identical boundaries through
router/engine, legacy tools and the planner at month-end, 31 Mar, 29 Feb, FY start and mid-month. The engine also
matches an independent calendar oracle on 204/204 boundaries.

### PRODUCT DECISION REQUIRED — future-dated vouchers

One real tenant has active Sales vouchers dated 1 Oct 2026, entered 22 Sep 2026, while today is 28 Sep 2026. The data
model has no post-dated or optional flag: the voucher header holds only voucherNo, date, type, total, narration and party.
The code therefore cannot tell a legitimate post-dated invoice from a typo.

The three options:

- **A — keep (current, unchanged):** the latest voucher date even if it is in the future. This is consistent with the
  dashboard and engine, but for that tenant "this month" = 1 Oct 2026 only.
- **B — `min(latest voucher, today)`:** "this month" becomes 1–28 Sep, and the 1 Oct vouchers are excluded from every
  relative period.
- **C — ignore future-dated vouchers when picking the anchor:** same as B for the anchor, but it needs a cutoff rule.

Nothing was switched. A is kept, and every answer on a relative period now **discloses** it (`reference_date_after_today`):

> "This company's latest synced voucher is dated 1 Oct 2026, which is after today (28 Sept 2026); relative periods such
> as 'this month' are measured up to 1 Oct 2026."

Suggestion: B is the safer default for a business user, together with a sync-time warning about post-dated vouchers. Changing
the rule is a one-line change in `buildDateContext` plus the dashboard's use of `getTenantReferenceDate`, and it needs
sign-off.

## 2. Coverage — "no data" is never "zero"

- **Window:** the first to the last active voucher of either type. A sync covers both types, so a covered month with
  purchases but no sales is a real zero.
- **Classifier:** `analytics/coverage.js` assigns one of `covered`, `partly_before_history`, `before_history`,
  `partly_after_latest_data`, `after_latest_data`, `no_history` or `unbounded` (all time).
- **Engine path (`queryChat`):** the gate runs after the plan and freshness checks and before the engine.
  - If the subject or comparison is entirely outside the window, the turn is **refused** (`outside_coverage`, tool state
    `no_usable_data`). The engine does not run, and the fixed text names the missing range and the synced window. For a
    comparison it offers the subject on its own.
  - If a period is partly outside, the turn is answered with a deterministic "Coverage: …" caveat in both the text and
    `warnings`.
- **Legacy tools:** a period entirely outside coverage returns the same fixed message through the trust envelope
  (`no_usable_data`); no zero figure is ever computed. Partial-coverage caveats are not added on the legacy path
  (see §9).
- **Real data (read-only):** both real tenants have less than one year of history, so "this month vs same month last
  year" is now refused instead of "everyone grew from ₹0".
- **Known limit:** gaps *inside* the window (for example a month never imported) are not detectable. There is no sync
  ledger of imported ranges.

## 3. "Who"

"Who" is never read as "customer" on its own; the surrounding words decide.

| Wording | Reading |
|---|---|
| "who bought / purchased / stopped buying / reduced purchases", "who did we sell … to", "whose sales / purchases" | **customers** (their buying is our sales) |
| "who did we buy … from", "from whom", "who supplied us", "who sold us" | **suppliers** (our purchases) |
| explicit nouns (products, product groups, categories, stock groups, suppliers, customers) | that dimension, always |
| "who" + sales / revenue words, no verb frame | customers |
| "who sold the most" (no "us"); "who grew" / "is growing" with no sales or purchase word; "who had the lowest purchases" | **clarification** `who_ambiguous`: no guess, no name lookup |
| "who drove / contributed to the increase" | a party breakdown ranked by the change in amount, stated as *arithmetic contribution, not a cause*; "what drove …" without a party stays a reasoning request |

Each reading is stated in the answer: `who_read_as_customers`, `customer_buying_is_sales` or
`supplier_selling_is_purchases`.

Synonyms added:

- clients and buyers → customer;
- goods → product;
- parties → the customer on sales or the supplier on purchases ("parties bought" → customers);
- "who's" is recognised;
- conversational filler (hi, thanks, pls, I want to know, they, perform) is treated as grammar, not a name.

The audit's silent misread ("Who bought less …" → our purchase total) is fixed. The name-lookup leaks for grammar words
went from 8 to 2, and the 2 left are genuine typos.

## 4. Percentages

- **Total % change** ("sales growth % this month vs last month", "% change in revenue …") is answered. It was refused
  by P1-4.
- **Grouped %** ("growth % by customer") is answered. Rows are ordered by amount, not by %, and the answer says so.
- **Ranking by %** ("highest growth %", "top 10 by % growth", "fastest growing", "ranked by % growth") stays refused
  (`unsupported_growth_rate`) with a fixed reason: a tiny baseline tops any % ranking.
- **Thresholds** ("grew by more than 20%", "growth above 20%", "fell by at least 30%") map to a deltaPct filter.
  "Changed by more than 20%" has no direction, so it gets the clarification `threshold_direction_missing` (the DSL
  cannot express "either way").
- **Share of total** ("what % of sales came from X") is refused as `unsupported_share_of_total`. It was misread as
  growth.
- **Zero baseline:** the text says "% change n/a: the comparison value is zero" (never 0% or infinite). A zero current
  period against a non-zero baseline is now shown as a −100% comparison; the formatter used to print only "No matching
  records".

## 5. Month-end — PRODUCT DECISION REQUIRED (no semantic change made)

The evidence conflicts. The `dateRanges` header promises "like-for-like day ranges" but also "never a partial period
against a complete one". On the last day of a month, the current month is complete, yet like-for-like compares it with
the same day numbers of the previous month.

- 30 Apr is compared with 1–30 Mar, dropping 31 Mar.
- This affects 15 of 36 month-ends in 2024–26, plus quarter-end on 30 Jun.
- On synthetic data, a customer who bought only on 31 May is listed as a "new customer" in June.

**Implemented (disclosure only; ranges and figures unchanged):**

> "This period is complete (1–30 Apr 2026) but is compared with the same days of the previous period (1–30 Mar 2026),
> not all of it (1–31 Mar 2026). Say "vs full last month" …"

"vs full last month" already gives complete-vs-complete. Every relative answer now also prints the resolved dates of the
subject and comparison periods.

**Proposed semantics** (needs sign-off): when the current period is complete (`isPartial === false`), "this X vs last X"
should compare complete periods (`full_previous`); while it is partial, keep like-for-like.

**Tests to add with the change:**

- every month-end and quarter-end 2000–2040 compares with the full previous period;
- mid-period anchors are unchanged;
- new/lost lists on 31 May / 30 Jun synthetic data;
- dashboard parity.

## 6. New / reactivated / lost

| Definition | Status |
|---|---|
| **New** = bought in this period, not in the comparison period | Supported, as before. Every answer now states: "not necessarily a first-ever purchase (full purchase history is not checked)". |
| **Lost / stopped** = bought in the comparison period, not in this one | Supported, stated the same way. |
| **First-ever** (first transaction in history) | Not answerable with one comparison. Refused: `unsupported_first_purchase` ("first time", "first-ever", "brand new", "never bought before"). |
| **Reactivated** (history → gap → return) | Needs full per-customer history. Refused: `unsupported_reactivation` ("reactivated", "came back", "returning", "won back"). |

**PRODUCT DECISION REQUIRED:** whether "new customer" should mean first-ever. That needs a per-party history query or
DSL capability, which was out of scope. Also, "doing better/worse" has no single measurable meaning; it gets the
clarification `vague_performance` rather than being read as "bought more".

## 7. Follow-up context

**Where context was lost:** the chat persisted only display text.

- Follow-ups with history went to legacy chat (12/14 in the audit).
- The router answered fragments stand-alone: "and by customer?" became all-time sales by customer.

**Smallest structured state:** the previous engine answer's validated plan plus its measure (`basis`: revenue, amount,
count, avg or qty).

- It is stored on the assistant message as `queryContext` (`{v, plan, basis}`), in the tenant- and user-scoped chat
  document.
- It is returned non-enumerable, never in the API response and never in the history sent to Claude.
- On reuse it is strict-schema re-parsed. Unknown keys such as `tenantId`, operators, an unknown basis or an unknown
  version cause it to be ignored.

**Merge** (`query/followUp.js`): the fragment is read with the router's own grammar, and the fixed rules change only
what it names:

- grouping, including a party noun implying the entity ("what about suppliers?" → purchases);
- top/bottom N;
- % threshold (direction from the words, else from the previous question);
- direction, new or lost (adds the like-for-like comparison, with a note);
- period;
- comparison ("compare with last FY", "vs same month last year", "the month before");
- measure (revenue, quantity, count, average);
- sales ↔ purchases;
- a name (via the tenant resolver).

The merged plan is validated again. The answer states "Follow-up to your previous question: kept the …; changed: …".
Anything the rules can't apply gets a fixed clarification (for example "top 10" after a total: "Top 10 of what?").

A continuation cue ("and …", "what about …") with no stored plan goes to history-aware legacy chat and is never
answered stand-alone. A clarification turn carries the context forward.

**Result:** 13 of the audit's 14 follow-ups are now structured and 1 goes to legacy ("compare the two"). The new suite
has 43 follow-ups with exact expected meanings, and 0 Claude calls.

## 8. Tests

| Suite | Status | Checks | Contents |
|---|---|---|---|
| `verify-semantic-foundation.js` | new | 77 | A reference date (rule, future dates, memo, 20 cross-path boundary checks) · B 34 relative-period questions × 6 anchors vs an independent oracle · C 32 coverage questions · D 60 "who" · E 50 growth/% · F 24 new/reactivated/lost · G 43 follow-ups · H month-end · I synthetic tenant on real MongoDB (engine vs oracle for covered/partial/outside/zero/zero-baseline/who/new/lost, plus a controller round trip with persistence) · J safety · K no network |
| router | updated | 715 | "who stopped buying" is now customers; total % answered |
| planner | updated | 191 | invented-year guard |
| chat | updated | 202 | engine receives `{tenantId, referenceDate}`; notes cap 6 → 8 |
| telemetry | harness | 49 | harness gets a fixed synthetic date context |
| growth audit | updated | 28 | defects asserted fixed; 19/207 snapshot rows changed, each reviewed |
| comparison audit | updated | 80 | invented-date RISK now asserted FIXED |
| stock-group tool | updated | 34 | server-built date context; new no-history check |

## 9. Remaining gaps (not silent misreads)

- **Typos** ("custmers", "grwoth") still reach the name lookup. They get a "check the spelling" clarification.
- **"compare the two"** needs the two previous periods, so it goes to legacy chat.
- **Legacy chat:** no partial-coverage caveat. Custom dates are still chosen by Claude there, now anchored to the tenant
  date.
- **Products / product groups / "parties grew"** with no sales or purchase word stay `entity_ambiguous` (G2), and go to
  the planner when there is no history.
- **Gaps inside the synced window** are not detectable.
- **The running `node server.js` must be restarted** to serve these changes.

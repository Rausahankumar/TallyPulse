# Growth & Comparison Semantics Audit + Reference-Date Design

**Date:** 2026-09-26 · **Branch:** `security/audit-and-hardening` (base `9526bdf` + uncommitted P1-4 month-shift/router work)
**Scope:** read-only audit. No production code changed. No Anthropic, no Tally, no real-data writes.
**Evidence:** `backend/verify-growth-comparison-capability.js` (28 checks, all passing). It covers:
- 207 realistic questions;
- 14 conversational follow-ups;
- 126 engine-vs-oracle runs on a synthetic tenant;
- a coverage study;
- counts only from real tenants.

---

## 1. Executive findings

1. **The query engine's arithmetic is right.** 126 of 126 runs matched an independent oracle (plain calendar arithmetic plus in-memory sums):
   - 14 growth/decline/new/lost/% questions × 9 boundary anchors;
   - the anchors cover 29 Feb 2024, month ends, FY end and start, quarter end, year end and start, and mid-month.
2. **There are three different "nows" in one product.**
   - The query engine anchors relative periods to the tenant's latest synced voucher.
   - Legacy chat anchors its prompt *and* its tools to the **wall clock**.
   - The planner gets **no date**.

   For a tenant synced to 8 Dec 2025, turn 1 answers "this month" as 1–8 Dec 2025. A follow-up that falls through to legacy chat answers it as Sep 2026, which is empty.
3. **"No data" is shown as "no sales".** Both real tenants' synced history starts within the last ~9 months:
   - one starts 2025-04-01;
   - the other starts 2026-08-01.

   So every year-over-year question compares against a year with no synced data. Each customer then "grew from ₹0" (114 of 114 "growing" customers in one real case). Nothing warns, and the engine can't tell "no sales" from "no data" today.
4. **Follow-ups lose context.**
   - 12 of 14 realistic follow-ups go to legacy chat, with its wall-clock dates.
   - The other 2 are answered as **standalone** questions with the period and comparison silently dropped. For example, "and by customer?" after "Sales this month vs last month" returns *all-time* sales by customer.
5. **One silently wrong plan.** "Who bought less this month than last month?" returns **our purchases** as a total, when the user means *customers who bought less*. This is the only one among 98 supported questions. Nothing else that should be a clarification or refusal was answered with a plan.
6. **Like-for-like drops days at month end.** On the last day of a month the month is complete, yet the comparison drops the previous month's extra days. On 30 Apr, April (complete) is compared with 1–30 Mar. That happens on 15 of 36 month-ends; the quarter equivalent happens on 30 Jun.
7. **"New" and "lost" use the like-for-like baseline.** "New customers this quarter" (on 18 Sep) means "no purchase between 1 Apr and 18 Jun". So a customer who bought on 25 Jun counts as *new*.
8. **P1-4 over-reached.** "Sales growth percentage this month vs last month" is now refused. A total's % change is well defined and already shown in every comparison answer; only *% ranking* should be refused.
9. **39 gaps between current and recommended behavior** (details in §10).
   - 17 are router grammar gaps. Examples: clients, parties, buyers and goods aren't dimension words; "who" isn't customers; "doing better/worse"; "today vs yesterday"; "last 30 days vs previous 30 days"; "from Apr 2025 to Sep 2025".
   - 9 need a product decision on the default entity: questions about products, product groups or voucher types with no "sales" word.
   - 8 grammar or filler words still reach the **name lookup**: "clients", "parties", "doing better", "doing worse", "became", "reactivated", and two typos.
10. **Planner caching is not ready** (§12). The date model, the coverage semantics and the follow-up model must be settled first.

---

## 2. Current architecture (verified in code)

| # | Question | Where / what |
|---|---|---|
| 1 | Reference date source | `analytics/referenceDate.js getTenantReferenceDate`: **max active `header.voucherDate` over Sales ∪ Purchase**; falls back to `new Date()` with no data. Can be in the **future**: one real tenant has 6 post-dated sales vouchers, so its "this month" is Oct 2026 while today is 26 Sep. |
| 2 | Period resolution | Query DSL: **only in `validator.js`** (`resolvePlanPeriod`, `resolveComparison` → `periodEngine`). Called at execution time by `execute.js`, which fetches the tenant reference date itself. Validation fails with `reference_date_required` without it. Legacy tools use `tools.resolvePeriod` with a **wall-clock default**; only the stock-group tool anchors to the tenant. |
| 3 | Date context seen by Claude | **Planner:** none (prompt has no date; `queryChat` calls `planQuestion` with no reference date). **Legacy chat:** a wall-clock "Today's date is …" block in the system prompt. |
| 4 | Relative → absolute dates | **Router:** emits *symbolic* kinds (`current_month`…) plus absolute dates only for literal text (`August 2025`, ISO dates, `FY 2025-26`). **Planner:** symbolic kinds, or `custom` dates it writes itself, which nothing verifies. **Engine:** validator + periodEngine, with the tenant reference date. **Legacy chat:** Claude writes custom dates from the wall-clock block. |
| 5 | Comparison semantics | `semanticCatalog.COMPARE` and `COMPARISON_SUPPORT` (modes per kind); `periodEngine.resolveComparisonPeriod` (like-for-like windows); router step 18 (which mode a wording gets; like-for-like is the default). |
| 6 | Growth ranking | Router maps words to `having` (`.delta > 0` / `< 0`, `.deltaPct > N`) and `sort` (by `.delta`). `execute.js finalizeInMemory` does a full outer join, then having, then sort (**nulls last**), then limit. |
| 7 | Zero baseline / null % | `salesAnalytics.computeGrowth`: `deltaPct = null` when previous = 0. Having on a null value never passes, so "grew by more than 20%" excludes new customers. Ranking by % puts them last. |
| 8 | Tenant data coverage | **Not modelled anywhere.** Derivable cheaply: min/max active `voucherDate` per entity (index `{tenantId, voucherStatus, voucherDate}`), plus freshness from `SyncCheckpoint` (fresh / stale / sync_failed / never_synced). No stored "books begin" date. Sync is incremental from AlterID 0, so synced history = the Tally company's history, except for manual deletions or failed batches. |
| 9 | Who should own each decision | See the table below. |

| Decision | Owner |
|---|---|
| What a word means ("grew", "last 6 months") | router, deterministic |
| Resolved dates | validator + periodEngine, with the server-computed tenant reference date |
| Coverage and "no data" status | engine result metadata |
| User-facing warnings | the deterministic answer formatter. **Claude never writes these.** |

---

## 3. Reference-date design (not implemented)

**Principle:** Claude never does date arithmetic. Relative wording stays **symbolic** until the validator resolves it with the server's trusted reference date. Absolute dates may enter a plan **only if they are literally in the user's text.**

1. **Source.** `getTenantReferenceDate(tenantId)`, unchanged. Computed **once per turn in `queryChat`, before routing** (one index-backed query; today the executor recomputes it). The same value then:
   - drives execution;
   - drives the coverage checks (§6);
   - goes into telemetry and any future cache key.

   **Product decision:** clamp to `min(latest voucher, now)` when post-dated vouchers push it into the future, and say so ("data runs to 1 Oct 2026; 'this month' uses today, 26 Sep").
2. **Before planner invocation?** Yes: computed first, but **not sent to Claude.**
3. **What the planner receives:**
   - **No date, no timezone.**
   - **No coverage information:** coverage is server-side, and Claude must not phrase coverage warnings.
   - Keep the planner's input exactly as today: question plus router hint.
4. **Are absolute dates from Claude allowed?** Only when **provable from the question text**. A new deterministic **date-provenance check** in `planner.js`, after validation, requires:

   | Plan field | Must appear in the question |
   |---|---|
   | `custom.from` / `custom.to` | as an ISO date |
   | a whole calendar month | as month name + year |
   | `specific_fy` | as an FY label |

   Otherwise the plan is refused (`planner_date_not_in_question`), with no retry. Relative wording with no symbolic kind ("last 6 months") is already stopped by the router (P1-4); this closes the planner side.
5. **How the validator proves the correspondence.** The provenance check is the proof. The validator stays purely structural. For a symbolic kind the correspondence is by construction.
6. **Preventing wall-clock "today".**
   - **Planner:** has no date, and the provenance check blocks invented dates.
   - **Legacy chat:** must be switched to the tenant anchor. Pass `referenceDate` into `buildSystemPromptBlocks()` and into `tools.resolvePeriod` / `resolveComparisonPeriods`, as the stock-group tool already does. This is a correctness fix, not a feature.
7. **Follow-ups.** Recompute the reference date each turn, which is always freshest, and show the resolved range in every answer (already done). Legacy follow-ups must use the same anchor (item 6). Persist the resolved plan on each assistant message, so a later follow-up can be resolved deterministically (§7).
8. **Future planner-cache key.** Planner output is symbolic plus literal dates only, so it is **independent of the reference date**. The key needs:
   - `tenantId`;
   - the normalized question;
   - the router code;
   - the catalog fingerprint;
   - the prompt/tool hash;
   - the model id;
   - the planner-rules version.

   It does *not* need the reference date. On every hit: re-validate with today's reference date, re-resolve names, and re-run the provenance and coverage checks. Only first-turn, history-free questions may use it.

---

## 4. Growth semantics

| # | Meaning | DSL | Engine | Router | Planner | Definition clear? | New capability? |
|---|---|---|---|---|---|---|---|
| A | Absolute growth (current − comparison) | ✓ `.delta` | ✓ | ✓ grew/increased/improved/went up | ✓ | **Yes** | no |
| B | % change | ✓ `.deltaPct` (null when comparison = 0) | ✓ | ✓ thresholds "by more than 20% / 20 percent"; totals ✗ (P1-4 regression) | ✓ | **Yes** for totals and thresholds | no |
| C | New (comparison = 0, current > 0) | ✓ | ✓ | ✓ "new customers", "are new" (✗ "became a new customer") | ✓ | **Partly.** Baseline is the like-for-like span, not the full previous period or all history | decision |
| D | Lost (comparison > 0, current = 0) | ✓ | ✓ | ✓ stopped/lost/churned/dormant | ✓ | Same caveat as C | decision |
| E | Consistent growth (every sub-period up) | ✗ comparison + date series rejected; ≤ 3 having | ✗ | honest refusal (P1-4) | ✗ | Yes, but not buildable | **DSL/engine** |
| F | Growth across a multi-month window | only as two absolute custom ranges | ✓ | clarifies (P1-4) | would need dates it doesn't have | **No**, 7 meanings (§5) | decision, then DSL |
| G | MoM | ✓ current_month like-for-like | ✓ | ✓ | ✓ | Yes, except month-end truncation (§1.6) | rule |
| H | QoQ | ✓ | ✓ | ✓ | ✓ | Yes, except 30 Jun truncation | rule |
| I | YoY | ✓ same_period_last_year | ✓ | ✓ | ✓ | Yes, but **meaningless without coverage** (§6) | coverage metadata |
| J | Fastest growing | ✓ sort `.deltaPct` | ✓ nulls last | honest refusal | expressible | **No.** New customers have no %: excluded, or put first? Minimum base? | decision |
| K | Largest increase | ✓ sort `.delta` desc | ✓ | ✓ most/biggest/top N by growth | ✓ | **Yes** | no |
| L | Highest % | as J | ✓ | refusal | expressible | as J | decision |
| M | Biggest decline | ✓ sort `.delta` asc | ✓ | ✓ (✗ "lost the most business": the word "business" is ambiguous) | ✓ | **Yes** | no |
| N | Largest % decline | ✓ | ✓ | refusal | expressible | Mostly. Lost customers are all −100% (ties) | decision |

**Recommended product definitions** (to confirm):
- **"Growing" with no qualifier** is absolute change against the stated comparison. That's the current behavior, and it's the only unambiguous one.
- **"Fastest" / "highest %"** ranks by % among entities *present in both periods*, with new entities listed separately as "new". It needs a minimum comparison value to avoid ₹1 → ₹100 = +9,900%.
- **New / lost** use the **full previous period** (or, for "new", the whole synced history before the period, which needs coverage).

---

## 5. Period semantics

**Supported deterministically:**
- today, yesterday, this/last week, this/last month, this/last quarter;
- this/last FY, FY 2025-26, FYTD;
- last 7 / 30 / 90 days;
- MTD vs LMTD, "same/corresponding period last year";
- explicit ISO ranges, "April 2025", "April 2025 vs April 2024".

**Clarification required (all Claude-free today):**
| Wording | Why |
|---|---|
| "this/last year", "year to date", "YTD" | calendar or financial? |
| Q1–Q4, H1/H2, "first half" | FY Q1 = Apr–Jun; calendar Q1 = Jan–Mar |
| "April to September" | year missing |
| "two months ago", "month before last" | no offset period kind |
| "since …", "onwards", "recently", "till date" | range not fully stated |
| last N months/weeks/quarters/years, rolling, trailing, TTM, "over the past year" | see below |

**Should be supported (router gaps):**
- "today vs yesterday" and "yesterday vs the day before": the DSL's `today`/`yesterday` like-for-like *is* exactly this.
- "last 30 days vs the previous 30 days": identical to `last_30_days` like-for-like.
- "from April 2025 to September 2025" as a range: a single custom range, 1 Apr – 30 Sep 2025.

**Rolling windows.** "Which customers grew over the last 6 months?" has at least 7 readings:
1. first month vs last month;
2. first 3 vs last 3 months;
3. first half vs second half;
4. every month up;
5. the 6-month total vs the previous 6 months;
6. average monthly growth;
7. trend slope.

The only evidence in the code is that `last_7/30/90_days` compare with the **immediately preceding equal window**. So reading 5 is the product-consistent one, but it isn't what a user saying "have been growing" usually means (reading 4). **Recommendation:** keep the clarification, and offer the two deterministic options that exist or are cheap:
- "last 6 months vs the 6 months before", which needs a `last_n_months` kind: **DSL**;
- "month by month", a plain monthly series: already supported.

Treat TTM and "last 12 months" the same way. "Over the past year" also needs the FY/calendar question.

**Month-end rule (deterministic, needs a decision).** When the current period is complete (the anchor is its last day), like-for-like should equal the **full** previous period. Today it drops the previous period's extra days on 15/36 month-ends and on 30 Jun.

---

## 6. Data-coverage semantics (design)

**Coverage object**, computed server-side per entity and cached per TenantDataVersion:

```
coverage = {
  sales:    { earliest, latest },
  purchase: { earliest, latest },
  freshness: <existing>,
}
```

Each resolved range gets a state:

| State | Meaning | Example (synthetic tenant, history 2024-01-01 … 2026-02-28) |
|---|---|---|
| `covered` | inside history; a 0 is a real "no sales" | Sep 2025 vs Aug 2025 |
| `partly_before_history` | starts before the first synced voucher | FY 2024-25 to date vs Apr 2023 – Jan 2024 |
| `before_history` | entirely before it; a 0 means **no data** | Feb 2024 vs Feb 2023: all 6 customers "grew from 0" |
| `partly_after_latest_data` / `after_latest_data` | beyond the latest synced voucher (sync lag) | "2026-02-01 to 2026-03-31" |
| `no_data` | tenant has no vouchers (the reference date falls back to the wall clock; freshness `never_synced` already stops the answer) | empty tenant |

**Behavior:**
- **Comparison `before_history`** with a growth, new or lost filter: **don't answer the list.** Say deterministically: "TallyPulse has Sales data only from 1 Apr 2025. The comparison period (1–8 Dec 2024) is before that, so it can't show who grew." A plain totals comparison may be shown with that warning, and with the previous value displayed as "no data", not ₹0.
- **`partly_before_history`:** answer with a warning naming the coverage start: "growth is overstated".
- **`after_latest_data`:** a warning naming the last synced date.
- **Inside coverage:** zero is zero. Reactivated customers look "new" with a one-period baseline; only a longer baseline or all-history check (§4 C) separates them.
- **Limitation:** gaps *inside* history (manual deletions, failed batches) can't be detected without Tally reconciliation (the existing `voucherRecovery` tool).
- **Claude writes none of this.** Texts come from a fixed catalog in the formatter, driven by `result.coverage`.

---

## 7. Follow-up findings

Each message is routed on its own. History only decides that a *non-parseable* follow-up goes to legacy chat.

| Conversation | What happens |
|---|---|
| "Which customers grew this month?" → "Show me the top 10." → "Now compare them with last year." → "What about products?" → "Only those above 20%." | Turn 1: engine. **Turns 2–5: legacy chat** (wall-clock dates; "this month" = a different month). |
| "How did sales perform last month?" → … | Turn 1 ends in "couldn't find that name" ("perform" is looked up as a name). Every follow-up goes to legacy chat. |
| "Sales this month vs last month" → **"and by customer?"** | **Answered standalone as all-time sales by customer.** Context silently lost. |
| "Which products grew in sales this quarter vs last quarter?" → **"and customers?"** | **All-time customer ranking.** Context silently lost. |

**Recommendations:**
1. **Legacy chat on the tenant anchor** (§3.6).
2. **Deterministic follow-up guard.** A message with history that starts with a continuation cue (and, what about, only, same for, now, compare, those, them), or states no period when the previous turn had one, must **not** be answered as a standalone plan. Send it to legacy chat, which keeps the history, or ask a clarification.
3. **Persist the resolved plan on each assistant message.** This enables a later deterministic "plan delta" (change breakdown, add a threshold, swap the period) without Claude. That's a DSL-level feature for later.

---

## 8. Cross-dimension consistency

- **The entity is implied for customers (sales) and suppliers (purchases), but not for products, product groups or voucher types.** "Which products grew…" costs a planner call. Decision: default to sales, and disclose it.
- **Metric basis differs by breakdown.**
  - Customer and supplier growth use the **invoice total, tax-inclusive**.
  - Product and group growth use the **line amount, pre-tax**.
  - "Sales growth by customer" and "by product" therefore don't reconcile. This is disclosed in answer notes, but deserves a product decision (P0-2 made the equivalent choice for "revenue").
- **Synonyms.** customers ✓, products/items/SKUs ✓, suppliers/vendors ✓, categories/stock groups ✓. **clients, buyers, parties and goods are ✗**, treated as names. "who" isn't mapped to customers.
- **New and lost behave the same for customers, products and suppliers**, all on the like-for-like baseline.
- **Voucher type** comparisons work only with an explicit "sales"/"purchases".

---

## 9. Capability matrix

| User intent | Example | Router | Planner | DSL | Engine | Correct behavior | New capability? |
|---|---|---|---|---|---|---|---|
| Current vs previous | customers grew this month vs last month | ✓ | ✓ | ✓ | ✓ (oracle-verified) | supported | no |
| YoY | this month vs same month last year | ✓ | ✓ | ✓ | ✓ | supported, **plus coverage check** | coverage metadata |
| MoM / QoQ | sales this month mom | ✓ | ✓ | ✓ | ✓ | supported; month-end rule | rule |
| YTD | sales YTD | clarify (calendar or FY?) | – | ✓ (calendar) | ✓ | clarify | no |
| FY / FYTD | this FY vs previous FY | ✓ | ✓ | ✓ | ✓ | supported | no |
| Absolute growth / largest increase | grew the most | ✓ | ✓ | ✓ | ✓ | supported | no |
| % threshold | grew by more than 20% | ✓ | ✓ | ✓ | ✓ | supported (new customers excluded, disclosed) | no |
| % change of a total | sales growth percentage | **✗ refused (P1-4 over-reach)** | ✓ | ✓ | ✓ | supported | router fix |
| Fastest / highest % | fastest-growing customers | refused | expressible | ✓ | ✓ | refused until defined | decision |
| New customers | new customers this month | ✓ (✗ "became a new customer") | ✓ | ✓ | ✓ | supported, baseline decision | decision |
| Lost customers | who stopped buying | ✓ (✗ "who" form) | ✓ | ✓ | ✓ | supported | router fix |
| Reactivated / first-ever | came back after being inactive | ✗ leaks / planner | ✗ | ✗ | ✗ | refused | DSL |
| Consistent / every-period growth | grew every month | refused (✗ "MoM by customer this fy" → planner) | ✗ | ✗ | ✗ | refused | DSL/engine |
| Rolling 6 / 12 months, TTM | grew over the last 6 months | clarify | – | only absolute ranges | ✓ | clarify, then offer window vs window | decision + DSL |
| Multi-period growth (range) | grew from Apr 2025 to Sep 2025 | planner (two periods) | would guess | ✓ as two ranges | ✓ | clarify | router fix |
| Multiple comparisons | grew MoM and YoY | refused (✗ "this month and also last month" → planner) | ✗ | ✗ | ✗ | refused | stay unsupported |
| today vs yesterday, last N days vs previous N | – | planner | ✓ | ✓ | ✓ | supported | router fix |
| Data coverage warning | YoY against pre-sync year | **none** | – | – | – | deterministic warning or refusal | coverage metadata |
| Partial-data warning | period past latest sync | freshness only | – | – | – | deterministic warning | coverage metadata |

---

## 10. Gaps by owner

**Router (deterministic grammar; no DSL change):**
- **The silent misread.** "who bought less/more", "who stopped buying" and "who is growing" should mean customers.
- **Revert the P1-4 over-reach.** A total's percentage change (no breakdown, no ranking word) is a supported comparison.
- **Synonyms:** clients, buyers, parties → customer; goods → product.
- **Phrases:** "doing better/worse (than)" = up/down; "became a new customer" = new; "lost the most business" = biggest decline; "up or down" = the comparison itself.
- **Periods:**
  - today vs yesterday;
  - yesterday vs the day before;
  - last N days vs the previous N days;
  - "from <Month Year> to <Month Year>" as one custom range, with a clarification when a growth word is present.
- **Refusals and reasoning words:** "MoM by customer this fy" (a series) and "this month and also last month" (two comparisons) should be refused, not sent to the planner. "perform"/"performing" joins the reasoning vocabulary.
- **Filler:** polite openers and closers ("Hi", "Thanks", "I want to know …").
- **Follow-up guard** (§7).

**Planner:** date-provenance check (§3.4), and keep the planner free of any date.

**Deterministic semantic rules:**
- month-end like-for-like = full previous period;
- the new/lost baseline;
- the coverage warnings and refusals;
- legacy chat on the tenant anchor.

**DSL / engine (later, after decisions):**
- `last_n_months` (window vs preceding window);
- per-bucket comparison (consistent / every-period growth);
- reactivation and first-ever purchase over full history;
- plan deltas for follow-ups.

**Data-quality metadata:** coverage per entity and range state (§6).

**Product decisions:**
- default entity for products, groups and voucher types;
- growth-rate ranking rules;
- new/lost baseline;
- the rolling-window reading;
- clamping future reference dates;
- invoice-total vs line-amount basis across breakdowns.

**Should remain unsupported:**
- multiple comparisons in one answer;
- trend/slope and "why";
- forecasts and run rates.

---

## 11. Recommended implementation order (smallest safe first)

| # | Class | Work | Why first |
|---|---|---|---|
| 1 | F + D | **Coverage metadata + deterministic warnings/refusals** (§6) | Stops the real, current false "everyone grew from ₹0" on YoY for both tenants. Server-only; no Claude. |
| 2 | B | **Fix the silent "who bought" misread** and the "who" forms | The only known wrong plan. |
| 3 | D | **Legacy chat on the tenant reference date** (prompt block + `tools.resolvePeriod`/`resolveComparisonPeriods`) | One anchor for the whole product. |
| 4 | B | **Follow-up guard**: no standalone plans for continuation messages | Stops silent context loss. |
| 5 | B | **Router gaps**: % change of totals, synonyms, today/yesterday, N days vs previous N, month range, better/worse, became, lost business, filler, refusing "MoM by customer this fy" | Removes about 20 planner calls or false clarifications in the corpus. |
| 6 | C | **Planner date-provenance check** (+ decision on clamping future reference dates) | Required before any planner cache. |
| 7 | G | **Product decisions**: default entity, % ranking, new/lost baseline, month-end rule, rolling-window reading, basis consistency | Unblocks 8–9. |
| 8 | D | Implement the decided rules (month-end full-previous, new/lost baseline, default entity) | Deterministic, small. |
| 9 | E | DSL: `last_n_months`, per-bucket comparison, reactivation/first-ever, plan deltas | Only after 7. |
| 10 | – | Planner cache | After 1, 3, 4, 6 (§12). |

---

## 12. Planner-cache readiness: **NOT READY**

| Criterion | Status | Blocker |
|---|---|---|
| 1. Relative date semantics trusted | ✗ | Three anchors in one product (§1.2). Month-end like-for-like truncation undecided. |
| 2. Reference date safely handled | ✗ | Planner may emit unverifiable absolute dates (needs the provenance check). Future-dated anchor undecided. |
| 3. Growth semantics deterministic | ◐ | Absolute growth is deterministic. "Fastest"/"highest %", the new/lost baseline and rolling windows are undefined. A cache would freeze one Claude interpretation per tenant. |
| 4. Coverage behavior defined | ✗ | Not modelled. Cached answers would repeat "grew from ₹0" silently. |
| 5. Cached plans can't go semantically stale | ◐ | Symbolic plans are stable, but plans with Claude-written dates aren't (fixed by 2). |
| 6. Names re-resolved, plans re-validated | ✓ design | Must be done on every hit (resolver + validator already exist). |
| 7. Cache key captures all inputs | ◐ design | §3.8. Reference date excluded only once 2 holds. |
| 8. Follow-ups can't reuse an incompatible plan | ✗ | Follow-ups are routed standalone (context loss). Only first-turn, history-free questions may ever hit the cache, and the follow-up guard must exist first. |

**Minimum before building it:** items 1, 3, 4 and 6 of §11, plus the §12.3 decisions for the phrasings the planner actually receives.

---

## 13. Test evidence (`verify-growth-comparison-capability.js`)

| Area | Result |
|---|---|
| Architecture facts (reference date and date context) | 6 checks ✓ |
| Corpus: 207 questions snapshotted (status, code, semantic signature) | ✓ |
| Current behavior | 98 SUPPORTED · 55 CLARIFY · 28 PLANNER · 26 UNSUPPORTED |
| Target behavior | 117 SUPPORTED · 56 CLARIFY · 25 UNSUPPORTED · 9 DECISION |
| Gaps | 39 |
| Silent misreads | 1 |
| Name-lookup leaks | 8 |
| Follow-ups | 14: 12 to legacy chat, 2 context lost, 0 Claude |
| Semantic sweeps | month-end truncation 15/36 + 30 Jun; new/lost baseline |
| **Engine vs independent oracle** | **126/126** (14 questions × 9 boundary anchors) |
| Coverage cases | 11 ✓ (before / partly before / after history, covered, new, reactivated, lost, empty tenant, one-voucher tenant) |
| Synthetic tenants | removed (0 documents left) |
| Real tenants | read-only counts only, never named |
| Network | 0 fetch/http calls |

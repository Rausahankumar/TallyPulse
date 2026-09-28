"use strict";

/**
 * Comparison & period capability AUDIT - characterizes what TallyPulse can answer today about period comparisons and
 * growth/decline. It changes no production code and asserts CURRENT behaviour (surprising-but-correct behaviour is
 * documented; defects are reported as KNOWN DEFECT, not fixed).
 *
 *   A. period x comparison resolution matrix at two anchors (pure)
 *   B. known period-engine defects, characterized (pure)
 *   C. routing corpus: exact status/code, exact DSL and resolved dates for supported questions (pure, synthetic names)
 *   D. growth semantics: what the DSL/validator can and cannot represent (pure)
 *   E. planner representability with a fake Claude client (no network)
 *   F. engine results vs an independent aggregation - READ-ONLY on the largest real tenant (skipped without MongoDB)
 *   G. no network
 *
 * No Anthropic, no Tally, no writes. Run: node verify-comparison-period-capability.js
 */

const http = require("http");
const https = require("https");

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = async () => { netCalls += 1; throw new Error("network disabled in this audit"); };
http.request = () => { netCalls += 1; throw new Error("network disabled in this audit"); };
https.request = () => { netCalls += 1; throw new Error("network disabled in this audit"); };

const { routeQuestion } = require("./src/services/query/localRouter");
const { validateQueryPlan } = require("./src/services/query/validator");
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { planQuestion, routeAndPlan, getPlannerPrompt, PLANNER_TOOL_NAME, SKIP_ROUTER_CODES } = require("./src/services/query/planner");
const { CATALOG, PERIOD_KINDS, LIMITS } = require("./src/services/query/semanticCatalog");
const periodEngine = require("./src/services/analytics/periodEngine");

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const cj = (v) => JSON.stringify(canon(v));
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

const REF_MID = new Date(2026, 8, 18, 12); // Fri 18 Sep 2026: month, quarter, FY and week are all in progress
const REF_END = new Date(2026, 2, 31, 12); // Tue 31 Mar 2026: month, quarter and FY end on the anchor day
const ANCHORS = { mid: REF_MID, end: REF_END };

// synthetic tenant names only (no real tenant data in this file)
const NAMES = { customer: ["Aarav Traders", "Bluebell Mart"], supplier: ["Crescent Supplies"], product: ["Widget Alpha", "Gadget Beta"], productGroup: ["Hardware", "Stationery"] };
const resolver = createEntityResolver({ tenantId: "AUDIT-TENANT", sources: Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, async () => v])) });
const resolverTexts = [];
const spyResolver = async (a) => (resolverTexts.push(a.text), resolver(a));
const route = (q, referenceDate = REF_MID) => routeQuestion(q, { resolveEntity: spyResolver, entityIndex: resolver.spanIndex, referenceDate });

// ---------------------------------------------------------------- A. matrix
// Every period kind x {no compare, like_for_like, full_previous, same_period_last_year, custom} as the validator
// resolves it: "subject from..to [partial] vs baseline from..to [canonical mode] W:warnings" or "ERR codes".
// The custom subject is 2026-01-01..2026-03-31, the custom baseline 2025-01-01..2025-02-15 (deliberately unequal).
const MATRIX = {
  "mid|today|none": "2026-09-18..2026-09-18 partial",
  "mid|today|like_for_like": "2026-09-18..2026-09-18 partial vs 2026-09-17..2026-09-17 [like_for_like]",
  "mid|today|full_previous": "2026-09-18..2026-09-18 partial vs 2026-09-17..2026-09-17 [like_for_like]",
  "mid|today|same_period_last_year": "2026-09-18..2026-09-18 partial vs 2025-09-18..2025-09-18 [same_period_last_year]",
  "mid|today|custom": "2026-09-18..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|yesterday|none": "2026-09-17..2026-09-17",
  "mid|yesterday|like_for_like": "2026-09-17..2026-09-17 vs 2026-09-16..2026-09-16 [like_for_like]",
  "mid|yesterday|full_previous": "2026-09-17..2026-09-17 vs 2026-09-16..2026-09-16 [like_for_like]",
  "mid|yesterday|same_period_last_year": "2026-09-17..2026-09-17 vs 2025-09-17..2025-09-17 [same_period_last_year]",
  "mid|yesterday|custom": "2026-09-17..2026-09-17 vs 2025-01-01..2025-02-15 [custom]",
  "mid|current_week|none": "2026-09-14..2026-09-18 partial",
  "mid|current_week|like_for_like": "2026-09-14..2026-09-18 partial vs 2026-09-07..2026-09-11 [like_for_like]",
  "mid|current_week|full_previous": "2026-09-14..2026-09-18 partial vs 2026-09-07..2026-09-13 [full_previous]",
  "mid|current_week|same_period_last_year": "2026-09-14..2026-09-18 partial vs 2025-09-14..2025-09-18 [same_period_last_year]",
  "mid|current_week|custom": "2026-09-14..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|previous_week|none": "2026-09-07..2026-09-13",
  "mid|previous_week|like_for_like": "2026-09-07..2026-09-13 vs 2026-08-31..2026-09-06 [like_for_like]",
  "mid|previous_week|full_previous": "2026-09-07..2026-09-13 vs 2026-08-31..2026-09-06 [like_for_like]",
  "mid|previous_week|same_period_last_year": "2026-09-07..2026-09-13 vs 2025-09-07..2025-09-13 [same_period_last_year]",
  "mid|previous_week|custom": "2026-09-07..2026-09-13 vs 2025-01-01..2025-02-15 [custom]",
  "mid|current_month|none": "2026-09-01..2026-09-18 partial",
  "mid|current_month|like_for_like": "2026-09-01..2026-09-18 partial vs 2026-08-01..2026-08-18 [like_for_like]",
  "mid|current_month|full_previous": "2026-09-01..2026-09-18 partial vs 2026-08-01..2026-08-31 [full_previous]",
  "mid|current_month|same_period_last_year": "2026-09-01..2026-09-18 partial vs 2025-09-01..2025-09-18 [same_period_last_year]",
  "mid|current_month|custom": "2026-09-01..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|previous_month|none": "2026-08-01..2026-08-31",
  "mid|previous_month|like_for_like": "2026-08-01..2026-08-31 vs 2026-07-01..2026-07-31 [like_for_like]",
  "mid|previous_month|full_previous": "2026-08-01..2026-08-31 vs 2026-07-01..2026-07-31 [like_for_like]",
  "mid|previous_month|same_period_last_year": "2026-08-01..2026-08-31 vs 2025-08-01..2025-08-31 [same_period_last_year]",
  "mid|previous_month|custom": "2026-08-01..2026-08-31 vs 2025-01-01..2025-02-15 [custom]",
  "mid|same_month_last_year|none": "2025-09-01..2025-09-18",
  "mid|same_month_last_year|like_for_like": "ERR compare_mode_unsupported_for_period",
  "mid|same_month_last_year|full_previous": "ERR compare_mode_unsupported_for_period",
  "mid|same_month_last_year|same_period_last_year": "2025-09-01..2025-09-18 vs 2024-09-01..2024-09-18 [same_period_last_year]",
  "mid|same_month_last_year|custom": "2025-09-01..2025-09-18 vs 2025-01-01..2025-02-15 [custom]",
  "mid|current_quarter|none": "2026-07-01..2026-09-18 partial",
  "mid|current_quarter|like_for_like": "2026-07-01..2026-09-18 partial vs 2026-04-01..2026-06-18 [like_for_like]",
  "mid|current_quarter|full_previous": "2026-07-01..2026-09-18 partial vs 2026-04-01..2026-06-30 [full_previous]",
  "mid|current_quarter|same_period_last_year": "2026-07-01..2026-09-18 partial vs 2025-07-01..2025-09-18 [same_period_last_year]",
  "mid|current_quarter|custom": "2026-07-01..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|previous_quarter|none": "2026-04-01..2026-06-30",
  "mid|previous_quarter|like_for_like": "2026-04-01..2026-06-30 vs 2026-01-01..2026-03-31 [like_for_like]",
  "mid|previous_quarter|full_previous": "2026-04-01..2026-06-30 vs 2026-01-01..2026-03-31 [like_for_like]",
  "mid|previous_quarter|same_period_last_year": "2026-04-01..2026-06-30 vs 2025-04-01..2025-06-30 [same_period_last_year]",
  "mid|previous_quarter|custom": "2026-04-01..2026-06-30 vs 2025-01-01..2025-02-15 [custom]",
  "mid|current_fy|none": "2026-04-01..2026-09-18 partial",
  "mid|current_fy|like_for_like": "2026-04-01..2026-09-18 partial vs 2025-04-01..2025-09-18 [like_for_like]",
  "mid|current_fy|full_previous": "2026-04-01..2026-09-18 partial vs 2025-04-01..2026-03-31 [full_previous]",
  "mid|current_fy|same_period_last_year": "2026-04-01..2026-09-18 partial vs 2025-04-01..2025-09-18 [same_period_last_year]",
  "mid|current_fy|custom": "2026-04-01..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|previous_fy|none": "2025-04-01..2026-03-31",
  "mid|previous_fy|like_for_like": "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31 [like_for_like]",
  "mid|previous_fy|full_previous": "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31 [like_for_like]",
  "mid|previous_fy|same_period_last_year": "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31 [same_period_last_year]",
  "mid|previous_fy|custom": "2025-04-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "mid|specific_fy|none": "2026-04-01..2027-03-31 partial",
  "mid|specific_fy|like_for_like": "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [like_for_like] W:warn_specific_fy_partial_comparison",
  "mid|specific_fy|full_previous": "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [like_for_like] W:warn_specific_fy_partial_comparison",
  "mid|specific_fy|same_period_last_year": "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [same_period_last_year] W:warn_specific_fy_partial_comparison",
  "mid|specific_fy|custom": "2026-04-01..2027-03-31 partial vs 2025-01-01..2025-02-15 [custom] W:warn_specific_fy_partial_comparison",
  "mid|custom|none": "2026-01-01..2026-03-31",
  "mid|custom|like_for_like": "ERR compare_mode_unsupported_for_period",
  "mid|custom|full_previous": "ERR compare_mode_unsupported_for_period",
  "mid|custom|same_period_last_year": "2026-01-01..2026-03-31 vs 2025-01-01..2025-03-31 [same_period_last_year]",
  "mid|custom|custom": "2026-01-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "mid|last_7_days|none": "2026-09-12..2026-09-18 partial",
  "mid|last_7_days|like_for_like": "2026-09-12..2026-09-18 partial vs 2026-09-05..2026-09-11 [like_for_like]",
  "mid|last_7_days|full_previous": "2026-09-12..2026-09-18 partial vs 2026-09-05..2026-09-11 [like_for_like]",
  "mid|last_7_days|same_period_last_year": "2026-09-12..2026-09-18 partial vs 2025-09-12..2025-09-18 [same_period_last_year]",
  "mid|last_7_days|custom": "2026-09-12..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|last_30_days|none": "2026-08-20..2026-09-18 partial",
  "mid|last_30_days|like_for_like": "2026-08-20..2026-09-18 partial vs 2026-07-21..2026-08-19 [like_for_like]",
  "mid|last_30_days|full_previous": "2026-08-20..2026-09-18 partial vs 2026-07-21..2026-08-19 [like_for_like]",
  "mid|last_30_days|same_period_last_year": "2026-08-20..2026-09-18 partial vs 2025-08-20..2025-09-18 [same_period_last_year]",
  "mid|last_30_days|custom": "2026-08-20..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|last_90_days|none": "2026-06-21..2026-09-18 partial",
  "mid|last_90_days|like_for_like": "2026-06-21..2026-09-18 partial vs 2026-03-23..2026-06-20 [like_for_like]",
  "mid|last_90_days|full_previous": "2026-06-21..2026-09-18 partial vs 2026-03-23..2026-06-20 [like_for_like]",
  "mid|last_90_days|same_period_last_year": "2026-06-21..2026-09-18 partial vs 2025-06-21..2025-09-18 [same_period_last_year]",
  "mid|last_90_days|custom": "2026-06-21..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|ytd|none": "2026-01-01..2026-09-18 partial",
  "mid|ytd|like_for_like": "2026-01-01..2026-09-18 partial vs 2025-01-01..2025-09-18 [like_for_like]",
  "mid|ytd|full_previous": "ERR compare_mode_unsupported_for_period",
  "mid|ytd|same_period_last_year": "2026-01-01..2026-09-18 partial vs 2025-01-01..2025-09-18 [same_period_last_year]",
  "mid|ytd|custom": "2026-01-01..2026-09-18 partial vs 2025-01-01..2025-02-15 [custom]",
  "mid|all_time|none": "-..-",
  "mid|all_time|like_for_like": "ERR all_time_cannot_compare",
  "mid|all_time|full_previous": "ERR all_time_cannot_compare",
  "mid|all_time|same_period_last_year": "ERR all_time_cannot_compare",
  "mid|all_time|custom": "ERR all_time_cannot_compare",
  "end|today|none": "2026-03-31..2026-03-31 partial",
  "end|today|like_for_like": "2026-03-31..2026-03-31 partial vs 2026-03-30..2026-03-30 [like_for_like]",
  "end|today|full_previous": "2026-03-31..2026-03-31 partial vs 2026-03-30..2026-03-30 [like_for_like]",
  "end|today|same_period_last_year": "2026-03-31..2026-03-31 partial vs 2025-03-31..2025-03-31 [same_period_last_year]",
  "end|today|custom": "2026-03-31..2026-03-31 partial vs 2025-01-01..2025-02-15 [custom]",
  "end|yesterday|none": "2026-03-30..2026-03-30",
  "end|yesterday|like_for_like": "2026-03-30..2026-03-30 vs 2026-03-29..2026-03-29 [like_for_like]",
  "end|yesterday|full_previous": "2026-03-30..2026-03-30 vs 2026-03-29..2026-03-29 [like_for_like]",
  "end|yesterday|same_period_last_year": "2026-03-30..2026-03-30 vs 2025-03-30..2025-03-30 [same_period_last_year]",
  "end|yesterday|custom": "2026-03-30..2026-03-30 vs 2025-01-01..2025-02-15 [custom]",
  "end|current_week|none": "2026-03-30..2026-03-31 partial",
  "end|current_week|like_for_like": "2026-03-30..2026-03-31 partial vs 2026-03-23..2026-03-24 [like_for_like]",
  "end|current_week|full_previous": "2026-03-30..2026-03-31 partial vs 2026-03-23..2026-03-29 [full_previous]",
  "end|current_week|same_period_last_year": "2026-03-30..2026-03-31 partial vs 2025-03-30..2025-03-31 [same_period_last_year]",
  "end|current_week|custom": "2026-03-30..2026-03-31 partial vs 2025-01-01..2025-02-15 [custom]",
  "end|previous_week|none": "2026-03-23..2026-03-29",
  "end|previous_week|like_for_like": "2026-03-23..2026-03-29 vs 2026-03-16..2026-03-22 [like_for_like]",
  "end|previous_week|full_previous": "2026-03-23..2026-03-29 vs 2026-03-16..2026-03-22 [like_for_like]",
  "end|previous_week|same_period_last_year": "2026-03-23..2026-03-29 vs 2025-03-23..2025-03-29 [same_period_last_year]",
  "end|previous_week|custom": "2026-03-23..2026-03-29 vs 2025-01-01..2025-02-15 [custom]",
  "end|current_month|none": "2026-03-01..2026-03-31",
  "end|current_month|like_for_like": "2026-03-01..2026-03-31 vs 2026-02-01..2026-02-28 [like_for_like]",
  "end|current_month|full_previous": "2026-03-01..2026-03-31 vs 2026-02-01..2026-02-28 [like_for_like]",
  "end|current_month|same_period_last_year": "2026-03-01..2026-03-31 vs 2025-03-01..2025-03-31 [same_period_last_year]",
  "end|current_month|custom": "2026-03-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|previous_month|none": "2026-02-01..2026-02-28",
  "end|previous_month|like_for_like": "2026-02-01..2026-02-28 vs 2026-01-01..2026-01-31 [like_for_like]",
  "end|previous_month|full_previous": "2026-02-01..2026-02-28 vs 2026-01-01..2026-01-31 [like_for_like]",
  "end|previous_month|same_period_last_year": "2026-02-01..2026-02-28 vs 2025-02-01..2025-02-28 [same_period_last_year]",
  "end|previous_month|custom": "2026-02-01..2026-02-28 vs 2025-01-01..2025-02-15 [custom]",
  "end|same_month_last_year|none": "2025-03-01..2025-03-31",
  "end|same_month_last_year|like_for_like": "ERR compare_mode_unsupported_for_period",
  "end|same_month_last_year|full_previous": "ERR compare_mode_unsupported_for_period",
  "end|same_month_last_year|same_period_last_year": "2025-03-01..2025-03-31 vs 2024-03-01..2024-03-31 [same_period_last_year]",
  "end|same_month_last_year|custom": "2025-03-01..2025-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|current_quarter|none": "2026-01-01..2026-03-31",
  "end|current_quarter|like_for_like": "2026-01-01..2026-03-31 vs 2025-10-01..2025-12-31 [like_for_like]",
  "end|current_quarter|full_previous": "2026-01-01..2026-03-31 vs 2025-10-01..2025-12-31 [full_previous]",
  "end|current_quarter|same_period_last_year": "2026-01-01..2026-03-31 vs 2025-01-01..2025-03-31 [same_period_last_year]",
  "end|current_quarter|custom": "2026-01-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|previous_quarter|none": "2025-10-01..2025-12-31",
  "end|previous_quarter|like_for_like": "2025-10-01..2025-12-31 vs 2025-07-01..2025-09-30 [like_for_like]",
  "end|previous_quarter|full_previous": "2025-10-01..2025-12-31 vs 2025-07-01..2025-09-30 [like_for_like]",
  "end|previous_quarter|same_period_last_year": "2025-10-01..2025-12-31 vs 2024-10-01..2024-12-31 [same_period_last_year]",
  "end|previous_quarter|custom": "2025-10-01..2025-12-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|current_fy|none": "2025-04-01..2026-03-31",
  "end|current_fy|like_for_like": "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31 [like_for_like]",
  "end|current_fy|full_previous": "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31 [full_previous]",
  "end|current_fy|same_period_last_year": "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31 [same_period_last_year]",
  "end|current_fy|custom": "2025-04-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|previous_fy|none": "2024-04-01..2025-03-31",
  "end|previous_fy|like_for_like": "2024-04-01..2025-03-31 vs 2023-04-01..2024-03-31 [like_for_like]",
  "end|previous_fy|full_previous": "2024-04-01..2025-03-31 vs 2023-04-01..2024-03-31 [like_for_like]",
  "end|previous_fy|same_period_last_year": "2024-04-01..2025-03-31 vs 2023-04-01..2024-03-31 [same_period_last_year]",
  "end|previous_fy|custom": "2024-04-01..2025-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|specific_fy|none": "2026-04-01..2027-03-31 partial",
  "end|specific_fy|like_for_like": "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [like_for_like] W:warn_specific_fy_partial_comparison",
  "end|specific_fy|full_previous": "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [like_for_like] W:warn_specific_fy_partial_comparison",
  "end|specific_fy|same_period_last_year": "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [same_period_last_year] W:warn_specific_fy_partial_comparison",
  "end|specific_fy|custom": "2026-04-01..2027-03-31 partial vs 2025-01-01..2025-02-15 [custom] W:warn_specific_fy_partial_comparison",
  "end|custom|none": "2026-01-01..2026-03-31",
  "end|custom|like_for_like": "ERR compare_mode_unsupported_for_period",
  "end|custom|full_previous": "ERR compare_mode_unsupported_for_period",
  "end|custom|same_period_last_year": "2026-01-01..2026-03-31 vs 2025-01-01..2025-03-31 [same_period_last_year]",
  "end|custom|custom": "2026-01-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]",
  "end|last_7_days|none": "2026-03-25..2026-03-31 partial",
  "end|last_7_days|like_for_like": "2026-03-25..2026-03-31 partial vs 2026-03-18..2026-03-24 [like_for_like]",
  "end|last_7_days|full_previous": "2026-03-25..2026-03-31 partial vs 2026-03-18..2026-03-24 [like_for_like]",
  "end|last_7_days|same_period_last_year": "2026-03-25..2026-03-31 partial vs 2025-03-25..2025-03-31 [same_period_last_year]",
  "end|last_7_days|custom": "2026-03-25..2026-03-31 partial vs 2025-01-01..2025-02-15 [custom]",
  "end|last_30_days|none": "2026-03-02..2026-03-31 partial",
  "end|last_30_days|like_for_like": "2026-03-02..2026-03-31 partial vs 2026-01-31..2026-03-01 [like_for_like]",
  "end|last_30_days|full_previous": "2026-03-02..2026-03-31 partial vs 2026-01-31..2026-03-01 [like_for_like]",
  "end|last_30_days|same_period_last_year": "2026-03-02..2026-03-31 partial vs 2025-03-02..2025-03-31 [same_period_last_year]",
  "end|last_30_days|custom": "2026-03-02..2026-03-31 partial vs 2025-01-01..2025-02-15 [custom]",
  "end|last_90_days|none": "2026-01-01..2026-03-31 partial",
  "end|last_90_days|like_for_like": "2026-01-01..2026-03-31 partial vs 2025-10-03..2025-12-31 [like_for_like]",
  "end|last_90_days|full_previous": "2026-01-01..2026-03-31 partial vs 2025-10-03..2025-12-31 [like_for_like]",
  "end|last_90_days|same_period_last_year": "2026-01-01..2026-03-31 partial vs 2025-01-01..2025-03-31 [same_period_last_year]",
  "end|last_90_days|custom": "2026-01-01..2026-03-31 partial vs 2025-01-01..2025-02-15 [custom]",
  "end|ytd|none": "2026-01-01..2026-03-31 partial",
  "end|ytd|like_for_like": "2026-01-01..2026-03-31 partial vs 2025-01-01..2025-03-31 [like_for_like]",
  "end|ytd|full_previous": "ERR compare_mode_unsupported_for_period",
  "end|ytd|same_period_last_year": "2026-01-01..2026-03-31 partial vs 2025-01-01..2025-03-31 [same_period_last_year]",
  "end|ytd|custom": "2026-01-01..2026-03-31 partial vs 2025-01-01..2025-02-15 [custom]",
  "end|all_time|none": "-..-",
  "end|all_time|like_for_like": "ERR all_time_cannot_compare",
  "end|all_time|full_previous": "ERR all_time_cannot_compare",
  "end|all_time|same_period_last_year": "ERR all_time_cannot_compare",
  "end|all_time|custom": "ERR all_time_cannot_compare",
};

function resolveCell(kind, mode, referenceDate) {
  const period = kind === "custom" ? { kind: "custom", from: "2026-01-01", to: "2026-03-31" } : kind === "specific_fy" ? { kind: "specific_fy", fy: "2026-27" } : { kind };
  const compare = mode === "none" ? null : mode === "custom" ? { mode: "custom", period: { kind: "custom", from: "2025-01-01", to: "2025-02-15" } } : { mode };
  const v = validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period, metrics: ["invoiceAmount"], filters: [], ...(compare ? { compare } : {}) }, { referenceDate });
  if (!v.ok) return { text: `ERR ${v.errors.map((e) => e.code).join(",")}`, v };
  const n = v.normalized;
  const text = `${n.period.from ? ymd(n.period.from) : "-"}..${n.period.to ? ymd(n.period.to) : "-"}${n.period.isPartial ? " partial" : ""}${n.comparison ? ` vs ${ymd(n.comparison.from)}..${ymd(n.comparison.to)} [${n.comparison.canonicalMode}]` : ""}${v.warnings.length ? ` W:${v.warnings.map((w) => w.code)}` : ""}`;
  return { text, v };
}

// ---------------------------------------------------------------- C. corpus
// [semantic tag, question, router status, router code, exact plan (canonical JSON) | null, "subject vs baseline" at REF_MID | null]
// Tags (the audit's reading of the question, not the router's): point = one point-to-point comparison; totals = same,
// without a breakdown; abs_ranking = ranked by absolute change; pct_threshold = filtered on % change; presence =
// stopped/new; window_system = a rolling window the engine defines (vs the preceding equal window); unequal_custom =
// two explicit ranges of different length; series_single = a plain series, no growth; and the AMBIGUOUS/UNREPRESENTABLE
// tags: window_ambiguous, series, rate_ranking, multi_compare, period_ambiguous, relative_offset, two_ranges,
// window_unsupported, window_explicit, unaligned.
// 2026-09-28 final decisions re-pinned 12 rows (each proven by a script to be ONLY: current_month like_for_like -> full_previous
// with the complete previous month as comparison dates [decision 2], or new-customer -> unsupported_new_party [decision 3]).
const CORPUS = [
    ["point", "Which customers are growing this month vs last month?", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"invoiceAmount.delta\",\"op\":\"gt\",\"value\":0}],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount.delta\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["point", "Which customers declined this month vs last month?", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"invoiceAmount.delta\",\"op\":\"lt\",\"value\":0}],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount.delta\",\"dir\":\"asc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["point", "Which products grew this quarter vs last quarter?", "needs_planner", "entity_ambiguous", null, null],
    ["point", "Which customers increased sales this week vs last week?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_week"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-09-14..2026-09-18 vs 2026-09-07..2026-09-11"],
    ["point", "Which customers grew vs last year?", "needs_planner", "period_missing", null, null],
    ["point", "Which products grew compared with the same period last year?", "needs_planner", "entity_ambiguous", null, null],
    ["point", "Which customers declined compared with last year?", "needs_planner", "period_missing", null, null],
    ["point", "Which customers grew from April 2025 to April 2026?", "needs_planner", "two_periods_without_comparison", null, null],
    ["point", "Which customers declined between April 1 2025 and April 1 2026?", "needs_planner", "router_plan_invalid", null, null],
    ["point", "Which products grew from Q1 2025 to Q1 2026?", "needs_planner", "period_label_unsupported", null, null],
    ["window_ambiguous", "Which customers grew over the last 3 months?", "needs_planner", "unsupported_window", null, null],
    ["window_ambiguous", "Which customers grew over the last 6 months?", "needs_planner", "unsupported_window", null, null],
    ["window_ambiguous", "Which customers grew over the last 12 months?", "needs_planner", "unsupported_window", null, null],
    ["window_ambiguous", "Which products declined over the last 6 months?", "needs_planner", "unsupported_window", null, null],
    ["relative_offset", "Which customers grew two months ago vs three months ago?", "needs_planner", "relative_offset_unsupported", null, null],
    ["relative_offset", "Which customers grew three months ago vs six months ago?", "needs_planner", "relative_offset_unsupported", null, null],
    ["point", "Which customers grew last quarter vs the quarter before?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"previous_quarter"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-04-01..2026-06-30 vs 2026-01-01..2026-03-31"],
    ["rate_ranking", "Which customers are growing fastest?", "unsupported", "unsupported_growth_rate", null, null],
    ["rate_ranking", "Top 10 fastest-growing customers", "unsupported", "unsupported_growth_rate", null, null],
    ["rate_ranking", "Which products are declining fastest?", "unsupported", "unsupported_growth_rate", null, null],
    ["abs_ranking", "Top 5 customers with the biggest growth", "needs_planner", "period_missing", null, null],
    ["window_ambiguous", "Which customers are growing?", "needs_planner", "period_missing", null, null],
    ["window_ambiguous", "Which customers have been growing?", "needs_planner", "period_missing", null, null],
    ["series", "Which customers are consistently growing?", "unsupported", "unsupported_growth_pattern", null, null],
    ["period_ambiguous", "Which customers grew over the last year?", "needs_planner", "ambiguous_period", null, null],
    ["series", "Which customers increased their sales every month?", "unsupported", "unsupported_growth_pattern", null, null],
    ["series", "Which customers have continuous growth?", "unsupported", "unsupported_growth_pattern", null, null],
    ["period_ambiguous", "Show customer growth over the last year", "needs_planner", "ambiguous_period", null, null],
    ["series", "Show monthly customer growth for the last 12 months", "unsupported", "unsupported_growth_pattern", null, null],
    ["series", "Which customers grew every quarter this year?", "unsupported", "unsupported_growth_pattern", null, null],
    ["series", "Which customers increased sales in each quarter?", "unsupported", "unsupported_growth_pattern", null, null],
    ["multi_compare", "Which customers grew MoM and YoY?", "unsupported", "unsupported_combination", null, null],
    ["multi_compare", "Which customers grew this month and last year?", "needs_planner", "ambiguous_period", null, null],
    ["multi_compare", "Which customers declined MoM but grew YoY?", "unsupported", "unsupported_combination", null, null],
    ["period_ambiguous", "Which customers are growing this year?", "needs_planner", "ambiguous_period", null, null],
    ["period_ambiguous", "Which customers grew last year?", "needs_planner", "ambiguous_period", null, null],
    ["window_ambiguous", "Which customers are growing recently?", "needs_planner", "period_missing", null, null],
    ["period_ambiguous", "Which customers grew over the year?", "needs_planner", "ambiguous_period", null, null],
    ["pct_threshold", "Which customers grew this month vs last month by more than 20%?", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"invoiceAmount.deltaPct\",\"op\":\"gt\",\"value\":20}],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount.deltaPct\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["abs_ranking", "Top 10 customers by growth this month vs last month", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"invoiceAmount.delta\",\"op\":\"gt\",\"value\":0}],\"limit\":10,\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount.delta\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["abs_ranking", "Which customers grew the most this month vs last month?", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"invoiceAmount.delta\",\"op\":\"gt\",\"value\":0}],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount.delta\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["rate_ranking", "Top 5 fastest growing customers this month vs last month", "unsupported", "unsupported_growth_rate", null, null],
    ["rate_ranking", "Top 5 customers with the highest growth percentage this month vs last month", "unsupported", "unsupported_growth_rate", null, null],
    ["point", "Which customers grew this month compared to same month last year?", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_month"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-09-01..2026-09-18 vs 2025-09-01..2025-09-18"],
    ["point", "Which customers grew this quarter compared to the same quarter last year?", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_quarter"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-07-01..2026-09-18 vs 2025-07-01..2025-09-18"],
    ["point", "Which customers declined previous quarter vs same period last year", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"lt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"previous_quarter"},"sort":[{"by":"invoiceAmount.delta","dir":"asc"}],"v":1}', "2026-04-01..2026-06-30 vs 2025-04-01..2025-06-30"],
    ["presence", "Which customers stopped buying this month vs last month?", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"invoiceAmount\",\"op\":\"eq\",\"value\":0},{\"metric\":\"invoiceAmount.previous\",\"op\":\"gt\",\"value\":0}],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount.previous\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["presence", "Which customers are new this month vs last month?", "supported", null, "{\"entity\":\"sales\",\"filters\":[{\"dim\":\"customer\",\"op\":\"new_in_period\",\"value\":\"period\"}],\"groupBy\":[{\"dim\":\"customer\"}],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"invoiceAmount\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18"], // decision 3: ledger created this month (LedgerMaster); comparison dropped
    ["point", "Which customers declined this month vs the full last month?", "supported", null, '{"compare":{"mode":"full_previous"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"lt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_month"},"sort":[{"by":"invoiceAmount.delta","dir":"asc"}],"v":1}', "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["point", "Which customers grew this financial year vs last financial year?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_fy"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-04-01..2026-09-18 vs 2025-04-01..2025-09-18"],
    ["point", "Which customers grew in FY 2025-26 vs FY 2024-25?", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2024-04-01","kind":"custom","to":"2025-03-31"}},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"fy":"2025-26","kind":"specific_fy"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2025-04-01..2026-03-31 vs 2024-04-01..2025-03-31"],
    ["point", "Which customers grew in FY 2026-27 vs FY 2025-26?", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2025-04-01","kind":"custom","to":"2026-03-31"}},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"fy":"2026-27","kind":"specific_fy"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-04-01..2027-03-31 vs 2025-04-01..2026-03-31"],
    ["point", "Which customers grew in August 2026 vs August 2025?", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2025-08-01","kind":"custom","to":"2025-08-31"}},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"from":"2026-08-01","kind":"custom","to":"2026-08-31"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-08-01..2026-08-31 vs 2025-08-01..2025-08-31"],
    ["point", "Which customers grew in June 2026 vs January 2026?", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2026-01-01","kind":"custom","to":"2026-01-31"}},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"from":"2026-06-01","kind":"custom","to":"2026-06-30"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-06-01..2026-06-30 vs 2026-01-01..2026-01-31"],
    ["point", "Which customers grew from 2026-01-01 to 2026-03-31 vs 2025-01-01 to 2025-03-31?", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2025-01-01","kind":"custom","to":"2025-03-31"}},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"from":"2026-01-01","kind":"custom","to":"2026-03-31"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-01-01..2026-03-31 vs 2025-01-01..2025-03-31"],
    ["two_ranges", "Which customers grew from Jan 2026 to Jun 2026 vs Jul 2025 to Dec 2025?", "needs_planner", "too_many_periods", null, null],
    ["window_system", "Which customers grew in the last 7 days?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"last_7_days"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-09-12..2026-09-18 vs 2026-09-05..2026-09-11"],
    ["window_system", "Which customers grew in the last 30 days?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"last_30_days"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-08-20..2026-09-18 vs 2026-07-21..2026-08-19"],
    ["window_system", "Which customers grew in the last 90 days?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"invoiceAmount.delta","op":"gt","value":0}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"last_90_days"},"sort":[{"by":"invoiceAmount.delta","dir":"desc"}],"v":1}', "2026-06-21..2026-09-18 vs 2026-03-23..2026-06-20"],
    ["window_unsupported", "Which customers grew in the last 60 days?", "needs_planner", "unsupported_window", null, null],
    ["window_explicit", "Which customers grew in the last 30 days vs the previous 30 days?", "needs_planner", "comparison_periods_not_aligned", null, null],
    ["window_explicit", "Sales in the last 7 days vs the previous 7 days", "needs_planner", "comparison_periods_not_aligned", null, null],
    ["series", "Which customers are growing month over month?", "needs_planner", "period_missing", null, null],
    ["series", "Which customers grew every month this fy", "unsupported", "unsupported_growth_pattern", null, null],
    ["period_ambiguous", "Which customers grew ytd?", "needs_planner", "ambiguous_period", null, null],
    ["point", "Customers whose revenue grew this month vs last month", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"groupBy\":[{\"dim\":\"customer\"}],\"having\":[{\"metric\":\"lineAmount.delta\",\"op\":\"gt\",\"value\":0}],\"metrics\":[\"lineAmount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"lineAmount.delta\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["point", "Products whose revenue declined this quarter vs last quarter", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"product"}],"having":[{"metric":"lineAmount.delta","op":"lt","value":0}],"metrics":["lineAmount","quantity"],"mode":"aggregate","period":{"kind":"current_quarter"},"sort":[{"by":"lineAmount.delta","dir":"asc"}],"v":1}', "2026-07-01..2026-09-18 vs 2026-04-01..2026-06-18"],
    ["point", "Which products grew in sales this quarter vs last quarter?", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"product"}],"having":[{"metric":"lineAmount.delta","op":"gt","value":0}],"metrics":["lineAmount","quantity"],"mode":"aggregate","period":{"kind":"current_quarter"},"sort":[{"by":"lineAmount.delta","dir":"desc"}],"v":1}', "2026-07-01..2026-09-18 vs 2026-04-01..2026-06-18"],
    ["point", "Which product groups grew in revenue this fy vs last fy", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"productGroup"}],"having":[{"metric":"lineAmount.delta","op":"gt","value":0}],"metrics":["lineAmount"],"mode":"aggregate","period":{"kind":"current_fy"},"sort":[{"by":"lineAmount.delta","dir":"desc"}],"v":1}', "2026-04-01..2026-09-18 vs 2025-04-01..2025-09-18"],
    ["point", "Revenue growth by product group this quarter vs last quarter", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"groupBy":[{"dim":"productGroup"}],"having":[{"metric":"lineAmount.delta","op":"gt","value":0}],"metrics":["lineAmount"],"mode":"aggregate","period":{"kind":"current_quarter"},"sort":[{"by":"lineAmount.delta","dir":"desc"}],"v":1}', "2026-07-01..2026-09-18 vs 2026-04-01..2026-06-18"],
    ["point", "Which customers' revenue grew vs the same month last year this month?", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"sales","filters":[],"groupBy":[{"dim":"customer"}],"having":[{"metric":"lineAmount.delta","op":"gt","value":0}],"metrics":["lineAmount"],"mode":"aggregate","period":{"kind":"current_month"},"sort":[{"by":"lineAmount.delta","dir":"desc"}],"v":1}', "2026-09-01..2026-09-18 vs 2025-09-01..2025-09-18"],
    ["point", "Suppliers whose purchases grew this month vs last month", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"purchase\",\"filters\":[],\"groupBy\":[{\"dim\":\"supplier\"}],\"having\":[{\"metric\":\"purchaseAmount.delta\",\"op\":\"gt\",\"value\":0}],\"metrics\":[\"purchaseAmount\",\"purchaseInvoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"sort\":[{\"by\":\"purchaseAmount.delta\",\"dir\":\"desc\"}],\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["point", "Which suppliers declined vs last year?", "needs_planner", "period_missing", null, null],
    ["point", "Which suppliers declined this quarter vs same quarter last year?", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"purchase","filters":[],"groupBy":[{"dim":"supplier"}],"having":[{"metric":"purchaseAmount.delta","op":"lt","value":0}],"metrics":["purchaseAmount","purchaseInvoiceCount"],"mode":"aggregate","period":{"kind":"current_quarter"},"sort":[{"by":"purchaseAmount.delta","dir":"asc"}],"v":1}', "2026-07-01..2026-09-18 vs 2025-07-01..2025-09-18"],
    ["window_ambiguous", "Which suppliers grew over the last 6 months?", "needs_planner", "unsupported_window", null, null],
    ["totals", "Sales growth this month vs last month", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["totals", "Revenue this fy vs last fy", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"metrics":["lineAmount"],"mode":"aggregate","period":{"kind":"current_fy"},"v":1}', "2026-04-01..2026-09-18 vs 2025-04-01..2025-09-18"],
    ["totals", "Purchases this month vs same month last year", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"purchase","filters":[],"metrics":["purchaseAmount","purchaseInvoiceCount"],"mode":"aggregate","period":{"kind":"current_month"},"v":1}', "2026-09-01..2026-09-18 vs 2025-09-01..2025-09-18"],
    ["totals", "Sales last month vs the month before", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"previous_month"},"v":1}', "2026-08-01..2026-08-31 vs 2026-07-01..2026-07-31"],
    ["totals", "Sales this month mom", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"metrics\":[\"invoiceAmount\",\"invoiceCount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["totals", "Sales this quarter qoq", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_quarter"},"v":1}', "2026-07-01..2026-09-18 vs 2026-04-01..2026-06-18"],
    ["totals", "Sales this month yoy", "supported", null, '{"compare":{"mode":"same_period_last_year"},"entity":"sales","filters":[],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_month"},"v":1}', "2026-09-01..2026-09-18 vs 2025-09-01..2025-09-18"],
    ["totals", "Sales this week vs last week", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"sales","filters":[],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"kind":"current_week"},"v":1}', "2026-09-14..2026-09-18 vs 2026-09-07..2026-09-11"],
    ["totals", "Revenue this month vs last month", "supported",null,"{\"compare\":{\"mode\":\"full_previous\"},\"entity\":\"sales\",\"filters\":[],\"metrics\":[\"lineAmount\"],\"mode\":\"aggregate\",\"period\":{\"kind\":\"current_month\"},\"v\":1}", "2026-09-01..2026-09-18 vs 2026-08-01..2026-08-31"],
    ["totals", "Purchases last quarter vs the quarter before", "supported", null, '{"compare":{"mode":"like_for_like"},"entity":"purchase","filters":[],"metrics":["purchaseAmount","purchaseInvoiceCount"],"mode":"aggregate","period":{"kind":"previous_quarter"},"v":1}', "2026-04-01..2026-06-30 vs 2026-01-01..2026-03-31"],
    ["unaligned", "Sales today vs yesterday", "needs_planner", "comparison_periods_not_aligned", null, null],
    ["unaligned", "Sales yesterday vs the day before", "needs_planner", "comparison_periods_not_aligned", null, null],
    ["series", "Monthly sales for the last 12 months", "needs_planner", "unsupported_window", null, null],
    ["series_single", "Monthly sales for FY 2025-26", "supported", null, '{"entity":"sales","filters":[],"groupBy":[{"bucket":"month","dim":"date"}],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"fy":"2025-26","kind":"specific_fy"},"v":1}', "2025-04-01..2026-03-31"],
    ["window_ambiguous", "Sales in the last 6 months", "needs_planner", "unsupported_window", null, null],
    ["period_ambiguous", "Sales this year vs last year", "needs_planner", "ambiguous_period", null, null],
    ["unequal_custom", "Sales from 2026-01-01 to 2026-03-31 vs 2026-04-01 to 2026-06-30", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2026-04-01","kind":"custom","to":"2026-06-30"}},"entity":"sales","filters":[],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"from":"2026-01-01","kind":"custom","to":"2026-03-31"},"v":1}', "2026-01-01..2026-03-31 vs 2026-04-01..2026-06-30"],
    ["unequal_custom", "Sales from 2026-01-01 to 2026-03-31 vs 2026-04-01 to 2026-06-15", "supported", null, '{"compare":{"mode":"custom","period":{"from":"2026-04-01","kind":"custom","to":"2026-06-15"}},"entity":"sales","filters":[],"metrics":["invoiceAmount","invoiceCount"],"mode":"aggregate","period":{"from":"2026-01-01","kind":"custom","to":"2026-03-31"},"v":1}', "2026-01-01..2026-03-31 vs 2026-04-01..2026-06-15"],
    ["window_ambiguous", "Sales growth by customer over the past six months", "needs_planner", "unsupported_window", null, null],
    ["window_ambiguous", "Customer sales trend for the last 6 months", "needs_planner", "unsupported_window", null, null],
];
const NEVER_A_PLAN = new Set(["window_ambiguous", "series", "rate_ranking", "multi_compare", "period_ambiguous", "relative_offset", "two_ranges", "window_unsupported"]);
const classify = (status, code) => (status === "supported" ? "SUPPORTED" : status === "unsupported" ? "UNSUPPORTED" : SKIP_ROUTER_CODES.has(code) ? "CLARIFY" : "PLANNER");

(async () => {
  // =============================================================== A
  section("A. period x comparison resolution matrix (validator + periodEngine, two anchors)");
  {
    let ok = 0;
    const bad = [];
    for (const [key, expected] of Object.entries(MATRIX)) {
      const [anchor, kind, mode] = key.split("|");
      const got = resolveCell(kind, mode, ANCHORS[anchor]).text;
      if (got === expected) ok += 1;
      else bad.push(`${key}: ${got} != ${expected}`);
    }
    check(`all ${ok} period/comparison resolutions match the documented matrix exactly`, bad.length === 0 && ok === Object.keys(MATRIX).length, bad.slice(0, 5).join(" | "));
    const cellEnd = (k, m) => MATRIX[`end|${k}|${m}`];
    check("month-end anchor (31 Mar): 'last month' = 1-28 Feb; vs the month before = January; full previous of this month = February", cellEnd("previous_month", "none") === "2026-02-01..2026-02-28" && cellEnd("previous_month", "like_for_like") === "2026-02-01..2026-02-28 vs 2026-01-01..2026-01-31 [like_for_like]" && cellEnd("current_month", "full_previous") === "2026-03-01..2026-03-31 vs 2026-02-01..2026-02-28 [like_for_like]"); // complete month: identical to like-for-like, so canonicalised
    check("matrix covers every DSL period kind x 5 comparison options x 2 anchors", Object.keys(MATRIX).length === PERIOD_KINDS.length * 5 * 2 && PERIOD_KINDS.length === 18);
    // the partial-period behaviour, stated explicitly
    const cell = (a, k, m) => MATRIX[`${a}|${k}|${m}`];
    check("partial current month: like_for_like = 1st..same day of previous month (1-18 Sep vs 1-18 Aug)", cell("mid", "current_month", "like_for_like") === "2026-09-01..2026-09-18 partial vs 2026-08-01..2026-08-18 [like_for_like]");
    check("partial current month: full_previous = the COMPLETE previous month", cell("mid", "current_month", "full_previous") === "2026-09-01..2026-09-18 partial vs 2026-08-01..2026-08-31 [full_previous]");
    check("partial current month: same_period_last_year = the same partial span a year earlier", cell("mid", "current_month", "same_period_last_year") === "2026-09-01..2026-09-18 partial vs 2025-09-01..2025-09-18 [same_period_last_year]");
    check("partial current quarter: like_for_like same elapsed span; full_previous complete previous quarter", cell("mid", "current_quarter", "like_for_like").endsWith("vs 2026-04-01..2026-06-18 [like_for_like]") && cell("mid", "current_quarter", "full_previous").endsWith("vs 2026-04-01..2026-06-30 [full_previous]"));
    check("partial current FY: like_for_like Apr-18 Sep last year; full_previous the complete prior FY", cell("mid", "current_fy", "like_for_like").endsWith("vs 2025-04-01..2025-09-18 [like_for_like]") && cell("mid", "current_fy", "full_previous").endsWith("vs 2025-04-01..2026-03-31 [full_previous]"));
    check("partial current week (Mon-Fri): like_for_like Mon-Fri of last week; full_previous the whole last week", cell("mid", "current_week", "like_for_like").endsWith("vs 2026-09-07..2026-09-11 [like_for_like]") && cell("mid", "current_week", "full_previous").endsWith("vs 2026-09-07..2026-09-13 [full_previous]"));
    check("complete periods: full_previous is canonicalised to like_for_like (identical range)", cell("mid", "previous_month", "full_previous").endsWith("[like_for_like]") && cell("end", "current_quarter", "full_previous").endsWith("[full_previous]") === true);
    check("specific_fy of an in-progress FY: WHOLE FY vs complete prior FY, with a warning (not like-for-like)", cell("mid", "specific_fy", "like_for_like") === "2026-04-01..2027-03-31 partial vs 2025-04-01..2026-03-31 [like_for_like] W:warn_specific_fy_partial_comparison");
    check("rolling windows: like_for_like = the immediately preceding window of equal length", cell("mid", "last_90_days", "like_for_like") === "2026-06-21..2026-09-18 partial vs 2026-03-23..2026-06-20 [like_for_like]" && cell("end", "last_30_days", "like_for_like").endsWith("vs 2026-01-31..2026-03-01 [like_for_like]"));
    check("rolling windows are always flagged partial (they end on the anchor)", ["last_7_days", "last_30_days", "last_90_days"].every((k) => / partial/.test(cell("end", k, "none"))));
    check("not comparable: custom and same_month_last_year have no like_for_like/full_previous; ytd has no full_previous; all_time none", ["custom", "same_month_last_year"].every((k) => cell("mid", k, "like_for_like").startsWith("ERR compare_mode_unsupported_for_period") && cell("mid", k, "full_previous").startsWith("ERR")) && cell("mid", "ytd", "full_previous").startsWith("ERR") && ["like_for_like", "full_previous", "same_period_last_year", "custom"].every((m) => cell("mid", "all_time", m) === "ERR all_time_cannot_compare"));
    check("same_period_last_year works for custom ranges (both ends shifted one year)", cell("mid", "custom", "same_period_last_year") === "2026-01-01..2026-03-31 vs 2025-01-01..2025-03-31 [same_period_last_year]");
    check("same_month_last_year + same_period_last_year shifts AGAIN (two years back) - literal, documented", cell("mid", "same_month_last_year", "same_period_last_year") === "2025-09-01..2025-09-18 vs 2024-09-01..2024-09-18 [same_period_last_year]");
    check("custom comparison ranges of a different length are accepted WITHOUT any warning (Jan-Mar vs 1 Jan-15 Feb)", cell("mid", "custom", "custom") === "2026-01-01..2026-03-31 vs 2025-01-01..2025-02-15 [custom]");
  }

  // =============================================================== B
  section("B. month-end anchors: 'last month' is the month BEFORE the anchor month on every day (previous_month fix)");
  {
    // Fixed at the root: dateRanges.shiftMonths/shiftYears used to roll "31 Mar -> 31 Feb" over into March, so
    // previous_month (and the full previous month of current_month) resolved to the anchor's OWN month on 29-31 Mar
    // and 31 May/Jul/Oct/Dec. They now clamp to the target month's last day.
    const r = await route("Sales last month", REF_END);
    const v = validateQueryPlan(r.plan, { referenceDate: REF_END });
    check("the router's 'Sales last month' on 31 Mar 2026 = 1-28 Feb 2026", r.status === "supported" && r.plan.period.kind === "previous_month" && ymd(v.normalized.period.from) === "2026-02-01" && ymd(v.normalized.period.to) === "2026-02-28");
    // blast radius over every anchor day 2024-2026
    const mi = (x) => x.getFullYear() * 12 + x.getMonth();
    const sweep = (fn) => {
      const bad = [];
      for (let y = 2024; y <= 2026; y += 1) for (let m = 0; m < 12; m += 1) for (let day = 1; day <= 31; day += 1) {
        const ref = new Date(y, m, day, 12);
        if (ref.getMonth() !== m) continue;
        if (!fn(ref)) bad.push(ymd(ref));
      }
      return bad;
    };
    const res = (kind, mode, ref) => validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind }, metrics: ["invoiceAmount"], filters: [], ...(mode ? { compare: { mode } } : {}) }, { referenceDate: ref }).normalized;
    const invariants = [
      ["previous_month = the whole month before the anchor month", (ref) => { const n = res("previous_month", null, ref); return mi(n.period.from) === mi(ref) - 1 && mi(n.period.to) === mi(ref) - 1 && n.period.from.getDate() === 1; }],
      ["previous_month like_for_like baseline = the whole month two before", (ref) => { const n = res("previous_month", "like_for_like", ref); return mi(n.comparison.from) === mi(ref) - 2 && mi(n.comparison.to) === mi(ref) - 2; }],
      ["current_month full_previous baseline = the whole previous month", (ref) => { const n = res("current_month", "full_previous", ref); return mi(n.comparison.from) === mi(ref) - 1 && mi(n.comparison.to) === mi(ref) - 1; }],
      ["current_month like_for_like baseline: 1st..clamped same day of previous month", (ref) => { const n = res("current_month", "like_for_like", ref); return mi(n.comparison.from) === mi(ref) - 1 && mi(n.comparison.to) === mi(ref) - 1 && n.comparison.from.getDate() === 1; }],
      ["current_month same_period_last_year: same month, a year earlier (incl. 29 Feb 2024)", (ref) => { const n = res("current_month", "same_period_last_year", ref); return mi(n.comparison.from) === mi(ref) - 12 && mi(n.comparison.to) === mi(ref) - 12; }],
      ["same_month_last_year: the anchor month a year earlier", (ref) => { const n = res("same_month_last_year", null, ref); return mi(n.period.from) === mi(ref) - 12; }],
      ["current_quarter like_for_like: previous quarter, same elapsed span", (ref) => { const n = res("current_quarter", "like_for_like", ref); return mi(n.period.from) - mi(n.comparison.from) === 3 && mi(n.comparison.to) < mi(n.period.from); }],
      ["current_fy / ytd like_for_like: same span one year earlier", (ref) => { const a = res("current_fy", "like_for_like", ref); const b = res("ytd", "like_for_like", ref); return mi(a.period.to) - mi(a.comparison.to) === 12 && mi(b.period.to) - mi(b.comparison.to) === 12; }],
    ];
    for (const [label, fn] of invariants) {
      const bad = sweep(fn);
      check(`correct on all 1096 anchors: ${label}`, bad.length === 0, bad.slice(0, 5).join(" "));
    }
    const dr = require("./src/services/analytics/dateRanges");
    const legacyBad = sweep((ref) => { const p = dr.previousFullMonth(ref); return mi(p.from) === mi(ref) - 1 && mi(p.to) === mi(ref) - 1; });
    check("legacy chat's previous_month tool period (dateRanges.previousFullMonth) correct on all 1096 anchors", legacyBad.length === 0, legacyBad.slice(0, 5).join(" "));
    const trendBad = sweep((ref) => { const p = dr.lastNMonthsEnding(ref, 6); return mi(p.from) === mi(ref) - 5 && mi(p.to) === mi(ref); });
    check("dashboard default trend window (lastNMonthsEnding 6) = 6 whole months on all 1096 anchors", trendBad.length === 0, trendBad.slice(0, 5).join(" "));
  }

  // =============================================================== C
  section("C. routing corpus: exact outcome, exact DSL and resolved dates (router + validator, synthetic names)");
  {
    const byClass = {};
    let outcomeMismatch = [];
    let planMismatch = [];
    const misleading = [];
    for (const [tag, q, status, code, planJson, dates] of CORPUS) {
      resolverTexts.length = 0;
      const r = await route(q);
      const got = `${r.status}/${r.code || ""}`;
      if (got !== `${status}/${code || ""}`) outcomeMismatch.push(`${q}: ${got}`);
      const klass = classify(r.status, r.code);
      byClass[klass] = (byClass[klass] || 0) + 1;
      if (planJson) {
        const v = r.plan ? validateQueryPlan(r.plan, { referenceDate: REF_MID }) : { ok: false };
        const d = v.ok ? `${ymd(v.normalized.period.from)}..${ymd(v.normalized.period.to)}${v.normalized.comparison ? ` vs ${ymd(v.normalized.comparison.from)}..${ymd(v.normalized.comparison.to)}` : ""}` : "invalid";
        if (!r.plan || cj(r.plan) !== planJson || d !== dates) planMismatch.push(`${q}: ${r.plan ? cj(r.plan) : "no plan"} ${d}`);
      } else if (r.plan) planMismatch.push(`${q}: unexpected plan`);
      if (r.code === "entity_not_resolved") misleading.push(`"${q}" -> looked up "${resolverTexts[resolverTexts.length - 1]}"`);
    }
    check(`all ${CORPUS.length} corpus questions route to the documented status/code`, outcomeMismatch.length === 0, outcomeMismatch.slice(0, 4).join(" | "));
    check(`every supported question produces the documented exact DSL and resolves to the documented dates`, planMismatch.length === 0, planMismatch.slice(0, 3).join(" | "));
    console.log(`    classification: ${Object.entries(byClass).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    const silently = CORPUS.filter(([tag, , status]) => NEVER_A_PLAN.has(tag) && status === "supported");
    check(`no ambiguous/unrepresentable meaning is silently answered (${CORPUS.filter(([t]) => NEVER_A_PLAN.has(t)).length} such questions, 0 plans)`, silently.length === 0, silently.map((x) => x[1]).join(" | "));
    // misleading clarification: the router asked the NAME resolver about grammar it did not understand
    // (before the P1-4 grammar fix, 22 of these questions ended in "couldn't find that customer/product")
    check("no corpus question ends in a misleading \"couldn't find that customer/product\" (grammar words are never looked up as names)", misleading.length === 0, misleading.join(" | "));
    // direction: the subject is ALWAYS plan.period, the baseline is compare
    const supported = [];
    for (const [tag, q] of CORPUS) {
      const r = await route(q);
      if (r.status === "supported" && r.plan.compare) supported.push({ tag, q, r, n: validateQueryPlan(r.plan, { referenceDate: REF_MID }).normalized });
    }
    const relative = supported.filter((s) => s.r.plan.compare.mode !== "custom");
    check(`direction: for all ${relative.length} relative comparisons the subject is the later period and the baseline the earlier one`, relative.every((s) => s.n.period.from > s.n.comparison.from));
    const growth = supported.filter((s) => (s.r.plan.having || []).some((h) => /\.delta$/.test(h.metric)));
    check(`"grew/increased/growing" = delta (subject - baseline) > 0, "declined" = delta < 0, in all ${growth.length} change questions`, growth.every((s) => s.r.plan.having.every((h) => !/\.delta$/.test(h.metric) || (h.value === 0 && (h.op === "gt" || h.op === "lt")))));
    const custom = supported.filter((s) => s.r.plan.compare.mode === "custom" && s.r.plan.period.kind === "custom");
    const earlierSubject = custom.filter((s) => s.n.period.from < s.n.comparison.from).map((s) => s.q);
    check(`custom-vs-custom follows WORD ORDER, not chronology: the first range is the subject (${earlierSubject.length} of ${custom.length} have an earlier subject)`, earlierSubject.length === 2 && earlierSubject.every((q) => /vs 2026-04-01/.test(q)));
    // metric semantics per wording (P0-2 unchanged)
    const plans = [];
    for (const [, q] of CORPUS) {
      const r = await route(q);
      if (r.status === "supported") plans.push({ q, p: r.plan, a: r.assumptions });
    }
    const rev = plans.filter((x) => /\brevenue\b/i.test(x.q));
    check(`revenue questions (${rev.length}) use only the pre-tax lineAmount basis and carry the revenue definition`, rev.length >= 5 && rev.every((x) => x.p.metrics.includes("lineAmount") && !x.p.metrics.includes("invoiceAmount") && x.a.some((a) => a.code === "revenue_is_pre_tax_item_value")));
    const pur = plans.filter((x) => /\bpurchases?\b|\bsuppliers?\b/i.test(x.q));
    check(`purchase/supplier questions (${pur.length}) use purchase metrics on the purchase entity`, pur.length >= 3 && pur.every((x) => x.p.entity === "purchase" && x.p.metrics[0] === "purchaseAmount"));
    const sal = plans.filter((x) => !/\brevenue\b|\bpurchases?\b|\bsuppliers?\b|\bproducts?\b|\bproduct groups?\b/i.test(x.q));
    check(`sales/customer questions (${sal.length}) use the tax-inclusive invoiceAmount`, sal.length >= 20 && sal.every((x) => x.p.entity === "sales" && x.p.metrics[0] === "invoiceAmount"));
    const prod = plans.filter((x) => /\bproducts?\b/i.test(x.q) && !/\brevenue\b/i.test(x.q));
    check("product breakdowns use the line basis (lineAmount) even when the word is 'sales'", prod.length >= 1 && prod.every((x) => x.p.metrics.includes("lineAmount")));
    const lfl = plans.filter((x) => x.p.compare && x.p.compare.mode === "like_for_like");
    const lflDisclosed = lfl.filter((x) => x.a.some((a) => a.code === "comparison_like_for_like_default"));
    check(`like_for_like comparisons disclose the like-for-like assumption when the period is in progress (${lflDisclosed.length}/${lfl.length}; complete periods do not need it)`, lflDisclosed.length >= 10);
    const pctRows = plans.filter((x) => (x.p.having || []).some((h) => /deltaPct/.test(h.metric)));
    check("'by more than 20%' filters on deltaPct > 20 and sorts by deltaPct (customers with no previous value have null % and are excluded)", pctRows.length === 1 && pctRows[0].p.having[0].metric === "invoiceAmount.deltaPct" && pctRows[0].p.having[0].value === 20);
    const abs = plans.filter((x) => /most|by growth|biggest/i.test(x.q));
    check("'grew the most' / 'top by growth' rank by ABSOLUTE change (delta), never by %", abs.length === 2 && abs.every((x) => x.p.sort[0].by === "invoiceAmount.delta"));
  }

  // =============================================================== D
  section("D. growth semantics: what the DSL / validator can and cannot represent");
  {
    const base = (o = {}) => ({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "desc" }], compare: { mode: "like_for_like" }, ...o });
    const ok = (p) => validateQueryPlan(p, { referenceDate: REF_MID });
    check("single point-to-point growth (delta > 0 by customer) is representable", ok(base({ having: [{ metric: "invoiceAmount.delta", op: "gt", value: 0 }] })).ok);
    check("growth-RATE ranking is representable (sort by deltaPct, having deltaPct > 0)", ok(base({ sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }], having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 0 }] })).ok);
    check("ONE comparison per plan: a second comparison has no field (strict schema rejects compare arrays / extra keys)", !parseQueryPlan(base({ compare: [{ mode: "like_for_like" }, { mode: "same_period_last_year" }] })).ok && !parseQueryPlan({ ...base(), compare2: { mode: "same_period_last_year" } }).ok);
    const series = ok(base({ groupBy: [{ dim: "customer" }, { dim: "date", bucket: "month" }], period: { kind: "specific_fy", fy: "2025-26" }, compare: { mode: "like_for_like" } }));
    check("growth PER SUB-PERIOD is not representable: compare + date series is rejected", !series.ok && series.errors.some((e) => e.code === "compare_not_supported_with_date_groupby"));
    const seriesNoCmp = ok({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "specific_fy", fy: "2025-26" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "date", bucket: "month" }] });
    check("a plain monthly series is representable, but it carries no growth values", seriesNoCmp.ok && !seriesNoCmp.normalized.comparison);
    const deltaNoCmp = ok(base({ compare: undefined, sort: [{ by: "invoiceAmount.delta", dir: "desc" }] }));
    check("delta/deltaPct refs without a comparison are rejected (derived_ref_requires_compare)", !deltaNoCmp.ok && deltaNoCmp.errors.some((e) => e.code === "derived_ref_requires_compare"));
    check(`"positive in every one of N periods" is not representable: having holds at most ${LIMITS.maxHaving} conditions on ONE comparison`, !parseQueryPlan(base({ having: [1, 2, 3, 4].map(() => ({ metric: "invoiceAmount.delta", op: "gt", value: 0 })) })).ok);
    check("no 'last N months' period kind exists: rolling windows are only 7 / 30 / 90 days", !PERIOD_KINDS.some((k) => /^last_\d+_(?:weeks?|months?|years?)$/.test(k)) && ["last_7_days", "last_30_days", "last_90_days"].every((k) => PERIOD_KINDS.includes(k)));
    const sixMonths = ok({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2026-03-19", to: "2026-09-18" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "desc" }], compare: { mode: "custom", period: { kind: "custom", from: "2025-09-18", to: "2026-03-18" } } });
    check("a 6-month window vs the previous 6 months IS representable, but only as two ABSOLUTE custom ranges", sixMonths.ok);
    const unequal = ok({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2026-01-01", to: "2026-03-31" }, metrics: ["invoiceAmount"], filters: [], compare: { mode: "custom", period: { kind: "custom", from: "2026-04-01", to: "2026-06-15" } } });
    check("unequal-length custom comparisons validate with NO warning (90 days vs 76 days)", unequal.ok && unequal.warnings.length === 0);
    const tooLong = ok({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2019-01-01", to: "2026-01-01" }, metrics: ["invoiceAmount"], filters: [] });
    check(`multi-year ranges are capped at ${CATALOG.periods.rules.maxCustomRangeDays} days (range_too_long beyond)`, !tooLong.ok && tooLong.errors.some((e) => e.code === "range_too_long"));
    check("ytd is a valid DSL period (calendar YTD) even though the router treats 'ytd' as ambiguous and the planner prompt omits it", ok({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "ytd" }, metrics: ["invoiceAmount"], filters: [] }).ok);
    const { computeGrowth } = require("./src/services/analytics/salesAnalytics");
    check("change % = (current - previous) / |previous| x 100, and NULL (not 0, not infinity) when previous = 0", computeGrowth(150, 100).growthPercentage === 50 && computeGrowth(0, 100).growthPercentage === -100 && computeGrowth(10, 0).growthPercentage === null && CATALOG.compare.derivedSuffixes.deltaPct.nullWhen === "previous == 0 (never Infinity/NaN, never 0%)");
    check("groups present in only one period are kept (full outer join) with the missing side = 0", CATALOG.compare.joinPolicy === "full_outer_on_group_keys");
    check(`a comparison is refused beyond ${LIMITS.maxCompareGroups} groups per period (result_too_large)`, Number.isInteger(LIMITS.maxCompareGroups) && LIMITS.maxCompareGroups > 0);
  }

  // =============================================================== E
  section("E. planner representability (fake Claude client - no network)");
  {
    const prompt = getPlannerPrompt();
    const system = prompt.system.map((b) => b.text).join("\n");
    check("the planner is never told today's / the tenant's reference date (no date context in its prompt)", !/reference date|today is|current date|20\d\d-\d\d-\d\d/i.test(system) && /YYYY-MM-DD/.test(system));
    check("planner prompt lists every compare mode and every period kind except ytd", CATALOG.compare.modes.every((m) => system.includes(m)) && PERIOD_KINDS.filter((k) => k !== "ytd").every((k) => system.includes(k)) && !/\bytd\b/.test(system));
    const fake = (input) => { const fn = async (req) => { fn.req = req; return { content: [{ type: "tool_use", id: "t1", name: PLANNER_TOOL_NAME, input }], usage: {} }; }; return fn; };
    const q = "Which customers grew over the last 6 months?";
    const invented = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-03-01", to: "2025-08-31" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "desc" }], compare: { mode: "custom", period: { kind: "custom", from: "2024-09-01", to: "2025-02-28" } }, having: [{ metric: "invoiceAmount.delta", op: "gt", value: 0 }] };
    const c1 = fake({ plan: invented });
    const r1 = await planQuestion(q, { claudeClient: c1 });
    // P-SF closed this audit RISK (it used to validate): years the user never wrote are refused by the planner's date guard
    check("FIXED (was RISK): a planner plan with invented absolute dates for a RELATIVE window is refused (year_missing), never run", r1.status === "needs_clarification" && r1.code === "year_missing" && !r1.plan && c1.req.messages[0].content === q);
    const rp = await routeAndPlan(q, { resolveEntity: resolver, claudeClient: async () => { throw new Error("must not be called"); } });
    check("...that question never reaches the planner: the router asks for a supported window (unsupported_window, 0 Claude)", rp.claudeCalled === false && rp.final.code === "unsupported_window");
    const r2 = await planQuestion("Which customers grew MoM and YoY?", { claudeClient: fake({ plan: { ...invented, compare: [{ mode: "like_for_like" }, { mode: "same_period_last_year" }] } }) });
    check("two comparisons from the planner are refused (planner_invalid_plan)", r2.status === "planner_failed" && r2.code === "planner_invalid_plan");
    const r3 = await planQuestion("monthly customer growth this fy", { claudeClient: fake({ plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_fy" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "date", bucket: "month" }], compare: { mode: "like_for_like" } } }) });
    check("growth per month from the planner is refused (compare + date series)", r3.status === "planner_failed" && r3.code === "planner_invalid_plan");
    const r4 = await planQuestion("fastest growing customers this month", { claudeClient: fake({ plan: { ...invented, period: { kind: "current_month" }, compare: { mode: "like_for_like" }, sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }], having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 0 }] } }) });
    check("a growth-RATE ranking is expressible by the planner (only reachable if the router forwarded the question)", r4.status === "supported" && r4.plan.sort[0].by === "invoiceAmount.deltaPct");
    const r5 = await planQuestion("which customers are growing", { claudeClient: fake({ plan: { ...invented, period: { kind: "current_quarter" }, compare: { mode: "same_period_last_year" } } }) });
    check("the planner may pick ANY single period+comparison for an undefined 'growing' - the result validates and nothing records which meaning was chosen except its free-text assumptions", r5.status === "supported" && Array.isArray(r5.plannerAssumptions));
    const plannerReachable = CORPUS.filter(([, , status, code]) => status === "needs_planner" && !SKIP_ROUTER_CODES.has(code));
    console.log(`    corpus questions that would reach the planner (1 Claude call each): ${plannerReachable.length}`);
    for (const [, qq, , code] of plannerReachable) console.log(`      ${code}: ${qq}`);
    check("planner-reachable corpus questions are only structural router gaps (no ambiguous 'growing'-window meaning reaches Claude)", plannerReachable.every(([tag]) => !["window_ambiguous", "rate_ranking", "period_ambiguous"].includes(tag)));
  }

  // =============================================================== F
  section("F. engine results vs an independent aggregation (READ-ONLY, largest real tenant)");
  await groundTruth();

  // =============================================================== G
  section("G. no network was used");
  check("zero fetch/http calls (no Anthropic, no Tally)", netCalls === 0, String(netCalls));
  Object.assign(global, { fetch: savedNet.fetch });
  http.request = savedNet.h;
  https.request = savedNet.s;

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------- F. ground truth (read-only)
async function groundTruth() {
  const mongoose = require("mongoose");
  require("dotenv").config();
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }); // not connectDB(): it exits the process on failure
  } catch (e) {
    console.log("  SKIPPED - MongoDB not reachable (sections A-E are complete without it)");
    return;
  }
  try {
    const Company = require("./src/models/company");
    const Sale = require("./src/models/sales.model");
    const Purchase = require("./src/models/purchase.model");
    const { executeQuery } = require("./src/services/query/execute");
    const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");
    // the tenant with the most active sales vouchers (no names are read or printed)
    let tenantId = null;
    let most = -1;
    for (const c of await Company.find({ isActive: true }, { tenantId: 1 }).lean()) {
      const n = await Sale.countDocuments({ tenantId: c.tenantId, voucherStatus: "active" });
      if (n > most) { most = n; tenantId = c.tenantId; }
    }
    if (!tenantId || most < 100) { console.log("  SKIPPED - no tenant with enough data"); return; }
    const ref = await getTenantReferenceDate(tenantId);
    console.log(`    tenant with ${most} active sales vouchers; reference date ${ymd(ref)}${[29, 30, 31].includes(ref.getDate()) ? " (a month-end anchor: see section B)" : ""}`);

    // independent oracle: raw aggregation written separately from compile/execute
    const VOUCHER = { invoiceAmount: "$header.voucherTotalAmount", purchaseAmount: "$header.voucherTotalAmount" };
    const LINE = { lineAmount: "$inventory.amount", quantity: "$inventory.quantity" };
    async function sums(n, range) {
      const Model = n.entity === "sales" ? Sale : Purchase;
      const dim = n.groupBy.length ? n.groupBy[0].dim : null;
      const line = n.metrics.some((m) => LINE[m]);
      const pipeline = [{ $match: { tenantId, voucherStatus: "active", "header.voucherDate": { $gte: range.from, $lte: range.to } } }];
      if (line) pipeline.push({ $unwind: "$inventory" });
      const group = { _id: dim === null ? null : dim === "product" ? "$inventory.itemName" : "$header.partyName" };
      for (const m of n.metrics) group[m] = VOUCHER[m] ? { $sum: VOUCHER[m] } : LINE[m] ? { $sum: LINE[m] } : { $sum: 1 };
      pipeline.push({ $group: group });
      const out = new Map();
      for (const r of await Model.aggregate(pipeline)) {
        const key = dim === null ? {} : { [dim]: r._id === undefined ? null : r._id };
        out.set(JSON.stringify(key), { key, values: Object.fromEntries(n.metrics.map((m) => [m, r[m] || 0])) });
      }
      return out;
    }
    const OPS = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b, neq: (a, b) => a !== b };
    const rd6 = (v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
    async function expected(n) {
      const cur = await sums(n, n.period);
      const prev = await sums(n, n.comparison);
      const zero = Object.fromEntries(n.metrics.map((m) => [m, 0]));
      const ids = new Set([...cur.keys(), ...prev.keys()]);
      let rows = [...ids].map((id) => {
        const values = (cur.get(id) || { values: zero }).values;
        const previous = (prev.get(id) || { values: zero }).values;
        const comparison = Object.fromEntries(n.metrics.map((m) => [m, { previous: previous[m], delta: values[m] - previous[m], deltaPct: previous[m] === 0 ? null : ((values[m] - previous[m]) / Math.abs(previous[m])) * 100 }]));
        return { id, key: (cur.get(id) || prev.get(id)).key, values, comparison, isNew: !prev.has(id) };
      });
      const ref = (r, s) => { const [b, suf] = s.split("."); return suf ? r.comparison[b][suf] : r.values[b]; };
      rows = rows.filter((r) => n.having.every((h) => { const v = ref(r, h.metric); return v !== null && v !== undefined && OPS[h.op](v, h.value); }));
      rows.sort((a, b) => {
        for (const s of n.sort) {
          const va = rd6(ref(a, s.by));
          const vb = rd6(ref(b, s.by));
          if (va === vb) continue;
          if (va === null || va === undefined) return 1;
          if (vb === null || vb === undefined) return -1;
          return (va < vb ? -1 : 1) * (s.dir === "asc" ? 1 : -1);
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const totalCur = zero && Object.fromEntries(n.metrics.map((m) => [m, [...cur.values()].reduce((s, r) => s + r.values[m], 0)]));
      const totalPrev = Object.fromEntries(n.metrics.map((m) => [m, [...prev.values()].reduce((s, r) => s + r.values[m], 0)]));
      return { rows: rows.slice(0, n.limit), truncated: rows.length > n.limit, totalCur, totalPrev, newPassing: rows.filter((r) => r.isNew).length, all: rows.length };
    }
    const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.01);
    const fmt = (d) => ymd(d);
    const m1 = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
    const m2 = new Date(ref.getFullYear(), ref.getMonth() - 2, 1);
    const end = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const questions = [
      "Which customers grew this month vs last month?",
      "Which customers declined this month vs the full last month?",
      "Which customers grew this month compared to same month last year?",
      "Which customers grew this month vs last month by more than 20%?",
      "Top 10 customers by growth this month vs last month",
      "Which customers stopped buying this month vs last month?",
      "Customers whose revenue grew this month vs last month",
      "Products whose revenue declined this quarter vs last quarter",
      "Suppliers whose purchases grew this quarter vs last quarter",
      "Which customers grew in the last 90 days?",
      `Which customers grew from ${fmt(m1)} to ${fmt(end(m1))} vs ${fmt(m2)} to ${fmt(end(m2))}?`,
      "Sales this quarter vs same quarter last year",
      "Revenue this fy vs last fy",
    ];
    for (const q of questions) {
      const r = await routeQuestion(q, { resolveEntity: resolver, referenceDate: ref });
      if (r.status !== "supported") { check(`"${q}" is router-supported`, false, `${r.status}/${r.code}`); continue; }
      const v = validateQueryPlan(r.plan, { referenceDate: ref });
      const res = await executeQuery(r.plan, { tenantId, referenceDate: ref });
      const exp = await expected(v.normalized);
      const problems = [];
      if (!res.ok) problems.push(`engine ${JSON.stringify(res.errors)}`);
      else if (v.normalized.groupBy.length) {
        if (res.rows.length !== exp.rows.length) problems.push(`rows ${res.rows.length} vs ${exp.rows.length}`);
        res.rows.forEach((row, i) => {
          const e = exp.rows[i];
          if (!e || JSON.stringify(row.key) !== JSON.stringify(e.key)) return problems.push(`row ${i} key`);
          for (const m of v.normalized.metrics) {
            if (!near(row.values[m], e.values[m]) || !near(row.comparison[m].previous, e.comparison[m].previous) || !near(row.comparison[m].delta, e.comparison[m].delta) || !near(row.comparison[m].deltaPct, e.comparison[m].deltaPct)) problems.push(`row ${i} ${m}`);
          }
        });
        if (res.truncated !== exp.truncated) problems.push("truncated flag");
      }
      if (res.ok && res.totals) {
        for (const m of v.normalized.metrics) {
          if (!near(res.totals.values[m], exp.totalCur[m])) problems.push(`total ${m}`);
          if (res.totals.comparison && !near(res.totals.comparison[m].previous, exp.totalPrev[m])) problems.push(`total previous ${m}`);
        }
      }
      const note = v.normalized.groupBy.length ? `${exp.all} matching groups, ${res.rows ? res.rows.length : 0} returned${exp.newPassing ? `, ${exp.newPassing} of them new (no previous value)` : ""}` : "totals";
      check(`"${q}" [${ymd(v.normalized.period.from)}..${ymd(v.normalized.period.to)} vs ${ymd(v.normalized.comparison.from)}..${ymd(v.normalized.comparison.to)}] engine = independent aggregation (${note})`, problems.length === 0, problems.slice(0, 4).join(", "));
    }
  } finally {
    await mongoose.disconnect();
  }
}

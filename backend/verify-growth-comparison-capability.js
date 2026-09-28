"use strict";

/**
 * Real-user growth & comparison semantics AUDIT (read-only). Written as a snapshot of the audit findings; updated by the
 * Semantic Foundation checkpoint (P-SF, 2026-09-28): the defects it pinned (three "todays", the "who bought less" misread,
 * 12/14 follow-ups to legacy chat, % totals refused, no coverage model) are now asserted FIXED. The month-end and new/lost
 * facts in D are unchanged on purpose (product decisions, docs/SEMANTIC_FOUNDATION.md).
 *
 *   A. architecture facts: where the reference date comes from and which paths ever see it
 *   B. realistic corpus (207 questions): current router behaviour vs the audit's TARGET behaviour,
 *      semantic signature of every supported plan, grammar words leaking into the name lookup
 *   C. conversational follow-ups through the real chat path (fakes): context kept / lost / sent to legacy chat
 *   D. semantic sweeps: month-end like-for-like truncation, new/lost baselines
 *   E. synthetic tenant: engine results vs an INDEPENDENT oracle (plain calendar arithmetic + in-memory sums)
 *      across month-end, February, leap-day, FY, quarter and year boundaries
 *   F. data coverage: zero baselines that are really "no data" (prototype classifier = the proposed design)
 *   G. no network
 *
 * Section E writes ONLY a synthetic tenant ("verify-growth-audit-*") through the raw driver and deletes it afterwards;
 * real tenants are only counted (read-only), never named. No Anthropic, no Tally.
 * Run: node verify-growth-comparison-capability.js
 */

require("dotenv").config();
const http = require("http");
const https = require("https");

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = async () => { netCalls += 1; throw new Error("network disabled in this audit"); };
http.request = () => { netCalls += 1; throw new Error("network disabled in this audit"); };
https.request = () => { netCalls += 1; throw new Error("network disabled in this audit"); };

const fs = require("fs");
const { routeQuestion } = require("./src/services/query/localRouter");
const { validateQueryPlan } = require("./src/services/query/validator");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { getPlannerPrompt, SKIP_ROUTER_CODES } = require("./src/services/query/planner");
const { tryAnswerWithQueryEngine: realTryAnswer } = require("./src/services/query/queryChat");
// P-SF: the engine now reads ONE tenant date context per turn. Synthetic (fake-resolver) turns have no database,
// so they get a fixed one (latest voucher 2025-12-08 = the fake freshness date; history from 2024-04-01).
const { buildDateContext } = require("./src/services/analytics/referenceDate");
const SYNTH_DATES = buildDateContext({ sales: { earliest: new Date(2024, 3, 1), latest: new Date(2025, 11, 8) }, purchase: { earliest: new Date(2024, 3, 1), latest: new Date(2025, 11, 8) } }, new Date(2025, 11, 8, 18));
const tryAnswerWithQueryEngine = (a) => realTryAnswer(a && a.deps && a.deps.resolveEntity && !a.deps.getDateContext ? { ...a, deps: { ...a.deps, getDateContext: async () => SYNTH_DATES } } : a);
const periodEngine = require("./src/services/analytics/periodEngine");
const tools = require("./src/services/ai/tools");

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
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const REF = new Date(2026, 8, 18, 12); // mid-period anchor for routing (plans are symbolic; only validation uses it)
const classOf = (status, code) => (status === "supported" ? "SUPPORTED" : status === "unsupported" ? "UNSUPPORTED" : SKIP_ROUTER_CODES.has(code) ? "CLARIFY" : "PLANNER");

// synthetic names only
const NAMES = { customer: ["Aarav Traders", "Bluebell Mart"], supplier: ["Crescent Supplies"], product: ["Widget Alpha"], productGroup: ["Hardware"] };
const resolver = createEntityResolver({ tenantId: "AUDIT-TENANT", sources: Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, async () => v])) });
const lookups = [];
const spy = async (a) => (lookups.push(a.text), resolver(a));

// semantic signature of a plan: entity:metric | breakdown | direction | comparison | period
function sem(p) {
  const h = p.having || [];
  const find = (m, op) => h.find((x) => x.metric.endsWith(m) && x.op === op);
  let dir = "-";
  if (h.some((x) => /\.previous$/.test(x.metric) && x.op === "eq") && h.some((x) => !/\./.test(x.metric) && x.op === "gt")) dir = "new";
  else if (h.some((x) => !/\./.test(x.metric) && x.op === "eq") && h.some((x) => /\.previous$/.test(x.metric) && x.op === "gt")) dir = "lost";
  else if (find(".deltaPct", "gt")) dir = `pct>${find(".deltaPct", "gt").value}`;
  else if (find(".deltaPct", "lt")) dir = `pct<${find(".deltaPct", "lt").value}`;
  else if (find(".delta", "gt")) dir = "up";
  else if (find(".delta", "lt")) dir = "down";
  const dim = p.groupBy && p.groupBy.length ? p.groupBy.map((g) => g.dim + (g.bucket ? ":" + g.bucket : "")).join("+") : "total";
  const period = p.period.kind === "custom" ? `${p.period.from}..${p.period.to}` : p.period.kind === "specific_fy" ? `fy${p.period.fy}` : p.period.kind;
  const cmp = p.compare ? (p.compare.mode === "custom" ? `vs ${p.compare.period.from}..${p.compare.period.to}` : p.compare.mode) : "none";
  return `${p.entity}:${p.metrics[0]}|${dim}|${dir}|${cmp}|${period}`;
}

// ---------------------------------------------------------------- B. corpus
// [family, question, TARGET, note, current status, current code, current semantic signature]
// TARGET = the behaviour this audit recommends: SUPPORTED | CLARIFY | PLANNER | UNSUPPORTED | DECISION (product call first)
const CORPUS = [
  ["point/customer","Which customers grew this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["point/customer","Which customers declined this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|down|full_previous|current_month"],
  ["point/customer","Which customers grew this quarter compared to last quarter?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|like_for_like|current_quarter"],
  ["point/customer","Which customers grew this month compared to the same month last year?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|same_period_last_year|current_month"],
  ["point/customer","Which customers increased their sales this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["point/customer","Which customers had lower sales this month than last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|down|full_previous|current_month"],
  ["point/customer","clients whose sales dropped vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|down|full_previous|current_month"],
  ["point/customer","parties with higher sales this quarter than last quarter","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|like_for_like|current_quarter"],
  ["point/product","Which products grew this month vs last month?","DECISION","no sales/purchase word: default entity is a product decision (G2)","needs_planner","entity_ambiguous",null],
  ["point/product","Which products declined this month vs last month?","DECISION","","needs_planner","entity_ambiguous",null],
  ["point/product","Which products grew this quarter compared to last quarter?","DECISION","","needs_planner","entity_ambiguous",null],
  ["point/product","Which products grew this month compared to the same month last year?","DECISION","","needs_planner","entity_ambiguous",null],
  ["point/product","Which products increased their sales this month vs last month?","SUPPORTED","","supported",null,"sales:lineAmount|product|up|full_previous|current_month"],
  ["point/product","Which products had lower sales this month than last month?","SUPPORTED","","supported",null,"sales:lineAmount|product|down|full_previous|current_month"],
  ["point/product","items whose sales dropped vs last month","SUPPORTED","","supported",null,"sales:lineAmount|product|down|full_previous|current_month"],
  ["point/product","SKUs with higher sales this quarter than last quarter","SUPPORTED","","supported",null,"sales:lineAmount|product|up|like_for_like|current_quarter"],
  ["point/productGroup","Which product groups grew this month vs last month?","DECISION","no sales/purchase word: default entity is a product decision (G2)","needs_planner","entity_ambiguous",null],
  ["point/productGroup","Which product groups declined this month vs last month?","DECISION","","needs_planner","entity_ambiguous",null],
  ["point/productGroup","Which product groups grew this quarter compared to last quarter?","DECISION","","needs_planner","entity_ambiguous",null],
  ["point/productGroup","Which product groups grew this month compared to the same month last year?","DECISION","","needs_planner","entity_ambiguous",null],
  ["point/productGroup","Which product groups increased their sales this month vs last month?","SUPPORTED","","supported",null,"sales:lineAmount|productGroup|up|full_previous|current_month"],
  ["point/productGroup","Which product groups had lower sales this month than last month?","SUPPORTED","","supported",null,"sales:lineAmount|productGroup|down|full_previous|current_month"],
  ["point/productGroup","categories whose sales dropped vs last month","SUPPORTED","","supported",null,"sales:lineAmount|productGroup|down|full_previous|current_month"],
  ["point/productGroup","stock groups with higher sales this quarter than last quarter","SUPPORTED","","supported",null,"sales:lineAmount|productGroup|up|like_for_like|current_quarter"],
  ["point/supplier","Which suppliers grew this month vs last month?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|up|full_previous|current_month"],
  ["point/supplier","Which suppliers declined this month vs last month?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|down|full_previous|current_month"],
  ["point/supplier","Which suppliers grew this quarter compared to last quarter?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|up|like_for_like|current_quarter"],
  ["point/supplier","Which suppliers grew this month compared to the same month last year?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|up|same_period_last_year|current_month"],
  ["point/supplier","Which suppliers increased their purchases this month vs last month?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|up|full_previous|current_month"],
  ["point/supplier","Which suppliers had lower purchases this month than last month?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|down|full_previous|current_month"],
  ["point/supplier","vendors whose purchases dropped vs last month","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|down|full_previous|current_month"],
  ["point/supplier","vendors with higher purchases this quarter than last quarter","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|up|like_for_like|current_quarter"],
  ["point/customer","Which customers are doing better than last month?","SUPPORTED","better = up, vs last month = current month vs previous","needs_planner","vague_performance",null],
  ["point/customer","Which customers are doing worse than last month?","SUPPORTED","","needs_planner","vague_performance",null],
  ["point/customer","Which customers improved this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["point/customer","Which customers fell this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|down|full_previous|current_month"],
  ["point/customer","Which customers grew more than last month?","SUPPORTED","'grew more than last month' = grew vs last month","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["point/customer","Which customers bought more this month than last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["point/customer","Who bought less this month than last month?","SUPPORTED","'who' = customers","supported",null,"sales:invoiceAmount|customer|down|full_previous|current_month"],
  ["point/product","Which products sold more this month than last month?","SUPPORTED","'sold' says sales","supported",null,"sales:lineAmount|product|up|full_previous|current_month"],
  ["point/product","Which items sold less this quarter than last quarter?","SUPPORTED","","supported",null,"sales:lineAmount|product|down|like_for_like|current_quarter"],
  ["point/voucherType","Sales by voucher type this month vs last month","SUPPORTED","voucherType breakdown with comparison","supported",null,"sales:invoiceAmount|voucherType|-|full_previous|current_month"],
  ["point/voucherType","Which voucher types grew this month vs last month?","DECISION","no sales/purchase word","needs_planner","entity_ambiguous",null],
  ["no_period","Who is growing?","CLARIFY","no period stated","needs_planner","who_ambiguous",null],
  ["no_period","Who is declining?","CLARIFY","no period stated","needs_planner","who_ambiguous",null],
  ["no_period","Which customers are growing?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which customers grew the most?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which customers increased the most?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which products are declining?","CLARIFY","no period stated","needs_planner","entity_ambiguous",null],
  ["no_period","Which suppliers are growing?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which customers lost the most business?","CLARIFY","no period stated","needs_planner","ambiguous_metric",null],
  ["no_period","Who grew the most compared with last year?","CLARIFY","no period stated","needs_planner","who_ambiguous",null],
  ["no_period","Which customers are growing year over year?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Top 10 customers by growth","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Biggest decline by customer","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which customers improved?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which customers fell?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["no_period","Which customers grew by more than 20%?","CLARIFY","no period stated","needs_planner","period_missing",null],
  ["abs_rank","Which customers grew the most this month vs last month?","SUPPORTED","ranked by absolute change","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["abs_rank","Which customers increased the most this quarter vs last quarter?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|like_for_like|current_quarter"],
  ["abs_rank","Top 10 customers by growth this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["abs_rank","Biggest increase in sales by customer this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["abs_rank","Which customers lost the most business this month vs last month?","SUPPORTED","biggest decline (absolute)","needs_planner","ambiguous_metric",null],
  ["abs_rank","Which customers declined the most this quarter vs last quarter?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|down|like_for_like|current_quarter"],
  ["abs_rank","Largest drop in sales by customer this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|down|full_previous|current_month"],
  ["abs_rank","Which products increased the most in sales this month vs last month?","SUPPORTED","","supported",null,"sales:lineAmount|product|up|full_previous|current_month"],
  ["abs_rank","Which suppliers did we buy more from this quarter vs last quarter?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|up|like_for_like|current_quarter"],
  ["pct_threshold","Which customers grew by more than 20% this month vs last month?","SUPPORTED","% change > 20; no-previous customers excluded (null %)","supported",null,"sales:invoiceAmount|customer|pct>20|full_previous|current_month"],
  ["pct_threshold","Which customers grew more than 20 percent this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|pct>20|full_previous|current_month"],
  ["pct_threshold","Customers whose sales fell by more than 10% this quarter vs last quarter","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|pct<-10|like_for_like|current_quarter"],
  ["pct_threshold","Which products grew over 50% this month vs last month in sales?","SUPPORTED","","supported",null,"sales:lineAmount|product|pct>50|full_previous|current_month"],
  ["pct_rank","Which customers grew fastest this month vs last month?","UNSUPPORTED","rate ranking needs a zero-baseline product rule","unsupported","unsupported_growth_rate",null],
  ["pct_rank","Top 10 fastest-growing customers this quarter vs last quarter","UNSUPPORTED","","unsupported","unsupported_growth_rate",null],
  ["pct_rank","Which customers have the highest growth percentage this month vs last month?","UNSUPPORTED","","unsupported","unsupported_growth_rate",null],
  ["pct_rank","Which products are declining fastest this month vs last month?","UNSUPPORTED","","unsupported","unsupported_growth_rate",null],
  ["pct_rank","Largest percentage decline by customer this month vs last month","UNSUPPORTED","","unsupported","unsupported_growth_rate",null],
  ["pct_rank","Sales growth percentage this month vs last month","SUPPORTED","a TOTAL's % change is shown by every comparison answer - only % RANKING is undefined","supported",null,"sales:invoiceAmount|total|-|full_previous|current_month"],
  ["pct_rank","What is the percentage change in revenue this quarter vs last quarter?","SUPPORTED","same: totals carry % change","supported",null,"sales:lineAmount|total|-|like_for_like|current_quarter"],
  ["new_lost","Who became a new customer this month?","SUPPORTED","new = Tally ledger created in the period (LedgerMaster)","supported",null,"sales:invoiceAmount|customer|-|none|current_month"],
  ["new_lost","New customers this month vs last month","SUPPORTED","new in this month; comparison dropped","supported",null,"sales:invoiceAmount|customer|-|none|current_month"],
  ["new_lost","Which customers are new this quarter?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|-|none|current_quarter"],
  ["new_lost","Who stopped buying this month vs last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|lost|full_previous|current_month"],
  ["new_lost","Which customers stopped buying this quarter?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|lost|like_for_like|current_quarter"],
  ["new_lost","Customers we lost this quarter vs last quarter","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|lost|like_for_like|current_quarter"],
  ["new_lost","Which products stopped selling this month vs last month?","SUPPORTED","","supported",null,"sales:lineAmount|product|lost|full_previous|current_month"],
  ["new_lost","Which suppliers did we stop buying from this quarter?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|lost|like_for_like|current_quarter"],
  ["new_lost","First time customers this month","UNSUPPORTED","first-EVER needs full history","unsupported","unsupported_first_purchase",null],
  ["new_lost","Which customers came back this month after being inactive?","UNSUPPORTED","reactivation needs >2 periods","unsupported","unsupported_reactivation",null],
  ["new_lost","Reactivated customers this quarter","UNSUPPORTED","","unsupported","unsupported_reactivation",null],
  ["every_period","Which customers grew consistently?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Which customers grew every month?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Which customers grew every quarter?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Which customers grew in every month this year?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Which customers have been growing steadily?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Customers with 3 months of growth in a row","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Which products keep growing?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Monthly sales growth this fy","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["every_period","Month on month growth by customer this fy","UNSUPPORTED","one comparison per plan; no per-bucket comparison","needs_planner","comparison_periods_not_aligned",null],
  ["every_period","Which customers grew each month this quarter?","UNSUPPORTED","one comparison per plan; no per-bucket comparison","unsupported","unsupported_growth_pattern",null],
  ["rolling","Which customers have been growing over the last 6 months?","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Which customers grew over the last 3 months?","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Which customers grew over the last 12 months?","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Sales growth over the last 6 months","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Which products declined over the past 6 months?","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Rolling 6 month sales by customer","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Customer growth trailing 12 months","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","TTM revenue","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Which customers grew over the past year?","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","ambiguous_period",null],
  ["rolling","Sales in the last 6 months","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Previous 6 months sales","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Revenue for the last 12 months","CLARIFY","rolling windows beyond 90 days: meaning/period undefined","needs_planner","unsupported_window",null],
  ["rolling","Which customers grew in the last 90 days?","SUPPORTED","system-defined: vs the preceding 90 days (disclose it)","supported",null,"sales:invoiceAmount|customer|up|like_for_like|last_90_days"],
  ["rolling","Sales in the last 30 days vs the previous 30 days","SUPPORTED","explicit equal windows","needs_planner","comparison_periods_not_aligned",null],
  ["rolling","Last 7 days sales","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|last_7_days"],
  ["range","Which customers have grown from April to September?","CLARIFY","year missing","needs_planner","year_missing",null],
  ["range","Which customers grew from April 2025 to September 2025?","CLARIFY","growth ACROSS a range: first vs last month? range vs previous range? - undefined","needs_planner","two_periods_without_comparison",null],
  ["range","Sales from April 2025 to September 2025","SUPPORTED","one explicit range: Apr 1 - Sep 30 2025","needs_planner","two_periods_without_comparison",null],
  ["range","Sales April 2025 vs April 2024","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|vs 2024-04-01..2024-04-30|2025-04-01..2025-04-30"],
  ["range","Which customers grew in August 2025 vs July 2025?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|vs 2025-07-01..2025-07-31|2025-08-01..2025-08-31"],
  ["range","Sales between 2025-04-01 and 2025-06-30","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|2025-04-01..2025-06-30"],
  ["range","Sales from 2025-01-01 to 2025-03-31 vs 2024-01-01 to 2024-03-31","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|vs 2024-01-01..2024-03-31|2025-01-01..2025-03-31"],
  ["period","Sales today vs yesterday","SUPPORTED","today like-for-like = yesterday (whole day)","needs_planner","comparison_periods_not_aligned",null],
  ["period","Sales yesterday vs the day before","SUPPORTED","yesterday like-for-like = the day before","needs_planner","comparison_periods_not_aligned",null],
  ["period","Sales this week vs last week","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_week"],
  ["period","Sales this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|full_previous|current_month"],
  ["period","Sales last month vs the month before","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|previous_month"],
  ["period","Sales this quarter vs last quarter","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_quarter"],
  ["period","Sales this FY vs previous FY","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_fy"],
  ["period","Sales this financial year vs last financial year","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_fy"],
  ["period","Sales YTD vs YTD last year","CLARIFY","YTD: calendar or financial year?","needs_planner","ambiguous_period",null],
  ["period","Sales this year vs last year","CLARIFY","calendar or financial year","needs_planner","ambiguous_period",null],
  ["period","Sales current year vs previous year","CLARIFY","","needs_planner","ambiguous_period",null],
  ["period","Sales year to date","CLARIFY","","needs_planner","ambiguous_period",null],
  ["period","Sales financial year to date","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|current_fy"],
  ["period","Sales FYTD vs last FY","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_fy"],
  ["period","Sales MTD vs LMTD","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_month"],
  ["period","Sales in Q1","CLARIFY","FY vs calendar quarter","needs_planner","period_label_unsupported",null],
  ["period","Sales Q2 2025","CLARIFY","","needs_planner","period_label_unsupported",null],
  ["period","Sales in the first quarter","CLARIFY","","needs_planner","period_label_unsupported",null],
  ["period","Sales H1","CLARIFY","","needs_planner","period_label_unsupported",null],
  ["period","Sales first half","CLARIFY","","needs_planner","period_label_unsupported",null],
  ["period","Sales two months ago","CLARIFY","no offset period in the DSL; name the month","needs_planner","relative_offset_unsupported",null],
  ["period","Sales three months ago","CLARIFY","","needs_planner","relative_offset_unsupported",null],
  ["period","Sales the month before last","CLARIFY","","needs_planner","relative_offset_unsupported",null],
  ["period","Sales this month vs same period last year","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|same_period_last_year|current_month"],
  ["period","Sales this quarter vs the corresponding period last year","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|same_period_last_year|current_quarter"],
  ["period","Sales last 7 days","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|last_7_days"],
  ["period","Sales last 30 days","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|last_30_days"],
  ["period","Sales last 90 days","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|last_90_days"],
  ["period","Sales last 6 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["period","Sales last 12 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["period","Sales rolling 6 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["period","Sales trailing 12 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["period","Sales TTM","CLARIFY","","needs_planner","unsupported_window",null],
  ["period","Sales this month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|current_month"],
  ["period","Sales for April","CLARIFY","year missing","needs_planner","year_missing",null],
  ["period","Sales for April 2025","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|none|2025-04-01..2025-04-30"],
  ["totals/sales","Sales growth this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|full_previous|current_month"],
  ["totals/sales","Sales increase this quarter vs last quarter","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_quarter"],
  ["totals/sales","Sales decline this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|full_previous|current_month"],
  ["totals/sales","Sales change vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|full_previous|current_month"],
  ["totals/sales","Sales variance vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|full_previous|current_month"],
  ["totals/sales","Sales vs last year this month","SUPPORTED","","supported",null,"sales:invoiceAmount|total|-|same_period_last_year|current_month"],
  ["totals/sales","Sales growth percentage this quarter vs last quarter","SUPPORTED","total % change is part of every comparison answer","supported",null,"sales:invoiceAmount|total|-|like_for_like|current_quarter"],
  ["totals/sales","Sales over the last 6 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["totals/sales","Monthly sales growth this fy","UNSUPPORTED","","unsupported","unsupported_growth_pattern",null],
  ["totals/sales","Sales growth","CLARIFY","no period","needs_planner","period_missing",null],
  ["totals/purchase","Purchases growth this month vs last month","SUPPORTED","","supported",null,"purchase:purchaseAmount|total|-|full_previous|current_month"],
  ["totals/purchase","Purchases increase this quarter vs last quarter","SUPPORTED","","supported",null,"purchase:purchaseAmount|total|-|like_for_like|current_quarter"],
  ["totals/purchase","Purchases decline this month vs last month","SUPPORTED","","supported",null,"purchase:purchaseAmount|total|-|full_previous|current_month"],
  ["totals/purchase","Purchases change vs last month","SUPPORTED","","supported",null,"purchase:purchaseAmount|total|-|full_previous|current_month"],
  ["totals/purchase","Purchases variance vs last month","SUPPORTED","","supported",null,"purchase:purchaseAmount|total|-|full_previous|current_month"],
  ["totals/purchase","Purchases vs last year this month","SUPPORTED","","supported",null,"purchase:purchaseAmount|total|-|same_period_last_year|current_month"],
  ["totals/purchase","Purchases growth percentage this quarter vs last quarter","SUPPORTED","total % change is part of every comparison answer","supported",null,"purchase:purchaseAmount|total|-|like_for_like|current_quarter"],
  ["totals/purchase","Purchases over the last 6 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["totals/purchase","Monthly purchases growth this fy","UNSUPPORTED","","unsupported","unsupported_growth_pattern",null],
  ["totals/purchase","Purchases growth","CLARIFY","no period","needs_planner","period_missing",null],
  ["totals/revenue","Revenue growth this month vs last month","SUPPORTED","","supported",null,"sales:lineAmount|total|-|full_previous|current_month"],
  ["totals/revenue","Revenue increase this quarter vs last quarter","SUPPORTED","","supported",null,"sales:lineAmount|total|-|like_for_like|current_quarter"],
  ["totals/revenue","Revenue decline this month vs last month","SUPPORTED","","supported",null,"sales:lineAmount|total|-|full_previous|current_month"],
  ["totals/revenue","Revenue change vs last month","SUPPORTED","","supported",null,"sales:lineAmount|total|-|full_previous|current_month"],
  ["totals/revenue","Revenue variance vs last month","SUPPORTED","","supported",null,"sales:lineAmount|total|-|full_previous|current_month"],
  ["totals/revenue","Revenue vs last year this month","SUPPORTED","","supported",null,"sales:lineAmount|total|-|same_period_last_year|current_month"],
  ["totals/revenue","Revenue growth percentage this quarter vs last quarter","SUPPORTED","total % change is part of every comparison answer","supported",null,"sales:lineAmount|total|-|like_for_like|current_quarter"],
  ["totals/revenue","Revenue over the last 6 months","CLARIFY","","needs_planner","unsupported_window",null],
  ["totals/revenue","Monthly revenue growth this fy","UNSUPPORTED","","unsupported","unsupported_growth_pattern",null],
  ["totals/revenue","Revenue growth","CLARIFY","no period","needs_planner","period_missing",null],
  ["multi_compare","Which customers grew MoM and YoY?","UNSUPPORTED","one comparison per plan","unsupported","unsupported_combination",null],
  ["multi_compare","Which customers declined MoM but grew YoY?","UNSUPPORTED","one comparison per plan","unsupported","unsupported_combination",null],
  ["multi_compare","Sales this month vs last month and vs last year","UNSUPPORTED","one comparison per plan","unsupported","unsupported_combination",null],
  ["multi_compare","Which customers grew this month and also last month?","UNSUPPORTED","one comparison per plan","needs_planner","two_periods_without_comparison",null],
  ["phrasing","Could you please tell me which customers grew this month compared to last month?","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","Hi, which of my clients grew this month vs last month? Thanks","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","customers grew this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","customer growth this month vs last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","MoM customer growth this month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","customers mom this month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|-|full_previous|current_month"],
  ["phrasing","yoy growth customers this month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|same_period_last_year|current_month"],
  ["phrasing","this month vs last month customer sales growth","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","I want to know which of our customers bought more from us this month compared with what they bought last month","SUPPORTED","","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","pls show custmers growth this month vs last month","CLARIFY","typo in the dimension noun: must not be guessed as a name","needs_planner","entity_not_resolved",null],
  ["phrasing","which customers grwoth this month vs last month","CLARIFY","typo in the growth word","needs_planner","entity_not_resolved",null],
  ["phrasing","Which customer grew this month vs last month?","SUPPORTED","singular noun","supported",null,"sales:invoiceAmount|customer|up|full_previous|current_month"],
  ["phrasing","Which SKUs grew in sales this month vs last month?","SUPPORTED","","supported",null,"sales:lineAmount|product|up|full_previous|current_month"],
  ["phrasing","Which vendors did we buy less from this month vs last month?","SUPPORTED","","supported",null,"purchase:purchaseAmount|supplier|down|full_previous|current_month"],
  ["phrasing","growth?","CLARIFY","","needs_planner","entity_ambiguous",null],
  ["phrasing","customers up or down this month vs last month","SUPPORTED","the comparison itself (both directions)","needs_planner","conflicting_intents",null],
];
// Supported plans that answered a DIFFERENT question than the user asked (found by the audit's review of every supported
// plan). P-SF fixed it; the map now holds the CORRECT reading each must produce.
const SILENT_MISREADS = {
  "Who bought less this month than last month?": "sales:invoiceAmount|customer|down|full_previous|current_month",
};

(async () => {
  // =============================================================== A
  section("A. architecture facts: ONE tenant reference date per turn (the audit found three; fixed by P-SF)");
  {
    const system = getPlannerPrompt().system.map((b) => b.text).join("\n");
    check("planner: its prompt carries no date / reference date (relative wording can only become SYMBOLIC periods; the date never reaches Claude)", !/reference date|today is|current date|20\d\d-\d\d-\d\d/i.test(system));
    const qc = fs.readFileSync(require.resolve("./src/services/query/queryChat.js"), "utf8");
    check("P-SF: queryChat reads the turn's date context ONCE and hands the SAME referenceDate to the router, planner validation and executor", /const dc = await turnDates\(\);/.test(qc) && /routeQuestion\(userMessage, \{ resolveEntity, entityIndex, referenceDate \}\)/.test(qc) && /planQuestion\(userMessage, \{[^}]*routerCode: route\.code, referenceDate \}\)/.test(qc) && /exec\(plan, \{ tenantId, referenceDate \}, timing\)/.test(qc));
    const { buildDateContext } = require("./src/services/analytics/referenceDate");
    const d = (y, m, dd) => new Date(Date.UTC(y, m - 1, dd));
    const dc = buildDateContext({ sales: { earliest: d(2025, 4, 1), latest: d(2025, 12, 8) }, purchase: { earliest: d(2025, 3, 15), latest: d(2025, 12, 10) } }, new Date(2026, 8, 28, 12));
    const none = buildDateContext({ sales: {}, purchase: {} }, new Date(2026, 8, 28, 12));
    // Decision 1 (2026-09-28): the reference date is TODAY (end of the local day), never the latest voucher
    check("reference date = today (decision 1), not the latest voucher; synced window starts at the earlier first voucher; no vouchers -> no window", dc.referenceDate.getTime() === new Date(2026, 8, 28, 23, 59, 59, 999).getTime() && dc.source === "today" && dc.coverage.earliest.getTime() === d(2025, 3, 15).getTime() && none.coverage.earliest === null && none.coverage.latest === null);
    const orch = fs.readFileSync(require.resolve("./src/services/ai/chatOrchestrator.js"), "utf8");
    check("P-SF: legacy chat prompt date = the turn's tenant reference date (no wall-clock default left)", /buildSystemPromptBlocks\(dates\.referenceDate\)/.test(orch) && !/buildSystemPromptBlocks\(referenceDate = new Date\(\)\)/.test(orch));
    const lag = new Date(2025, 11, 8, 0, 0); // a tenant whose sync ends 8 Dec 2025
    const engineMonth = periodEngine.resolvePeriod("current_month", lag);
    const legacyMonth = tools.resolvePeriod({ period: "current_month" }, lag);
    let refused = false;
    try {
      tools.resolvePeriod({ period: "current_month" });
    } catch (e) {
      refused = true;
    }
    check(`P-SF: legacy tools resolve "this month" from the SAME tenant date as the engine (${ymdLocal(legacyMonth.from)}); without it they refuse instead of using the wall clock`, ymdLocal(engineMonth.from) === "2025-12-01" && legacyMonth.from.getTime() === engineMonth.from.getTime() && legacyMonth.to.getTime() === engineMonth.to.getTime() && refused);
    const v = validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [] }, {});
    check("relative periods become absolute dates ONLY in the validator, with the tenant reference date (refused without it)", !v.ok && v.errors.some((e) => e.code === "reference_date_required"));
  }

  // =============================================================== B
  section(`B. realistic corpus (${CORPUS.length} questions): current behaviour vs target behaviour`);
  const stats = { now: {}, target: {}, gaps: [], leaks: [], silent: [], snapshotDrift: [] };
  {
    for (const [family, q, target, , status, code, signature] of CORPUS) {
      lookups.length = 0;
      const x = await routeQuestion(q, { resolveEntity: spy, entityIndex: resolver.spanIndex, referenceDate: REF });
      const got = `${x.status}/${x.code || ""}|${x.plan ? sem(x.plan) : ""}`;
      if (got !== `${status}/${code || ""}|${signature || ""}`) stats.snapshotDrift.push(`${q}: ${got}`);
      const now = classOf(x.status, x.code);
      stats.now[now] = (stats.now[now] || 0) + 1;
      stats.target[target] = (stats.target[target] || 0) + 1;
      if (now !== target) stats.gaps.push({ family, q, target, now, code: x.code || "" });
      if (lookups.length) stats.leaks.push(`${q} -> looked up "${lookups[0]}"`);
      if (SILENT_MISREADS[q] && !(x.plan && sem(x.plan) === SILENT_MISREADS[q])) stats.silent.push(`${q}: answers ${x.plan ? sem(x.plan) : x.code}, user means ${SILENT_MISREADS[q]}`);
    }
    check(`all ${CORPUS.length} questions route exactly as documented (status, code and the semantic signature of every plan)`, stats.snapshotDrift.length === 0, stats.snapshotDrift.slice(0, 4).join(" | "));
    console.log(`    now:    ${JSON.stringify(stats.now)}`);
    console.log(`    target: ${JSON.stringify(stats.target)}`);
    const silentlyWrongClass = stats.gaps.filter((g) => g.now === "SUPPORTED");
    check("no question whose correct answer is a clarification/refusal is silently answered with a plan", silentlyWrongClass.length === 0, silentlyWrongClass.map((g) => g.q).join(" | "));
    check(`the audit's silent misread(s) now answer the question the user asked (${Object.keys(SILENT_MISREADS).length}); still misread: ${stats.silent.length}`, stats.silent.length === 0);
    for (const s of stats.silent) console.log(`      SILENT MISREAD: ${s}`);
    console.log(`    gaps between current and target behaviour: ${stats.gaps.length}`);
    for (const g of stats.gaps) console.log(`      [${g.family}] ${g.now} (${g.code}) -> should be ${g.target}: ${g.q}`);
    console.log(`    grammar/filler words looked up as a customer/product NAME: ${stats.leaks.length}`);
    for (const l of stats.leaks) console.log(`      ${l}`);
    check("name-lookup leaks: only 2 misspellings remain (the audit had 8: synonyms, 'doing better', 'became', typos, 'reactivated')", stats.leaks.length === 2 && stats.leaks.every((l) => /custmers|grwoth/.test(l)), String(stats.leaks.length));
    const revenue = CORPUS.filter(([, q, , , s, , sig]) => s === "supported" && /\brevenue\b/i.test(q));
    check(`revenue questions (${revenue.length}) all use the pre-tax line basis (P0-2 unchanged)`, revenue.every((r) => /^sales:lineAmount\|/.test(r[6])));
    const purch = CORPUS.filter(([, q, , , s, , sig]) => s === "supported" && /\bpurchases?\b|\bsuppliers?\b|\bvendors?\b/i.test(q));
    check(`purchase/supplier questions (${purch.length}) all use purchase metrics`, purch.every((r) => /^purchase:purchaseAmount\|/.test(r[6])));
  }

  // =============================================================== C
  section("C. conversational follow-ups through the real chat path (fakes: no Claude, no DB)");
  {
    const conversations = [
      ["Which customers grew this month?", "Show me the top 10.", "Now compare them with last year.", "What about products?", "Only those above 20%."],
      ["How did sales perform last month?", "Compared with the month before?", "What about this month?", "Which customers drove the increase?"],
      ["Sales this month vs last month", "and by customer?", "only the ones that declined", "what about last quarter"],
      ["Top 5 customers this month", "same for last month", "compare the two"],
      ["Which products grew in sales this quarter vs last quarter?", "and customers?", "by more than 20%"],
    ];
    const okResult = (plan) => ({ ok: true, entity: plan.entity, mode: plan.mode, period: { kind: plan.period.kind, label: plan.period.kind, isPartial: false }, comparison: null, metrics: plan.metrics || [], groupBy: plan.groupBy || [], amountBasis: {}, rows: [], totals: { values: {} }, truncated: false, rowLimit: 10, warnings: [], assumptions: [] });
    const fresh = async () => ({ state: "fresh", dataAsOf: new Date(), message: "ok" });
    let followUps = 0;
    let legacy = 0;
    let lost = 0;
    let claude = 0;
    const lostCases = [];
    const trace = [];
    for (const turns of conversations) {
      const history = [];
      let prevPlan = null;
      let prevOut = null;
      for (const q of turns) {
        let planned = null;
        // P-SF: exactly what the controller does - the previous ENGINE answer's stored query context rides along
        const out = await tryAnswerWithQueryEngine({
          context: { tenantId: "AUDIT-TENANT" }, userMessage: q, conversationHistory: [...history], previousQuery: prevOut && prevOut.queryContext ? prevOut.queryContext : null,
          deps: { resolveEntity: resolver, getFreshness: fresh, plannerClient: async () => { claude += 1; throw new Error("no Claude"); }, execute: async (plan) => ((planned = plan), { result: okResult(plan), cache: { status: "miss" } }) },
        });
        if (history.length) {
          followUps += 1;
          if (!out.handled) legacy += 1;
          else if (planned && prevPlan && (planned.period.kind !== prevPlan.period.kind || !!planned.compare !== !!prevPlan.compare)) {
            lost += 1;
            lostCases.push(`"${q}" after "${history[history.length - 2].content}" -> ${sem(planned)}`);
          }
        }
        trace.push(`${history.length ? "  -> " : ""}${q} => ${!out.handled ? "LEGACY" : planned ? sem(planned) : `${out.structured.details.queryEngine.status}/${out.structured.details.queryEngine.code || ""}`}`);
        if (planned) prevPlan = planned;
        prevOut = out;
        history.push({ role: "user", content: q }, { role: "assistant", content: out.handled ? out.structured.answer : "(legacy)" });
      }
    }
    for (const t of trace) console.log(`      ${t}`);
    console.log(`    follow-ups: ${followUps}; sent to legacy chat: ${legacy}; answered standalone with the context silently dropped: ${lost}`);
    void lostCases;
    // P-SF: the audit found 12/14 follow-ups sent to legacy chat and 2 answered with their context silently dropped.
    // Each turn's meaning is now asserted: what was kept from the previous question and what the follow-up changed.
    // decision 2 (2026-09-28): month turns compare with the complete previous month
    const EXPECTED = [
      "Which customers grew this month? => sales:invoiceAmount|customer|up|full_previous|current_month",
      "  -> Show me the top 10. => sales:invoiceAmount|customer|up|full_previous|current_month",
      "  -> Now compare them with last year. => sales:invoiceAmount|customer|up|same_period_last_year|current_month",
      "  -> What about products? => sales:lineAmount|product|up|same_period_last_year|current_month",
      "  -> Only those above 20%. => sales:lineAmount|product|pct>20|same_period_last_year|current_month",
      "How did sales perform last month? => sales:invoiceAmount|total|-|none|previous_month",
      "  -> Compared with the month before? => sales:invoiceAmount|total|-|like_for_like|previous_month",
      "  -> What about this month? => sales:invoiceAmount|total|-|full_previous|current_month",
      "  -> Which customers drove the increase? => sales:invoiceAmount|customer|up|full_previous|current_month",
      "Sales this month vs last month => sales:invoiceAmount|total|-|full_previous|current_month",
      "  -> and by customer? => sales:invoiceAmount|customer|-|full_previous|current_month",
      "  -> only the ones that declined => sales:invoiceAmount|customer|down|full_previous|current_month",
      "  -> what about last quarter => sales:invoiceAmount|customer|down|like_for_like|previous_quarter",
      "Top 5 customers this month => sales:invoiceAmount|customer|-|none|current_month",
      "  -> same for last month => sales:invoiceAmount|customer|-|none|previous_month",
      // "the two" names two earlier periods: no structured reading exists, so the history-aware legacy chat answers
      // (tenant-anchored since P-SF) - never a stand-alone guess
      "  -> compare the two => LEGACY",
      "Which products grew in sales this quarter vs last quarter? => sales:lineAmount|product|up|like_for_like|current_quarter",
      "  -> and customers? => sales:invoiceAmount|customer|up|like_for_like|current_quarter",
      "  -> by more than 20% => sales:invoiceAmount|customer|pct>20|like_for_like|current_quarter",
    ];
    const wrong = trace.filter((t, i) => t !== EXPECTED[i]);
    check("P-SF: every follow-up keeps the previous question's measure/period/comparison and changes only what it names (13 of 14 structured, 1 to history-aware legacy chat, no planner call)", wrong.length === 0 && trace.length === EXPECTED.length && followUps === 14 && legacy === 1 && claude === 0, wrong.slice(0, 3).join(" | "));
  }

  // =============================================================== D
  section("D. semantic sweeps (pure): what 'like-for-like' and 'new/lost' actually compare");
  {
    const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
    let monthEnd = 0;
    const truncated = [];
    let quarterEndTrunc = [];
    for (let y = 2024; y <= 2026; y += 1) for (let m = 0; m < 12; m += 1) {
      const ref = new Date(y, m, daysIn(y, m), 12);
      monthEnd += 1;
      const lfl = periodEngine.resolveComparisonPeriod("current_month", ref);
      const full = periodEngine.resolvePeriod("previous_month", ref);
      const cur = periodEngine.resolvePeriod("current_month", ref);
      if (!cur.isPartial && ymdLocal(lfl.to) !== ymdLocal(full.to)) truncated.push(`${ymdLocal(ref)} (vs ${ymdLocal(lfl.from)}..${ymdLocal(lfl.to)})`);
      if ([2, 5, 8, 11].includes(m)) {
        const q = periodEngine.resolveComparisonPeriod("current_quarter", ref);
        const pq = periodEngine.resolvePeriod("previous_quarter", ref);
        if (ymdLocal(q.to) !== ymdLocal(pq.to)) quarterEndTrunc.push(`${ymdLocal(ref)} (vs ${ymdLocal(q.from)}..${ymdLocal(q.to)})`);
      }
    }
    console.log(`    on a month's LAST day the month is complete, yet like-for-like drops the previous month's extra days: ${truncated.length}/${monthEnd} month-ends 2024-2026`);
    console.log(`      e.g. ${truncated.slice(0, 4).join(", ")}`);
    console.log(`    same at quarter end: ${quarterEndTrunc.join(", ")}`);
    check("documented: complete month vs TRUNCATED previous month on 15 of 36 month-ends (Feb/Apr/Jun/Sep/Nov ends); quarter end on 30 Jun", truncated.length === 15 && quarterEndTrunc.length === 3 && quarterEndTrunc.every((s) => /-06-30/.test(s)), `${truncated.length} / ${quarterEndTrunc.length}`);
    const n = validateQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_quarter" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], compare: { mode: "like_for_like" }, having: [{ metric: "invoiceAmount.previous", op: "eq", value: 0 }, { metric: "invoiceAmount", op: "gt", value: 0 }] }, { referenceDate: new Date(2026, 8, 18, 12) }).normalized;
    check(`"new customers this quarter" (18 Sep) = no purchase in ${ymdLocal(n.comparison.from)}..${ymdLocal(n.comparison.to)} only - a customer who bought on 25 Jun counts as NEW`, ymdLocal(n.comparison.from) === "2026-04-01" && ymdLocal(n.comparison.to) === "2026-06-18");
  }

  // =============================================================== E + F
  section("E. synthetic tenant: engine vs an INDEPENDENT oracle across calendar boundaries");
  await engineVsOracle();

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

// ================================================================ E / F implementation
// Synthetic data is generated IN MEMORY; the oracle sums that array with its own calendar arithmetic. Nothing is shared
// with dateRanges / periodEngine / compile / execute.
const T = "verify-growth-audit-tenant";
const T_EMPTY = "verify-growth-audit-empty";
const T_ONE = "verify-growth-audit-one";

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m 0-based
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addMonth = (y, m, k) => { const t = y * 12 + m + k; return [Math.floor(t / 12), ((t % 12) + 12) % 12]; };
const addDays = (s, k) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const r2 = (v) => Math.round(v * 100) / 100;

function buildData() {
  const sales = [];
  const purchases = [];
  let seq = 0;
  const v = (list, date, party, total, lines) => {
    seq += 1;
    list.push({ date, party, total: r2(total), lines: lines.map(([item, qty, amt]) => [item, qty, r2(amt)]), no: `GA-${seq}` });
  };
  const pre = (t) => t / 1.18; // pre-tax item value of a tax-inclusive total
  for (let i = 0; i < 26; i += 1) {
    const [y, m] = addMonth(2024, 0, i); // Jan 2024 .. Feb 2026
    const last = daysIn(y, m);
    v(sales, ymd(y, m, 5), "Grower Co", 1000 + 100 * i, [["Item A", 2, pre(1000 + 100 * i) * 0.6], ["Item C", 1, pre(1000 + 100 * i) * 0.4]]);
    v(sales, ymd(y, m, 20), "Grower Co", 500 + 50 * i, [["Item B", 1, pre(500 + 50 * i)]]);
    v(sales, ymd(y, m, 10), "Decliner Co", Math.max(200, 5000 - 120 * i), [["Item B", 3, pre(Math.max(200, 5000 - 120 * i))]]);
    v(sales, ymd(y, m, 15), "Flat Co", 2000, [["Item A", 4, pre(2000)]]);
    v(sales, ymd(y, m, 1), "Boundary Co", 300, [["Item C", 1, pre(300)]]); // first day of every month
    v(sales, ymd(y, m, last), "Boundary Co", 700, [["Item C", 2, pre(700)]]); // last day (incl. 29 Feb 2024, 31 Mar, 31 Dec)
    if (m % 2 === 0) v(sales, ymd(y, m, 12), "Seasonal Co", 900, [["Item D", 1, pre(900)]]); // Jan, Mar, May, ... (new/lost churn)
    if (y * 12 + m >= 2025 * 12 + 5) v(sales, ymd(y, m, 25), "Latecomer Co", 1500 + 10 * i, [["Item A", 1, pre(1500 + 10 * i)]]); // from Jun 2025
    if (y === 2024) v(sales, ymd(y, m, 8), "Gone Co", 800, [["Item B", 1, pre(800)]]); // lost from Jan 2025
    if ((y === 2024 && m <= 2) || y * 12 + m >= 2025 * 12 + 8) v(sales, ymd(y, m, 18), "Returner Co", 1200, [["Item D", 2, pre(1200)]]); // reactivated Sep 2025
    v(purchases, ymd(y, m, 3), "Supply North", 3000 + 75 * i, [["Item A", 10, pre(3000 + 75 * i)]]);
    if (m % 3 !== 1) v(purchases, ymd(y, m, 28), "Supply South", 1800, [["Item B", 6, pre(1800)]]);
  }
  return { sales, purchases };
}
const GROUP = { "Item A": "Group One", "Item B": "Group One", "Item C": "Group Two", "Item D": "Group Two" };

// oracle periods (plain calendar arithmetic on [y, m, d])
function ranges(kind, [y, m, d]) {
  const clamp = (yy, mm, dd) => ymd(yy, mm, Math.min(dd, daysIn(yy, mm)));
  const [py, pm] = addMonth(y, m, -1);
  const [p2y, p2m] = addMonth(y, m, -2);
  const qs = m - (m % 3);
  const [pqy, pqm] = addMonth(y, qs, -3);
  const [lqy, lqm] = addMonth(y, m, -3);
  const fyStart = m >= 3 ? y : y - 1;
  const cur = (from, to) => ({ from, to });
  switch (kind) {
    case "month_lfl": return [cur(ymd(y, m, 1), ymd(y, m, d)), cur(ymd(py, pm, 1), clamp(py, pm, d))];
    case "month_full": return [cur(ymd(y, m, 1), ymd(y, m, d)), cur(ymd(py, pm, 1), ymd(py, pm, daysIn(py, pm)))];
    case "month_sply": return [cur(ymd(y, m, 1), ymd(y, m, d)), cur(ymd(y - 1, m, 1), clamp(y - 1, m, d))];
    case "quarter_lfl": return [cur(ymd(y, qs, 1), ymd(y, m, d)), cur(ymd(pqy, pqm, 1), clamp(lqy, lqm, d))];
    case "fy_lfl": return [cur(ymd(fyStart, 3, 1), ymd(y, m, d)), cur(ymd(fyStart - 1, 3, 1), clamp(y - 1, m, d))];
    case "prev_months": return [cur(ymd(py, pm, 1), ymd(py, pm, daysIn(py, pm))), cur(ymd(p2y, p2m, 1), ymd(p2y, p2m, daysIn(p2y, p2m)))];
    case "last30": { const to = ymd(y, m, d); return [cur(addDays(to, -29), to), cur(addDays(to, -59), addDays(to, -30))]; }
    default: throw new Error(kind);
  }
}

// [question, oracle range kind, entity, breakdown, measure, filter, sort]
// Decision 2 (2026-09-28): "this month vs last month" = month to date vs the COMPLETE previous month (month_full); the
// same days are compared only when asked ("same period last month" = month_lfl). Decision 3: new CUSTOMERS are refused
// (party master not synced), so the "new" oracle row uses products.
const QUESTIONS = [
  ["Which customers grew this month vs last month?", "month_full", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers grew this month vs the same period last month?", "month_lfl", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers declined this month vs the full last month?", "month_full", "sales", "customer", "invoice", "down", "delta asc"],
  ["Which customers grew this month compared to same month last year?", "month_sply", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers grew this quarter vs last quarter?", "quarter_lfl", "sales", "customer", "invoice", "up", "delta desc"],
  ["Which customers grew this financial year vs last financial year?", "fy_lfl", "sales", "customer", "invoice", "up", "delta desc"],
  ["Sales last month vs the month before", "prev_months", "sales", null, "invoice", null, null],
  ["New products sold this month vs last month", "month_full", "sales", "product", "line", "new", "current desc"],
  ["Which customers stopped buying this month vs last month?", "month_full", "sales", "customer", "invoice", "lost", "previous desc"],
  ["Which customers grew by more than 20% this month vs last month?", "month_full", "sales", "customer", "invoice", "pct>20", "pct desc"],
  ["Products whose revenue declined this quarter vs last quarter", "quarter_lfl", "sales", "product", "line", "down", "delta asc"],
  ["Which product groups increased their sales this quarter vs last quarter?", "quarter_lfl", "sales", "productGroup", "line", "up", "delta desc"],
  ["Suppliers whose purchases grew this month vs last month", "month_full", "purchase", "supplier", "invoice", "up", "delta desc"],
  ["Which customers grew in the last 30 days?", "last30", "sales", "customer", "invoice", "up", "delta desc"],
  ["Revenue this fy vs last fy", "fy_lfl", "sales", null, "line", null, null],
];
// anchors = the tenant's latest-voucher date (stored as UTC midnight, exactly like real synced vouchers)
const ANCHORS = ["2024-02-29", "2024-03-31", "2024-12-31", "2025-01-01", "2025-03-31", "2025-04-01", "2025-06-30", "2025-10-15", "2026-02-28"];

function oracleResult(data, q, anchor) {
  const [, kind, entity, dim, measure, filter, sort] = q;
  const [y, m, d] = anchor.split("-").map(Number);
  const [cur, prev] = ranges(kind, [y, m - 1, d]);
  const list = entity === "sales" ? data.sales : data.purchases;
  const inRange = (r) => (x) => x.date >= r.from && x.date <= r.to;
  const sums = (r) => {
    const out = new Map();
    const add = (key, a, b) => { const e = out.get(key) || { a: 0, b: 0 }; e.a += a; e.b += b; out.set(key, e); };
    for (const x of list.filter(inRange(r))) {
      if (measure === "invoice") add(dim ? x.party : "_", x.total, 1);
      else for (const [item, qty, amt] of x.lines) add(dim === "product" ? item : dim === "productGroup" ? GROUP[item] : dim ? x.party : "_", amt, qty);
    }
    return out;
  };
  const c = sums(cur);
  const p = sums(prev);
  const keys = [...new Set([...c.keys(), ...p.keys()])];
  let rows = keys.map((k) => {
    const cv = c.get(k) || { a: 0, b: 0 };
    const pv = p.get(k) || { a: 0, b: 0 };
    return { k, cur: cv.a, curB: cv.b, prev: pv.a, prevB: pv.b, delta: cv.a - pv.a, pct: pv.a === 0 ? null : ((cv.a - pv.a) / Math.abs(pv.a)) * 100 };
  });
  const keep = { up: (r) => r.delta > 0, down: (r) => r.delta < 0, new: (r) => r.prev === 0 && r.cur > 0, lost: (r) => r.cur === 0 && r.prev > 0, "pct>20": (r) => r.pct !== null && r.pct > 20 };
  if (filter) rows = rows.filter(keep[filter]);
  const rd6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  const val = { "delta desc": (r) => [r.delta, -1], "delta asc": (r) => [r.delta, 1], "current desc": (r) => [r.cur, -1], "previous desc": (r) => [r.prev, -1], "pct desc": (r) => [r.pct, -1] };
  if (sort) {
    rows.sort((a, b) => {
      const [rawA, dir] = val[sort](a); // dir: 1 = ascending, -1 = descending
      const va = rd6(rawA);
      const vb = rd6(val[sort](b)[0]);
      if (va !== vb) {
        if (va === null) return 1; // nulls last, either direction
        if (vb === null) return -1;
        return (va < vb ? -1 : 1) * dir;
      }
      const ka = JSON.stringify({ [dim]: a.k });
      const kb = JSON.stringify({ [dim]: b.k });
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  const total = (map) => [...map.values()].reduce((s, e) => ({ a: s.a + e.a, b: s.b + e.b }), { a: 0, b: 0 });
  return { cur, prev, rows: rows.slice(0, 10), truncated: rows.length > 10, total: total(c), totalPrev: total(p), all: rows.length, newCount: rows.filter((r) => r.prev === 0).length };
}

// PROPOSED coverage classification (design reference only - not production code)
function classifyCoverage(range, coverage) {
  if (!coverage.earliest) return "no_data";
  if (range.to < coverage.earliest) return "before_history";
  if (range.from > coverage.latest) return "after_latest_data";
  if (range.from < coverage.earliest) return "partly_before_history";
  if (range.to > coverage.latest) return "partly_after_latest_data";
  return "covered";
}

async function engineVsOracle() {
  const mongoose = require("mongoose");
  try {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  } catch (e) {
    console.log("  SKIPPED - MongoDB not reachable (sections A-D are complete without it)");
    return;
  }
  const Sale = require("./src/models/sales.model");
  const Purchase = require("./src/models/purchase.model");
  const StockItemMaster = require("./src/models/stockItemMaster.model");
  const { executeQuery } = require("./src/services/query/execute");
  const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");
  const clean = async () => {
    const ids = { $in: [T, T_EMPTY, T_ONE] };
    // raw driver: synthetic tenant only, no model hooks (no TenantDataVersion writes)
    await Promise.all([Sale.collection.deleteMany({ tenantId: ids }), Purchase.collection.deleteMany({ tenantId: ids }), StockItemMaster.collection.deleteMany({ tenantId: ids })]);
  };
  const data = buildData();
  const doc = (tenantId, x) => ({
    tenantId, tallyGuid: `${tenantId}-${x.no}`, tallyAlterId: Number(x.no.slice(3)), voucherStatus: "active",
    header: { voucherNo: x.no, voucherDate: new Date(`${x.date}T00:00:00.000Z`), voucherType: "Invoice", voucherTotalAmount: x.total, narration: "", partyName: x.party },
    inventory: x.lines.map(([itemName, quantity, amount]) => ({ itemName, quantity, rate: quantity ? amount / quantity : 0, amount })), ledgers: [],
  });
  let oracleMatches = 0;
  let oracleRuns = 0;
  try {
    await clean();
    await Sale.collection.insertMany(data.sales.map((x) => doc(T, x)));
    await Purchase.collection.insertMany(data.purchases.map((x) => doc(T, x)));
    await StockItemMaster.collection.insertMany(Object.entries(GROUP).map(([itemName, stockGroupName]) => ({ tenantId: T, itemName, stockGroupName, tallyGuid: `${T}-m-${itemName}`, syncedAt: new Date() })));
    await Sale.collection.insertOne(doc(T_ONE, { no: "GA-1", date: "2025-06-10", party: "Solo Co", total: 500, lines: [["Item A", 1, 423.73]] }));
    console.log(`    synthetic tenant: ${data.sales.length} sales + ${data.purchases.length} purchase vouchers, Jan 2024 - Feb 2026, 8 customer behaviours (growing, declining, flat, month-boundary days, alternating, new, lost, reactivated)`);

    const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.01);
    const fmt = (s) => ymdLocal(new Date(s));
    const problems = [];
    for (const anchor of ANCHORS) {
      const referenceDate = new Date(`${anchor}T00:00:00.000Z`);
      for (const q of QUESTIONS) {
        oracleRuns += 1;
        const route = await routeQuestion(q[0], { resolveEntity: resolver, referenceDate });
        if (route.status !== "supported") { problems.push(`${anchor} "${q[0]}": router ${route.status}/${route.code}`); continue; }
        const res = await executeQuery(route.plan, { tenantId: T, referenceDate });
        const exp = oracleResult(data, q, anchor);
        const issues = [];
        if (!res.ok) issues.push(`engine ${JSON.stringify(res.errors)}`);
        else {
          if (fmt(res.period.from) !== exp.cur.from || fmt(res.period.to) !== exp.cur.to) issues.push(`subject ${fmt(res.period.from)}..${fmt(res.period.to)} vs oracle ${exp.cur.from}..${exp.cur.to}`);
          if (fmt(res.comparison.from) !== exp.prev.from || fmt(res.comparison.to) !== exp.prev.to) issues.push(`baseline ${fmt(res.comparison.from)}..${fmt(res.comparison.to)} vs oracle ${exp.prev.from}..${exp.prev.to}`);
          const [ma, mb] = route.plan.metrics;
          if (q[3]) {
            if (res.rows.length !== exp.rows.length) issues.push(`rows ${res.rows.length} vs ${exp.rows.length}`);
            res.rows.forEach((row, i) => {
              const e = exp.rows[i];
              if (!e || row.key[q[3]] !== e.k) return issues.push(`row ${i}: ${row.key[q[3]]} vs ${e && e.k}`);
              if (!near(row.values[ma], e.cur) || !near(row.comparison[ma].previous, e.prev) || !near(row.comparison[ma].delta, e.delta) || !near(row.comparison[ma].deltaPct, e.pct)) issues.push(`row ${i} ${e.k} values`);
              if (mb && !near(row.values[mb], e.curB)) issues.push(`row ${i} ${e.k} ${mb}`);
            });
            if (res.truncated !== exp.truncated) issues.push("truncated flag");
          }
          if (res.totals) {
            if (!near(res.totals.values[ma], exp.total.a)) issues.push(`total ${res.totals.values[ma]} vs ${exp.total.a}`);
            if (res.totals.comparison && !near(res.totals.comparison[ma].previous, exp.totalPrev.a)) issues.push(`total previous ${res.totals.comparison[ma].previous} vs ${exp.totalPrev.a}`);
          }
        }
        if (issues.length) problems.push(`${anchor} "${q[0]}": ${issues.slice(0, 3).join("; ")}`);
        else oracleMatches += 1;
      }
    }
    check(`engine = independent oracle for ${oracleMatches}/${oracleRuns} runs (${QUESTIONS.length} questions x ${ANCHORS.length} boundary anchors: month-end, 29 Feb, FY end/start, quarter end, year end/start, mid-month)`, problems.length === 0, problems.slice(0, 5).join(" | "));

    // ---------- F. coverage: "no sales" vs "no data"
    section("F. data coverage: when a zero baseline means 'no data', not 'no sales'");
    const refT = await getTenantReferenceDate(T);
    const [minDoc] = await Sale.collection.find({ tenantId: T, voucherStatus: "active" }).sort({ "header.voucherDate": 1 }).limit(1).toArray();
    const coverage = { earliest: minDoc.header.voucherDate.toISOString().slice(0, 10), latest: refT.toISOString().slice(0, 10) };
    check(`coverage is derivable from existing data: earliest ${coverage.earliest}, latest ${coverage.latest} (latest = the reference date)`, coverage.earliest === "2024-01-01" && coverage.latest === "2026-02-28");
    // 1. comparison entirely before history: every active customer "grew" from 0 and NOTHING says the baseline has no data
    const a1 = new Date("2024-02-29T00:00:00.000Z");
    const r1 = await routeQuestion("Which customers grew this month compared to same month last year?", { referenceDate: a1 });
    const e1 = await executeQuery(r1.plan, { tenantId: T, referenceDate: a1 });
    const cmp1 = { from: fmt(e1.comparison.from), to: fmt(e1.comparison.to) };
    check(`comparison ${cmp1.from}..${cmp1.to} lies BEFORE history (${classifyCoverage(cmp1, coverage)}): all ${e1.rows.length} rows show previous = 0, and the result carries no coverage warning`, classifyCoverage(cmp1, coverage) === "before_history" && e1.rows.length > 0 && e1.rows.every((r) => r.comparison.invoiceAmount.previous === 0) && !(e1.warnings || []).some((w) => /coverage|history|before/i.test(w.code || "")));
    // 2. comparison partly before history
    const a2 = new Date("2025-01-31T00:00:00.000Z");
    const r2q = await routeQuestion("Sales this financial year vs last financial year", { referenceDate: a2 });
    const e2 = await executeQuery(r2q.plan, { tenantId: T, referenceDate: a2 });
    const cmp2 = { from: fmt(e2.comparison.from), to: fmt(e2.comparison.to) };
    check(`comparison ${cmp2.from}..${cmp2.to} is PARTLY before history (${classifyCoverage(cmp2, coverage)}): growth is overstated, no warning`, classifyCoverage(cmp2, coverage) === "partly_before_history" && e2.totals.comparison.invoiceAmount.delta > 0);
    // 3. subject partly after the latest data (explicit range reaching past the anchor)
    const r3 = await routeQuestion("Sales from 2026-02-01 to 2026-03-31", { referenceDate: refT });
    check(`an explicit range past the latest synced voucher is classified "${classifyCoverage({ from: "2026-02-01", to: "2026-03-31" }, coverage)}" (sync lag, not zero sales)`, r3.status === "supported" && classifyCoverage({ from: "2026-02-01", to: "2026-03-31" }, coverage) === "partly_after_latest_data");
    // 4. fully covered comparison: a zero really is zero
    const cmp4 = ranges("month_lfl", [2025, 9, 15]);
    check(`fully covered comparison (${cmp4[1].from}..${cmp4[1].to}): a 0 for a customer is a genuine "no sales"`, classifyCoverage(cmp4[1], coverage) === "covered");
    // 5-10. behaviours inside covered history
    // oracle specs (not router questions): parties absent in / gone from the comparison month
    const ABSENT_BEFORE = ["(oracle) customers absent in the comparison month", "month_full", "sales", "customer", "invoice", "new", "current desc"];
    const GONE = ["(oracle) customers absent in this month", "month_full", "sales", "customer", "invoice", "lost", "previous desc"];
    const o = oracleResult(data, ABSENT_BEFORE, "2025-06-30");
    check(`a customer whose first voucher is inside history (Latecomer Co, 2025-06-25) is absent in May 2025 - a real zero`, o.rows.some((r) => r.k === "Latecomer Co"));
    const o2 = oracleResult(data, ABSENT_BEFORE, "2025-09-30");
    check("a returning customer (Returner Co, silent Apr 2024 - Aug 2025) is equally absent from the comparison month - why decision 3 refuses 'new customer' without the party master", o2.rows.some((r) => r.k === "Returner Co"));
    const o3 = oracleResult(data, GONE, "2025-01-31");
    check("lost customer (Gone Co, last voucher Dec 2024) shows as 'stopped buying' in Jan 2025", o3.rows.some((r) => r.k === "Gone Co"));
    // 11. tenant with no data: the reference date falls back to the wall clock; every period is empty
    const refEmpty = await getTenantReferenceDate(T_EMPTY);
    check("tenant with NO data: reference date falls back to the wall clock (freshness 'never_synced' is what stops an answer)", Math.abs(refEmpty.getTime() - Date.now()) < 60000);
    // 12. tenant with one voucher: the reference date is that voucher; last month is 'before history'
    const refOne = await getTenantReferenceDate(T_ONE);
    const rOne = await routeQuestion("Sales this month vs last month", { referenceDate: refOne });
    const eOne = await executeQuery(rOne.plan, { tenantId: T_ONE, referenceDate: refOne });
    check(`tenant with ONE voucher (${refOne.toISOString().slice(0, 10)}): this month = 500 vs last month 0 - a 'no data' baseline presented as growth`, eOne.ok && eOne.totals.values.invoiceAmount === 500 && eOne.totals.comparison.invoiceAmount.previous === 0 && eOne.totals.comparison.invoiceAmount.deltaPct === null);
  } finally {
    await clean();
    const left = await Promise.all([Sale.collection.countDocuments({ tenantId: { $in: [T, T_EMPTY, T_ONE] } }), Purchase.collection.countDocuments({ tenantId: { $in: [T, T_EMPTY, T_ONE] } }), StockItemMaster.collection.countDocuments({ tenantId: { $in: [T, T_EMPTY, T_ONE] } })]);
    check("synthetic tenants removed (0 documents left)", left.every((n) => n === 0), JSON.stringify(left));
    // real tenants: counts only, never names
    const Company = require("./src/models/company");
    const tenants = await Company.find({ isActive: true }, { tenantId: 1 }).lean();
    const cov = [];
    for (const c of tenants) {
      const [mn] = await Sale.collection.find({ tenantId: c.tenantId, voucherStatus: "active" }).sort({ "header.voucherDate": 1 }).limit(1).toArray();
      const ref = await getTenantReferenceDate(c.tenantId);
      if (mn) cov.push(`${mn.header.voucherDate.toISOString().slice(0, 10)}..${ref.toISOString().slice(0, 10)}`);
    }
    console.log(`    real tenants (read-only, unnamed): synced coverage ${cov.join(", ")} - a YoY question at their anchor compares against a year with NO synced data`);
    await mongoose.disconnect();
  }
}

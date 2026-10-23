"use strict";

/**
 * Phase 1G - CONTROLLED LIVE PLANNER EVALUATION (manual; makes real Anthropic calls).
 *
 * For each representative Sales/Purchase question the deterministic router DEFERS to the planner,
 * this script:
 *   1. asks the real Claude planner (exactly one call per question, no repair),
 *   2. compares Claude's plan SEMANTICALLY against an independently written expectation,
 *   3. executes the validated plan through the real engine + answer cache,
 *   4. compares the final answer with an independent oracle (raw MongoDB aggregation written here,
 *      not using the engine, compiler or periodEngine),
 *   5. records planner calls, input/output/cache tokens, validation and execution failures, oracle
 *      mismatches, and categorizes every failure: period | metric | dimension | comparison |
 *      ranking | unsupported_intent.
 *
 * Before any live call it SELF-CHECKS the harness with a "golden" plan per question (what a perfect
 * planner would return): golden must pass the semantic comparator AND its executed answer must match
 * the oracle. A failure there is a harness bug, and no credits are spent.
 *
 * Run:  node verify-planner-live-eval.js           (live: ~18 planner calls)
 *       node verify-planner-live-eval.js --dry     (self-check only, no Anthropic call)
 *       node verify-planner-live-eval.js --out=path.json
 * Read-only against MongoDB. Never modifies data. Tenant = WE FOUR (the large real tenant).
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Company = require("./src/models/company");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const { routeAndPlan } = require("./src/services/query/planner");
const { routeQuestion } = require("./src/services/query/localRouter");
const { createAnthropicPlannerClient, SKIP_ROUTER_CODES } = require("./src/services/query/planner");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { createAnswerCache } = require("./src/services/query/answerCache");
const { getTenantVersion } = require("./src/services/query/dataVersion");
const { executeQuery } = require("./src/services/query/execute");

const DRY = process.argv.includes("--dry");
const OUT = (process.argv.find((a) => a.startsWith("--out=")) || "").slice(6) || null;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const near = (a, b, tol = 0.011) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

// =========================================================================================
// Independent ORACLES: raw aggregation over the collections. Calendar dates are compared as
// YYYY-MM-DD strings in the server's timezone, so none of the engine's boundary math is reused.
// =========================================================================================

const modelOf = (entity) => (entity === "sales" ? Sale : Purchase);
const dayStage = { $addFields: { __d: { $dateToString: { format: "%Y-%m-%d", date: "$header.voucherDate", timezone: TZ } }, __m: { $dateToString: { format: "%Y-%m", date: "$header.voucherDate", timezone: TZ } } } };
const scope = (t, from, to) => [{ $match: { tenantId: t, voucherStatus: "active" } }, dayStage, { $match: { __d: { $gte: from, $lte: to } } }];
const r2 = (n) => Math.round(n * 100) / 100;

async function oTotals(t, entity, from, to) {
  const r = await modelOf(entity).aggregate([...scope(t, from, to), { $group: { _id: null, amount: { $sum: "$header.voucherTotalAmount" }, count: { $sum: 1 } } }]);
  return r.length ? { amount: r[0].amount, count: r[0].count } : { amount: 0, count: 0 };
}
async function oByParty(t, entity, from, to) {
  const r = await modelOf(entity).aggregate([...scope(t, from, to), { $group: { _id: "$header.partyName", amount: { $sum: "$header.voucherTotalAmount" }, count: { $sum: 1 } } }]);
  return new Map(r.map((x) => [x._id, { amount: x.amount, count: x.count }]));
}
async function oByItem(t, entity, from, to) {
  const r = await modelOf(entity).aggregate([...scope(t, from, to), { $unwind: "$inventory" }, { $group: { _id: "$inventory.itemName", amount: { $sum: "$inventory.amount" }, qty: { $sum: "$inventory.quantity" } } }]);
  return new Map(r.map((x) => [x._id, { amount: x.amount, qty: x.qty }]));
}
async function oMonthly(t, entity, from, to) {
  const r = await modelOf(entity).aggregate([...scope(t, from, to), { $group: { _id: "$__m", amount: { $sum: "$header.voucherTotalAmount" }, count: { $sum: 1 } } }]);
  return new Map(r.map((x) => [x._id, { amount: x.amount, count: x.count }]));
}
async function oMonthlyByType(t, entity, from, to) {
  const r = await modelOf(entity).aggregate([...scope(t, from, to), { $group: { _id: { m: "$__m", v: "$header.voucherType" }, amount: { $sum: "$header.voucherTotalAmount" } } }]);
  return new Map(r.map((x) => [`${x._id.m}|${x._id.v}`, { amount: x.amount }]));
}
const sortedDesc = (map, f) => [...map.entries()].sort((a, b) => f(b[1]) - f(a[1]) || String(a[0]).localeCompare(String(b[0])));

// ---- comparing an engine result with an oracle. Each returns [] on match or a list of problems.

const valueOf = (row, metric) => (row && row.values ? row.values[metric] : undefined);

function cmpScalar(result, want, metricMap) {
  const out = [];
  const v = result.totals && result.totals.values;
  for (const [metric, expected] of Object.entries(metricMap)) {
    if (!v || v[metric] === undefined) continue; // absent metric is reported by the semantic check
    if (!near(v[metric], expected)) out.push(`${metric}: engine ${v[metric]} vs oracle ${r2(expected)}`);
  }
  return out;
}

// Tie-aware top-N: engine values must equal the oracle's top values in order; names must match except within ties.
function cmpTop(result, sorted, metric, n, valueFn, nameKey) {
  const out = [];
  const rows = result.rows || [];
  const want = sorted.slice(0, n);
  if (rows.length !== want.length) out.push(`row count ${rows.length} vs oracle ${want.length}`);
  for (let i = 0; i < Math.min(rows.length, want.length); i += 1) {
    const got = valueOf(rows[i], metric);
    if (!near(got, valueFn(want[i][1]))) out.push(`#${i + 1} ${metric}: engine ${got} vs oracle ${r2(valueFn(want[i][1]))}`);
    const tied = sorted.filter((e) => near(valueFn(e[1]), valueFn(want[i][1]))).map((e) => e[0]);
    if (!tied.includes(rows[i].key[nameKey])) out.push(`#${i + 1} name "${rows[i].key[nameKey]}" not among oracle candidates`);
  }
  return out;
}

// =========================================================================================
// Semantic comparison of a plan against an independent expectation.
// =========================================================================================

const fyRange = (fy) => ({ from: `${fy.slice(0, 4)}-04-01`, to: `${Number(fy.slice(0, 4)) + 1}-03-31` });
function normPeriod(p) {
  if (!p) return null;
  if (p.kind === "custom") return `${p.from}..${p.to}`;
  if (p.kind === "specific_fy") {
    const r = fyRange(p.fy);
    return `${r.from}..${r.to}`;
  }
  return p.kind;
}
const normGroup = (g) => (g || []).map((x) => (x.dim === "date" ? `date:${x.bucket}` : x.dim)).sort().join(",");
const normFilters = (f) => (f || []).map((x) => `${x.dim}=${Array.isArray(x.value) ? x.value.join("|") : x.value}`).sort().join(";");

/** returns [{category, detail}] */
function comparePlan(plan, e) {
  const bad = [];
  const add = (category, detail) => bad.push({ category, detail });
  if (plan.entity !== e.entity) add("metric", `entity ${plan.entity} != ${e.entity}`);
  if (plan.mode !== (e.mode || "aggregate")) add("dimension", `mode ${plan.mode}`);
  if (normPeriod(plan.period) !== normPeriod(e.period)) add("period", `${normPeriod(plan.period)} != ${normPeriod(e.period)}`);
  const metrics = plan.metrics || [];
  for (const m of e.requiredMetrics) if (!metrics.includes(m)) add("metric", `missing ${m}`);
  for (const m of metrics) if (!e.requiredMetrics.includes(m) && !(e.allowedExtraMetrics || []).includes(m)) add("metric", `unexpected ${m}`);
  if (normGroup(plan.groupBy) !== normGroup(e.groupBy)) add("dimension", `groupBy [${normGroup(plan.groupBy)}] != [${normGroup(e.groupBy)}]`);
  if (normFilters(plan.filters) !== normFilters(e.filters)) add("dimension", `filters [${normFilters(plan.filters)}] != [${normFilters(e.filters)}]`);
  const pc = plan.compare ? `${plan.compare.mode}${plan.compare.period ? ":" + normPeriod(plan.compare.period) : ""}` : "none";
  const ec = e.compare ? `${e.compare.mode}${e.compare.period ? ":" + normPeriod(e.compare.period) : ""}` : "none";
  if (pc !== ec) add("comparison", `compare ${pc} != ${ec}`);
  const haveHaving = (plan.having || []).map((h) => `${h.metric}|${h.op}|${h.value}`).sort().join(";");
  const wantHaving = (e.having || []).map((h) => `${h.metric}|${h.op}|${h.value}`).sort().join(";");
  if (haveHaving !== wantHaving) add("comparison", `having [${haveHaving}] != [${wantHaving}]`);
  if (e.limit !== undefined && (plan.limit ?? null) !== e.limit) add("ranking", `limit ${plan.limit ?? "none"} != ${e.limit}`);
  if (e.sort) {
    const s = (plan.sort || [])[0];
    if (!s || s.by !== e.sort.by || s.dir !== e.sort.dir) add("ranking", `sort ${s ? s.by + " " + s.dir : "none"} != ${e.sort.by} ${e.sort.dir}`);
  }
  return bad;
}

// =========================================================================================
// The questions: every one is deferred by the deterministic router (verified before any call).
// =========================================================================================

const S = { AUG: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, JUL: { kind: "custom", from: "2025-07-01", to: "2025-07-31" }, SEP: { kind: "custom", from: "2025-09-01", to: "2025-09-30" }, AUG_: null };
const FY2526 = { kind: "specific_fy", fy: "2025-26" };
const FY_FROM = "2025-04-01";
const FY_TO = "2026-03-31";
const P = (from, to) => ({ kind: "custom", from, to });

function buildCases(ctx) {
  const { t, topCustomer } = ctx;
  const cases = [
    {
      id: "Q01", area: "period+metric", q: "What was our revenue in August 2025?",
      expect: { entity: "sales", period: S.AUG, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [], filters: [] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: S.AUG, metrics: ["invoiceAmount"], filters: [] },
      oracle: async (res) => cmpScalar(res, null, { invoiceAmount: (await oTotals(t, "sales", "2025-08-01", "2025-08-31")).amount, invoiceCount: (await oTotals(t, "sales", "2025-08-01", "2025-08-31")).count }),
    },
    {
      id: "Q02", area: "period+metric", q: "Show turnover between 2025-06-01 and 2025-08-31",
      expect: { entity: "sales", period: P("2025-06-01", "2025-08-31"), requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [], filters: [] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: P("2025-06-01", "2025-08-31"), metrics: ["invoiceAmount"], filters: [] },
      oracle: async (res) => { const o = await oTotals(t, "sales", "2025-06-01", "2025-08-31"); return cmpScalar(res, null, { invoiceAmount: o.amount, invoiceCount: o.count }); },
    },
    {
      id: "Q03", area: "entity+metric", q: "How much did we spend on purchases in September 2025?",
      expect: { entity: "purchase", period: S.SEP, requiredMetrics: ["purchaseAmount"], allowedExtraMetrics: ["purchaseInvoiceCount"], groupBy: [], filters: [] },
      golden: { v: 1, entity: "purchase", mode: "aggregate", period: S.SEP, metrics: ["purchaseAmount"], filters: [] },
      oracle: async (res) => { const o = await oTotals(t, "purchase", "2025-09-01", "2025-09-30"); return cmpScalar(res, null, { purchaseAmount: o.amount, purchaseInvoiceCount: o.count }); },
    },
    {
      id: "Q04", area: "ranking", q: "Top 5 customers by revenue in FY 2025-26",
      expect: { entity: "sales", period: FY2526, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [{ dim: "customer" }], filters: [], limit: 5, sort: { by: "invoiceAmount", dir: "desc" } },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: FY2526, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], filters: [], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 },
      oracle: async (res) => cmpTop(res, sortedDesc(await oByParty(t, "sales", FY_FROM, FY_TO), (x) => x.amount), "invoiceAmount", 5, (x) => x.amount, "customer"),
    },
    {
      id: "Q05", area: "ranking", q: "Which 5 suppliers did we spend the most with from 2025-04-01 to 2025-09-30?",
      expect: { entity: "purchase", period: P("2025-04-01", "2025-09-30"), requiredMetrics: ["purchaseAmount"], allowedExtraMetrics: ["purchaseInvoiceCount"], groupBy: [{ dim: "supplier" }], filters: [], limit: 5, sort: { by: "purchaseAmount", dir: "desc" } },
      golden: { v: 1, entity: "purchase", mode: "aggregate", period: P("2025-04-01", "2025-09-30"), metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], filters: [], sort: [{ by: "purchaseAmount", dir: "desc" }], limit: 5 },
      oracle: async (res) => cmpTop(res, sortedDesc(await oByParty(t, "purchase", "2025-04-01", "2025-09-30"), (x) => x.amount), "purchaseAmount", 5, (x) => x.amount, "supplier"),
    },
    {
      id: "Q06", area: "dimension+metric", q: "Top 10 products by revenue in August 2025",
      expect: { entity: "sales", period: S.AUG, requiredMetrics: ["lineAmount"], allowedExtraMetrics: ["quantity", "lineCount"], groupBy: [{ dim: "product" }], filters: [], limit: 10, sort: { by: "lineAmount", dir: "desc" } },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: S.AUG, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], filters: [], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10 },
      oracle: async (res) => cmpTop(res, sortedDesc(await oByItem(t, "sales", "2025-08-01", "2025-08-31"), (x) => x.amount), "lineAmount", 10, (x) => x.amount, "product"),
    },
    {
      id: "Q07", area: "dimension(date)", q: "Monthly revenue and number of invoices for FY 2025-26",
      expect: { entity: "sales", period: FY2526, requiredMetrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }], filters: [] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: FY2526, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }], filters: [] },
      oracle: async (res) => {
        const want = await oMonthly(t, "sales", FY_FROM, FY_TO);
        const out = [];
        const rows = res.rows || [];
        if (rows.length !== want.size) out.push(`month rows ${rows.length} vs oracle ${want.size}`);
        for (const row of rows) {
          const w = want.get(row.key.date.label);
          if (!w) { out.push(`unexpected month ${row.key.date.label}`); continue; }
          if (!near(valueOf(row, "invoiceAmount"), w.amount)) out.push(`${row.key.date.label} amount ${valueOf(row, "invoiceAmount")} vs ${r2(w.amount)}`);
          if (valueOf(row, "invoiceCount") !== w.count) out.push(`${row.key.date.label} count ${valueOf(row, "invoiceCount")} vs ${w.count}`);
        }
        return out;
      },
    },
    {
      id: "Q08", area: "comparison", q: "Which customers spent less in August 2025 than in July 2025?",
      expect: { entity: "sales", period: S.AUG, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [{ dim: "customer" }], filters: [], compare: { mode: "custom", period: S.JUL }, having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: S.AUG, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], filters: [], compare: { mode: "custom", period: S.JUL }, having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] },
      oracle: async (res) => cmpChange(res, await oByParty(t, "sales", "2025-08-01", "2025-08-31"), await oByParty(t, "sales", "2025-07-01", "2025-07-31"), "invoiceAmount", "customer", (d) => d < 0),
    },
    {
      id: "Q09", area: "comparison", q: "Which suppliers did we spend more with in September 2025 than in August 2025?",
      expect: { entity: "purchase", period: S.SEP, requiredMetrics: ["purchaseAmount"], allowedExtraMetrics: ["purchaseInvoiceCount"], groupBy: [{ dim: "supplier" }], filters: [], compare: { mode: "custom", period: S.AUG }, having: [{ metric: "purchaseAmount.delta", op: "gt", value: 0 }] },
      golden: { v: 1, entity: "purchase", mode: "aggregate", period: S.SEP, metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], filters: [], compare: { mode: "custom", period: S.AUG }, having: [{ metric: "purchaseAmount.delta", op: "gt", value: 0 }], sort: [{ by: "purchaseAmount.delta", dir: "desc" }] },
      oracle: async (res) => cmpChange(res, await oByParty(t, "purchase", "2025-09-01", "2025-09-30"), await oByParty(t, "purchase", "2025-08-01", "2025-08-31"), "purchaseAmount", "supplier", (d) => d > 0),
    },
    {
      id: "Q10", area: "dimension(2)", q: "Monthly revenue by voucher type for FY 2025-26",
      expect: { entity: "sales", period: FY2526, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }, { dim: "voucherType" }], filters: [] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: FY2526, metrics: ["invoiceAmount"], groupBy: [{ dim: "date", bucket: "month" }, { dim: "voucherType" }], filters: [] },
      oracle: async (res) => {
        const want = await oMonthlyByType(t, "sales", FY_FROM, FY_TO);
        const out = [];
        const rows = res.rows || [];
        if (rows.length !== want.size) out.push(`rows ${rows.length} vs oracle ${want.size}`);
        for (const row of rows) {
          const w = want.get(`${row.key.date.label}|${row.key.voucherType}`);
          if (!w) { out.push(`unexpected ${row.key.date.label}|${row.key.voucherType}`); continue; }
          if (!near(valueOf(row, "invoiceAmount"), w.amount)) out.push(`${row.key.date.label}|${row.key.voucherType} ${valueOf(row, "invoiceAmount")} vs ${r2(w.amount)}`);
        }
        return out;
      },
    },
    {
      id: "Q11", area: "comparison", q: "Revenue in August 2025 compared with July 2025",
      expect: { entity: "sales", period: S.AUG, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [], filters: [], compare: { mode: "custom", period: S.JUL } },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: S.AUG, metrics: ["invoiceAmount"], filters: [], compare: { mode: "custom", period: S.JUL } },
      oracle: async (res) => {
        const a = await oTotals(t, "sales", "2025-08-01", "2025-08-31");
        const b = await oTotals(t, "sales", "2025-07-01", "2025-07-31");
        const out = cmpScalar(res, null, { invoiceAmount: a.amount });
        const c = res.totals && res.totals.comparison && res.totals.comparison.invoiceAmount;
        if (!c) return out.concat("no comparison block");
        if (!near(c.previous, b.amount)) out.push(`previous ${c.previous} vs ${r2(b.amount)}`);
        if (!near(c.delta, a.amount - b.amount)) out.push(`delta ${c.delta} vs ${r2(a.amount - b.amount)}`);
        if (!near(c.deltaPct, ((a.amount - b.amount) / Math.abs(b.amount)) * 100, 0.001)) out.push(`deltaPct ${c.deltaPct} vs ${(((a.amount - b.amount) / Math.abs(b.amount)) * 100).toFixed(4)}`);
        return out;
      },
    },
    {
      id: "Q12", area: "filter", q: `Revenue from ${topCustomer} in FY 2025-26`,
      expect: { entity: "sales", period: FY2526, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [], filters: [{ dim: "customer", value: topCustomer }] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: FY2526, metrics: ["invoiceAmount"], filters: [{ dim: "customer", op: "eq_ci", value: topCustomer }] },
      oracle: async (res) => {
        const m = await oByParty(t, "sales", FY_FROM, FY_TO);
        const o = m.get(topCustomer) || { amount: 0, count: 0 };
        return cmpScalar(res, null, { invoiceAmount: o.amount, invoiceCount: o.count });
      },
    },
    {
      id: "Q13", area: "period(relative)+series", q: "Weekly revenue for the last 90 days",
      expect: { entity: "sales", period: { kind: "last_90_days" }, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [{ dim: "date", bucket: "week" }], filters: [] },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "last_90_days" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "date", bucket: "week" }], filters: [] },
      oracle: null, // relative window: bounds come from periodEngine, so no independent oracle
    },
    {
      id: "Q14", area: "comparison(mode)", q: "How is revenue this month doing against the complete last month?",
      expect: { entity: "sales", period: { kind: "current_month" }, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [], filters: [], compare: { mode: "full_previous" } },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"], filters: [], compare: { mode: "full_previous" } },
      oracle: null,
    },
    {
      id: "Q15", area: "comparison(mode)", q: "Revenue for the current quarter versus the same period last year",
      expect: { entity: "sales", period: { kind: "current_quarter" }, requiredMetrics: ["invoiceAmount"], allowedExtraMetrics: ["invoiceCount"], groupBy: [], filters: [], compare: { mode: "same_period_last_year" } },
      golden: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_quarter" }, metrics: ["invoiceAmount"], filters: [], compare: { mode: "same_period_last_year" } },
      oracle: null,
    },
    { id: "D01", area: "unsupported-intent", q: "Why did revenue drop in November 2025?", expectDecline: true },
    { id: "D02", area: "unsupported-intent", q: "Forecast revenue for next quarter", expectDecline: true },
    { id: "D03", area: "unsupported-intent", q: "Which customers should I focus on?", expectDecline: true },
  ];
  return cases;
}

// customers/suppliers change oracle: each engine row must match the oracle's current/previous/delta and satisfy the predicate;
// the row count must equal min(engine row limit, oracle qualifying count).
function cmpChange(res, cur, prev, metric, key, pred) {
  const out = [];
  const qualifying = [];
  for (const name of new Set([...cur.keys(), ...prev.keys()])) {
    const c = (cur.get(name) || { amount: 0 }).amount;
    const p = (prev.get(name) || { amount: 0 }).amount;
    if (pred(c - p)) qualifying.push(name);
  }
  const rows = res.rows || [];
  const cap = res.rowLimit || 10;
  const expectedCount = Math.min(cap, qualifying.length);
  if (rows.length !== expectedCount) out.push(`row count ${rows.length} vs oracle ${expectedCount} (qualifying ${qualifying.length}, cap ${cap})`);
  for (const row of rows) {
    const name = row.key[key];
    const c = (cur.get(name) || { amount: 0 }).amount;
    const p = (prev.get(name) || { amount: 0 }).amount;
    if (!qualifying.includes(name)) out.push(`"${name}" does not satisfy the change predicate in the oracle`);
    if (!near(valueOf(row, metric), c)) out.push(`${name} current ${valueOf(row, metric)} vs ${r2(c)}`);
    const cmp = row.comparison && row.comparison[metric];
    if (!cmp || !near(cmp.previous, p) || !near(cmp.delta, c - p)) out.push(`${name} previous/delta ${JSON.stringify(cmp)} vs ${r2(p)}/${r2(c - p)}`);
  }
  return out;
}

// =========================================================================================
// runner
// =========================================================================================

(async () => {
  await connectDB();
  const started = Date.now();
  const report = { startedAt: new Date().toISOString(), dry: DRY, model: process.env.ANTHROPIC_PLANNER_MODEL || process.env.ANTHROPIC_MODEL || "(planner default)", tz: TZ, cases: [], totals: {} };
  try {
    const we = (await Company.find({ isActive: true }).lean()).find((c) => c.companyName === "WE FOUR");
    if (!we) throw new Error("WE FOUR not found");
    const t = we.tenantId;
    const resolver = createEntityResolver({ tenantId: t });

    // A customer with a name that passes the router's safety gate and is unique after normalisation.
    const parties = await Sale.aggregate([{ $match: { tenantId: t, voucherStatus: "active" } }, { $group: { _id: "$header.partyName", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 40 }]);
    const topCustomer = parties.map((p) => p._id).find((n) => typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9 &.-]*$/.test(n) && n.length >= 5 && !/\b(gst|tax|cash|bank|ledger|order|return|region|state)\b/i.test(n));
    if (!topCustomer) throw new Error("no suitable customer name");
    const cases = buildCases({ t, topCustomer });
    const cache = createAnswerCache();
    const run = (plan) => cache.run(plan, { tenantId: t }, { execute: executeQuery, getVersion: getTenantVersion });
    console.log(`Tenant: WE FOUR | timezone: ${TZ} | customer for Q12: "${topCustomer}" | mode: ${DRY ? "DRY (no Anthropic calls)" : "LIVE"}`);

    // ---------- harness self-check (no credits): router defers each question; golden plans pass comparator and oracle
    console.log("\n--- harness self-check ---");
    let harnessBad = 0;
    for (const c of cases) {
      const route = await routeQuestion(c.q, { resolveEntity: resolver });
      const deferred = route.status === "needs_planner" && !SKIP_ROUTER_CODES.has(route.code);
      c.routerCode = route.code || route.status;
      if (!deferred) { harnessBad += 1; console.log(`  HARNESS  ${c.id} router did not defer to planner: ${route.status}/${route.code}`); continue; }
      if (c.expectDecline) continue;
      const cmp = comparePlan(c.golden, c.expect);
      if (cmp.length) { harnessBad += 1; console.log(`  HARNESS  ${c.id} golden plan fails its own expectation: ${JSON.stringify(cmp)}`); continue; }
      const res = await executeQuery(c.golden, { tenantId: t });
      if (res.ok !== true) { harnessBad += 1; console.log(`  HARNESS  ${c.id} golden plan does not execute: ${JSON.stringify(res.errors || res)}`); continue; }
      if (c.oracle) {
        const probs = await c.oracle(res);
        if (probs.length) { harnessBad += 1; console.log(`  HARNESS  ${c.id} golden answer != oracle: ${probs.slice(0, 3).join(" | ")}`); continue; }
      }
      console.log(`  ok       ${c.id} router=${route.code} golden plan matches expectation${c.oracle ? " and oracle" : " (no oracle: relative period)"}`);
    }
    report.harnessProblems = harnessBad;
    if (harnessBad) { console.log(`\nHarness self-check found ${harnessBad} problem(s); refusing to spend credits.`); process.exitCode = 2; return; }
    if (DRY) { console.log("\nDry run complete: harness is sound. No Anthropic calls made."); return; }

    // ---------- live run
    console.log("\n--- live planner run (1 call per question, no repair) ---");
    const client = createAnthropicPlannerClient();
    const tot = { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, validationFailures: 0, executionFailures: 0, oracleMismatches: 0, semanticMismatches: 0, protocolFailures: 0 };
    const failures = [];

    for (const c of cases) {
      const rec = { id: c.id, question: c.q, area: c.area, routerCode: c.routerCode, outcome: null, plannerStatus: null, failures: [], usage: null, ms: 0 };
      const t0 = Date.now();
      let out;
      try {
        out = await routeAndPlan(c.q, { resolveEntity: resolver, claudeClient: client });
      } catch (e) {
        rec.outcome = "exception";
        rec.failures.push({ category: "harness", detail: `${e.name}: ${e.message}` });
        report.cases.push(rec);
        continue;
      }
      rec.ms = Date.now() - t0;
      const f = out.final;
      rec.plannerStatus = `${f.status}${f.code ? "/" + f.code : ""}`;
      rec.usage = f.usage || null;
      if (f.usage) for (const k of ["calls", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) tot[k] += f.usage[k] || 0;
      rec.plannerAssumptions = f.plannerAssumptions || [];
      rec.plan = f.plan || null;

      if (c.expectDecline) {
        if (f.status === "supported") rec.failures.push({ category: "unsupported_intent", detail: "planner produced a plan for a question that should be declined", plan: f.plan });
        rec.outcome = rec.failures.length ? "FAIL" : "PASS";
      } else if (f.status !== "supported") {
        const cat = f.status === "planner_failed" ? (f.code === "planner_invalid_plan" ? "validation" : f.code === "planner_protocol_violation" ? "protocol" : "planner_error") : "unsupported_intent";
        if (cat === "validation") tot.validationFailures += 1;
        if (cat === "protocol") tot.protocolFailures += 1;
        rec.failures.push({ category: cat === "validation" || cat === "protocol" || cat === "planner_error" ? "metric" : cat, kind: cat, detail: `${f.status}/${f.code}: ${f.reason} ${JSON.stringify(f.errors || "")}` });
        rec.outcome = "FAIL";
      } else {
        const sem = comparePlan(f.plan, c.expect);
        if (sem.length) tot.semanticMismatches += 1;
        sem.forEach((s) => rec.failures.push({ ...s, kind: "semantic" }));
        // execute the validated plan through the real engine + cache regardless (so oracle mismatches are visible too)
        const ex = await run(f.plan);
        rec.cacheStatus = ex.cache.status;
        if (ex.result.ok !== true) {
          tot.executionFailures += 1;
          rec.failures.push({ category: "metric", kind: "execution", detail: JSON.stringify(ex.result.errors || ex.result).slice(0, 200) });
        } else if (c.oracle && sem.length === 0) {
          const probs = await c.oracle(ex.result);
          if (probs.length) {
            tot.oracleMismatches += 1;
            probs.slice(0, 4).forEach((p) => rec.failures.push({ category: "metric", kind: "oracle", detail: p }));
          }
        } else if (c.oracle) {
          rec.oracleSkipped = "plan already semantically different; oracle answers the expected question";
        }
        rec.outcome = rec.failures.length ? "FAIL" : "PASS";
      }
      report.cases.push(rec);
      const u = rec.usage || {};
      console.log(`  ${rec.outcome === "PASS" ? "PASS" : "FAIL"}  ${c.id}  ${rec.plannerStatus.padEnd(22)} calls=${u.calls || 0} in=${u.input_tokens || 0} out=${u.output_tokens || 0} cacheW=${u.cache_creation_input_tokens || 0} cacheR=${u.cache_read_input_tokens || 0} ${rec.ms}ms  ${c.q}`);
      for (const fl of rec.failures) console.log(`        [${fl.category}${fl.kind ? "/" + fl.kind : ""}] ${fl.detail}`);
      if (rec.plannerAssumptions.length) console.log(`        assumptions: ${rec.plannerAssumptions.join(" | ")}`);
      if (rec.outcome === "FAIL") failures.push(rec);
    }

    // ---------- summary
    const byCat = {};
    for (const r of failures) for (const fl of r.failures) byCat[fl.category] = (byCat[fl.category] || 0) + 1;
    report.totals = { ...tot, questions: cases.length, passed: cases.length - failures.length, failed: failures.length, failuresByCategory: byCat, elapsedMs: Date.now() - started };
    console.log("\n=== SUMMARY ===");
    console.log(`questions ${cases.length} | passed ${report.totals.passed} | failed ${failures.length}`);
    console.log(`planner calls ${tot.calls} | input ${tot.input_tokens} | output ${tot.output_tokens} | cache write ${tot.cache_creation_input_tokens} | cache read ${tot.cache_read_input_tokens}`);
    console.log(`validation failures ${tot.validationFailures} | protocol failures ${tot.protocolFailures} | execution failures ${tot.executionFailures} | semantic mismatches ${tot.semanticMismatches} | oracle mismatches ${tot.oracleMismatches}`);
    console.log(`failures by category: ${JSON.stringify(byCat)}`);
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await mongoose.disconnect().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

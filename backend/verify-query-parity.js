"use strict";

/**
 * Phase 1C - PARITY SUITE: generic Query Engine vs the existing analytics.
 *
 * READ-ONLY against real data (WE FOUR = the large tenant, Nirmal = a small
 * second tenant). Writes nothing. No Claude/Anthropic calls.
 *
 * Oracle policy (from the semantic catalog's PARITY_ORACLES):
 *   existing     - the current analytics function is the ground truth
 *                  (salesAnalytics / purchaseAnalytics / stockGroupAnalytics).
 *   independent  - no existing function covers the shape, so the oracle is an
 *                  INDEPENDENTLY written JavaScript computation over lean
 *                  documents (different code path from the engine's Mongo
 *                  aggregation: no $group/$lookup, hand-rolled joins and date
 *                  bucketing). Such capabilities are only trusted once this
 *                  passes.
 *
 * Known, intentional differences the harness normalizes (NOT tolerated
 * mismatches): product 'orderCount' (existing) == lineCount (engine);
 * rankings are compared tie-aware because MongoDB group order is undefined
 * while the engine sorts deterministically.
 *
 * Run: node verify-query-parity.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Company = require("./src/models/company");

const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
const stockGroupAnalytics = require("./src/services/analytics/stockGroupAnalytics");
const periodEngine = require("./src/services/analytics/periodEngine");
const dateRanges = require("./src/services/analytics/dateRanges");
const { getTenantReferenceDate } = require("./src/services/analytics/referenceDate");
const { executeQuery } = require("./src/services/query/execute");
const catalog = require("./src/services/query/semanticCatalog");

// ------------------------------------------------------------------ plumbing

const results = []; // {tenant, cap, id, oracle, ok, detail}
let currentTenantLabel = "";

const EPS = 1e-6;
const close = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= EPS + 1e-9 * Math.max(Math.abs(a), Math.abs(b)));

function diff(a, b, path = "") {
  if (a === b) return null;
  if (typeof a === "number" && typeof b === "number") return close(a, b) ? null : `${path}: oracle=${a} engine=${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: oracle=${a.length} engine=${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diff(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return `${path}: oracle=${JSON.stringify(a)} engine=${JSON.stringify(b)}`;
}

async function parity(cap, id, oracleKind, oracleFn, engineFn) {
  let ok = false;
  let detail = "";
  try {
    const [o, e] = await Promise.all([oracleFn(), engineFn()]);
    const d = diff(o, e);
    ok = d === null;
    detail = d || "";
  } catch (err) {
    detail = `ERROR: ${err.message}`;
  }
  results.push({ tenant: currentTenantLabel, cap, id, oracle: oracleKind, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} - [${cap}] ${id}${ok ? "" : `  -> ${detail}`}`);
  return ok;
}

// Asserts a plain condition as a parity-suite finding.
function assertCase(cap, id, cond, detail) {
  results.push({ tenant: currentTenantLabel, cap, id, oracle: "assertion", ok: !!cond, detail: cond ? "" : detail || "" });
  console.log(`  ${cond ? "PASS" : "FAIL"} - [${cap}] ${id}${cond ? "" : `  -> ${detail || ""}`}`);
}

// Ties are judged at 6 decimals - the same resolution the engine sorts at.
const r4 = (v) => Math.round(v * 1e6);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Tie-aware ranking comparison. `full` is the oracle's COMPLETE list
 * ([{name, ...}]) and `engineRows` the engine's top-N (already limited). The
 * oracle list is canonicalised (value desc, name asc); rows strictly above the
 * boundary value must match by name and values exactly, rows AT the boundary
 * value must have equal values and belong to the oracle's boundary tie block.
 */
function rankDiff(full, engineRows, n, valueKey) {
  const canon = [...full].sort((a, b) => r4(b[valueKey]) - r4(a[valueKey]) || cmpStr(a.name, b.name));
  const top = canon.slice(0, Math.min(n, canon.length));
  if (engineRows.length !== top.length) return `count: oracle=${top.length} engine=${engineRows.length}`;
  if (!top.length) return null;
  const boundary = r4(top[top.length - 1][valueKey]);
  const boundaryNames = new Set(canon.filter((x) => r4(x[valueKey]) === boundary).map((x) => x.name));
  for (let i = 0; i < top.length; i += 1) {
    const o = top[i];
    const e = engineRows[i];
    if (!close(o[valueKey], e[valueKey])) return `rank ${i + 1} value: oracle=${o[valueKey]} (${o.name}) engine=${e[valueKey]} (${e.name})`;
    if (r4(o[valueKey]) !== boundary) {
      const d = diff(o, e, `rank ${i + 1}`);
      if (d) return d;
    } else if (!boundaryNames.has(e.name)) {
      return `rank ${i + 1}: engine row '${e.name}' is not in the oracle's boundary tie block`;
    }
  }
  return null;
}

async function rankParity(cap, id, oracleKind, oracleFullFn, engineFn, n, valueKey) {
  let ok = false;
  let detail = "";
  try {
    const [full, rows] = await Promise.all([oracleFullFn(), engineFn()]);
    const d = rankDiff(full, rows, n, valueKey);
    ok = d === null;
    detail = d || "";
  } catch (err) {
    detail = `ERROR: ${err.message}`;
  }
  results.push({ tenant: currentTenantLabel, cap, id, oracle: oracleKind, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} - [${cap}] ${id}${ok ? "" : `  -> ${detail}`}`);
  return ok;
}

// ------------------------------------------------------------------ period fixtures

function periodSet(ref, { wide = true } = {}) {
  const custom = (from, to) => ({ plan: { kind: "custom", from, to }, oracle: dateRanges.customRange(from, to) });
  const rel = (kind) => ({ plan: { kind }, oracle: periodEngine.resolvePeriod(kind, ref) });
  const set = {
    all_time: { plan: { kind: "all_time" }, oracle: { from: undefined, to: undefined, label: "All time", isPartial: false } },
    current_month: rel("current_month"),
    previous_month: rel("previous_month"),
    current_quarter: rel("current_quarter"),
    previous_quarter: rel("previous_quarter"),
    current_fy: rel("current_fy"),
    custom_aug_2025: custom("2025-08-01", "2025-08-31"),
    custom_cross_month: custom("2025-06-15", "2025-08-15"),
    empty_2024: custom("2024-01-01", "2024-01-31"),
  };
  if (wide) {
    set.last_30_days = rel("last_30_days");
    set.ytd = rel("ytd");
    set.current_week = rel("current_week");
  }
  return set;
}

// ------------------------------------------------------------------ normalizers

const engineOrThrow = (res) => {
  if (!res.ok) throw new Error(`engine refused: ${JSON.stringify(res.errors)}`);
  return res;
};

// ------------------------------------------------------------------ independent (JS) oracle helpers

// A period bound is a LOCAL calendar day and a voucher is dated by the calendar day of its stored (UTC-midnight) date. The oracle compares the two
// as YYYY-MM-DD strings, so it shares nothing with the engine's conversion and does not move with the server's time zone. MongoDB only pre-selects
// a window two days wider than the period; the exact test is the string comparison.
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY_MS = 86400000;
async function loadVouchers(Model, tenantId, oraclePeriod) {
  const q = { tenantId, voucherStatus: "active" };
  if (oraclePeriod.from || oraclePeriod.to) {
    q["header.voucherDate"] = {};
    if (oraclePeriod.from) q["header.voucherDate"].$gte = new Date(oraclePeriod.from.getTime() - 2 * DAY_MS);
    if (oraclePeriod.to) q["header.voucherDate"].$lte = new Date(oraclePeriod.to.getTime() + 2 * DAY_MS);
  }
  const docs = await Model.find(q).select("header inventory").lean();
  if (!oraclePeriod.from && !oraclePeriod.to) return docs;
  const from = oraclePeriod.from ? localDay(oraclePeriod.from) : null;
  const to = oraclePeriod.to ? localDay(oraclePeriod.to) : null;
  return docs.filter((v) => {
    const day = v.header.voucherDate.toISOString().slice(0, 10);
    return (!from || day >= from) && (!to || day <= to);
  });
}

async function loadGroupMap(tenantId) {
  const docs = await StockItemMaster.find({ tenantId }).select("itemName stockGroupName").lean();
  return new Map(docs.map((d) => [d.itemName, d.stockGroupName]));
}

function sumBy(map, key, add) {
  if (!map.has(key)) map.set(key, {});
  const acc = map.get(key);
  for (const [k, v] of Object.entries(add)) acc[k] = (acc[k] || 0) + v;
}

function bucketStart(d, bucket) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const iso = (dt) => dt.toISOString().slice(0, 10);
  if (bucket === "day") return iso(new Date(Date.UTC(y, m, day)));
  if (bucket === "week") return iso(new Date(Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7))));
  if (bucket === "month") return `${y}-${pad2(m + 1)}-01`;
  if (bucket === "quarter") return `${y}-${pad2(Math.floor(m / 3) * 3 + 1)}-01`;
  return `${m >= 3 ? y : y - 1}-04-01`; // fy
}

const oneLine = (o) => JSON.stringify(o);

// ================================================================== the suite

async function runTenant(tenant, { extended }) {
  const { tenantId, name } = tenant;
  currentTenantLabel = name;
  const ref = await getTenantReferenceDate(tenantId);
  const P = periodSet(ref, { wide: extended });
  const E = async (plan) => engineOrThrow(await executeQuery(plan, { tenantId, referenceDate: ref }));
  const S = (extra) => ({ v: 1, entity: "sales", mode: "aggregate", ...extra });
  const B = (extra) => ({ v: 1, entity: "purchase", mode: "aggregate", ...extra });

  console.log(`\n##### TENANT ${name} (reference date ${ref.toISOString().slice(0, 10)}) #####`);

  // ---------------------------------------------------------- 1. summaries
  console.log("\n--- Totals: amount / count / average (existing: getSalesSummary, getPurchaseSummary) ---");
  for (const [pid, per] of Object.entries(P)) {
    await parity(
      "sales_summary",
      `sales ${pid}`,
      "existing",
      async () => {
        const s = await salesAnalytics.getSalesSummary(tenantId, per.oracle);
        return { amount: s.totalSales, count: s.orderCount, avg: s.averageOrderValue };
      },
      async () => {
        const t = (await E(S({ period: per.plan, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"] }))).totals.values;
        return { amount: t.invoiceAmount, count: t.invoiceCount, avg: t.averageInvoiceValue };
      }
    );
    await parity(
      "purchase_summary",
      `purchase ${pid}`,
      "existing",
      async () => {
        const s = await purchaseAnalytics.getPurchaseSummary(tenantId, per.oracle);
        return { amount: s.totalPurchases, count: s.orderCount, avg: s.averageOrderValue };
      },
      async () => {
        const t = (await E(B({ period: per.plan, metrics: ["purchaseAmount", "purchaseInvoiceCount", "averagePurchaseValue"] }))).totals.values;
        return { amount: t.purchaseAmount, count: t.purchaseInvoiceCount, avg: t.averagePurchaseValue };
      }
    );
  }

  // ---------------------------------------------------------- 2. rankings
  console.log("\n--- Rankings: customers / suppliers / products (existing top-N functions, tie-aware) ---");
  const rankPeriods = extended ? ["all_time", "current_quarter", "custom_aug_2025", "current_fy", "previous_month"] : ["all_time", "current_fy"];
  for (const pid of rankPeriods) {
    const per = P[pid];
    for (const n of [10, 100]) {
      await rankParity(
        "sales_by_customer",
        `top ${n} customers ${pid}`,
        "existing",
        async () => (await salesAnalytics.getTopCustomers(tenantId, per.oracle, { limit: 1e6 })).customers.map((c) => ({ name: c.customerName, amount: c.totalAmount, count: c.orderCount })),
        async () => (await E(S({ period: per.plan, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: n }))).rows.map((r) => ({ name: r.key.customer, amount: r.values.invoiceAmount, count: r.values.invoiceCount })),
        n,
        "amount"
      );
      await rankParity(
        "purchase_by_supplier",
        `top ${n} suppliers ${pid}`,
        "existing",
        async () => (await purchaseAnalytics.getTopSuppliers(tenantId, per.oracle, { limit: 1e6 })).suppliers.map((c) => ({ name: c.supplierName, amount: c.totalAmount, count: c.orderCount })),
        async () => (await E(B({ period: per.plan, metrics: ["purchaseAmount", "purchaseInvoiceCount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "purchaseAmount", dir: "desc" }], limit: n }))).rows.map((r) => ({ name: r.key.supplier, amount: r.values.purchaseAmount, count: r.values.purchaseInvoiceCount })),
        n,
        "amount"
      );
      await rankParity(
        "sales_by_product",
        `top ${n} products (lineAmount/quantity/lineCount) ${pid}`,
        "existing",
        async () => (await salesAnalytics.getTopProducts(tenantId, per.oracle, { limit: 1e6 })).items.map((p) => ({ name: p.itemName, amount: p.totalAmount, qty: p.totalQuantity, lines: p.orderCount })),
        async () => (await E(S({ period: per.plan, metrics: ["lineAmount", "quantity", "lineCount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: n }))).rows.map((r) => ({ name: r.key.product, amount: r.values.lineAmount, qty: r.values.quantity, lines: r.values.lineCount })),
        n,
        "amount"
      );
      await rankParity(
        "purchase_by_product",
        `top ${n} purchased products ${pid}`,
        "existing",
        async () => (await purchaseAnalytics.getTopPurchasedProducts(tenantId, per.oracle, { limit: 1e6 })).items.map((p) => ({ name: p.itemName, amount: p.totalAmount, qty: p.totalQuantity, lines: p.orderCount })),
        async () => (await E(B({ period: per.plan, metrics: ["lineAmount", "quantity", "lineCount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: n }))).rows.map((r) => ({ name: r.key.product, amount: r.values.lineAmount, qty: r.values.quantity, lines: r.values.lineCount })),
        n,
        "amount"
      );
    }
  }

  // ---------------------------------------------------------- 3. customer lookup
  console.log("\n--- Customer-specific sales (existing: getCustomerSales) ---");
  const allCustomers = (await salesAnalytics.getTopCustomers(tenantId, P.all_time.oracle, { limit: 1e6 })).customers.map((c) => c.customerName);
  const special = allCustomers.filter((n) => /[.()&\-+*?\[\]|\\$^]/.test(n)).slice(0, 5);
  const names = [...new Set([...allCustomers.slice(0, 5), ...special])];
  const lookupPeriods = extended ? ["all_time", "previous_month", "custom_aug_2025", "current_quarter"] : ["all_time"];
  const variants = (n) => [n, n.toLowerCase(), n.toUpperCase()];
  for (const cname of extended ? names : names.slice(0, 3)) {
    for (const pid of lookupPeriods) {
      for (const v of pid === "all_time" ? variants(cname) : [cname]) {
        await parity(
          "sales_customer_lookup",
          `${JSON.stringify(v)} ${pid}`,
          "existing",
          async () => {
            const c = await salesAnalytics.getCustomerSales(tenantId, v, P[pid].oracle);
            return { amount: c.totalSales === null ? 0 : c.totalSales, count: c.orderCount === null ? 0 : c.orderCount, avg: c.averageOrderValue === null ? 0 : c.averageOrderValue };
          },
          async () => {
            const t = (await E(S({ period: P[pid].plan, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"], filters: [{ dim: "customer", op: "eq_ci", value: v }] }))).totals.values;
            return { amount: t.invoiceAmount, count: t.invoiceCount, avg: t.averageInvoiceValue };
          }
        );
      }
    }
  }
  await parity(
    "sales_customer_lookup",
    "unknown customer -> zeros (oracle customerFound=false)",
    "existing",
    async () => {
      const c = await salesAnalytics.getCustomerSales(tenantId, "NO SUCH CUSTOMER 123", P.all_time.oracle);
      return { found: c.customerFound, amount: c.totalSales === null ? 0 : c.totalSales };
    },
    async () => {
      const t = (await E(S({ period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [{ dim: "customer", op: "eq_ci", value: "NO SUCH CUSTOMER 123" }] }))).totals.values;
      return { found: t.invoiceCount > 0, amount: t.invoiceAmount };
    }
  );
  await parity(
    "sales_customer_lookup",
    "anchored match: a prefix of a real name matches nothing (as the oracle)",
    "existing",
    async () => {
      const c = await salesAnalytics.getCustomerSales(tenantId, allCustomers[0].slice(0, Math.max(3, allCustomers[0].length - 2)), P.all_time.oracle);
      return { count: c.orderCount === null ? 0 : c.orderCount };
    },
    async () => ({ count: (await E(S({ period: { kind: "all_time" }, metrics: ["invoiceCount"], filters: [{ dim: "customer", op: "eq_ci", value: allCustomers[0].slice(0, Math.max(3, allCustomers[0].length - 2)) }] }))).totals.values.invoiceCount })
  );

  // ---------------------------------------------------------- 4. product groups
  console.log("\n--- Product groups (existing: getTopStockGroups) ---");
  const groupPeriods = extended ? ["all_time", "current_quarter", "previous_quarter", "custom_aug_2025", "current_fy", "empty_2024"] : ["all_time", "current_fy"];
  for (const pid of groupPeriods) {
    const per = P[pid];
    await rankParity(
      "sales_by_product_group",
      `groups amount+quantity ${pid}`,
      "existing",
      async () => (await stockGroupAnalytics.getTopStockGroups(tenantId, per.oracle, null, null, { limit: 1e6 })).items.map((g) => ({ name: g.stockGroupName, amount: g.salesAmount, qty: g.salesQuantity })),
      async () => (await E(S({ period: per.plan, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 100 }))).rows.map((r) => ({ name: r.key.productGroup, amount: r.values.lineAmount, qty: r.values.quantity })),
      100,
      "amount"
    );
    await parity(
      "sales_by_product_group",
      `groups totals + mapping diagnostics ${pid}`,
      "existing",
      async () => {
        const o = await stockGroupAnalytics.getTopStockGroups(tenantId, per.oracle, null, null, { limit: 1e6 });
        return {
          totalAmount: o.summary.currentPeriod.totalAmount,
          totalQuantity: o.summary.currentPeriod.totalQuantity,
          groups: o.totalGroups,
          mappedLines: o.mapping.mappedLines,
          unmappedLines: o.mapping.unmappedLines,
          mappedAmount: o.mapping.mappedAmount,
          unmappedAmount: o.mapping.unmappedAmount,
        };
      },
      async () => {
        const e = await E(S({ period: per.plan, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 100 }));
        return {
          totalAmount: e.totals.values.lineAmount,
          totalQuantity: e.totals.values.quantity,
          groups: e.rows.length,
          mappedLines: e.mapping.mappedLines,
          unmappedLines: e.mapping.unmappedLines,
          mappedAmount: e.mapping.mappedLineAmount,
          unmappedAmount: e.mapping.unmappedLineAmount,
        };
      }
    );
  }
  assertCase("sales_by_product_group", "amount basis strings agree (stock group 'line_item_pre_tax' == engine lineAmount basis)", stockGroupAnalytics.AMOUNT_BASIS === catalog.CATALOG.metrics.lineAmount.amountBasis);

  // Stock groups WITH comparison (like-for-like MoM + YoY), per group
  if (extended) {
    for (const pid of ["current_quarter", "current_month", "current_fy"]) {
      const per = P[pid];
      const prev = periodEngine.resolveComparisonPeriod(pid, ref);
      const yoy = periodEngine.resolveSamePeriodLastYear(pid, ref);
      const oracleFn = () => stockGroupAnalytics.getTopStockGroups(tenantId, per.oracle, prev, yoy, { limit: 1e6 });
      await parity(
        "sales_by_product_group",
        `per-group like-for-like MoM: previous amount, delta, delta% ${pid}`,
        "existing",
        async () => {
          const o = await oracleFn();
          const m = {};
          for (const g of o.items) m[g.stockGroupName] = { cur: g.salesAmount, prev: g.previousPeriodAmount, delta: g.momGrowthAmount, pct: g.momGrowthPercentage };
          return m;
        },
        async () => {
          const e = await E(S({ period: per.plan, metrics: ["lineAmount", "quantity"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 100 }));
          const m = {};
          for (const r of e.rows.filter((x) => x.presence !== "previous_only")) m[r.key.productGroup] = { cur: r.values.lineAmount, prev: r.comparison.lineAmount.previous, delta: r.comparison.lineAmount.delta, pct: r.comparison.lineAmount.deltaPct };
          return m;
        }
      );
      await parity(
        "sales_by_product_group",
        `overall MoM growth + previous total ${pid}`,
        "existing",
        async () => {
          const o = await oracleFn();
          return { prevTotal: o.summary.previousPeriod.totalAmount, delta: o.summary.momGrowth.growthAmount, pct: o.summary.momGrowth.growthPercentage };
        },
        async () => {
          const e = await E(S({ period: per.plan, metrics: ["lineAmount", "quantity"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 100 }));
          const c = e.totals.comparison.lineAmount;
          return { prevTotal: c.previous, delta: c.delta, pct: c.deltaPct };
        }
      );
      await parity(
        "sales_by_product_group",
        `per-group YoY (same_period_last_year) ${pid}`,
        "existing",
        async () => {
          const o = await oracleFn();
          const m = {};
          for (const g of o.items) m[g.stockGroupName] = { prev: g.samePeriodLastYearAmount, delta: g.yoyGrowthAmount, pct: g.yoyGrowthPercentage };
          return m;
        },
        async () => {
          const e = await E(S({ period: per.plan, metrics: ["lineAmount"], compare: { mode: "same_period_last_year" }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 100 }));
          const m = {};
          for (const r of e.rows.filter((x) => x.presence !== "previous_only")) m[r.key.productGroup] = { prev: r.comparison.lineAmount.previous, delta: r.comparison.lineAmount.delta, pct: r.comparison.lineAmount.deltaPct };
          return m;
        }
      );
    }
  }

  // ---------------------------------------------------------- 5. trends
  console.log("\n--- Monthly trend (existing: getSalesTrend, getPurchaseTrend) ---");
  const trendPeriods = extended ? ["current_fy", "custom_cross_month", "all_time", "previous_quarter", "empty_2024"] : ["current_fy", "all_time"];
  for (const pid of trendPeriods) {
    const per = P[pid];
    await parity(
      "sales_trend",
      `sales monthly ${pid}`,
      "existing",
      async () => (await salesAnalytics.getSalesTrend(tenantId, per.oracle)).items.map((i) => ({ month: `${i.year}-${pad2(i.month)}`, amount: i.totalSales, count: i.orderCount })),
      async () => (await E(S({ period: per.plan, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }] }))).rows.map((r) => ({ month: r.key.date.label, amount: r.values.invoiceAmount, count: r.values.invoiceCount }))
    );
    await parity(
      "purchase_trend",
      `purchase monthly ${pid}`,
      "existing",
      async () => (await purchaseAnalytics.getPurchaseTrend(tenantId, per.oracle)).items.map((i) => ({ month: `${i.year}-${pad2(i.month)}`, amount: i.totalPurchases, count: i.orderCount })),
      async () => (await E(B({ period: per.plan, metrics: ["purchaseAmount", "purchaseInvoiceCount"], groupBy: [{ dim: "date", bucket: "month" }] }))).rows.map((r) => ({ month: r.key.date.label, amount: r.values.purchaseAmount, count: r.values.purchaseInvoiceCount }))
    );
  }

  // ---------------------------------------------------------- 6. period comparisons
  console.log("\n--- Period comparison totals (existing: getSalesComparison, getPurchaseComparison) ---");
  const pairs = [
    ["current_month", "like_for_like", () => periodEngine.resolveComparisonPeriod("current_month", ref)],
    ["current_month", "full_previous", () => periodEngine.resolvePeriod("previous_month", ref)],
    ["current_quarter", "like_for_like", () => periodEngine.resolveComparisonPeriod("current_quarter", ref)],
    ["current_quarter", "full_previous", () => periodEngine.resolvePeriod("previous_quarter", ref)],
    ["current_fy", "like_for_like", () => periodEngine.resolveComparisonPeriod("current_fy", ref)],
    ["previous_month", "like_for_like", () => periodEngine.resolveComparisonPeriod("previous_month", ref)],
    ["current_month", "same_period_last_year", () => periodEngine.resolveSamePeriodLastYear("current_month", ref)],
  ];
  const cmpNorm = (cur, prev, growthAmount, growthPct) => ({ cur, prev, growthAmount, growthPct });
  for (const [kind, mode, prevFn] of pairs) {
    const prevPeriod = prevFn();
    const curPeriod = P[kind].oracle;
    await parity(
      "sales_period_comparison",
      `sales ${kind} ${mode}`,
      "existing",
      async () => {
        const o = await salesAnalytics.getSalesComparison(tenantId, curPeriod, prevPeriod);
        return cmpNorm({ a: o.current.totalSales, n: o.current.orderCount, v: o.current.averageOrderValue }, { a: o.previous.totalSales, n: o.previous.orderCount, v: o.previous.averageOrderValue }, o.growthAmount, o.growthPercentage);
      },
      async () => {
        const t = (await E(S({ period: P[kind].plan, compare: { mode }, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"] }))).totals;
        return cmpNorm(
          { a: t.values.invoiceAmount, n: t.values.invoiceCount, v: t.values.averageInvoiceValue },
          { a: t.comparison.invoiceAmount.previous, n: t.comparison.invoiceCount.previous, v: t.comparison.averageInvoiceValue.previous },
          t.comparison.invoiceAmount.delta,
          t.comparison.invoiceAmount.deltaPct
        );
      }
    );
    await parity(
      "purchase_period_comparison",
      `purchase ${kind} ${mode}`,
      "existing",
      async () => {
        const o = await purchaseAnalytics.getPurchaseComparison(tenantId, curPeriod, prevPeriod);
        return cmpNorm({ a: o.current.totalPurchases, n: o.current.orderCount }, { a: o.previous.totalPurchases, n: o.previous.orderCount }, o.growthAmount, o.growthPercentage);
      },
      async () => {
        const t = (await E(B({ period: P[kind].plan, compare: { mode }, metrics: ["purchaseAmount", "purchaseInvoiceCount"] }))).totals;
        return cmpNorm({ a: t.values.purchaseAmount, n: t.values.purchaseInvoiceCount }, { a: t.comparison.purchaseAmount.previous, n: t.comparison.purchaseInvoiceCount.previous }, t.comparison.purchaseAmount.delta, t.comparison.purchaseAmount.deltaPct);
      }
    );
  }
  // custom-vs-custom (both existing oracles take any two periods)
  {
    const cur = dateRanges.customRange("2025-08-01", "2025-08-31");
    const prev = dateRanges.customRange("2025-07-01", "2025-07-31");
    const plan = { period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } } };
    await parity(
      "sales_period_comparison",
      "sales custom Aug vs custom Jul",
      "existing",
      async () => {
        const o = await salesAnalytics.getSalesComparison(tenantId, cur, prev);
        return cmpNorm({ a: o.current.totalSales, n: o.current.orderCount }, { a: o.previous.totalSales, n: o.previous.orderCount }, o.growthAmount, o.growthPercentage);
      },
      async () => {
        const t = (await E(S({ ...plan, metrics: ["invoiceAmount", "invoiceCount"] }))).totals;
        return cmpNorm({ a: t.values.invoiceAmount, n: t.values.invoiceCount }, { a: t.comparison.invoiceAmount.previous, n: t.comparison.invoiceCount.previous }, t.comparison.invoiceAmount.delta, t.comparison.invoiceAmount.deltaPct);
      }
    );
    await parity(
      "sales_period_comparison",
      "growth% is null (not Infinity/0) when the previous period is empty - oracle vs engine",
      "existing",
      async () => {
        const o = await salesAnalytics.getSalesComparison(tenantId, cur, dateRanges.customRange("2024-01-01", "2024-01-31"));
        return { pct: o.growthPercentage, amount: o.growthAmount };
      },
      async () => {
        const t = (await E(S({ period: plan.period, compare: { mode: "custom", period: { kind: "custom", from: "2024-01-01", to: "2024-01-31" } }, metrics: ["invoiceAmount"] }))).totals;
        return { pct: t.comparison.invoiceAmount.deltaPct, amount: t.comparison.invoiceAmount.delta };
      }
    );
  }
  // The REST analytics comparison periods == the engine's like_for_like / same-period-last-year
  {
    const t1 = dateRanges.resolveRequestComparison("vs_previous_month", ref);
    const lfl = periodEngine.resolveComparisonPeriod("current_month", ref);
    assertCase("sales_period_comparison", "REST 'vs_previous_month' periods == engine current_month like_for_like (same ranges)", t1.current.from.getTime() === P.current_month.oracle.from.getTime() && t1.previous.from.getTime() === lfl.from.getTime() && t1.previous.to.getTime() === lfl.to.getTime());
    const t2 = dateRanges.resolveRequestComparison("vs_same_month_last_year", ref);
    const sply = periodEngine.resolveSamePeriodLastYear("current_month", ref);
    assertCase("sales_period_comparison", "REST 'vs_same_month_last_year' periods == engine same_period_last_year", t2.previous.from.getTime() === sply.from.getTime() && t2.previous.to.getTime() === sply.to.getTime());
  }

  // ---------------------------------------------------------- 7. product growth / decline
  console.log("\n--- Product growth & decline (existing: getDecliningProducts, getTopGrowingProducts) ---");
  const gdPairs = [
    ["current_month", () => periodEngine.resolveComparisonPeriod("current_month", ref), { mode: "like_for_like" }],
    ["current_quarter", () => periodEngine.resolveComparisonPeriod("current_quarter", ref), { mode: "like_for_like" }],
    ["custom_aug_2025", () => dateRanges.customRange("2025-07-01", "2025-07-31"), { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } }],
  ];
  for (const [pid, prevFn, compare] of extended ? gdPairs : gdPairs.slice(1, 2)) {
    const prev = prevFn();
    const per = P[pid];
    const norm = (items) => items.map((i) => ({ name: i.itemName, cur: i.current, prev: i.previous, delta: i.growthAmount, pct: i.growthPercentage, isNew: i.isNew }));
    const withScore = (rows, sign) => rows.map((r) => ({ ...r, score: sign * r.delta }));
    const engineFull = async (having, sort) => {
      const e = await E(S({ period: per.plan, metrics: ["lineAmount"], compare, groupBy: [{ dim: "product" }], having, sort, limit: 100 }));
      return e.rows.map((r) => ({ name: r.key.product, cur: r.values.lineAmount, prev: r.comparison.lineAmount.previous, delta: r.comparison.lineAmount.delta, pct: r.comparison.lineAmount.deltaPct, isNew: r.presence === "current_only" }));
    };

    // Same MEMBERS and per-item values: top 100 by largest fall, compared tie-aware against the oracle's COMPLETE declining set.
    await rankParity(
      "sales_product_growth_decline",
      `declining products: same members + per-item values, top 100 by fall (${pid})`,
      "existing",
      async () => withScore(norm((await salesAnalytics.getDecliningProducts(tenantId, per.oracle, prev, { limit: 1e6 })).items), -1),
      async () => withScore(await engineFull([{ metric: "lineAmount.delta", op: "lt", value: 0 }], [{ by: "lineAmount.delta", dir: "asc" }]), -1),
      100,
      "score"
    );
    // The existing function RANKS by growth% ascending; the engine can express that ordering exactly.
    await parity(
      "sales_product_growth_decline",
      `declining products: ranked by growth% ascending, top 100 (${pid})`,
      "existing",
      async () => norm((await salesAnalytics.getDecliningProducts(tenantId, per.oracle, prev, { limit: 100 })).items).map((x) => x.pct),
      async () => (await engineFull([{ metric: "lineAmount.delta", op: "lt", value: 0 }], [{ by: "lineAmount.deltaPct", dir: "asc" }])).map((x) => x.pct)
    );
    await rankParity(
      "sales_product_growth_decline",
      `growing products: same members + per-item values incl. new-product flag, top 100 by gain (${pid})`,
      "existing",
      async () => withScore(norm((await salesAnalytics.getTopGrowingProducts(tenantId, per.oracle, prev, { limit: 1e6 })).items), 1),
      async () => withScore(await engineFull([{ metric: "lineAmount.delta", op: "gt", value: 0 }], [{ by: "lineAmount.delta", dir: "desc" }]), 1),
      100,
      "score"
    );
  }
  // NOTE (documented, intentional): getTopGrowingProducts lists NEW products first, then by growth%.
  // The DSL cannot sort 'new first' (nulls sort last), so ORDER parity is asserted for declining products only.

  if (!extended) return;

  // ================================================================ independent oracles (no existing function)
  console.log("\n--- Independent oracles (no existing function): JS over lean documents ---");
  const groupMap = await loadGroupMap(tenantId);

  // I1 voucherType
  for (const pid of ["all_time", "current_fy", "custom_aug_2025"]) {
    await parity(
      "sales_by_voucher_type",
      `sales by voucherType ${pid}`,
      "independent",
      async () => {
        const m = new Map();
        for (const v of await loadVouchers(Sale, tenantId, P[pid].oracle)) sumBy(m, v.header.voucherType, { a: v.header.voucherTotalAmount, n: 1 });
        return [...m.entries()].map(([k, x]) => ({ k, a: x.a, n: x.n })).sort((a, b) => cmpStr(a.k, b.k));
      },
      async () => (await E(S({ period: P[pid].plan, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "voucherType" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }))).rows.map((r) => ({ k: r.key.voucherType, a: r.values.invoiceAmount, n: r.values.invoiceCount })).sort((a, b) => cmpStr(a.k, b.k))
    );
  }

  // I2 customer x product (2 dimensions)
  await rankParity(
    "sales_two_dimension_grouping",
    "top 50 customer x product by lineAmount (all_time)",
    "independent",
    async () => {
      const m = new Map();
      for (const v of await loadVouchers(Sale, tenantId, P.all_time.oracle)) for (const l of v.inventory) sumBy(m, `${v.header.partyName}\u0001${l.itemName}`, { a: l.amount, q: l.quantity });
      return [...m.entries()].map(([k, x]) => ({ name: k.replace("\u0001", " | "), amount: x.a, qty: x.q }));
    },
    async () => (await E(S({ period: { kind: "all_time" }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "customer" }, { dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 50 }))).rows.map((r) => ({ name: `${r.key.customer} | ${r.key.product}`, amount: r.values.lineAmount, qty: r.values.quantity })),
    50,
    "amount"
  );

  // I3 date buckets
  for (const [bucket, pid] of [["day", "custom_aug_2025"], ["week", "custom_cross_month"], ["month", "all_time"], ["quarter", "all_time"], ["fy", "all_time"]]) {
    await parity(
      "sales_date_buckets",
      `sales by ${bucket} bucket, ${pid}`,
      "independent",
      async () => {
        const m = new Map();
        for (const v of await loadVouchers(Sale, tenantId, P[pid].oracle)) sumBy(m, bucketStart(v.header.voucherDate, bucket), { a: v.header.voucherTotalAmount, n: 1 });
        return [...m.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([k, x]) => ({ start: k, a: x.a, n: x.n }));
      },
      async () => (await E(S({ period: P[pid].plan, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket }], sort: [{ by: "date", dir: "asc" }] }))).rows.map((r) => ({ start: r.key.date.start, a: r.values.invoiceAmount, n: r.values.invoiceCount }))
    );
  }
  await parity(
    "purchase_date_buckets",
    "purchases by week bucket, custom_cross_month",
    "independent",
    async () => {
      const m = new Map();
      for (const v of await loadVouchers(Purchase, tenantId, P.custom_cross_month.oracle)) sumBy(m, bucketStart(v.header.voucherDate, "week"), { a: v.header.voucherTotalAmount, n: 1 });
      return [...m.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([k, x]) => ({ start: k, a: x.a, n: x.n }));
    },
    async () => (await E(B({ period: P.custom_cross_month.plan, metrics: ["purchaseAmount", "purchaseInvoiceCount"], groupBy: [{ dim: "date", bucket: "week" }], sort: [{ by: "date", dir: "asc" }] }))).rows.map((r) => ({ start: r.key.date.start, a: r.values.purchaseAmount, n: r.values.purchaseInvoiceCount }))
  );

  // I4 invoice lists
  for (const [label, filterName] of [["largest 10 invoices all_time", null], ["largest 10 invoices for top customer", allCustomers[0]]]) {
    await parity(
      "invoice_list",
      label,
      "independent",
      async () => {
        const docs = (await loadVouchers(Sale, tenantId, P.all_time.oracle)).filter((v) => !filterName || v.header.partyName.toLowerCase() === filterName.toLowerCase());
        docs.sort((a, b) => b.header.voucherTotalAmount - a.header.voucherTotalAmount || cmpStr(String(a._id), String(b._id)));
        return docs.slice(0, 10).map((v) => ({ no: v.header.voucherNo, date: v.header.voucherDate.toISOString().slice(0, 10), party: v.header.partyName, type: v.header.voucherType, amount: v.header.voucherTotalAmount }));
      },
      async () => (await E({ v: 1, entity: "sales", mode: "list", period: { kind: "all_time" }, filters: filterName ? [{ dim: "customer", op: "eq_ci", value: filterName }] : [], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 })).rows.map((r) => ({ no: r.voucherNo, date: r.date, party: r.customer, type: r.voucherType, amount: r.invoiceAmount }))
    );
  }
  await parity(
    "invoice_list",
    "purchase list: latest 10 invoices by date desc (all_time)",
    "independent",
    async () => {
      const docs = await loadVouchers(Purchase, tenantId, P.all_time.oracle);
      docs.sort((a, b) => b.header.voucherDate - a.header.voucherDate || cmpStr(String(a._id), String(b._id)));
      return docs.slice(0, 10).map((v) => ({ no: v.header.voucherNo, date: v.header.voucherDate.toISOString().slice(0, 10), amount: v.header.voucherTotalAmount }));
    },
    async () => (await E({ v: 1, entity: "purchase", mode: "list", period: { kind: "all_time" }, sort: [{ by: "date", dir: "desc" }], limit: 10 })).rows.map((r) => ({ no: r.voucherNo, date: r.date, amount: r.purchaseAmount }))
  );

  // I5-I8 filters
  const topCustomerLower = allCustomers[0].toLowerCase();
  const frag = (allCustomers.find((n) => n.trim().length >= 6) || allCustomers[0]).slice(1, 6).trim().toLowerCase();
  const someItem = (await salesAnalytics.getTopProducts(tenantId, P.all_time.oracle, { limit: 3 })).items[2].itemName;
  const someGroup = [...groupMap.values()][0];
  await parity(
    "sales_filters",
    "customer contains_ci fragment",
    "independent",
    async () => {
      const docs = (await loadVouchers(Sale, tenantId, P.all_time.oracle)).filter((v) => v.header.partyName.toLowerCase().includes(frag));
      return { a: docs.reduce((s, v) => s + v.header.voucherTotalAmount, 0), n: docs.length };
    },
    async () => {
      const t = (await E(S({ period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [{ dim: "customer", op: "contains_ci", value: frag }] }))).totals.values;
      return { a: t.invoiceAmount, n: t.invoiceCount };
    }
  );
  await parity(
    "sales_filters",
    "customer in_ci (two names, mixed case)",
    "independent",
    async () => {
      const want = new Set([allCustomers[0].toLowerCase(), allCustomers[1].toLowerCase()]);
      const docs = (await loadVouchers(Sale, tenantId, P.all_time.oracle)).filter((v) => want.has(v.header.partyName.toLowerCase()));
      return { a: docs.reduce((s, v) => s + v.header.voucherTotalAmount, 0), n: docs.length };
    },
    async () => {
      const t = (await E(S({ period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [{ dim: "customer", op: "in_ci", value: [allCustomers[0].toUpperCase(), allCustomers[1].toLowerCase()] }] }))).totals.values;
      return { a: t.invoiceAmount, n: t.invoiceCount };
    }
  );
  await parity(
    "sales_filters",
    "invoice-level: invoices CONTAINING a product (whole-invoice totals)",
    "independent",
    async () => {
      const docs = (await loadVouchers(Sale, tenantId, P.all_time.oracle)).filter((v) => v.inventory.some((l) => l.itemName.toLowerCase() === someItem.toLowerCase()));
      return { a: docs.reduce((s, v) => s + v.header.voucherTotalAmount, 0), n: docs.length };
    },
    async () => {
      const t = (await E(S({ period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [{ dim: "product", op: "eq_ci", value: someItem }] }))).totals.values;
      return { a: t.invoiceAmount, n: t.invoiceCount };
    }
  );
  await parity(
    "sales_filters",
    "invoice-level: invoices CONTAINING any item of a product group (item names resolved first)",
    "independent",
    async () => {
      const docs = (await loadVouchers(Sale, tenantId, P.all_time.oracle)).filter((v) => v.inventory.some((l) => (groupMap.get(l.itemName) || "").toLowerCase() === someGroup.toLowerCase()));
      return { a: docs.reduce((s, v) => s + v.header.voucherTotalAmount, 0), n: docs.length };
    },
    async () => {
      const t = (await E(S({ period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [{ dim: "productGroup", op: "eq_ci", value: someGroup }] }))).totals.values;
      return { a: t.invoiceAmount, n: t.invoiceCount };
    }
  );
  await parity(
    "sales_filters",
    "line-level: productGroup + customer filters on lineAmount/quantity",
    "independent",
    async () => {
      let a = 0;
      let q = 0;
      for (const v of await loadVouchers(Sale, tenantId, P.all_time.oracle)) {
        if (v.header.partyName.toLowerCase() !== topCustomerLower) continue;
        for (const l of v.inventory) if ((groupMap.get(l.itemName) || "").toLowerCase() === someGroup.toLowerCase()) (a += l.amount), (q += l.quantity);
      }
      return { a, q };
    },
    async () => {
      const t = (await E(S({ period: { kind: "all_time" }, metrics: ["lineAmount", "quantity"], filters: [{ dim: "productGroup", op: "eq_ci", value: someGroup }, { dim: "customer", op: "eq_ci", value: allCustomers[0] }] }))).totals.values;
      return { a: t.lineAmount, q: t.quantity };
    }
  );
  await parity(
    "sales_filters",
    "line-level: product contains_ci + voucherType filter",
    "independent",
    async () => {
      const needle = someItem.slice(0, 6).trim().toLowerCase();
      let a = 0;
      for (const v of await loadVouchers(Sale, tenantId, P.all_time.oracle)) {
        if (v.header.voucherType.toLowerCase() !== "invoice") continue;
        for (const l of v.inventory) if (l.itemName.toLowerCase().includes(needle)) a += l.amount;
      }
      return { a };
    },
    async () => ({ a: (await E(S({ period: { kind: "all_time" }, metrics: ["lineAmount"], filters: [{ dim: "product", op: "contains_ci", value: someItem.slice(0, 6).trim() }, { dim: "voucherType", op: "eq_ci", value: "invoice" }] }))).totals.values.lineAmount })
  );

  // I9 purchases by product group (no existing oracle)
  for (const pid of ["all_time", "current_quarter", "custom_aug_2025"]) {
    await rankParity(
      "purchase_by_product_group",
      `purchases by productGroup ${pid}`,
      "independent",
      async () => {
        const m = new Map();
        for (const v of await loadVouchers(Purchase, tenantId, P[pid].oracle)) for (const l of v.inventory) {
          const g = groupMap.get(l.itemName);
          // Tally stores purchase item amounts negative; the engine reports a purchase's line amount as a positive value (catalog entitySign).
          if (g) sumBy(m, g, { a: -l.amount, q: l.quantity });
        }
        return [...m.entries()].map(([k, x]) => ({ name: k, amount: x.a, qty: x.q }));
      },
      async () => (await E(B({ period: P[pid].plan, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 100 }))).rows.map((r) => ({ name: r.key.productGroup, amount: r.values.lineAmount, qty: r.values.quantity })),
      100,
      "amount"
    );
  }

  // I10 comparisons grouped by customer / supplier (no existing function)
  for (const [entity, Model, dim, metric] of [["sales", Sale, "customer", "invoiceAmount"], ["purchase", Purchase, "supplier", "purchaseAmount"]]) {
    for (const pid of ["current_quarter", "current_month"]) {
      const prev = periodEngine.resolveComparisonPeriod(pid, ref);
      const oracleList = async () => {
        const cur = new Map();
        const pre = new Map();
        for (const v of await loadVouchers(Model, tenantId, P[pid].oracle)) sumBy(cur, v.header.partyName, { a: v.header.voucherTotalAmount });
        for (const v of await loadVouchers(Model, tenantId, prev)) sumBy(pre, v.header.partyName, { a: v.header.voucherTotalAmount });
        const out = [];
        for (const k of new Set([...cur.keys(), ...pre.keys()])) {
          const c = cur.has(k) ? cur.get(k).a : 0;
          const p = pre.has(k) ? pre.get(k).a : 0;
          out.push({ name: k, cur: c, prev: p, delta: c - p, pct: p === 0 ? null : ((c - p) / Math.abs(p)) * 100, presence: cur.has(k) && pre.has(k) ? "both" : cur.has(k) ? "current_only" : "previous_only", fall: p - c });
        }
        return out;
      };
      const engineList = async (sort) => {
        const plan = entity === "sales" ? S : B;
        const e = await E(plan({ period: P[pid].plan, compare: { mode: "like_for_like" }, metrics: [metric], groupBy: [{ dim }], sort, limit: 100 }));
        return e.rows.map((r) => ({ name: r.key[dim], cur: r.values[metric], prev: r.comparison[metric].previous, delta: r.comparison[metric].delta, pct: r.comparison[metric].deltaPct, presence: r.presence, fall: -r.comparison[metric].delta }));
      };
      await rankParity(
        `${entity}_group_comparison`,
        `${entity} by ${dim}, ${pid} vs like-for-like: top 100 by current value (values, delta, delta%, presence)`,
        "independent",
        oracleList,
        () => engineList([{ by: metric, dir: "desc" }]),
        100,
        "cur"
      );
      await rankParity(
        `${entity}_group_comparison`,
        `${entity} by ${dim}, ${pid} vs like-for-like: top 100 by largest FALL (stopped-buying / declining)`,
        "independent",
        oracleList,
        () => engineList([{ by: `${metric}.delta`, dir: "asc" }]),
        100,
        "fall"
      );
      await rankParity(
        `${entity}_group_comparison`,
        `${entity} by ${dim}, ${pid} vs like-for-like: top 100 by largest GAIN`,
        "independent",
        oracleList,
        () => engineList([{ by: `${metric}.delta`, dir: "desc" }]),
        100,
        "delta"
      );
    }
  }
}

// ================================================================== main

(async () => {
  await connectDB();
  try {
    const companies = await Company.find({ isActive: true }).lean();
    const we = companies.find((c) => c.companyName === "WE FOUR");
    const other = companies.find((c) => c.companyName !== "WE FOUR" && c.tenantId !== (we && we.tenantId));
    if (!we) {
      console.log("  SKIPPED - the parity suite compares the engine with the existing analytics on the real WE FOUR tenant, which is not present in this database.");
      await mongoose.disconnect();
      process.exit(0);
    }

    await runTenant({ tenantId: we.tenantId, name: "WE FOUR" }, { extended: true });
    if (other) {
      await runTenant({ tenantId: other.tenantId, name: other.companyName }, { extended: false });

      // cross-tenant isolation under parity: each tenant's engine result equals its OWN oracle and differs from the other's
      currentTenantLabel = "cross-tenant";
      console.log("\n--- Cross-tenant isolation ---");
      const refW = await getTenantReferenceDate(we.tenantId);
      const refO = await getTenantReferenceDate(other.tenantId);
      const plan = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"] };
      const eW = await executeQuery(plan, { tenantId: we.tenantId, referenceDate: refW });
      const eO = await executeQuery(plan, { tenantId: other.tenantId, referenceDate: refO });
      const oW = await salesAnalytics.getSalesSummary(we.tenantId, { from: undefined, to: undefined });
      const oO = await salesAnalytics.getSalesSummary(other.tenantId, { from: undefined, to: undefined });
      assertCase("tenant_isolation", "each tenant's engine result equals its own oracle", close(eW.totals.values.invoiceAmount, oW.totalSales) && close(eO.totals.values.invoiceAmount, oO.totalSales) && eW.totals.values.invoiceCount === oW.orderCount && eO.totals.values.invoiceCount === oO.orderCount);
      assertCase("tenant_isolation", "the two tenants' results differ (no bleed-through)", eW.totals.values.invoiceCount !== eO.totals.values.invoiceCount && !close(eW.totals.values.invoiceAmount, eO.totals.values.invoiceAmount));
      const customersW = await executeQuery({ ...plan, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 100 }, { tenantId: we.tenantId, referenceDate: refW });
      const customersO = await executeQuery({ ...plan, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 100 }, { tenantId: other.tenantId, referenceDate: refO });
      const namesW = new Set(customersW.rows.map((r) => r.key.customer));
      assertCase("tenant_isolation", "no customer name appears in both tenants' engine results", customersO.rows.every((r) => !namesW.has(r.key.customer)));
    } else {
      console.log("\n(no second tenant found - cross-tenant parity skipped)");
    }
  } finally {
    // ---------------------------------------------------------- summary
    console.log("\n=================== PARITY SUMMARY ===================");
    const byCap = new Map();
    for (const r of results) {
      const key = `${r.cap} [${r.oracle}]`;
      if (!byCap.has(key)) byCap.set(key, { pass: 0, fail: 0 });
      byCap.get(key)[r.ok ? "pass" : "fail"] += 1;
    }
    for (const [k, v] of [...byCap.entries()].sort()) console.log(`  ${v.fail === 0 ? "OK  " : "FAIL"} ${k.padEnd(58)} ${v.pass}/${v.pass + v.fail}`);

    const declared = catalog.PARITY_ORACLES.map((o) => o.id);
    const covered = new Set(results.map((r) => r.cap));
    const missing = declared.filter((id) => !covered.has(id));
    console.log(`\n  Catalog oracles declared: ${declared.length}; exercised by this run: ${declared.length - missing.length}${missing.length ? `  MISSING: ${missing.join(", ")}` : ""}`);
    results.push({ tenant: "catalog", cap: "oracle_coverage", id: "every declared parity oracle was exercised", oracle: "assertion", ok: missing.length === 0, detail: missing.join(",") });

    const failed = results.filter((r) => !r.ok);
    const pass = results.length - failed.length;
    const perTenant = {};
    for (const r of results) perTenant[r.tenant] = (perTenant[r.tenant] || 0) + 1;
    console.log(`  Cases per tenant: ${oneLine(perTenant)}`);
    console.log(`  Oracle kinds: ${oneLine(results.reduce((a, r) => ((a[r.oracle] = (a[r.oracle] || 0) + 1), a), {}))}`);
    console.log(`\n=== RESULT: ${pass} passed, ${failed.length} failed ===`);
    if (failed.length) failed.slice(0, 25).forEach((f) => console.log(`  FAILED [${f.tenant}] [${f.cap}] ${f.id}: ${f.detail}`));
    await mongoose.disconnect();
    process.exit(failed.length ? 1 : 0);
  }
})().catch(async (e) => {
  console.error("PARITY SUITE CRASHED:", e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

"use strict";

/**
 * Phase 1B verification: validator + compiler + executor for the
 * Sales/Purchase Query DSL. NO Claude / Anthropic anywhere.
 *
 * Uses MongoDB with two clearly-labelled SYNTHETIC tenants
 * (TEST-TENANT-A/B-query-engine) whose expected values are hand-computed,
 * plus a small real-data smoke check on WE FOUR (independent aggregation).
 * All synthetic data is removed at the end, pass or fail.
 *
 * This is NOT the parity suite (Phase 1C).
 *
 * Run: node verify-query-engine.js         (SHOW_COMPILED=1 prints example pipelines)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Company = require("./src/models/company");

const catalog = require("./src/services/query/semanticCatalog");
const { validateQueryPlan, isValidatedPlan } = require("./src/services/query/validator");
const { compileQuery, assertPipelineSafe, escapeRegex } = require("./src/services/query/compile");
const { executeQuery, buildAggregate, formatDateKey } = require("./src/services/query/execute");
const { buildVoucherMatchStage } = require("./src/services/analytics/analyticsScope");
const periodEngine = require("./src/services/analytics/periodEngine");

const { CATALOG, LIMITS } = catalog;

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const near = (a, b, eps = 1e-6) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < eps;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Mid-period reference date, LOCAL noon (timezone-robust: same calendar day in any TZ).
const REF_DEC = new Date(2025, 11, 8, 12, 0, 0);
const REF_OCT20 = new Date(2025, 9, 20, 12, 0, 0);

const emitted = new Set(); // every error/warning code the validator produces
// ref: omitted -> mid-period default; null -> deliberately NO reference date.
const V = (plan, ref) => {
  const r = validateQueryPlan(plan, { referenceDate: ref === undefined ? REF_DEC : ref === null ? undefined : ref });
  (r.errors || []).forEach((e) => emitted.add(e.code));
  (r.warnings || []).forEach((w) => emitted.add(w.code));
  return r;
};

const base = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"] };
const purchaseBase = { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "current_month" }, metrics: ["purchaseAmount"] };

// ---------------------------------------------------------------- fixtures
const T_A = "TEST-TENANT-A-query-engine";
const T_B = "TEST-TENANT-B-query-engine";
const T_C = "TEST-TENANT-C-query-engine"; // float-noise tie fixtures (kept separate so tenant A/B totals stay simple)
const utc = (s) => new Date(`${s}T00:00:00.000Z`);
let guidSeq = 0;
function voucher(tenantId, no, date, party, total, lines, status = "active") {
  guidSeq += 1;
  return {
    tenantId,
    tallyGuid: `qe-${tenantId}-${guidSeq}`,
    tallyAlterId: guidSeq,
    voucherStatus: status,
    header: { voucherNo: no, voucherDate: utc(date), voucherType: "Invoice", voucherTotalAmount: total, narration: "", partyName: party },
    inventory: lines.map(([itemName, quantity, amount]) => ({ itemName, quantity, rate: quantity ? amount / quantity : 0, amount })),
    ledgers: [],
  };
}
const master = (tenantId, itemName, stockGroupName) => ({ tenantId, itemName, stockGroupName, tallyGuid: `qe-m-${tenantId}-${itemName}`, syncedAt: new Date() });

async function seed() {
  await cleanup();
  await Sale.insertMany([
    voucher(T_A, "S-V1", "2025-09-05", "Alpha Traders", 1180, [["ItemX", 10, 600], ["ItemY", 5, 400]]),
    voucher(T_A, "S-V2", "2025-09-25", "Beta Stores", 2360, [["ItemX", 20, 2000]]),
    voucher(T_A, "S-V3", "2025-10-05", "Alpha Traders", 590, [["ItemY", 5, 500]]),
    voucher(T_A, "S-V4", "2025-10-15", "Gamma Mart", 1770, [["ItemX", 15, 1400], ["ItemZ", 1, 100]]),
    voucher(T_A, "S-V5", "2025-10-25", "Alpha Traders", 1300, [["ItemX", 10, 1000]]),
    voucher(T_A, "S-V6", "2025-10-10", "Alpha Traders", 9999, [["ItemX", 999, 9999]], "cancelled"),
    voucher(T_A, "S-V7", "2025-10-12", "Alpha Traders", 8888, [["ItemX", 888, 8888]], "deleted"),
    voucher(T_B, "S-B1", "2025-10-05", "Alpha Traders", 999999, [["ItemX", 1000, 900000]]),
    // Tenant C: two customers whose totals are EQUAL to the paisa (0.3) but differ in the
    // last floating-point bit (0.1 + 0.2 = 0.30000000000000004).
    voucher(T_C, "S-C1", "2025-11-05", "Tie A", 0.3, [["ItemA", 1, 0.3]]),
    voucher(T_C, "S-C2", "2025-11-06", "Tie B", 0.1, [["ItemB", 1, 0.1]]),
    voucher(T_C, "S-C3", "2025-11-07", "Tie B", 0.2, [["ItemB", 1, 0.2]]),
  ]);
  await Purchase.insertMany([
    voucher(T_A, "P-1", "2025-10-02", "SupplierOne", 5900, [["ItemX", 50, 5000]]),
    voucher(T_A, "P-2", "2025-09-10", "SupplierTwo", 1180, [["ItemY", 10, 1000]]),
    voucher(T_B, "P-B1", "2025-10-02", "SupplierOne", 777777, [["ItemX", 1, 700000]]),
  ]);
  await StockItemMaster.insertMany([
    master(T_A, "ItemX", "GroupOne"),
    master(T_A, "ItemY", "GroupTwo"),
    master(T_B, "ItemX", "ForeignGroup"),
    master(T_B, "ItemY", "ForeignGroup"),
    master(T_C, "ItemA", "Tie GroupA"),
    master(T_C, "ItemB", "Tie GroupB"),
  ]);
}
async function cleanup() {
  const ids = { $in: [T_A, T_B, T_C] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), StockItemMaster.deleteMany({ tenantId: ids })]);
}

const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
const SEP = { kind: "custom", from: "2025-09-01", to: "2025-09-30" };
const run = (plan, tenantId = T_A, extra = {}) => executeQuery(plan, { tenantId, referenceDate: REF_OCT20, ...extra });
const rowMap = (r, dim) => Object.fromEntries((r.rows || []).map((x) => [x.key[dim], x]));

// ---------------------------------------------------------------- examples (same shapes as Phase 1A)
const EXAMPLES = [
  ["sales last month", { ...base, period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"] }],
  ["purchases last month", { ...purchaseBase, period: { kind: "previous_month" }, metrics: ["purchaseAmount", "purchaseInvoiceCount"] }],
  ["top 10 customers", { ...base, period: { kind: "current_fy" }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }],
  ["customers purchased less", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] }],
  ["customers stopped buying", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount", op: "eq", value: 0 }, { metric: "invoiceAmount.previous", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount.previous", dir: "desc" }] }],
  ["products sold the most", { ...base, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["products declined", { ...base, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "product" }], having: [{ metric: "lineAmount.delta", op: "lt", value: 0 }], sort: [{ by: "lineAmount.delta", dir: "asc" }] }],
  ["product groups grew", { ...base, period: { kind: "current_quarter" }, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount.delta", dir: "desc" }] }],
  ["what did I sell to X", { ...base, period: { kind: "all_time" }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], filters: [{ dim: "customer", op: "eq_ci", value: "Alpha Traders" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["purchased from supplier X", { ...purchaseBase, period: { kind: "all_time" }, filters: [{ dim: "supplier", op: "eq_ci", value: "SupplierOne" }] }],
  ["compare quarter with previous quarter", { ...base, period: { kind: "current_quarter" }, compare: { mode: "full_previous" } }],
  ["monthly sales", { ...base, period: { kind: "current_fy" }, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }], sort: [{ by: "date", dir: "asc" }], limit: 100 }],
  ["customers increased >20%", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 20 }], sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }] }],
  ["products contributing to decline", { ...base, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], totals: true }],
  ["average invoice value", { ...base, metrics: ["averageInvoiceValue"] }],
  ["largest invoices", { v: 1, entity: "sales", mode: "list", period: { kind: "current_fy" }, sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }],
  ["sales between two dates", { ...base, period: { kind: "custom", from: "2025-08-01", to: "2025-08-15" } }],
  ["invoices for customer/product", { v: 1, entity: "sales", mode: "list", period: { kind: "all_time" }, filters: [{ dim: "customer", op: "eq_ci", value: "Alpha Traders" }, { dim: "product", op: "contains_ci", value: "itemy" }], sort: [{ by: "date", dir: "desc" }] }],
  ["sales by voucher type", { ...base, groupBy: [{ dim: "voucherType" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }],
  ["purchases by product group", { ...purchaseBase, period: { kind: "current_quarter" }, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["customer x product", { ...base, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }, { dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["weekly sales", { ...base, groupBy: [{ dim: "date", bucket: "week" }] }],
  ["sales in FY 2024-25", { ...base, period: { kind: "specific_fy", fy: "2024-25" } }],
  ["vs same period last year", { ...base, compare: { mode: "same_period_last_year" } }],
  ["two explicit ranges", { ...base, period: OCT, compare: { mode: "custom", period: SEP } }],
  ["name fragment list", { ...base, groupBy: [{ dim: "customer" }], filters: [{ dim: "customer", op: "in_ci", value: ["Alpha Traders", "Gamma Mart"] }], sort: [{ by: "invoiceAmount", dir: "desc" }] }],
  ["purchases of a group vs prior quarter", { ...purchaseBase, period: { kind: "current_quarter" }, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] }],
];

(async () => {
  await connectDB();
  try {
    await seed();

    // ================================================================
    section("1. Validator: every example question validates (positive)");
    // ================================================================
    for (const [q, plan] of EXAMPLES) {
      const r = V(plan);
      check(q, r.ok, r.ok ? "" : JSON.stringify(r.errors));
    }
    {
      const r = V({ ...base, groupBy: [{ dim: "date", bucket: "month" }], sort: [{ by: "date", dir: "asc" }] });
      check("date series defaults to limit 100 (not 10)", r.ok && r.normalized.limit === 100);
      const r2 = V({ ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] });
      check("ranking defaults to limit 10", r2.ok && r2.normalized.limit === 10);
      const r3 = V({ ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 25 });
      check("explicit limit is honoured", r3.ok && r3.normalized.limit === 25);
      const r4 = V({ ...base, groupBy: [{ dim: "date", bucket: "month" }] });
      check("a date series with no sort gets the default date-asc sort", r4.ok && same(r4.normalized.sort, [{ by: "date", dir: "asc" }]));
      const r5 = V({ ...base, groupBy: [{ dim: "voucherType" }] });
      check("low-cardinality groupBy without sort is allowed and gets a metric-desc default", r5.ok && r5.normalized.sort[0].by === "invoiceAmount");
      check("the validated plan is deeply frozen", Object.isFrozen(r.normalized) && Object.isFrozen(r.normalized.metrics) && Object.isFrozen(r.normalized.period));
      check("only validator output carries the brand", isValidatedPlan(r.normalized) && !isValidatedPlan({ ...r.normalized }) && !isValidatedPlan(structuredClone(r.normalized)));
    }

    // ================================================================
    section("2. Validator: semantic refusals (negative)");
    // ================================================================
    const refusal = (label, plan, code, ref) => {
      const r = V(plan, ref);
      const codes = r.ok ? [] : r.errors.map((e) => e.code);
      check(`${label} -> ${code}`, r.ok === false && codes.includes(code), r.ok ? "ACCEPTED" : codes.join(","));
      return r;
    };
    refusal("purchase entity with a sales metric", { ...purchaseBase, metrics: ["invoiceAmount"] }, "metric_not_applicable_to_entity");
    refusal("sales entity with a purchase metric", { ...base, metrics: ["purchaseAmount"] }, "metric_not_applicable_to_entity");
    refusal("customer dimension on purchases", { ...purchaseBase, groupBy: [{ dim: "customer" }], sort: [{ by: "purchaseAmount", dir: "desc" }] }, "dimension_not_applicable_to_entity");
    refusal("supplier filter on sales", { ...base, filters: [{ dim: "supplier", op: "eq_ci", value: "X" }] }, "dimension_not_applicable_to_entity");
    {
      const r = refusal("invoice total grouped by product", { ...base, groupBy: [{ dim: "product" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }, "dimension_not_applicable_to_voucher_metric");
      check("...and the refusal explains why (no invented tax allocation)", /allocation/.test(r.errors.map((e) => e.message).join(" ")));
    }
    refusal("invoice count grouped by productGroup", { ...base, metrics: ["invoiceCount"], groupBy: [{ dim: "productGroup" }] }, "dimension_not_applicable_to_voucher_metric");
    refusal("average invoice value by product", { ...base, metrics: ["averageInvoiceValue"], groupBy: [{ dim: "product" }], sort: [{ by: "averageInvoiceValue", dir: "desc" }] }, "dimension_not_applicable_to_voucher_metric");
    refusal("mixed voucher + line metrics", { ...base, metrics: ["invoiceAmount", "lineAmount"] }, "mixed_metric_grains");
    refusal("compare on a date series", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "date", bucket: "month" }] }, "compare_not_supported_with_date_groupby");
    refusal("like_for_like on a custom period", { ...base, period: OCT, compare: { mode: "like_for_like" } }, "compare_mode_unsupported_for_period");
    refusal("full_previous on a custom period", { ...base, period: OCT, compare: { mode: "full_previous" } }, "compare_mode_unsupported_for_period");
    refusal("like_for_like on same_month_last_year", { ...base, period: { kind: "same_month_last_year" }, compare: { mode: "like_for_like" } }, "compare_mode_unsupported_for_period");
    refusal("full_previous on ytd (no complete previous kind)", { ...base, period: { kind: "ytd" }, compare: { mode: "full_previous" } }, "compare_mode_unsupported_for_period");
    refusal("compare on all_time", { ...base, period: { kind: "all_time" }, compare: { mode: "same_period_last_year" } }, "all_time_cannot_compare");
    refusal("custom compare on all_time", { ...base, period: { kind: "all_time" }, compare: { mode: "custom", period: OCT } }, "all_time_cannot_compare");
    refusal("derived sort ref without compare", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] }, "derived_ref_requires_compare");
    refusal("derived having ref without compare", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 1 }] }, "derived_ref_requires_compare");
    refusal("having on an unselected metric", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], having: [{ metric: "invoiceCount", op: "gt", value: 1 }] }, "ref_not_selected");
    refusal("sort by an unselected metric", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceCount", dir: "desc" }] }, "ref_not_selected");
    refusal("sort by a dimension that is not grouped", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "voucherType", dir: "asc" }] }, "ref_not_selected");
    refusal("voucherNo sort in an aggregate query", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "voucherNo", dir: "asc" }] }, "ref_not_selected");
    refusal("having with no groupBy", { ...base, having: [{ metric: "invoiceAmount", op: "gt", value: 1 }] }, "having_requires_groupby");
    refusal("high-cardinality groupBy (customer) with no sort", { ...base, groupBy: [{ dim: "customer" }] }, "high_cardinality_requires_sort");
    refusal("high-cardinality groupBy (product) with no sort", { ...base, metrics: ["lineAmount"], groupBy: [{ dim: "product" }] }, "high_cardinality_requires_sort");
    refusal("custom range over the 5-year cap", { ...base, period: { kind: "custom", from: "2015-01-01", to: "2025-12-31" } }, "range_too_long");
    refusal("custom comparison range over the cap", { ...base, period: OCT, compare: { mode: "custom", period: { kind: "custom", from: "2010-01-01", to: "2025-12-31" } } }, "range_too_long");
    refusal("daily series over a fiscal year (~250 buckets)", { ...base, period: { kind: "current_fy" }, groupBy: [{ dim: "date", bucket: "day" }] }, "series_too_long");
    refusal("all_time daily series (unbounded)", { ...base, period: { kind: "all_time" }, groupBy: [{ dim: "date", bucket: "day" }] }, "series_too_long");
    refusal("all_time weekly series (unbounded)", { ...base, period: { kind: "all_time" }, groupBy: [{ dim: "date", bucket: "week" }] }, "series_too_long");
    check("all_time monthly series is allowed", V({ ...base, period: { kind: "all_time" }, groupBy: [{ dim: "date", bucket: "month" }] }).ok);
    refusal("relative period without a reference date", base, "reference_date_required", null);
    check("...but custom / all_time need no reference date", V({ ...base, period: OCT }, null).ok && V({ ...base, period: { kind: "all_time" } }, null).ok);
    refusal("list mode sorted by an unsortable column", { v: 1, entity: "sales", mode: "list", period: { kind: "current_fy" }, sort: [{ by: "voucherType", dir: "asc" }] }, "list_mode_shape");
    refusal("list mode sorted by a metric it does not have (purchaseAmount on sales)", { v: 1, entity: "sales", mode: "list", period: { kind: "current_fy" }, sort: [{ by: "purchaseAmount", dir: "asc" }] }, "list_mode_shape");

    // Oversized (complexity) query: 2 dims + productGroup + compare + 4 filters + totals + line grain
    {
      const heavy = {
        ...base,
        metrics: ["lineAmount"],
        compare: { mode: "like_for_like" },
        groupBy: [{ dim: "customer" }, { dim: "productGroup" }],
        filters: [{ dim: "voucherType", op: "eq_ci", value: "Invoice" }, { dim: "product", op: "contains_ci", value: "abc" }, { dim: "customer", op: "contains_ci", value: "abc" }, { dim: "productGroup", op: "contains_ci", value: "abc" }],
        sort: [{ by: "lineAmount.delta", dir: "desc" }],
      };
      const r = refusal("oversized query (complexity over the limit)", heavy, "complexity_too_high");
      check("...complexity is reported and exceeds the cap", r.errors.some((e) => /complexity 1[3-9]/.test(e.message)));
      const lighter = { ...heavy, filters: heavy.filters.slice(0, 3) };
      check("...one filter fewer is accepted (boundary at the cap)", V(lighter).ok, JSON.stringify(V(lighter).errors));
    }

    // schema-stage refusals surface through the validator
    for (const [label, plan] of [
      ["tenantId in the plan", { ...base, tenantId: "x" }],
      ["companyGuid in the plan", { ...base, companyGuid: "x" }],
      ["$where in the plan", { ...base, $where: "1" }],
      ["raw pipeline in the plan", { ...base, pipeline: [] }],
      ["unsupported metric (profit)", { ...base, metrics: ["profit"] }],
      ["unsupported metric (taxAmount)", { ...base, metrics: ["taxAmount"] }],
      ["unsupported dimension (salesperson)", { ...base, groupBy: [{ dim: "salesperson" }] }],
      ["limit 500", { ...base, limit: 500 }],
      ["three groupBy dims", { ...base, groupBy: [{ dim: "customer" }, { dim: "product" }, { dim: "voucherType" }] }],
    ]) {
      const r = V(plan);
      check(`${label} -> refused at the schema stage`, r.ok === false && r.stage === "schema");
    }

    // caveats / assumptions
    {
      const r = V({ ...base, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "customer" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      check("quantity by customer carries the mixed_units warning", r.ok && r.warnings.some((w) => w.code === "warn_mixed_units"));
      const ok1 = V({ ...base, metrics: ["quantity"], groupBy: [{ dim: "product" }], sort: [{ by: "quantity", dir: "desc" }] });
      check("quantity by product has no unit warning", ok1.ok && !ok1.warnings.some((w) => w.code === "warn_mixed_units"));
      const ok2 = V({ ...base, metrics: ["quantity"], filters: [{ dim: "product", op: "eq_ci", value: "ItemX" }] });
      check("quantity filtered to ONE product has no unit warning", ok2.ok && !ok2.warnings.some((w) => w.code === "warn_mixed_units"));
      const ok3 = V({ ...base, metrics: ["quantity"], filters: [{ dim: "product", op: "contains_ci", value: "Item" }] });
      check("quantity filtered by a product fragment (many products) still warns", ok3.ok && ok3.warnings.some((w) => w.code === "warn_mixed_units"));
      const inv = V({ ...base, filters: [{ dim: "product", op: "eq_ci", value: "ItemX" }] });
      check("invoice total filtered by a product warns it is the whole invoice, not the product's share", inv.ok && inv.warnings.some((w) => w.code === "warn_invoice_total_not_product_share"));
      const rel = V(base);
      check("relative periods record the reference-date anchoring assumption", rel.ok && rel.assumptions.some((a) => a.code === "period_anchored_to_latest_data"));
      check("a partial period is recorded as an assumption", rel.ok && rel.assumptions.some((a) => a.code === "period_is_partial"));
      const cust = V({ ...base, period: OCT });
      check("a custom period needs no anchoring assumption", cust.ok && !cust.assumptions.some((a) => a.code === "period_anchored_to_latest_data"));
    }

    // ================================================================
    section("3. Period resolution (validator uses periodEngine, unchanged)");
    // ================================================================
    {
      const opts = { specific_fy: { fy: "2025-26" } };
      for (const kind of periodEngine.PERIOD_KINDS.filter((k) => k !== "custom" && k !== "specific_fy")) {
        const r = V({ ...base, period: { kind } });
        const eng = periodEngine.resolvePeriod(kind, REF_DEC);
        check(`${kind} resolves exactly as periodEngine does`, r.ok && r.normalized.period.from.getTime() === eng.from.getTime() && r.normalized.period.to.getTime() === eng.to.getTime() && r.normalized.period.isPartial === eng.isPartial);
      }
      const fy = V({ ...base, period: { kind: "specific_fy", fy: "2025-26" } });
      const engFy = periodEngine.resolvePeriod("specific_fy", REF_DEC, opts.specific_fy);
      check("specific_fy resolves exactly as periodEngine does", fy.ok && fy.normalized.period.to.getTime() === engFy.to.getTime());
      const all = V({ ...base, period: { kind: "all_time" } }, null);
      check("all_time resolves to no bounds", all.ok && all.normalized.period.from === null && all.normalized.period.to === null);
      const cus = V({ ...base, period: OCT });
      check("custom resolves to whole local days", cus.ok && cus.normalized.period.from.getHours() === 0 && cus.normalized.period.to.getHours() === 23);

      const lfl = V({ ...base, period: { kind: "current_quarter" }, compare: { mode: "like_for_like" } });
      const full = V({ ...base, period: { kind: "current_quarter" }, compare: { mode: "full_previous" } });
      const engLfl = periodEngine.resolveComparisonPeriod("current_quarter", REF_DEC);
      const engFull = periodEngine.resolvePeriod("previous_quarter", REF_DEC);
      check("current_quarter like_for_like == periodEngine.resolveComparisonPeriod (Jul 1 - Sep 8)", lfl.ok && lfl.normalized.comparison.to.getTime() === engLfl.to.getTime() && lfl.normalized.comparison.to.getMonth() === 8 && lfl.normalized.comparison.to.getDate() === 8);
      check("current_quarter full_previous == previous_quarter (Jul 1 - Sep 30)", full.ok && full.normalized.comparison.to.getTime() === engFull.to.getTime() && full.normalized.comparison.to.getDate() === 30);
      check("the two modes resolve to DIFFERENT ranges while the quarter is partial", lfl.normalized.comparison.to.getTime() !== full.normalized.comparison.to.getTime());
      check("both keep their own canonicalMode (they differ)", lfl.normalized.comparison.canonicalMode === "like_for_like" && full.normalized.comparison.canonicalMode === "full_previous");

      const pm1 = V({ ...base, period: { kind: "previous_month" }, compare: { mode: "like_for_like" } });
      const pm2 = V({ ...base, period: { kind: "previous_month" }, compare: { mode: "full_previous" } });
      check("previous_month: the two modes are the same range and share canonicalMode like_for_like (cache-key stability)", pm1.ok && pm2.ok && pm1.normalized.comparison.from.getTime() === pm2.normalized.comparison.from.getTime() && pm2.normalized.comparison.canonicalMode === "like_for_like");

      for (const [kind, prev] of [["current_month", "previous_month"], ["current_week", "previous_week"], ["current_fy", "previous_fy"]]) {
        const a = V({ ...base, period: { kind }, compare: { mode: "full_previous" } });
        const e = periodEngine.resolvePeriod(prev, REF_DEC);
        check(`${kind} full_previous == ${prev}`, a.ok && a.normalized.comparison.from.getTime() === e.from.getTime() && a.normalized.comparison.to.getTime() === e.to.getTime());
      }

      const sply = V({ ...base, period: { kind: "current_month" }, compare: { mode: "same_period_last_year" } });
      const engS = periodEngine.resolveSamePeriodLastYear("current_month", REF_DEC);
      check("same_period_last_year == periodEngine.resolveSamePeriodLastYear", sply.ok && sply.normalized.comparison.from.getTime() === engS.from.getTime());
      const cc = V({ ...base, period: OCT, compare: { mode: "custom", period: SEP } });
      check("custom comparison resolves to the supplied range", cc.ok && cc.normalized.comparison.from.getMonth() === 8 && cc.normalized.comparison.to.getDate() === 30);

      // preserved engine quirk: warn, never change
      const w = V({ ...base, period: { kind: "specific_fy", fy: "2025-26" }, compare: { mode: "like_for_like" } });
      check("specific_fy of an in-progress FY compared -> warn_specific_fy_partial_comparison (engine behaviour preserved)", w.ok && w.warnings.some((x) => x.code === "warn_specific_fy_partial_comparison"));
      const w2 = V({ ...base, period: { kind: "specific_fy", fy: "2023-24" }, compare: { mode: "like_for_like" } });
      check("a COMPLETED specific_fy comparison raises no warning", w2.ok && !w2.warnings.some((x) => x.code === "warn_specific_fy_partial_comparison"));
      const w3 = V({ ...base, period: { kind: "current_fy" }, compare: { mode: "like_for_like" } });
      check("current_fy like_for_like raises no warning (properly truncated)", w3.ok && w3.warnings.length === 0);
    }

    // ================================================================
    section("4. Compiler: structural tenant-scope proof (no database)");
    // ================================================================
    const TID = "TENANT-STRUCT-1";
    const validated = EXAMPLES.map(([q, p]) => [q, V(p)]).filter(([, r]) => r.ok);
    const compileAll = (r) => compileQuery(r.normalized, { tenantId: TID, groupItemNames: ["ItemX"] });

    {
      let pipelines = 0;
      let allScoped = true;
      let firstBad = "";
      for (const [q, r] of validated) {
        const c = compileAll(r);
        for (const query of c.queries) {
          pipelines += 1;
          const range = query.key.endsWith("previous") ? r.normalized.comparison : r.normalized.period;
          const expected = { $match: buildVoucherMatchStage({ tenantId: TID, from: range.from || undefined, to: range.to || undefined }) };
          const ok = same(query.pipeline[0], expected) && query.pipeline[0].$match.tenantId === TID && same(query.pipeline[0].$match.voucherStatus, { $in: ["active"] });
          if (!ok) {
            allScoped = false;
            firstBad = `${q}/${query.key}`;
          }
        }
      }
      check(`all ${pipelines} pipelines compiled from the ${validated.length} example plans begin EXACTLY with buildVoucherMatchStage({tenantId, range})`, allScoped && pipelines > 40, firstBad);
    }

    // seeded fuzz: random plans -> validate -> compile -> prove scope
    {
      let seed = 20250923;
      const rnd = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const chance = (p) => rnd() < p;
      const kinds = periodEngine.PERIOD_KINDS.filter((k) => k !== "custom" && k !== "specific_fy");
      let attempts = 0;
      let valid = 0;
      let scoped = true;
      let violations = "";
      const names = ["Alpha Traders", "x.*", "(a+)+$", "tenantId", "$where", "a|b", "O'Brien & Co"];

      for (; attempts < 4000; attempts += 1) {
        const entity = pick(["sales", "purchase"]);
        const party = entity === "sales" ? "customer" : "supplier";
        const lineMode = chance(0.5);
        const metricPool = lineMode ? ["lineAmount", "quantity", "lineCount"] : entity === "sales" ? ["invoiceAmount", "invoiceCount", "averageInvoiceValue"] : ["purchaseAmount", "purchaseInvoiceCount", "averagePurchaseValue"];
        const metrics = [...new Set([pick(metricPool), pick(metricPool)])];
        const dimPool = [party, "voucherType", "date", ...(lineMode ? ["product", "productGroup"] : [])];
        const groupBy = [];
        for (let i = 0; i < Math.floor(rnd() * 3); i += 1) {
          const dim = pick(dimPool);
          if (groupBy.some((g) => g.dim === dim)) continue;
          groupBy.push(dim === "date" ? { dim, bucket: pick(["month", "quarter", "fy"]) } : { dim });
        }
        const filters = [];
        for (const dim of [party, "product", "productGroup", "voucherType"]) {
          if (chance(0.25) && !filters.some((f) => f.dim === dim)) filters.push({ dim, op: pick(dim === "voucherType" ? ["eq_ci", "in_ci"] : ["eq_ci", "contains_ci", "in_ci"]), value: null });
        }
        for (const f of filters) f.value = f.op === "in_ci" ? [pick(names), pick(names)] : pick(names).padEnd(3, "x");
        const plan = { v: 1, entity, mode: "aggregate", period: chance(0.2) ? { kind: "all_time" } : chance(0.25) ? OCT : { kind: pick(kinds) }, metrics, groupBy, filters };
        if (groupBy.length) plan.sort = [{ by: groupBy.some((g) => g.dim === "date") ? "date" : metrics[0], dir: pick(["asc", "desc"]) }];
        if (chance(0.3)) plan.compare = { mode: pick(["like_for_like", "full_previous", "same_period_last_year"]) };
        if (plan.compare && groupBy.length && chance(0.5)) plan.having = [{ metric: `${metrics[0]}.delta`, op: pick(["gt", "lt"]), value: 0 }];
        if (chance(0.1)) {
          plan.mode = "list";
          delete plan.metrics;
          plan.groupBy = [];
          delete plan.compare;
          delete plan.having;
          plan.sort = [{ by: "date", dir: "desc" }];
        }

        const r = validateQueryPlan(plan, { referenceDate: REF_DEC });
        if (!r.ok) continue;
        valid += 1;
        const c = compileQuery(r.normalized, { tenantId: TID, groupItemNames: ["ItemX"] });
        for (const q of c.queries) {
          const first = q.pipeline[0];
          const good = Object.keys(first).join() === "$match" && first.$match.tenantId === TID && same(first.$match.voucherStatus, { $in: ["active"] });
          let safe = true;
          try {
            assertPipelineSafe(q.pipeline, TID);
          } catch {
            safe = false;
          }
          const text = JSON.stringify(q.pipeline);
          const leaked = /"\$where"|"\$function"|"\$out"|"\$merge"|"\$unionWith"/.test(text);
          if (!good || !safe || leaked || q.options.maxTimeMS !== LIMITS.queryTimeoutMs || q.options.allowDiskUse !== false) {
            scoped = false;
            violations = JSON.stringify(plan).slice(0, 200);
          }
        }
      }
      check(`fuzz: ${valid} of ${attempts} random plans passed validation (meaningful sample)`, valid >= 300, `valid=${valid}`);
      check(`fuzz: every one of those ${valid} plans compiled to tenant-scoped, allow-listed, time-limited pipelines (including hostile-looking filter text)`, scoped, violations);
    }

    // refusal to compile anything the validator did not approve
    {
      const good = V({ ...base, period: OCT });
      const throws = (fn) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      check("compileQuery refuses a hand-built plan", throws(() => compileQuery({ entity: "sales", mode: "aggregate", grain: "voucher", period: good.normalized.period, metrics: ["invoiceAmount"], groupBy: [], filters: [], having: [], sort: [], limit: 10, totals: true, comparison: null }, { tenantId: TID })));
      check("compileQuery refuses a copied validated plan (brand is identity-based)", throws(() => compileQuery(structuredClone(good.normalized), { tenantId: TID })));
      check("compileQuery refuses the raw (unvalidated) DSL", throws(() => compileQuery(good.plan, { tenantId: TID })));
      let mutated = false;
      try {
        good.normalized.filters.push({ dim: "customer", op: "eq_ci", value: "x" });
        mutated = true;
      } catch {
        mutated = false;
      }
      check("a validated plan cannot be mutated after validation", mutated === false);
      check("compileQuery refuses to run without a tenantId", throws(() => compileQuery(good.normalized, {})) && throws(() => compileQuery(good.normalized, { tenantId: "" })) && throws(() => compileQuery(good.normalized, { tenantId: "   " })));
      const grp = V({ ...base, period: OCT, filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] });
      check("an invoice-level productGroup filter refuses to compile without resolved item names", grp.ok && throws(() => compileQuery(grp.normalized, { tenantId: TID })));
      const grpLine = V({ ...base, period: OCT, metrics: ["lineAmount"], filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] });
      check("a line-level productGroup filter refuses to compile without resolved item names", grpLine.ok && throws(() => compileQuery(grpLine.normalized, { tenantId: TID })));
      check("...and refuses an absurdly large resolved-name list", throws(() => compileQuery(grpLine.normalized, { tenantId: TID, groupItemNames: Array.from({ length: LIMITS.maxGroupItemNames + 1 }, (_, i) => `i${i}`) })));

      // No compiled pipeline of ANY shape contains a join.
      const groupShapes = [
        { ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] },
        { ...base, period: OCT, metrics: ["lineAmount"], compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount.delta", dir: "asc" }] },
        { ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }, { dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] },
        { ...base, period: OCT, metrics: ["lineAmount"], filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] },
        { ...base, period: OCT, filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] },
        { v: 1, entity: "sales", mode: "list", period: OCT, filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] },
      ];
      let anyLookup = false;
      let allDetected = true;
      for (const plan of groupShapes) {
        const vr = V(plan);
        if (!vr.ok) {
          allDetected = false;
          continue;
        }
        const cq = compileQuery(vr.normalized, { tenantId: TID, groupItemNames: ["ItemX"] });
        if (cq.queries.some((q) => /"\$lookup"|"\$facet"/.test(JSON.stringify(q.pipeline)))) anyLookup = true;
      }
      check("no pipeline for any productGroup shape contains a $lookup (group resolution is an explicit tenant-filtered master read)", allDetected && !anyLookup);

      const roll = compileQuery(V(groupShapes[0]).normalized, { tenantId: TID });
      const grpStage = roll.queries[0].pipeline.find((s) => s.$group).$group;
      check("a productGroup grouping aggregates PER ITEM with hidden line counters and a bounded row cap", roll.rollup === true && grpStage._id.productGroup === "$inventory.itemName" && grpStage.x_lines && grpStage.x_amount && roll.queries.length === 1 && roll.queries[0].pipeline.some((s) => s.$limit === LIMITS.maxRollupRows + 1));
      const rollCmp = compileQuery(V(groupShapes[1]).normalized, { tenantId: TID });
      check("a productGroup comparison needs only TWO aggregations (totals/mapping are derived from the rows)", rollCmp.queries.map((q) => q.key).join() === "rows_current,rows_previous");
      const a = JSON.stringify(compileQuery(good.normalized, { tenantId: TID }));
      const b = JSON.stringify(compileQuery(good.normalized, { tenantId: TID }));
      check("compilation is deterministic (identical output on repeat)", a === b);
    }

    // runtime safety net catches tampering
    {
      const r = V({ ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      const p = compileQuery(r.normalized, { tenantId: TID }).queries[0].pipeline;
      const bad = (label, mutate) => {
        const copy = structuredClone(p);
        mutate(copy);
        let threw = false;
        try {
          assertPipelineSafe(copy, TID);
        } catch {
          threw = true;
        }
        check(`assertPipelineSafe rejects: ${label}`, threw);
      };
      let untouched = true;
      try {
        assertPipelineSafe(p, TID);
      } catch {
        untouched = false;
      }
      check("assertPipelineSafe accepts the genuine pipeline", untouched);
      bad("first stage removed", (x) => x.shift());
      bad("wrong tenant in the first stage", (x) => (x[0].$match.tenantId = "SOMEONE-ELSE"));
      bad("active-only restriction removed", (x) => delete x[0].$match.voucherStatus);
      bad("active-only widened to cancelled", (x) => (x[0].$match.voucherStatus = { $in: ["active", "cancelled"] }));
      bad("scope stage not first (swapped)", (x) => ([x[0], x[1]] = [x[1], x[0]]));
      bad("a $out stage appended", (x) => x.push({ $out: "stolen" }));
      bad("a $merge stage appended", (x) => x.push({ $merge: { into: "stolen" } }));
      bad("a $where clause injected", (x) => x.push({ $match: { $where: "sleep(5000)" } }));
      bad("a $function injected", (x) => x.push({ $addFields: { z: { $function: { body: "function(){}", args: [], lang: "js" } } } }));
      bad("a $unionWith stage", (x) => x.push({ $unionWith: "users" }));
      bad("a $lookup into another collection (no join of any kind is ever allowed)", (x) => x.push({ $lookup: { from: "users", localField: "tenantId", foreignField: "_id", as: "u" } }));
      bad("a tenant-scoped-looking $lookup (still refused: the compiler emits none)", (x) => x.push({ $lookup: { from: "stockitemmasters", let: { tid: "$tenantId" }, pipeline: [{ $match: { $expr: { $eq: ["$tenantId", "$$tid"] } } }], as: "m" } }));
      bad("a $facet stage", (x) => x.push({ $facet: { a: [] } }));
      bad("a $graphLookup stage", (x) => x.push({ $graphLookup: { from: "sales", startWith: "$a", connectFromField: "a", connectToField: "b", as: "c" } }));
      bad("a stage with two operators", (x) => (x[1].$limit = 5));
      bad("an empty pipeline", (x) => (x.length = 0));
    }

    // regex literal handling
    {
      const nasty = ".*(a+)+$";
      const r = V({ ...base, period: OCT, filters: [{ dim: "customer", op: "eq_ci", value: nasty }] });
      const c = compileQuery(r.normalized, { tenantId: TID }).queries[0].pipeline;
      const cond = c[1].$match["header.partyName"];
      check("regex metacharacters in a filter value are escaped to literals", cond.$regex === `^${escapeRegex(nasty)}$` && cond.$regex === "^\\.\\*\\(a\\+\\)\\+\\$$" && cond.$options === "i");
      const inRegex = compileQuery(V({ ...base, period: OCT, filters: [{ dim: "customer", op: "in_ci", value: ["a|b", "c.d"] }] }).normalized, { tenantId: TID }).queries[0].pipeline[1].$match["header.partyName"].$regex;
      check("in_ci escapes every alternative (an embedded | is literal)", inRegex === "^(?:a\\|b|c\\.d)$");
    }

    // maxTimeMS
    {
      const r = V({ ...base, period: OCT, compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] });
      const c = compileQuery(r.normalized, { tenantId: TID });
      check("every compiled query carries maxTimeMS and disallows disk use", c.queries.length >= 4 && c.queries.every((q) => q.options.maxTimeMS === LIMITS.queryTimeoutMs && q.options.allowDiskUse === false));
      const agg = buildAggregate("Sale", c.queries[0].pipeline, c.queries[0].options);
      check("buildAggregate sets maxTimeMS on the real Mongoose aggregate", agg.options && agg.options.maxTimeMS === LIMITS.queryTimeoutMs, JSON.stringify(agg.options));
      const seen = [];
      await executeQuery({ ...base, period: OCT, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }, { tenantId: T_A, runAggregate: async (m, p, o) => (seen.push(o), []) });
      check("executeQuery hands every query's maxTimeMS to the runner", seen.length >= 1 && seen.every((o) => o.maxTimeMS === LIMITS.queryTimeoutMs));
      const t1 = await executeQuery({ ...base, period: OCT }, { tenantId: T_A, runAggregate: async () => { const e = new Error("operation exceeded time limit"); e.code = 50; throw e; } });
      check("a MongoDB time-limit error becomes a structured query_timeout", t1.ok === false && t1.errors[0].code === "query_timeout");
      const t2 = await executeQuery({ ...base, period: OCT }, { tenantId: T_A, runAggregate: async () => { throw new Error("mongodb://user:secret@host internal detail"); } });
      check("any other database error becomes query_failed and leaks no detail", t2.ok === false && t2.errors[0].code === "query_failed" && !/secret|mongodb/.test(JSON.stringify(t2)));
      const big = await executeQuery({ ...base, period: OCT, compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }, { tenantId: T_A, runAggregate: async () => Array.from({ length: LIMITS.maxCompareGroups + 1 }, (_, i) => ({ key: { customer: `c${i}` }, invoiceAmount: 1 })) });
      check("a comparison beyond maxCompareGroups is refused (result_too_large), never silently truncated", big.ok === false && big.errors[0].code === "result_too_large");
    }

    // ================================================================
    section("5. Executor: tenant + context safety (spy proves MongoDB is never reached)");
    // ================================================================
    {
      let calls = 0;
      const spy = async () => (calls += 1, []);
      const cases = [
        ["no tenantId", { ...base, period: OCT }, {}],
        ["empty tenantId", { ...base, period: OCT }, { tenantId: "" }],
        ["tenantId injected in the plan", { ...base, period: OCT, tenantId: T_B }, { tenantId: T_A }],
        ["companyGuid injected in the plan", { ...base, period: OCT, companyGuid: "g" }, { tenantId: T_A }],
        ["$where in the plan", { ...base, period: OCT, $where: "1" }, { tenantId: T_A }],
        ["semantically invalid plan", { ...base, period: OCT, metrics: ["invoiceAmount", "lineAmount"] }, { tenantId: T_A }],
        ["oversized/complex plan", { ...base, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }, { dim: "productGroup" }], filters: ["voucherType", "product", "customer", "productGroup"].map((d) => ({ dim: d, op: "contains_ci", value: "abc" })), sort: [{ by: "lineAmount.delta", dir: "desc" }] }, { tenantId: T_A }],
        ["null plan", null, { tenantId: T_A }],
        ["string plan", "sales last month", { tenantId: T_A }],
      ];
      for (const [label, plan, ctx] of cases) {
        const r = await executeQuery(plan, { referenceDate: REF_DEC, runAggregate: spy, ...ctx });
        check(`${label} -> structured refusal, MongoDB never called`, r.ok === false && Array.isArray(r.errors) && r.errors.length > 0);
      }
      check("across all refusal cases the aggregate runner was invoked 0 times", calls === 0, `calls=${calls}`);
    }

    // ================================================================
    section("6. Executor: correctness on synthetic data (hand-computed)");
    // ================================================================
    {
      const t = await run({ ...base, period: OCT, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"] });
      check("Oct totals: invoiceAmount 3660, invoiceCount 3, average 1220 (cancelled + deleted vouchers excluded)", t.ok && near(t.totals.values.invoiceAmount, 3660) && t.totals.values.invoiceCount === 3 && near(t.totals.values.averageInvoiceValue, 1220), JSON.stringify(t.totals));
      check("amount basis is reported per metric (voucher total incl. tax; count has none)", t.ok && t.amountBasis.invoiceAmount === "voucher_total_incl_tax" && t.amountBasis.averageInvoiceValue === "voucher_total_incl_tax" && !("invoiceCount" in t.amountBasis));
      check("result carries structured period, catalog version and complexity", t.period.kind === "custom" && t.diagnostics.catalogVersion === catalog.CATALOG_VERSION && t.diagnostics.queryCount === 1);

      const c = await run({ ...base, period: OCT, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] });
      check("by customer (desc): Alpha 1890 (2 invoices) then Gamma 1770 (1)", c.ok && c.rows.length === 2 && c.rows[0].key.customer === "Alpha Traders" && near(c.rows[0].values.invoiceAmount, 1890) && c.rows[0].values.invoiceCount === 2 && c.rows[1].key.customer === "Gamma Mart" && near(c.rows[1].values.invoiceAmount, 1770));
      check("...with overall totals unaffected by limit (3660 / 3)", near(c.totals.values.invoiceAmount, 3660) && c.totals.values.invoiceCount === 3 && c.truncated === false);
      const asc = await run({ ...base, period: OCT, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "asc" }] });
      check("sort direction is honoured (asc)", asc.ok && asc.rows[0].key.customer === "Gamma Mart");
      const lim = await run({ ...base, period: OCT, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 1 });
      check("limit 1 returns one row and flags truncated: true", lim.ok && lim.rows.length === 1 && lim.truncated === true && lim.rowLimit === 1);
      check("...and totals still cover ALL groups", near(lim.totals.values.invoiceAmount, 3660));

      const p = await run({ ...base, period: OCT, metrics: ["lineAmount", "quantity", "lineCount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      const pm = rowMap(p, "product");
      check("by product: ItemX 2400 / qty 25 / 2 lines", p.ok && near(pm.ItemX.values.lineAmount, 2400) && pm.ItemX.values.quantity === 25 && pm.ItemX.values.lineCount === 2);
      check("by product: ItemY 500 and ItemZ 100, ordered X, Y, Z", near(pm.ItemY.values.lineAmount, 500) && near(pm.ItemZ.values.lineAmount, 100) && p.rows.map((r) => r.key.product).join() === "ItemX,ItemY,ItemZ");
      check("line metrics report the pre-tax basis", p.amountBasis.lineAmount === "line_item_pre_tax" && p.warnings.length === 0);

      const g = await run({ ...base, period: OCT, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      const gm = rowMap(g, "productGroup");
      check("by productGroup: GroupOne 2400 (qty 25), GroupTwo 500", g.ok && near(gm.GroupOne.values.lineAmount, 2400) && gm.GroupOne.values.quantity === 25 && near(gm.GroupTwo.values.lineAmount, 500));
      check("unmapped lines are excluded from groups and REPORTED (1 line, 100)", g.rows.length === 2 && g.mapping.unmappedLines === 1 && near(g.mapping.unmappedLineAmount, 100) && g.mapping.mappedLines === 3 && near(g.mapping.mappedLineAmount, 2900) && g.mapping.classificationBasis === "current_stock_item_master");
      check("...group totals exclude the unmapped line (2900)", near(g.totals.values.lineAmount, 2900));
      check("quantity by productGroup carries the mixed_units warning", g.warnings.some((w) => w.code === "warn_mixed_units"));

      const sc = await run({ ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }, { dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      check("two-dimension grouping (customer x product) returns composite keys", sc.ok && sc.rows.length === 4 && sc.rows[0].key.customer === "Gamma Mart" && sc.rows[0].key.product === "ItemX" && near(sc.rows[0].values.lineAmount, 1400));

      const vt = await run({ ...base, period: OCT, groupBy: [{ dim: "voucherType" }] });
      check("by voucherType groups on the raw type name", vt.ok && vt.rows.length === 1 && vt.rows[0].key.voucherType === "Invoice" && near(vt.rows[0].values.invoiceAmount, 3660));

      const empty = await run({ ...base, period: { kind: "custom", from: "2024-01-01", to: "2024-01-31" }, metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue"] });
      check("an empty period is a valid zero result (not an error)", empty.ok && empty.rows.length === 0 && empty.totals.values.invoiceAmount === 0 && empty.totals.values.invoiceCount === 0 && empty.totals.values.averageInvoiceValue === 0);
      const emptyG = await run({ ...base, period: { kind: "custom", from: "2024-01-01", to: "2024-01-31" }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] });
      check("an empty grouped period returns no rows and zero totals", emptyG.ok && emptyG.rows.length === 0 && emptyG.truncated === false && emptyG.totals.values.invoiceAmount === 0);

      const at = await run({ ...base, period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"] });
      check("all_time spans every active voucher (Sep + Oct = 7200, 5 invoices)", at.ok && near(at.totals.values.invoiceAmount, 7200) && at.totals.values.invoiceCount === 5 && at.period.from === null);
    }

    // ---- filters
    {
      const f = async (filters, extra = {}) => run({ ...base, period: OCT, metrics: ["invoiceAmount", "invoiceCount"], filters, ...extra });
      const a = await f([{ dim: "customer", op: "eq_ci", value: "alpha traders" }]);
      check("eq_ci is case-insensitive and anchored (alpha traders -> 1890)", a.ok && near(a.totals.values.invoiceAmount, 1890) && a.totals.values.invoiceCount === 2);
      check("...same result for the upper-cased spelling", near((await f([{ dim: "customer", op: "eq_ci", value: "ALPHA TRADERS" }])).totals.values.invoiceAmount, 1890));
      check("eq_ci is anchored: 'Alpha' does NOT match 'Alpha Traders'", near((await f([{ dim: "customer", op: "eq_ci", value: "Alpha" }])).totals.values.invoiceAmount, 0));
      check("contains_ci matches a fragment (amma -> Gamma Mart 1770)", near((await f([{ dim: "customer", op: "contains_ci", value: "amma" }])).totals.values.invoiceAmount, 1770));
      const inr = await f([{ dim: "customer", op: "in_ci", value: ["alpha traders", "GAMMA MART"] }]);
      check("in_ci matches several names (3660 / 3)", near(inr.totals.values.invoiceAmount, 3660) && inr.totals.values.invoiceCount === 3);
      for (const [label, op, value] of [["'.*' as eq_ci", "eq_ci", ".*"], ["'Alpha.*' as eq_ci", "eq_ci", "Alpha.*"], ["'(a+)+$' as contains_ci", "contains_ci", "(a+)+$"], ["'...' as contains_ci", "contains_ci", "..."], ["'|' alternation as in_ci", "in_ci", ["Alpha|Gamma"]]]) {
        const r = await f([{ dim: "customer", op, value }]);
        check(`regex-looking filter ${label} matches nothing (treated as a literal)`, r.ok && near(r.totals.values.invoiceAmount, 0) && r.totals.values.invoiceCount === 0);
      }
      const vt = await f([{ dim: "voucherType", op: "eq_ci", value: "invoice" }]);
      check("voucherType filter is case-insensitive", near(vt.totals.values.invoiceAmount, 3660));

      const prod = await f([{ dim: "product", op: "eq_ci", value: "itemy" }]);
      check("invoice total filtered by product = whole invoices containing it (V3 590), with the caveat warning", prod.ok && near(prod.totals.values.invoiceAmount, 590) && prod.warnings.some((w) => w.code === "warn_invoice_total_not_product_share"));
      const grp = await f([{ dim: "productGroup", op: "eq_ci", value: "groupone" }]);
      check("invoice total filtered by productGroup resolves the group's items first (V4 + V5 = 3070)", grp.ok && near(grp.totals.values.invoiceAmount, 3070) && grp.totals.values.invoiceCount === 2, JSON.stringify(grp.totals));
      const line = await run({ ...base, period: OCT, metrics: ["lineAmount"], filters: [{ dim: "productGroup", op: "eq_ci", value: "groupone" }, { dim: "customer", op: "eq_ci", value: "Alpha Traders" }] });
      check("line metric with productGroup + customer filters: only Alpha's ItemX line (1000)", line.ok && near(line.totals.values.lineAmount, 1000));
    }

    // ---- comparison
    {
      const cmp = await run({ ...base, period: OCT, compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "desc" }] });
      const m = rowMap(cmp, "customer");
      check("compare by customer: Alpha 1890 vs 1180, delta +710, +60.17%", cmp.ok && near(m["Alpha Traders"].values.invoiceAmount, 1890) && near(m["Alpha Traders"].comparison.invoiceAmount.previous, 1180) && near(m["Alpha Traders"].comparison.invoiceAmount.delta, 710) && near(m["Alpha Traders"].comparison.invoiceAmount.deltaPct, (710 / 1180) * 100));
      check("compare: a customer who STOPPED buying is kept (Beta: 0 vs 2360, -100%, previous_only)", m["Beta Stores"].presence === "previous_only" && m["Beta Stores"].values.invoiceAmount === 0 && near(m["Beta Stores"].comparison.invoiceAmount.delta, -2360) && near(m["Beta Stores"].comparison.invoiceAmount.deltaPct, -100));
      check("compare: a NEW customer has deltaPct null (never Infinity or 0%) (Gamma)", m["Gamma Mart"].presence === "current_only" && m["Gamma Mart"].comparison.invoiceAmount.deltaPct === null && near(m["Gamma Mart"].comparison.invoiceAmount.delta, 1770));
      check("compare: sorted by delta desc (Gamma, Alpha, Beta)", cmp.rows.map((r) => r.key.customer).join() === "Gamma Mart,Alpha Traders,Beta Stores");
      check("compare totals: 3660 vs 3540, +120, +3.39%", near(cmp.totals.values.invoiceAmount, 3660) && near(cmp.totals.comparison.invoiceAmount.previous, 3540) && near(cmp.totals.comparison.invoiceAmount.delta, 120) && near(cmp.totals.comparison.invoiceAmount.deltaPct, (120 / 3540) * 100));
      check("compare result echoes the resolved comparison range", cmp.comparison.mode === "custom" && cmp.comparison.from.startsWith("2025-08-31") || cmp.comparison.from.startsWith("2025-09-01"));

      const stopped = await run({ ...base, period: OCT, compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount", op: "eq", value: 0 }, { metric: "invoiceAmount.previous", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount.previous", dir: "desc" }] });
      check("'customers who stopped buying' -> only Beta", stopped.ok && stopped.rows.length === 1 && stopped.rows[0].key.customer === "Beta Stores");
      const less = await run({ ...base, period: OCT, compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] });
      check("'customers who purchased less' -> only Beta", less.ok && less.rows.length === 1 && less.rows[0].key.customer === "Beta Stores");
      const grew = await run({ ...base, period: OCT, compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 20 }], sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }] });
      check("'increased by more than 20%' -> Alpha only (a null deltaPct never qualifies)", grew.ok && grew.rows.length === 1 && grew.rows[0].key.customer === "Alpha Traders");

      const pcmp = await run({ ...base, period: OCT, metrics: ["lineAmount"], compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "product" }], having: [{ metric: "lineAmount.delta", op: "lt", value: 0 }], sort: [{ by: "lineAmount.delta", dir: "asc" }] });
      check("'products that declined' -> ItemX only (2400 vs 2600, -200)", pcmp.ok && pcmp.rows.length === 1 && pcmp.rows[0].key.product === "ItemX" && near(pcmp.rows[0].comparison.lineAmount.delta, -200));
      const contrib = await run({ ...base, period: OCT, metrics: ["lineAmount"], compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }] });
      check("'products contributing most to the decline': ItemX first, overall total change reported (3000 vs 3000?)", contrib.ok && contrib.rows[0].key.product === "ItemX" && contrib.totals.comparison.lineAmount.previous === 3000 && near(contrib.totals.values.lineAmount, 3000));

      const gcmp = await run({ ...base, period: OCT, metrics: ["lineAmount"], compare: { mode: "custom", period: SEP }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount.delta", dir: "desc" }] });
      const gcm = rowMap(gcmp, "productGroup");
      check("compare by productGroup: GroupOne 2400 vs 2600; GroupTwo 500 vs 400 (+25%)", gcmp.ok && near(gcm.GroupOne.comparison.lineAmount.previous, 2600) && near(gcm.GroupTwo.comparison.lineAmount.deltaPct, 25));

      const scalar = await run({ ...base, period: OCT, compare: { mode: "custom", period: SEP } });
      check("scalar comparison (no groupBy): 3660 vs 3540", scalar.ok && scalar.rows.length === 0 && near(scalar.totals.values.invoiceAmount, 3660) && near(scalar.totals.comparison.invoiceAmount.previous, 3540));
    }

    // ---- like-for-like vs full previous, with real data
    {
      const cur = await run({ ...base, period: { kind: "current_month" }, metrics: ["invoiceAmount", "invoiceCount"] });
      check("current_month at ref 20 Oct: only vouchers up to the 20th (V3+V4 = 2360, 2 invoices)", cur.ok && near(cur.totals.values.invoiceAmount, 2360) && cur.totals.values.invoiceCount === 2 && cur.period.isPartial === true);
      const lfl = await run({ ...base, period: { kind: "current_month" }, compare: { mode: "like_for_like" }, metrics: ["invoiceAmount", "invoiceCount"] });
      const full = await run({ ...base, period: { kind: "current_month" }, compare: { mode: "full_previous" }, metrics: ["invoiceAmount", "invoiceCount"] });
      check("like_for_like compares 1-20 Oct with 1-20 Sep: previous 1180 (V1 only), delta +1180, +100%", lfl.ok && near(lfl.totals.comparison.invoiceAmount.previous, 1180) && near(lfl.totals.comparison.invoiceAmount.delta, 1180) && near(lfl.totals.comparison.invoiceAmount.deltaPct, 100) && lfl.totals.comparison.invoiceCount.previous === 1);
      check("full_previous compares with ALL of September: previous 3540, delta -1180, -33.3%", full.ok && near(full.totals.comparison.invoiceAmount.previous, 3540) && near(full.totals.comparison.invoiceAmount.delta, -1180) && near(full.totals.comparison.invoiceAmount.deltaPct, (-1180 / 3540) * 100));
      check("the SAME question shows opposite growth under the two modes - which is exactly why the mode is explicit", lfl.totals.comparison.invoiceAmount.delta > 0 && full.totals.comparison.invoiceAmount.delta < 0);
      check("the resolved comparison range is echoed so an answer can state it", lfl.comparison.mode === "like_for_like" && full.comparison.mode === "full_previous" && lfl.comparison.to < full.comparison.to);
    }

    // ---- date series
    {
      const rng = { kind: "custom", from: "2025-09-01", to: "2025-10-31" };
      const m = await run({ ...base, period: rng, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }] });
      check("monthly series: 2025-09 (3540, 2), 2025-10 (3660, 3), ascending", m.ok && m.rows.length === 2 && m.rows[0].key.date.label === "2025-09" && near(m.rows[0].values.invoiceAmount, 3540) && m.rows[0].values.invoiceCount === 2 && m.rows[1].key.date.label === "2025-10" && near(m.rows[1].values.invoiceAmount, 3660));
      check("series limit defaults to 100 and is not truncated", m.rowLimit === 100 && m.truncated === false);
      const q = await run({ ...base, period: rng, groupBy: [{ dim: "date", bucket: "quarter" }] });
      check("quarter buckets are financial-year aligned (Sep -> Q2, Oct -> Q3)", q.ok && q.rows.map((r) => r.key.date.label).join() === "FY 2025-26 Q2,FY 2025-26 Q3");
      const fy = await run({ ...base, period: rng, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "fy" }] });
      check("fy bucket: one 'FY 2025-26' bucket of 7200 / 5", fy.ok && fy.rows.length === 1 && fy.rows[0].key.date.label === "FY 2025-26" && fy.rows[0].key.date.start === "2025-04-01" && near(fy.rows[0].values.invoiceAmount, 7200));
      const w = await run({ ...base, period: rng, groupBy: [{ dim: "date", bucket: "week" }] });
      check("week buckets partition the range (weeks sum to 7200, Monday starts)", w.ok && near(w.rows.reduce((s, r) => s + r.values.invoiceAmount, 0), 7200) && w.rows.every((r) => new Date(`${r.key.date.start}T00:00:00Z`).getUTCDay() === 1));
      const d = await run({ ...base, period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, groupBy: [{ dim: "date", bucket: "day" }] });
      check("day buckets: 3 active days in October (5th, 15th, 25th)", d.ok && d.rows.length === 3 && d.rows.map((r) => r.key.date.label).join() === "2025-10-05,2025-10-15,2025-10-25");
      const fk = formatDateKey("fy", 2024);
      check("formatDateKey labels FY buckets correctly", fk.label === "FY 2024-25" && fk.start === "2024-04-01");
    }

    // ---- list mode
    {
      const l = await run({ v: 1, entity: "sales", mode: "list", period: OCT, sort: [{ by: "invoiceAmount", dir: "desc" }] });
      check("largest invoices: V4 1770, V5 1300, V3 590 with fixed columns", l.ok && l.rows.map((r) => r.voucherNo).join() === "S-V4,S-V5,S-V3" && near(l.rows[0].invoiceAmount, 1770) && l.rows[0].customer === "Gamma Mart" && l.rows[0].date === "2025-10-15" && l.rows[0].voucherType === "Invoice");
      check("list rows carry no narration/internal fields", Object.keys(l.rows[0]).sort().join() === "customer,date,invoiceAmount,voucherNo,voucherType");
      const l2 = await run({ v: 1, entity: "sales", mode: "list", period: OCT, sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 2 });
      check("list limit 2 -> 2 rows and truncated: true", l2.rows.length === 2 && l2.truncated === true);
      const l3 = await run({ v: 1, entity: "sales", mode: "list", period: { kind: "all_time" }, filters: [{ dim: "customer", op: "eq_ci", value: "alpha traders" }], sort: [{ by: "date", dir: "asc" }] });
      check("invoices for a customer (all_time): V1, V3, V5 in date order", l3.ok && l3.rows.map((r) => r.voucherNo).join() === "S-V1,S-V3,S-V5");
      const l4 = await run({ v: 1, entity: "sales", mode: "list", period: OCT, filters: [{ dim: "product", op: "eq_ci", value: "ItemY" }] });
      check("invoices containing a product: V3 only, with the whole-invoice caveat", l4.ok && l4.rows.length === 1 && l4.rows[0].voucherNo === "S-V3" && l4.warnings.some((w) => w.code === "warn_invoice_total_not_product_share"));
      const seenPipes = [];
      const l5 = await run({ v: 1, entity: "sales", mode: "list", period: OCT, filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }], sort: [{ by: "voucherNo", dir: "asc" }] }, T_A, { runAggregate: async (m, p, o) => (seenPipes.push(p), buildAggregate(m, p, o).exec()) });
      check("invoices of a product group: V4, V5 (item names resolved first, tenant-scoped)", l5.ok && l5.rows.map((r) => r.voucherNo).join() === "S-V4,S-V5" && JSON.stringify(seenPipes).includes('"$in":["ItemX"]'));
      const lp = await run({ v: 1, entity: "purchase", mode: "list", period: { kind: "all_time" }, sort: [{ by: "purchaseAmount", dir: "desc" }] });
      check("purchase list uses supplier/purchaseAmount columns", lp.ok && Object.keys(lp.rows[0]).sort().join() === "date,purchaseAmount,supplier,voucherNo,voucherType" && lp.rows[0].supplier === "SupplierOne");
    }

    // ---- purchases
    {
      const p = await run({ ...purchaseBase, period: OCT, metrics: ["purchaseAmount", "purchaseInvoiceCount", "averagePurchaseValue"] });
      check("purchases Oct: 5900 / 1 / avg 5900", p.ok && near(p.totals.values.purchaseAmount, 5900) && p.totals.values.purchaseInvoiceCount === 1 && near(p.totals.values.averagePurchaseValue, 5900));
      const s = await run({ ...purchaseBase, period: { kind: "all_time" }, groupBy: [{ dim: "supplier" }], sort: [{ by: "purchaseAmount", dir: "desc" }] });
      check("by supplier: SupplierOne 5900 then SupplierTwo 1180", s.ok && s.rows.map((r) => r.key.supplier).join() === "SupplierOne,SupplierTwo");
      const pr = await run({ ...purchaseBase, period: OCT, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      check("purchases by product: ItemX 5000 / qty 50", pr.ok && near(pr.rows[0].values.lineAmount, 5000) && pr.rows[0].values.quantity === 50);
      const pg = await run({ ...purchaseBase, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] });
      check("purchases by productGroup: GroupOne 5000 (tenant A's master, not B's)", pg.ok && pg.rows.length === 1 && pg.rows[0].key.productGroup === "GroupOne");
      const pc = await run({ ...purchaseBase, period: OCT, compare: { mode: "custom", period: SEP }, metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "purchaseAmount.delta", dir: "desc" }] });
      check("purchase comparison: SupplierOne new (+5900, pct null), SupplierTwo stopped (-1180, -100%)", pc.ok && pc.rows[0].key.supplier === "SupplierOne" && pc.rows[0].comparison.purchaseAmount.deltaPct === null && near(pc.rows[1].comparison.purchaseAmount.deltaPct, -100));
    }

    // ================================================================
    section("7. Executor: tenant isolation on real MongoDB (A vs B share names)");
    // ================================================================
    {
      const plan = { ...base, period: OCT, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] };
      const a = await run(plan, T_A);
      const b = await run(plan, T_B);
      check("tenant A never sees tenant B's 999,999 (same customer name 'Alpha Traders' exists in both)", a.ok && !JSON.stringify(a).includes("999999") && near(rowMap(a, "customer")["Alpha Traders"].values.invoiceAmount, 1890));
      check("tenant B sees only its own single voucher", b.ok && b.rows.length === 1 && near(b.rows[0].values.invoiceAmount, 999999) && b.rows[0].values.invoiceCount === 1);
      const ga = await run({ ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }, T_A);
      const gb = await run({ ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }, T_B);
      check("the SAME item name ('ItemX') resolves to each tenant's OWN stock group (GroupOne vs ForeignGroup)", ga.rows.map((r) => r.key.productGroup).join() === "GroupOne,GroupTwo" && gb.rows.map((r) => r.key.productGroup).join() === "ForeignGroup" && near(gb.rows[0].values.lineAmount, 900000));
      const la = await run({ v: 1, entity: "sales", mode: "list", period: { kind: "all_time" }, sort: [{ by: "invoiceAmount", dir: "desc" }] }, T_A);
      check("list mode is tenant-scoped too", la.ok && la.rows.every((r) => r.invoiceAmount < 5000) && !la.rows.some((r) => r.voucherNo === "S-B1"));
      const ba = await run({ ...purchaseBase, period: OCT }, T_B);
      check("purchases are tenant-scoped (B sees 777,777, A does not)", near(ba.totals.values.purchaseAmount, 777777) && near((await run({ ...purchaseBase, period: OCT }, T_A)).totals.values.purchaseAmount, 5900));
      const grpB = await run({ ...base, period: OCT, filters: [{ dim: "productGroup", op: "eq_ci", value: "GroupOne" }] }, T_B);
      check("B filtering by A's group name finds nothing (group names are tenant-scoped)", grpB.ok && near(grpB.totals.values.invoiceAmount, 0));
      const grpA = await run({ ...base, period: OCT, filters: [{ dim: "productGroup", op: "eq_ci", value: "ForeignGroup" }] }, T_A);
      check("A filtering by B's group name finds nothing", grpA.ok && near(grpA.totals.values.invoiceAmount, 0));
      const nope = await run(plan, "TEST-TENANT-DOES-NOT-EXIST");
      check("an unknown tenant returns an empty (not an error, not someone else's) result", nope.ok && nope.rows.length === 0);
    }

    // ================================================================
    section("7b. Product-group roll-up: tenant-filtered master reads, unmapped handling, deterministic ties");
    // ================================================================
    {
      // The ONLY reads outside the compiled pipelines must be filtered by the authorized tenant.
      const mapCalls = [];
      const nameCalls = [];
      const spyCtx = {
        loadStockGroupMap: async (tid) => (mapCalls.push(tid), new Map([["ItemX", "G-One"], ["ItemY", "G-One"]])),
        findGroupItemNames: async (tid, f) => (nameCalls.push([tid, f.value]), ["ItemX"]),
      };
      const raw = [
        { key: { productGroup: "ItemX" }, lineAmount: 100, quantity: 10, __lines: 4, __amount: 100 },
        { key: { productGroup: "ItemY" }, lineAmount: 50, quantity: 5, __lines: 2, __amount: 50 },
        { key: { productGroup: "ItemUnmapped" }, lineAmount: 25, quantity: 2, __lines: 1, __amount: 25 },
      ];
      const r = await executeQuery({ ...base, period: OCT, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }, { tenantId: T_A, ...spyCtx, runAggregate: async () => raw });
      check("roll-up sums items into their group (ItemX + ItemY -> G-One 150 / qty 15)", r.ok && r.rows.length === 1 && r.rows[0].key.productGroup === "G-One" && near(r.rows[0].values.lineAmount, 150) && r.rows[0].values.quantity === 15);
      check("...the unmapped item is EXCLUDED from groups and totals but REPORTED (1 line, 25)", near(r.totals.values.lineAmount, 150) && r.mapping.unmappedLines === 1 && near(r.mapping.unmappedLineAmount, 25) && r.mapping.mappedLines === 6 && near(r.mapping.mappedLineAmount, 150));
      check("the Stock Item master was read exactly once, for the AUTHORIZED tenant only", mapCalls.length === 1 && mapCalls[0] === T_A);

      const plain = await executeQuery({ ...base, period: OCT, metrics: ["invoiceAmount"] }, { tenantId: T_A, ...spyCtx });
      check("queries with no productGroup never touch the master", plain.ok && mapCalls.length === 1 && nameCalls.length === 0);

      const filt = await executeQuery({ ...base, period: OCT, metrics: ["lineAmount"], filters: [{ dim: "productGroup", op: "eq_ci", value: "groupone" }] }, { tenantId: T_B, ...spyCtx, runAggregate: async () => [] });
      check("a productGroup filter resolves item names for the authorized tenant only (B, not A)", filt.ok && nameCalls.length === 1 && nameCalls[0][0] === T_B && nameCalls[0][1] === "groupone");

      const seenPipelines = [];
      const real = await run({ ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }, T_A, { runAggregate: async (m, p, o) => (seenPipelines.push(p), buildAggregate(m, p, o).exec()) });
      check("on real MongoDB a productGroup query issues exactly ONE aggregation (was 3) and still returns 2400 / 500", real.ok && seenPipelines.length === 1 && real.diagnostics.queryCount === 1 && near(real.rows[0].values.lineAmount, 2400) && near(real.rows[1].values.lineAmount, 500));

      // Deterministic ties: 0.3 vs (0.1 + 0.2 = 0.30000000000000004) are the same amount to the paisa.
      const NOV = { kind: "custom", from: "2025-11-01", to: "2025-11-30" };
      const tie = await executeQuery({ ...base, period: NOV, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }, { tenantId: T_C, referenceDate: REF_OCT20 });
      check("groups tied to the paisa order by KEY, not by float noise (Tie A before Tie B) - MongoDB path", tie.ok && tie.rows.map((r) => r.key.customer).join() === "Tie A,Tie B", tie.ok ? tie.rows.map((r) => `${r.key.customer}=${r.values.invoiceAmount}`).join() : JSON.stringify(tie.errors));
      check("...proof the noise is real: the raw sums differ in the last bit", tie.ok && tie.rows[0].values.invoiceAmount !== tie.rows[1].values.invoiceAmount);
      const tieAsc = await executeQuery({ ...base, period: NOV, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "asc" }] }, { tenantId: T_C, referenceDate: REF_OCT20 });
      check("...and the key tie-break is stable for ascending order too", tieAsc.ok && tieAsc.rows.map((r) => r.key.customer).join() === "Tie A,Tie B");
      const tieG = await executeQuery({ ...base, period: NOV, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }, { tenantId: T_C, referenceDate: REF_OCT20 });
      check("groups tied to the paisa order by key on the roll-up (in-memory) path too", tieG.ok && tieG.rows.map((r) => r.key.productGroup).join() === "Tie GroupA,Tie GroupB", tieG.ok ? tieG.rows.map((r) => `${r.key.productGroup}=${r.values.lineAmount}`).join() : JSON.stringify(tieG.errors));
      const tieC = await executeQuery({ ...base, period: NOV, compare: { mode: "custom", period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" } }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }, { tenantId: T_C, referenceDate: REF_OCT20 });
      check("groups tied to the paisa order by key on the comparison path too", tieC.ok && tieC.rows.map((r) => r.key.customer).join() === "Tie A,Tie B");

      const overflow = await executeQuery({ ...base, period: OCT, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }, { tenantId: T_A, loadStockGroupMap: async () => new Map(), runAggregate: async () => Array.from({ length: LIMITS.maxRollupRows + 1 }, (_, i) => ({ key: { productGroup: `i${i}` }, lineAmount: 1, __lines: 1, __amount: 1 })) });
      check("a roll-up beyond maxRollupRows is refused (result_too_large), never silently truncated", overflow.ok === false && overflow.errors[0].code === "result_too_large");
    }

    // ================================================================
    section("8. Real-data smoke (WE FOUR) - independent aggregation, NOT the parity suite");
    // ================================================================
    {
      const we = await Company.findOne({ companyName: "WE FOUR" }).lean();
      if (!we) {
        check("WE FOUR present for the smoke check", false, "not found - skipped");
      } else {
        const tid = we.tenantId;
        const sc = { tenantId: tid, voucherStatus: "active" };
        const [ind] = await Sale.aggregate([{ $match: sc }, { $group: { _id: null, t: { $sum: "$header.voucherTotalAmount" }, n: { $sum: 1 } } }]);
        const eng = await executeQuery({ ...base, period: { kind: "all_time" }, metrics: ["invoiceAmount", "invoiceCount"] }, { tenantId: tid });
        check(`all-time sales total/count equal an independent aggregation (${ind.n} invoices)`, eng.ok && near(eng.totals.values.invoiceAmount, ind.t, 1e-4) && eng.totals.values.invoiceCount === ind.n);
        const [ip] = await Purchase.aggregate([{ $match: sc }, { $group: { _id: null, t: { $sum: "$header.voucherTotalAmount" }, n: { $sum: 1 } } }]);
        const engP = await executeQuery({ ...purchaseBase, period: { kind: "all_time" }, metrics: ["purchaseAmount", "purchaseInvoiceCount"] }, { tenantId: tid });
        check(`all-time purchase total/count equal an independent aggregation (${ip.n} invoices)`, engP.ok && near(engP.totals.values.purchaseAmount, ip.t, 1e-4) && engP.totals.values.purchaseInvoiceCount === ip.n);
        const [top] = await Sale.aggregate([{ $match: sc }, { $group: { _id: "$header.partyName", t: { $sum: "$header.voucherTotalAmount" } } }, { $sort: { t: -1, _id: 1 } }, { $limit: 1 }]);
        const engTop = await executeQuery({ ...base, period: { kind: "all_time" }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 1 }, { tenantId: tid });
        check("top customer equals an independent aggregation", engTop.ok && engTop.rows[0].key.customer === top._id && near(engTop.rows[0].values.invoiceAmount, top.t, 1e-4));
        const quarter = await executeQuery({ ...base, period: { kind: "current_quarter" }, compare: { mode: "like_for_like" }, metrics: ["invoiceAmount"] }, { tenantId: tid });
        // Decision 1 (2026-09-28): with no date passed, the engine uses the AI reporting rule - TODAY (was: the tenant's
        // latest voucher). The current quarter therefore ends today, whatever the tenant's data holds.
        const today = new Date();
        const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        check("relative period on real data resolves via the reporting reference date (current quarter to date, comparison range echoed)", quarter.ok && quarter.assumptions.some((a) => a.code === "period_anchored_to_latest_data") && !!quarter.comparison.from);
        check("the reference date is today, not the tenant's latest voucher (current quarter ends today)", ymdLocal(new Date(quarter.period.to)) === ymdLocal(today), quarter.period.to);
      }
    }

    // ================================================================
    section("9. Catalog consistency: every code the validator emitted is declared");
    // ================================================================
    {
      const declared = new Set(CATALOG.queryRules.map((r) => r.code));
      const schemaCodes = new Set(["not_an_object", "not_serializable", "plan_too_large", "forbidden_key", "unrecognized_keys", "invalid_union", "custom", "invalid_value", "invalid_type", "too_big", "too_small", "invalid_format"]);
      const undeclared = [...emitted].filter((c) => !declared.has(c) && !schemaCodes.has(c));
      check(`all ${emitted.size} emitted validator codes are declared in the catalog rule table (or are schema-layer codes)`, undeclared.length === 0, undeclared.join(","));
      const unused = [...declared].filter((c) => !emitted.has(c));
      console.log(`  (info) declared rule codes not exercised in this run: ${unused.join(", ") || "none"}`);
    }

    // ================================================================
    // informational: DSL -> compiled MongoDB
    if (process.env.SHOW_COMPILED) {
      section("INFO: DSL -> compiled MongoDB examples");
      for (const [label, plan] of [
        ["Top customers (voucher grain)", { ...base, period: OCT, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 }],
        ["Product groups vs same-duration prior period", { ...base, period: { kind: "current_quarter" }, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount.delta", dir: "desc" }], limit: 5 }],
        ["Filtered by a hostile-looking customer name", { ...base, period: OCT, filters: [{ dim: "customer", op: "eq_ci", value: ".*" }] }],
      ]) {
        const r = V(plan);
        console.log(`\n# ${label}\nPLAN: ${JSON.stringify(plan)}`);
        const c = compileQuery(r.normalized, { tenantId: "<authorized tenantId>" });
        for (const q of c.queries) console.log(`--- query "${q.key}" on ${q.model} options=${JSON.stringify(q.options)}\n${JSON.stringify(q.pipeline)}`);
      }
    }
  } finally {
    await cleanup();
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(async (e) => {
  console.error("SUITE CRASHED:", e);
  try {
    await cleanup();
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});

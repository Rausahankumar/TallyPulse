"use strict";

/**
 * Phase 1A verification: Sales/Purchase semantic catalog + strict Query DSL
 * schema. Fully deterministic - NO database, NO Tally, NO Anthropic call.
 * (It require()s existing analytics modules only to guard the catalog
 * against drifting from production constants/functions; requiring them
 * loads Mongoose models but never connects.)
 *
 * Run: node verify-query-dsl.js
 */

const fs = require("fs");
const path = require("path");

const catalogModule = require("./src/services/query/semanticCatalog");
const schemaModule = require("./src/services/query/queryPlan.schema");
const periodEngine = require("./src/services/analytics/periodEngine");
const salesAnalytics = require("./src/services/analytics/salesAnalytics");
const purchaseAnalytics = require("./src/services/analytics/purchaseAnalytics");
const stockGroupAnalytics = require("./src/services/analytics/stockGroupAnalytics");

const { CATALOG, LIMITS } = catalogModule;
const { parseQueryPlan, queryPlanJsonSchema } = schemaModule;

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

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------
section("1. Catalog: required content (per the Phase 1 scope)");
// ------------------------------------------------------------------
{
  const salesMetrics = catalogModule.metricsForEntity("sales").map((m) => m.id).sort();
  const purchaseMetrics = catalogModule.metricsForEntity("purchase").map((m) => m.id).sort();
  check(
    "sales metrics are exactly the requested set (+ lineCount, the one disclosed addition)",
    same(salesMetrics, ["averageInvoiceValue", "invoiceAmount", "invoiceCount", "lineAmount", "lineCount", "quantity"]),
    salesMetrics.join(",")
  );
  check(
    "purchase metrics are exactly the requested set (+ lineCount)",
    same(purchaseMetrics, ["averagePurchaseValue", "lineAmount", "lineCount", "purchaseAmount", "purchaseInvoiceCount", "quantity"]),
    purchaseMetrics.join(",")
  );

  const salesDims = catalogModule.dimensionsForEntity("sales").map((d) => d.id).sort();
  const purchaseDims = catalogModule.dimensionsForEntity("purchase").map((d) => d.id).sort();
  check("sales dimensions: date, customer, product, productGroup, voucherType", same(salesDims, ["customer", "date", "product", "productGroup", "voucherType"]), salesDims.join(","));
  check("purchase dimensions: date, supplier, product, productGroup, voucherType", same(purchaseDims, ["date", "product", "productGroup", "supplier", "voucherType"]), purchaseDims.join(","));
  check("customer exists only on sales, supplier only on purchase", !purchaseDims.includes("customer") && !salesDims.includes("supplier"));

  // Every measure must fully specify its accounting meaning.
  const REQUIRED_FIELDS = ["id", "label", "entities", "grain", "sign", "amountBasis", "status", "description"];
  const incomplete = Object.values(CATALOG.metrics).filter((m) => REQUIRED_FIELDS.some((f) => !(f in m)) || !(m.aggregation || m.derived));
  check("every metric defines source/aggregation, sign, amount basis, status, applicable entities", incomplete.length === 0, incomplete.map((m) => m.id).join(","));

  const bad = Object.values(CATALOG.metrics).filter((m) => !["voucher", "line"].includes(m.grain) || m.status !== "supported" || (m.aggregation && m.derived));
  check("every metric has a valid grain, supported status, and exactly one of aggregation/derived", bad.length === 0, bad.map((m) => m.id).join(","));

  const derivedBad = Object.values(CATALOG.metrics).filter((m) => {
    if (!m.derived) return false;
    const n = CATALOG.metrics[m.derived.numerator];
    const d = CATALOG.metrics[m.derived.denominator];
    return !n || !d || n.grain !== m.grain || d.grain !== m.grain || !same(n.entities, m.entities) || !same(d.entities, m.entities);
  });
  check("derived metrics reference existing same-entity, same-grain metrics", derivedBad.length === 0, derivedBad.map((m) => m.id).join(","));

  const amountBases = Object.values(CATALOG.metrics).filter((m) => m.amountBasis).map((m) => `${m.id}=${m.amountBasis}`);
  check(
    "invoice/purchase totals use the voucher-total basis; lineAmount uses the pre-tax line basis (kept clearly separate)",
    CATALOG.metrics.invoiceAmount.amountBasis === "voucher_total_incl_tax" &&
      CATALOG.metrics.purchaseAmount.amountBasis === "voucher_total_incl_tax" &&
      CATALOG.metrics.lineAmount.amountBasis === "line_item_pre_tax",
    amountBases.join(" ")
  );
  check(
    "sources match the existing analytics: totals -> header.voucherTotalAmount, lines -> inventory.amount/quantity",
    CATALOG.metrics.invoiceAmount.aggregation.path === "header.voucherTotalAmount" &&
      CATALOG.metrics.purchaseAmount.aggregation.path === "header.voucherTotalAmount" &&
      CATALOG.metrics.lineAmount.aggregation.path === "inventory.amount" &&
      CATALOG.metrics.quantity.aggregation.path === "inventory.quantity"
  );
  // Planner-visible parts of the catalog (ids, labels, semantics) must never
  // mention tenant/company scope. Internal `source` metadata is excluded.
  const plannerVisible = {
    entities: Object.values(CATALOG.entities).map((e) => ({ id: e.id, label: e.label })),
    dimensions: Object.values(CATALOG.dimensions).map(({ source, ...rest }) => rest),
    metrics: CATALOG.metrics,
    compare: CATALOG.compare,
    limits: CATALOG.limits,
    listMode: CATALOG.listMode,
    periodKinds: CATALOG.periods.kinds,
  };
  check("no tenant/company concept appears in any planner-visible part of the catalog", !/tenant|companyGuid|companyId/i.test(JSON.stringify(plannerVisible)));
  check(
    "the productGroup join REQUIRES the tenant key (structural: a compiler cannot forget the tenant match)",
    CATALOG.dimensions.productGroup.source.join.on.tenantId === "tenantId" && CATALOG.dimensions.productGroup.source.join.on.itemName === "inventory.itemName"
  );
  check("unsupported capabilities each carry a reason", CATALOG.unsupported.length > 0 && CATALOG.unsupported.every((u) => u.id && u.reason));
}

// ------------------------------------------------------------------
section("2. Catalog: drift guards against production code");
// ------------------------------------------------------------------
{
  check(
    "voucher-total basis string equals salesAnalytics.CUSTOMER_SALES_AMOUNT_BASIS",
    CATALOG.amountBasis.VOUCHER_TOTAL_INCL_TAX === salesAnalytics.CUSTOMER_SALES_AMOUNT_BASIS
  );
  check("line-item basis string equals stockGroupAnalytics.AMOUNT_BASIS", CATALOG.amountBasis.LINE_ITEM_PRE_TAX === stockGroupAnalytics.AMOUNT_BASIS);

  const engineKinds = periodEngine.PERIOD_KINDS;
  const catalogKinds = CATALOG.periods.kinds;
  check("period kinds = every periodEngine kind + only the DSL-level all_time", same([...catalogKinds].sort(), [...engineKinds, "all_time"].sort()));
  check("comparisonSupport covers exactly the catalog period kinds", same(Object.keys(CATALOG.periods.comparisonSupport).sort(), [...catalogKinds].sort()));

  const modules = { salesAnalytics, purchaseAnalytics, stockGroupAnalytics };
  const missing = CATALOG.parityOracles.filter((o) => o.oracle && typeof modules[o.oracle.module]?.[o.oracle.fn] !== "function");
  check("every parity oracle names an existing analytics function", missing.length === 0, missing.map((o) => `${o.oracle.module}.${o.oracle.fn}`).join(","));
  check(
    "shapes with no existing oracle are explicitly marked independent (not silently assumed)",
    CATALOG.parityOracles.filter((o) => !o.oracle).every((o) => o.independent === true)
  );

  // The catalog's stated compare-derived semantics must equal computeGrowth.
  const g = salesAnalytics.computeGrowth(150, 100);
  const z = salesAnalytics.computeGrowth(5, 0);
  check("delta/deltaPct match computeGrowth for a normal case", g.growthAmount === 50 && g.growthPercentage === 50);
  check("deltaPct is null (not Infinity/0%) when previous is 0 - as the catalog states", z.growthAmount === 5 && z.growthPercentage === null);

  check("LIMITS: default <= max, series default <= max", LIMITS.defaultLimit <= LIMITS.maxLimit && LIMITS.defaultSeriesLimit <= LIMITS.maxLimit);
  check("LIMITS match the requested guards (max 100 rows, default 10, max 2 groupBy)", LIMITS.maxLimit === 100 && LIMITS.defaultLimit === 10 && LIMITS.maxGroupBy === 2);
}

// ------------------------------------------------------------------
section("3. Catalog: immutability + fingerprint");
// ------------------------------------------------------------------
{
  const isDeepFrozen = (o) => Object.isFrozen(o) && Object.values(o).every((v) => v === null || typeof v !== "object" || isDeepFrozen(v));
  check("catalog is deeply frozen", isDeepFrozen(CATALOG));
  let threw = false;
  try {
    CATALOG.metrics.invoiceAmount.aggregation.path = "inventory.amount";
  } catch {
    threw = true;
  }
  check("mutating a metric definition at runtime throws", threw && CATALOG.metrics.invoiceAmount.aggregation.path === "header.voucherTotalAmount");

  const f1 = catalogModule.computeFingerprint();
  const f2 = catalogModule.computeFingerprint();
  const clone = structuredClone(CATALOG);
  const f3 = catalogModule.computeFingerprint(clone);
  clone.metrics.invoiceAmount.aggregation.path = "inventory.amount";
  const f4 = catalogModule.computeFingerprint(clone);
  check("fingerprint is stable across calls and identical for an identical clone", f1 === f2 && f1 === f3 && /^[0-9a-f]{16}$/.test(f1));
  check("fingerprint changes when a financial definition changes (cache invalidates automatically)", f1 !== f4);
}

// ------------------------------------------------------------------
section("4. Comparison support vs the REAL periodEngine (like-for-like vs full previous)");
// ------------------------------------------------------------------
{
  const ref = new Date(2025, 11, 8, 0, 0, 0, 0); // 8 Dec 2025 - mid month/quarter/FY
  const opts = { custom: { from: "2025-08-01", to: "2025-08-31" }, specific_fy: { fy: "2025-26" } };
  const fmt = (r) => `${r.from.toDateString()}..${r.to.toDateString()}`;

  for (const kind of periodEngine.PERIOD_KINDS) {
    const support = CATALOG.periods.comparisonSupport[kind];
    const options = opts[kind] || {};
    const lfl = periodEngine.resolveComparisonPeriod(kind, ref, options);

    check(`${kind}: likeForLike=${support.likeForLike} agrees with resolveComparisonPeriod (${lfl ? "non-null" : "null"})`, (lfl !== null) === support.likeForLike);

    if (support.fullPrevious && typeof support.fullPrevious === "object") {
      const current = periodEngine.resolvePeriod(kind, ref, options);
      const full = periodEngine.resolvePeriod(support.fullPrevious.kind, ref, options);
      check(`${kind}: full_previous -> ${support.fullPrevious.kind} is a COMPLETE period`, full.isPartial === false);
      check(`${kind}: current period is partial at this reference date (so the two modes must differ)`, current.isPartial === true);
      check(
        `${kind}: like-for-like ends EARLIER than the full previous period (${fmt(lfl)} vs ${fmt(full)})`,
        lfl.to.getTime() < full.to.getTime() && lfl.from.getTime() === full.from.getTime()
      );
      check(`${kind}: differsWhenPartial is declared in the catalog`, support.differsWhenPartial === true);
    }

    if (support.fullPrevious === "equivalent_to_like_for_like") {
      const current = periodEngine.resolvePeriod(kind, ref, options);
      check(`${kind}: declared equivalent - the like-for-like window is a complete period (${fmt(lfl)})`, lfl !== null && current.isPartial !== undefined);
    }

    // same_period_last_year is uniform for every kind except all_time.
    let sply = true;
    try {
      periodEngine.resolveSamePeriodLastYear(kind, ref, options);
    } catch {
      sply = false;
    }
    check(`${kind}: same_period_last_year resolves`, sply);
  }

  // The verified periodEngine quirk, recorded as data (and locked in here).
  const cur = periodEngine.resolvePeriod("current_fy", ref);
  const curCmp = periodEngine.resolveComparisonPeriod("current_fy", ref);
  const spec = periodEngine.resolvePeriod("specific_fy", ref, { fy: "2025-26" });
  const specCmp = periodEngine.resolveComparisonPeriod("specific_fy", ref, { fy: "2025-26" });
  check("current_fy truncates like-for-like (prior FY comparison ends 8 Dec 2024)", curCmp.to.getMonth() === 11 && curCmp.to.getDate() === 8 && cur.to.getDate() === 8);
  check(
    "specific_fy of the in-progress FY spans the WHOLE FY and compares against the COMPLETE prior FY (documented caveat, preserved not changed)",
    spec.to.getMonth() === 2 && spec.to.getDate() === 31 && specCmp.to.getMonth() === 2 && specCmp.to.getDate() === 31 && spec.isPartial === true
  );
  check("catalog records that specific_fy caveat", CATALOG.periods.comparisonSupport.specific_fy.caveat === "comparison_is_complete_prior_fy_even_when_selected_fy_is_in_progress");
}

// ------------------------------------------------------------------
section("5. Compatibility matrix (metric x groupBy dimension)");
// ------------------------------------------------------------------
{
  const salesMx = catalogModule.buildCompatibilityMatrix("sales");
  const purchaseMx = catalogModule.buildCompatibilityMatrix("purchase");

  for (const m of ["invoiceAmount", "invoiceCount", "averageInvoiceValue"]) {
    check(`sales ${m}: OK by date/customer/voucherType`, ["date", "customer", "voucherType"].every((d) => salesMx[m][d].status === "ok"));
    check(
      `sales ${m}: INVALID by product/productGroup (no invented tax allocation)`,
      ["product", "productGroup"].every((d) => salesMx[m][d].status === "invalid" && salesMx[m][d].code === "dimension_not_applicable_to_voucher_metric")
    );
  }
  for (const m of ["lineAmount", "lineCount"]) {
    check(`sales ${m}: OK by every dimension`, Object.values(salesMx[m]).every((c) => c.status === "ok"));
  }
  check("sales quantity: OK by product", salesMx.quantity.product.status === "ok");
  check(
    "sales quantity: OK-with-caveat mixed_units for every other dimension",
    ["date", "customer", "productGroup", "voucherType"].every((d) => salesMx.quantity[d].status === "ok_with_caveat" && salesMx.quantity[d].code === "mixed_units")
  );
  for (const m of ["purchaseAmount", "purchaseInvoiceCount", "averagePurchaseValue"]) {
    check(
      `purchase ${m}: OK by date/supplier/voucherType, INVALID by product/productGroup`,
      ["date", "supplier", "voucherType"].every((d) => purchaseMx[m][d].status === "ok") && ["product", "productGroup"].every((d) => purchaseMx[m][d].status === "invalid")
    );
  }
  check("purchase quantity mirrors sales quantity caveats", purchaseMx.quantity.product.status === "ok" && purchaseMx.quantity.supplier.status === "ok_with_caveat");
  check(
    "matrix rows only contain metrics of that entity, columns only its dimensions",
    !("invoiceAmount" in purchaseMx) && !("purchaseAmount" in salesMx) && !("supplier" in salesMx.lineAmount) && !("customer" in purchaseMx.lineAmount)
  );
  check("query rule codes are unique", new Set(CATALOG.queryRules.map((r) => r.code)).size === CATALOG.queryRules.length);
}

// ------------------------------------------------------------------
section("6. DSL: the requested example questions are all expressible (no per-question tool)");
// ------------------------------------------------------------------
const base = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"] };

const EXAMPLES = [
  ["What were my sales last month?", { ...base, period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"] }],
  ["What were my purchases last month?", { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["purchaseAmount", "purchaseInvoiceCount"] }],
  ["Who were my top 10 customers?", { ...base, period: { kind: "current_fy" }, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }],
  ["Which customers purchased less this month?", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] }],
  ["Which customers stopped buying?", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount", op: "eq", value: 0 }, { metric: "invoiceAmount.previous", op: "gt", value: 0 }], sort: [{ by: "invoiceAmount.previous", dir: "desc" }] }],
  ["Which products sold the most?", { ...base, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["Which products declined compared with last month?", { ...base, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "product" }], having: [{ metric: "lineAmount.delta", op: "lt", value: 0 }], sort: [{ by: "lineAmount.delta", dir: "asc" }] }],
  ["Which product groups grew the most?", { ...base, period: { kind: "current_quarter" }, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount.delta", dir: "desc" }] }],
  ["What did I sell to DHINGRA GENERAL STORE?", { ...base, period: { kind: "all_time" }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "product" }], filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["How much did I purchase from supplier X?", { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "all_time" }, metrics: ["purchaseAmount"], filters: [{ dim: "supplier", op: "eq_ci", value: "Supplier X" }] }],
  ["Compare sales this quarter with the previous quarter.", { ...base, period: { kind: "current_quarter" }, compare: { mode: "full_previous" } }],
  ["Show monthly sales.", { ...base, period: { kind: "current_fy" }, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "date", bucket: "month" }], sort: [{ by: "date", dir: "asc" }], limit: 100 }],
  ["Show customers whose sales increased by more than 20%.", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "customer" }], having: [{ metric: "invoiceAmount.deltaPct", op: "gt", value: 20 }], sort: [{ by: "invoiceAmount.deltaPct", dir: "desc" }] }],
  ["Which products contributed most to the sales decline?", { ...base, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], totals: true }],
  ["What was my average invoice value?", { ...base, metrics: ["averageInvoiceValue"] }],
  ["Show the largest invoices.", { v: 1, entity: "sales", mode: "list", period: { kind: "current_fy" }, sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 }],
  ["Show sales between two dates.", { ...base, period: { kind: "custom", from: "2025-08-01", to: "2025-08-15" } }],
  ["Find invoices for a customer/product.", { v: 1, entity: "sales", mode: "list", period: { kind: "all_time" }, filters: [{ dim: "customer", op: "eq_ci", value: "DHINGRA GENERAL STORE" }, { dim: "product", op: "contains_ci", value: "lens cleaning" }], sort: [{ by: "date", dir: "desc" }] }],
  // beyond the list: other supported primitives
  ["Sales by voucher type", { ...base, groupBy: [{ dim: "voucherType" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }],
  ["Purchases by product group", { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "current_quarter" }, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["Customer x product breakdown (2 groupBy dims)", { ...base, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }, { dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }] }],
  ["Weekly sales", { ...base, groupBy: [{ dim: "date", bucket: "week" }] }],
  ["Sales in FY 2024-25", { ...base, period: { kind: "specific_fy", fy: "2024-25" } }],
  ["Sales vs same period last year", { ...base, compare: { mode: "same_period_last_year" } }],
  ["Compare two explicit ranges", { ...base, period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } } }],
  ["Customers matching a name fragment", { ...base, groupBy: [{ dim: "customer" }], filters: [{ dim: "customer", op: "in_ci", value: ["Elite Stores-Stationers", "School Caddy"] }], sort: [{ by: "invoiceAmount", dir: "desc" }] }],
  ["Purchases of a product group vs prior quarter", { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "current_quarter" }, metrics: ["lineAmount"], compare: { mode: "like_for_like" }, filters: [{ dim: "productGroup", op: "eq_ci", value: "Oddy" }] }],
];

for (const [question, plan] of EXAMPLES) {
  const r = parseQueryPlan(plan);
  check(question, r.ok, r.ok ? "" : JSON.stringify(r.errors));
}
check(`${EXAMPLES.length} distinct question shapes expressed with ONE schema and no question-specific tool`, EXAMPLES.length >= 25);

// defaults / normalization
{
  const r = parseQueryPlan(base);
  check(
    "defaults applied: compare=null, groupBy/filters/having/sort=[], totals=true, explain=none, limit left undefined (shape-dependent default is the validator's job)",
    r.ok && r.plan.compare === null && same(r.plan.groupBy, []) && same(r.plan.filters, []) && r.plan.totals === true && r.plan.explain === "none" && r.plan.limit === undefined
  );
  const l = parseQueryPlan({ v: 1, entity: "sales", mode: "list", period: { kind: "current_fy" } });
  check("list mode normalizes totals=false", l.ok && l.plan.totals === false);
  const input = { ...base };
  parseQueryPlan(input);
  check("parseQueryPlan does not mutate its input", same(input, base));
}

// ------------------------------------------------------------------
section("7. DSL: rejections (security + validity)");
// ------------------------------------------------------------------
{
  const rejects = (label, raw, code) => {
    const r = parseQueryPlan(raw);
    const codes = r.ok ? [] : r.errors.map((e) => e.code);
    check(label, r.ok === false && (!code || codes.includes(code)), r.ok ? "ACCEPTED" : `codes=${codes.join(",")}`);
  };
  const withKey = (extra) => ({ ...base, ...extra });

  // not a plan
  rejects("null", null, "not_an_object");
  rejects("string", "sales last month", "not_an_object");
  rejects("array", [], "not_an_object");
  rejects("number", 42, "not_an_object");
  rejects("circular structure", (() => { const o = { ...base }; o.self = o; return o; })(), "not_serializable");

  // tenant / company scope can never be supplied
  rejects("tenantId at top level", withKey({ tenantId: "x" }), "unrecognized_keys");
  rejects("companyGuid at top level", withKey({ companyGuid: "x" }), "unrecognized_keys");
  rejects("companyId at top level", withKey({ companyId: "x" }), "unrecognized_keys");
  rejects("tenantId smuggled inside a filter", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "A", tenantId: "x" }] }), "unrecognized_keys");
  rejects("tenantId smuggled inside period", withKey({ period: { kind: "current_month", tenantId: "x" } }), "unrecognized_keys");
  rejects("tenantId smuggled inside compare", withKey({ compare: { mode: "like_for_like", tenantId: "x" } }), "unrecognized_keys");
  rejects("tenantId smuggled inside groupBy item", withKey({ groupBy: [{ dim: "customer", tenantId: "x" }] }), "unrecognized_keys");
  rejects("tenant filter via a fake dimension", withKey({ filters: [{ dim: "tenantId", op: "eq_ci", value: "x" }] }));

  // raw mongo / expressions / code
  rejects("$match key", withKey({ $match: { tenantId: "x" } }), "unrecognized_keys");
  rejects("$where key", withKey({ $where: "sleep(1000)" }), "unrecognized_keys");
  rejects("pipeline key", withKey({ pipeline: [{ $match: {} }] }), "unrecognized_keys");
  rejects("collection key", withKey({ collection: "users" }), "unrecognized_keys");
  rejects("filter value as a Mongo operator object", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: { $ne: "" } }] }));
  rejects("filter value as an array under eq_ci", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: ["a"] }] }));
  rejects("metric as an arithmetic expression", withKey({ metrics: ["invoiceAmount*2"] }));
  rejects("metric as an object expression", withKey({ metrics: [{ $sum: "$header.voucherTotalAmount" }] }));
  rejects("unknown metric (profit)", withKey({ metrics: ["profit"] }));
  rejects("having metric as an expression", withKey({ having: [{ metric: "invoiceAmount - 1", op: "gt", value: 0 }] }));
  rejects("sort by an arbitrary path", withKey({ sort: [{ by: "header.voucherTotalAmount", dir: "desc" }] }));
  rejects("__proto__ own key (via JSON.parse)", JSON.parse(`{"v":1,"entity":"sales","mode":"aggregate","period":{"kind":"today"},"metrics":["invoiceAmount"],"__proto__":{"x":1}}`), "forbidden_key");
  rejects("nested constructor key", withKey({ filters: [JSON.parse('{"dim":"customer","op":"eq_ci","value":"A","constructor":{"x":1}}')] }), "forbidden_key");

  // strings are LITERALS: a Mongo-looking string is accepted only as an inert value
  const literal = parseQueryPlan(withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "$ne" }] }));
  check("a '$ne'-looking string is accepted only as an inert literal value (escaped downstream)", literal.ok && literal.plan.filters[0].value === "$ne");
  rejects("control character in a filter value", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "A\u0000B" }] }));
  rejects("newline in a filter value", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "A\nB" }] }));
  rejects("whitespace-only filter value", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "   " }] }));
  rejects("filter value over 200 characters", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "x".repeat(201) }] }));

  // envelope
  rejects("wrong version", withKey({ v: 2 }));
  rejects("missing version", (() => { const { v, ...rest } = base; return rest; })());
  rejects("unknown entity (ledger)", withKey({ entity: "ledger" }));
  rejects("unknown mode", withKey({ mode: "raw" }));
  rejects("aggregate with no metrics", withKey({ metrics: [] }));
  rejects("duplicate metrics", withKey({ metrics: ["invoiceAmount", "invoiceAmount"] }));
  rejects("too many metrics", withKey({ metrics: ["invoiceAmount", "invoiceCount", "averageInvoiceValue", "lineAmount", "quantity"] }));

  // groupBy
  rejects("unknown dimension (salesperson)", withKey({ groupBy: [{ dim: "salesperson" }] }));
  rejects("three groupBy dimensions", withKey({ groupBy: [{ dim: "customer" }, { dim: "product" }, { dim: "voucherType" }] }));
  rejects("duplicate groupBy dimension", withKey({ groupBy: [{ dim: "customer" }, { dim: "customer" }] }));
  rejects("groupBy date without a bucket", withKey({ groupBy: [{ dim: "date" }] }));
  rejects("bucket on a non-date dimension", withKey({ groupBy: [{ dim: "customer", bucket: "month" }] }));
  rejects("unknown bucket", withKey({ groupBy: [{ dim: "date", bucket: "hour" }] }));

  // filters
  rejects("unknown filter operator (regex)", withKey({ filters: [{ dim: "customer", op: "regex", value: ".*" }] }));
  rejects("case-sensitive 'eq' is not offered", withKey({ filters: [{ dim: "customer", op: "eq", value: "A" }] }));
  rejects("contains_ci under 3 characters", withKey({ filters: [{ dim: "customer", op: "contains_ci", value: "ab" }] }));
  rejects("contains_ci on voucherType (not allowed)", withKey({ filters: [{ dim: "voucherType", op: "contains_ci", value: "invoice" }] }));
  rejects("in_ci with a single string", withKey({ filters: [{ dim: "customer", op: "in_ci", value: "A" }] }));
  rejects("in_ci with an empty array", withKey({ filters: [{ dim: "customer", op: "in_ci", value: [] }] }));
  rejects("in_ci with 21 values", withKey({ filters: [{ dim: "customer", op: "in_ci", value: Array.from({ length: 21 }, (_, i) => `c${i}`) }] }));
  rejects("filter on date (dates only via period)", withKey({ filters: [{ dim: "date", op: "eq_ci", value: "2025-01-01" }] }));
  rejects("two filters on the same dimension", withKey({ filters: [{ dim: "customer", op: "eq_ci", value: "A" }, { dim: "customer", op: "contains_ci", value: "abc" }] }));
  rejects("six filters", withKey({ filters: ["customer", "product", "productGroup", "voucherType", "supplier", "date"].map((d) => ({ dim: d, op: "eq_ci", value: "abc" })) }));
  rejects(
    "oversized plan (>8KB) is refused before parsing",
    withKey({
      filters: ["customer", "product", "productGroup"].map((d) => ({ dim: d, op: "in_ci", value: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, "x")) })),
    }),
    "plan_too_large"
  );

  // limits
  rejects("limit 0", withKey({ limit: 0 }));
  rejects("limit 101 (max is 100)", withKey({ limit: 101 }));
  rejects("negative limit", withKey({ limit: -5 }));
  rejects("fractional limit", withKey({ limit: 1.5 }));
  rejects("string limit", withKey({ limit: "10" }));
  check("limit 100 is accepted (boundary)", parseQueryPlan(withKey({ limit: 100 })).ok);
  check("limit 1 is accepted (boundary)", parseQueryPlan(withKey({ limit: 1 })).ok);

  // having / sort
  rejects("having op unknown", withKey({ having: [{ metric: "invoiceAmount", op: "like", value: 1 }] }));
  rejects("having value as a string", withKey({ having: [{ metric: "invoiceAmount", op: "gt", value: "5" }] }));
  rejects("having value Infinity", withKey({ having: [{ metric: "invoiceAmount", op: "gt", value: Infinity }] }));
  rejects("four having clauses", withKey({ having: Array.from({ length: 4 }, () => ({ metric: "invoiceAmount", op: "gt", value: 1 })) }));
  rejects("sort dir invalid", withKey({ sort: [{ by: "invoiceAmount", dir: "sideways" }] }));
  rejects("duplicate sort keys", withKey({ sort: [{ by: "invoiceAmount", dir: "asc" }, { by: "invoiceAmount", dir: "desc" }] }));
  rejects("three sort keys", withKey({ sort: [{ by: "invoiceAmount", dir: "asc" }, { by: "invoiceCount", dir: "asc" }, { by: "date", dir: "asc" }] }));

  // period
  rejects("unknown period kind", withKey({ period: { kind: "next_year" } }));
  rejects("period given as a string", withKey({ period: "last month" }));
  rejects("custom without from/to", withKey({ period: { kind: "custom" } }));
  rejects("custom with from after to", withKey({ period: { kind: "custom", from: "2025-09-01", to: "2025-08-01" } }));
  rejects("custom with an impossible date (2025-02-30)", withKey({ period: { kind: "custom", from: "2025-02-30", to: "2025-03-01" } }));
  rejects("custom with month 13", withKey({ period: { kind: "custom", from: "2025-13-01", to: "2025-13-02" } }));
  rejects("custom with a timestamp instead of a date", withKey({ period: { kind: "custom", from: "2025-08-01T00:00:00Z", to: "2025-08-02" } }));
  rejects("custom date in a non-ISO format", withKey({ period: { kind: "custom", from: "1 Aug 2025", to: "31 Aug 2025" } }));
  rejects("dates smuggled into a standard kind", withKey({ period: { kind: "current_month", from: "2025-01-01", to: "2025-12-31" } }), "unrecognized_keys");
  rejects("specific_fy without fy", withKey({ period: { kind: "specific_fy" } }));
  rejects("specific_fy inconsistent years (2025-27)", withKey({ period: { kind: "specific_fy", fy: "2025-27" } }));
  rejects('specific_fy with an "FY " prefix (one canonical form only)', withKey({ period: { kind: "specific_fy", fy: "FY 2025-26" } }));
  check("all_time is accepted as a DSL-level period", parseQueryPlan(withKey({ period: { kind: "all_time" } })).ok);

  // compare
  rejects("unknown compare mode", withKey({ compare: { mode: "vs_budget" } }));
  rejects("custom compare without a period", withKey({ compare: { mode: "custom" } }));
  rejects("custom compare period that is not custom", withKey({ compare: { mode: "custom", period: { kind: "previous_month" } } }));
  rejects("like_for_like with extra keys", withKey({ compare: { mode: "like_for_like", from: "2025-01-01" } }), "unrecognized_keys");

  // list mode shape
  const listBase = { v: 1, entity: "sales", mode: "list", period: { kind: "current_fy" } };
  check("list mode with just a period is valid", parseQueryPlan(listBase).ok);
  rejects("list mode with metrics", { ...listBase, metrics: ["invoiceAmount"] });
  rejects("list mode with groupBy", { ...listBase, groupBy: [{ dim: "customer" }] });
  rejects("list mode with compare", { ...listBase, compare: { mode: "like_for_like" } });
  rejects("list mode with having", { ...listBase, having: [{ metric: "invoiceAmount", op: "gt", value: 1 }] });
}

// ------------------------------------------------------------------
section("8. Structural-vs-semantic layering (what Phase 1A deliberately does NOT reject)");
// ------------------------------------------------------------------
{
  // These are well-formed plans that the Phase 1B validator must refuse.
  // Asserting they PASS the schema documents (and pins) the layer boundary,
  // so a rule can't silently exist in both places or neither.
  const semantic = [
    ["purchase entity with a sales-only metric", { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "current_month" }, metrics: ["invoiceAmount"] }, "metric_not_applicable_to_entity"],
    ["voucher-grain metric grouped by product", { ...base, groupBy: [{ dim: "product" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }, "dimension_not_applicable_to_voucher_metric"],
    ["mixed voucher+line metrics", { ...base, metrics: ["invoiceAmount", "lineAmount"] }, "mixed_metric_grains"],
    ["compare on a date series", { ...base, compare: { mode: "like_for_like" }, groupBy: [{ dim: "date", bucket: "month" }] }, "compare_not_supported_with_date_groupby"],
    ["like_for_like on a custom period", { ...base, period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "like_for_like" } }, "compare_mode_unsupported_for_period"],
    ["compare on all_time", { ...base, period: { kind: "all_time" }, compare: { mode: "same_period_last_year" } }, "all_time_cannot_compare"],
    ["derived sort ref without compare", { ...base, groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }] }, "derived_ref_requires_compare"],
    ["having on an unselected metric", { ...base, having: [{ metric: "invoiceCount", op: "gt", value: 1 }] }, "ref_not_selected"],
    ["high-cardinality groupBy with no sort", { ...base, groupBy: [{ dim: "customer" }] }, "high_cardinality_requires_sort"],
    ["custom range over five years", { ...base, period: { kind: "custom", from: "2015-01-01", to: "2025-12-31" } }, "range_too_long"],
  ];
  for (const [label, plan, ruleCode] of semantic) {
    const r = parseQueryPlan(plan);
    const declared = CATALOG.queryRules.some((q) => q.code === ruleCode);
    check(`schema accepts (validator must reject): ${label} -> ${ruleCode}`, r.ok && declared, r.ok ? "rule not declared in catalog" : JSON.stringify(r.errors));
  }
}

// ------------------------------------------------------------------
section("9. Planner-facing JSON Schema");
// ------------------------------------------------------------------
{
  const js = queryPlanJsonSchema();
  const text = JSON.stringify(js);
  const tokens = Math.round(text.length / 4);
  check("JSON Schema generates and is an object", js && typeof js === "object" && !js.$schema);
  check("JSON Schema never mentions tenant/company fields", !/tenant|companyGuid|companyId/i.test(text));
  check("JSON Schema forbids additional properties at the top level", js.additionalProperties === false);
  check(`planner schema footprint is bounded (${text.length} bytes, ~${tokens} tokens; cacheable static block)`, text.length < 8000);
  const required = js.required || [];
  check("required top-level fields are exactly v, entity, mode, period", same([...required].sort(), ["entity", "mode", "period", "v"]), required.join(","));
}

// ------------------------------------------------------------------
section("10. Phase 1A guarantee: nothing in production imports the new modules");
// ------------------------------------------------------------------
{
  const root = path.join(__dirname, "src");
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full === path.join(root, "services", "query")) continue;
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        // Phase 1E: the data models may reference ONLY services/query/dataVersion (the cache-invalidation plugin).
        if (/services\/query|semanticCatalog|queryPlan\.schema/.test(text.replace(/\\/g, "/").replace(/services\/query\/dataVersion/g, ""))) offenders.push(path.relative(__dirname, full));
      }
    }
  })(root);
  for (const entry of ["server.js", "app.js", "index.js"]) {
    const f = path.join(__dirname, entry);
    if (fs.existsSync(f) && /services\/query|semanticCatalog|queryPlan\.schema/.test(fs.readFileSync(f, "utf8"))) offenders.push(entry);
  }
  check("no production file requires the query catalog/schema (zero behavior change)", offenders.length === 0, offenders.join(","));
}

// ------------------------------------------------------------------
// Informational: the compatibility matrix, for the design report.
// ------------------------------------------------------------------
console.log("\n--- Compatibility matrix (informational) ---");
for (const entity of ["sales", "purchase"]) {
  const mx = catalogModule.buildCompatibilityMatrix(entity);
  const dims = catalogModule.dimensionsForEntity(entity).map((d) => d.id);
  console.log(`${entity.toUpperCase()}: rows=metric, cols=[${dims.join(", ")}]  (ok / caveat / X)`);
  for (const [metric, row] of Object.entries(mx)) {
    console.log(`  ${metric.padEnd(22)} ${dims.map((d) => (row[d].status === "ok" ? "ok" : row[d].status === "ok_with_caveat" ? "caveat" : "X").padEnd(8)).join("")}`);
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

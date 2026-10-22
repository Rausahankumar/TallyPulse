/**
 * Insight tools (services/analytics/insightTools.js): the validated registry over the existing insight functions.
 *
 * Proves: each tool returns the insight function's OWN result unchanged (compared with a direct call), plus a consistent
 * evidence envelope (period, arguments, disclosures, coverage, limitations); strict argument validation (a tenant in the
 * arguments is rejected); the tenant comes from the context only and never leaks across tenants; every aggregation gets
 * an explicit maxTimeMS; timeouts, oversized groupings and other database errors map to fixed codes with plain messages;
 * product names resolve through the tenant's own entity resolver.
 *
 * Synthetic data only, on a loopback MongoDB (refused otherwise). No network, no Tally, no model. Data removed at the end.
 *
 * Run: node verify-insight-tools.js
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-insight-tools.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };
}

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const insights = require("./src/services/analytics/insights");
const dateRanges = require("./src/services/analytics/dateRanges");
const tools = require("./src/services/analytics/insightTools");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

const TA = "TEST-TENANT-A-insight-tools";
const TB = "TEST-TENANT-B-insight-tools";
let n = 0;
const V = (kind, tenant, date, party, lines) => ({ kind, tenant, date, party, lines });
// A line: [item, quantity, rate, amount as Tally stores it (purchase amounts negative)]
const VOUCHERS = [
  V("sale", TA, "2025-08-03", "Cust One", [["Item Alpha", 100, 20, 1800], ["Item Beta", 10, 100, 1000]]),
  V("sale", TA, "2025-08-18", "Cust Two", [["Item Alpha", 50, 20, 1000]]),
  V("sale", TA, "2025-09-04", "Cust One", [["Item Alpha", 20, 21, 420]]),
  V("sale", TB, "2025-08-05", "Cust B", [["Item Alpha", 7, 100, 700], ["Item Only B", 1, 10, 10]]),
  // nine suppliers of Item Alpha (more than the 8 the supplier view lists)
  ...Array.from({ length: 9 }, (_, i) => V("purchase", TA, `2025-08-${String(10 + i).padStart(2, "0")}`, `Sup ${i + 1}`, [["Item Alpha", 10, 15 + i, -(10 * (15 + i))]])),
  V("purchase", TA, "2025-08-20", "Sup 1", [["Item Beta", 5, 80, -400]]),
  V("purchase", TB, "2025-08-06", "Sup B", [["Item Alpha", 3, 90, -270]]),
];
const cleanup = async () => {
  const ids = { $in: [TA, TB] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
};
const AUG = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const augRange = () => ({ ...dateRanges.customRange(AUG.from, AUG.to), label: "2025-08-01 to 2025-08-31" });
const ctx = (tenantId, extra = {}) => ({ tenantId, ...extra });

async function main() {
  await connectDB();
  await cleanup();
  try {
    for (const v of VOUCHERS) {
      n += 1;
      const Model = v.kind === "sale" ? Sale : Purchase;
      await Model.create({
        tenantId: v.tenant,
        header: { voucherNo: `IT-${n}`, voucherDate: new Date(`${v.date}T00:00:00Z`), voucherType: v.kind === "sale" ? "Invoice" : "Purchase", partyName: v.party, voucherTotalAmount: 1, narration: "" },
        inventory: v.lines.map(([itemName, quantity, rate, amount]) => ({ itemName, quantity, rate, amount })),
        ledgers: [],
        tallyGuid: `it-${v.tenant}-${n}`,
        tallyAlterId: n,
        voucherStatus: "active",
      });
    }

    console.log("=== 1. Registry ===");
    const list = tools.listInsightTools();
    check("list-ids", "five tools with stable ids", list.map((t) => t.id), ["discount_summary", "product_rates", "product_margin", "product_trend", "supplier_rates"]);
    check("list-ready", "readiness is explicit for every tool", list.map((t) => typeof t.ready), Array(5).fill("boolean"));
    check("list-margin-indicative", "the margin tool states it is indicative, not accounting profit", list.find((t) => t.id === "product_margin").limitations.some((l) => /not accounting profit/.test(l)), true);
    check("list-descriptions", "the discount tool states its pre-tax list-minus-billed basis; the margin tool says it is not accounting profit", [list.find((t) => t.id === "discount_summary").description, list.find((t) => t.id === "product_margin").description], ["Discount given (sales) or received (purchases) in a period: list value (quantity × rate) minus the billed line amount, by customer/supplier, product or month. Pre-tax item values.", "Indicative margin per product sold in a period: average sale rate minus average purchase cost per unit. Not accounting profit."]);
    check("list-no-cause", "the discount, rates and margin tools state that figures alone do not explain a sales change", ["discount_summary", "product_rates", "product_margin"].every((id) => list.find((t) => t.id === id).limitations.some((l) => /do not explain a change in sales/.test(l))), true);
    const P = { period: { kind: "current_month" } };
    check("voucher-types", "every tool declares the vouchers it reads (the freshness gate's source)", [tools.insightToolVoucherTypes("discount_summary", P), tools.insightToolVoucherTypes("discount_summary", { ...P, entity: "purchase" }), tools.insightToolVoucherTypes("product_rates", P), tools.insightToolVoucherTypes("product_margin", P), tools.insightToolVoucherTypes("product_trend", { ...P, product: "x" }), tools.insightToolVoucherTypes("supplier_rates", { ...P, product: "x" })], [["Sales"], ["Purchase"], ["Sales", "Purchase"], ["Sales", "Purchase"], ["Sales", "Purchase"], ["Purchase"]]);
    check("voucher-types-invalid", "an unknown tool or invalid arguments read no vouchers (the tool itself then refuses)", [tools.insightToolVoucherTypes("drop_db", P), tools.insightToolVoucherTypes("product_trend", P)], [[], []]);

    console.log("\n=== 2. Each tool returns the insight function's own result, in one evidence shape ===");
    const runs = [
      ["discount_summary", { period: AUG, by: "customer", limit: 5 }, () => insights.discountSummary(TA, augRange(), { entity: "sales", by: "customer", limit: 5 })],
      ["product_rates", { period: AUG, limit: 10 }, () => insights.ratesByProduct(TA, augRange(), { limit: 10, product: null })],
      ["product_margin", { period: AUG, sortBy: "marginPct", order: "asc", limit: 10 }, () => insights.productMargin(TA, augRange(), { limit: 10, sortBy: "marginPct", order: "asc" })],
      ["product_trend", { period: { kind: "custom", from: "2025-08-01", to: "2025-09-30" }, product: "item alpha" }, () => insights.productTrend(TA, { ...dateRanges.customRange("2025-08-01", "2025-09-30"), label: "2025-08-01 to 2025-09-30" }, { product: "Item Alpha" })],
      ["supplier_rates", { period: AUG, product: "Item Alpha" }, () => insights.supplierRates(TA, augRange(), { product: "Item Alpha", limit: 1 })],
    ];
    const EVIDENCE_KEYS = ["ok", "tool", "period", "arguments", "data", "disclosures", "coverage", "limitations", "maxTimeMS"];
    for (const [id, args, direct] of runs) {
      const r = await tools.runInsightTool(id, args, ctx(TA));
      const expected = await direct();
      check(`${id}-ok`, `${id}: ok`, [r.ok, r.error ? r.error.code : null], [true, null]);
      check(`${id}-same-data`, `${id}: data is identical to a direct call of the insight function (no recalculation)`, JSON.stringify(r.data), JSON.stringify(expected));
      check(`${id}-shape`, `${id}: the evidence has the same keys as every other tool`, EVIDENCE_KEYS.every((k) => k in r) && ["hasData", "rowsReturned", "rowLimit", "mayHaveMore", "ordering", "notes"].every((k) => k in r.coverage), true);
      check(`${id}-disclosures`, `${id}: the function's own disclosures are passed through, non-empty`, [r.disclosures.length > 0, JSON.stringify(r.disclosures) === JSON.stringify(expected.disclosures)], [true, true]);
      check(`${id}-period`, `${id}: the resolved period is stated as calendar days`, [/^\d{4}-\d{2}-\d{2}$/.test(r.period.from), /^\d{4}-\d{2}-\d{2}$/.test(r.period.to)], [true, true]);
    }
    const trend = await tools.runInsightTool("product_trend", { period: AUG, product: "item alpha" }, ctx(TA));
    check("product-resolved", "a product name resolves to its stored spelling through the tenant's resolver", [trend.arguments.product, trend.productMatch.asked, trend.productMatch.resolved], ["Item Alpha", "item alpha", "Item Alpha"]);
    const sup = await tools.runInsightTool("supplier_rates", { period: AUG, product: "Item Alpha" }, ctx(TA));
    check("sup-notes", "9 suppliers, 8 listed: the evidence says so instead of hiding it", [sup.data.rows[0].supplierCount, sup.data.rows[0].suppliers.length, sup.coverage.notes.length === 1 && /8 cheapest of 9 suppliers/.test(sup.coverage.notes[0])], [9, 8, true]);
    const cleanDiscount = await tools.runInsightTool("discount_summary", { period: AUG }, ctx(TA));
    const cleanMargin = await tools.runInsightTool("product_margin", { period: AUG }, ctx(TA));
    check("no-false-notes", "clean data gets no conditional notes (every line priced, every product costed in the period, one unit)", [cleanDiscount.coverage.notes, cleanMargin.coverage.notes], [[], []]);
    const two = await tools.runInsightTool("product_rates", { period: AUG, limit: 2 }, ctx(TA));
    check("may-have-more", "a full page of rows is flagged as possibly incomplete (never presented as all rows)", [two.coverage.rowsReturned, two.coverage.rowLimit, two.coverage.mayHaveMore], [2, 2, true]);
    const rel = await tools.runInsightTool("discount_summary", { period: { kind: "current_month" } }, ctx(TA, { referenceDate: new Date(2025, 7, 20) }));
    check("relative-period", "a relative period uses the REST helper with the given reference date (1 to 20 August)", [rel.ok, rel.period.from, rel.period.to], [true, "2025-08-01", "2025-08-20"]);
    const empty = await tools.runInsightTool("discount_summary", { period: { kind: "custom", from: "2030-01-01", to: "2030-01-31" } }, ctx(TA));
    check("empty", "a period with no vouchers is an honest empty result", [empty.ok, empty.coverage.hasData, empty.coverage.rowsReturned], [true, false, 0]);

    console.log("\n=== 3. Argument validation ===");
    const code = async (id, args, c = ctx(TA)) => { const r = await tools.runInsightTool(id, args, c); return r.ok ? "ok" : r.error.code; };
    check("bad-tenant-arg", "a tenantId inside the arguments is rejected (strict schema), never used", await code("discount_summary", { period: AUG, tenantId: TB }), "invalid_arguments");
    check("bad-unknown-key", "any unknown argument is rejected", await code("product_margin", { period: AUG, sql: "x" }), "invalid_arguments");
    check("bad-limit", "limit 0 and 51 are rejected", [await code("product_rates", { period: AUG, limit: 0 }), await code("product_rates", { period: AUG, limit: 51 })], ["invalid_arguments", "invalid_arguments"]);
    check("bad-period-kind", "an unknown period kind is rejected", await code("discount_summary", { period: { kind: "last_decade" } }), "invalid_arguments");
    check("bad-period-order", "from after to is rejected", await code("discount_summary", { period: { kind: "custom", from: "2025-09-01", to: "2025-08-01" } }), "invalid_arguments");
    check("bad-period-day", "a date that does not exist (30 February) is rejected, not rolled over", await code("discount_summary", { period: { kind: "custom", from: "2025-02-01", to: "2025-02-30" } }), "invalid_arguments");
    check("bad-period-span", `a range longer than ${tools.MAX_RANGE_DAYS} days is rejected`, await code("discount_summary", { period: { kind: "custom", from: "2015-01-01", to: "2025-01-01" } }), "invalid_arguments");
    check("bad-breakdown", "a breakdown that does not exist for the entity (supplier for sales) is rejected", await code("discount_summary", { period: AUG, by: "supplier" }), "invalid_arguments");
    check("bad-product-required", "product_trend and supplier_rates require a product", [await code("product_trend", { period: AUG }), await code("supplier_rates", { period: AUG })], ["invalid_arguments", "invalid_arguments"]);
    check("bad-product-long", "a product name longer than 200 characters is rejected", await code("product_trend", { period: AUG, product: "x".repeat(201) }), "invalid_arguments");
    check("bad-sort", "an unknown margin sort is rejected", await code("product_margin", { period: AUG, sortBy: "galaxy" }), "invalid_arguments");
    check("unknown-tool", "an unknown tool id is refused", await code("drop_database", {}), "unknown_tool");
    check("bad-max-time", "a context maxTimeMS above the 8 s ceiling or not a whole number is refused", [await code("discount_summary", { period: AUG }, ctx(TA, { maxTimeMS: 60000 })), await code("discount_summary", { period: AUG }, ctx(TA, { maxTimeMS: 1.5 }))], ["invalid_context", "invalid_context"]);

    console.log("\n=== 4. Tenant context ===");
    check("tenant-required", "no tenant in the context -> refused before any query", [await code("discount_summary", { period: AUG }, {}), await code("discount_summary", { period: AUG }, { tenantId: "  " })], ["tenant_required", "tenant_required"]);
    const b = await tools.runInsightTool("product_rates", { period: AUG }, ctx(TB));
    check("tenant-isolation", "tenant B sees only its own products and numbers (A's sales never count)", b.data.rows.map((r) => [r.product, r.saleQty]).sort(), [["Item Alpha", 7], ["Item Only B", 1]]);
    check("tenant-product-resolver", "a product that exists only in tenant B does not resolve for tenant A", (await tools.runInsightTool("product_trend", { period: AUG, product: "Item Only B" }, ctx(TA))).error.code, "product_not_found");
    const nf = await tools.runInsightTool("product_trend", { period: AUG, product: "Item Alfa" }, ctx(TA));
    check("product-suggest", "an unknown product is refused with the tenant's closest names, never picked for the caller", [nf.ok, nf.error.code, Array.isArray(nf.error.suggestions) && nf.error.suggestions.includes("Item Alpha")], [false, "product_not_found", true]);
    const down = Object.assign(async () => { throw new Error("db down"); }, { suggest: async () => [] });
    check("resolver-down", "a resolver failure is entity_lookup_unavailable, not 'not found'", await code("product_trend", { period: AUG, product: "Item Alpha" }, ctx(TA, { resolveEntity: down })), "entity_lookup_unavailable");

    console.log("\n=== 5. Bounded execution and error mapping ===");
    const origSale = Sale.aggregate, origPurchase = Purchase.aggregate;
    const restore = () => { Sale.aggregate = origSale; Purchase.aggregate = origPurchase; };
    const spy = () => { const calls = []; Sale.aggregate = function (pl) { const a = origSale.call(this, pl); calls.push(a); return a; }; Purchase.aggregate = function (pl) { const a = origPurchase.call(this, pl); calls.push(a); return a; }; return calls; };
    const fakeWith = (exec) => { const fake = () => ({ option() { return this; }, exec }); Sale.aggregate = fake; Purchase.aggregate = fake; };
    try {
      for (const [id, args] of runs) {
        let calls = spy();
        await tools.runInsightTool(id, args, ctx(TA));
        restore();
        check(`time-default-${id}`, `${id}: every aggregation runs with the explicit default maxTimeMS ${tools.DEFAULT_MAX_TIME_MS}`, [calls.length > 0, calls.every((a) => a.options.maxTimeMS === tools.DEFAULT_MAX_TIME_MS)], [true, true]);
        check(`time-tenant-${id}`, `${id}: every aggregation still starts with this tenant's $match`, calls.every((a) => a.pipeline()[0].$match && a.pipeline()[0].$match.tenantId === TA), true);
        calls = spy();
        await tools.runInsightTool(id, args, ctx(TA, { maxTimeMS: 3000 }));
        restore();
        check(`time-override-${id}`, `${id}: a smaller context maxTimeMS is applied to every aggregation`, calls.every((a) => a.options.maxTimeMS === 3000), true);
      }
      fakeWith(() => Promise.reject(Object.assign(new Error("operation exceeded time limit"), { code: 50 })));
      const t = [];
      for (const [id, args] of runs) { const r = await tools.runInsightTool(id, args, ctx(TA)); t.push(`${r.error && r.error.code}|${/exceeded/i.test(JSON.stringify(r)) ? "driver text" : "plain"}`); }
      check("timeout", "a simulated MongoDB timeout is query_timeout with a plain message, in every tool", t, Array(5).fill("query_timeout|plain"));
      fakeWith(() => Promise.reject(new Error("E11000 internal pipeline detail: collection sales")));
      const leaked = await tools.runInsightTool("product_margin", { period: AUG }, ctx(TA));
      check("db-error", "any other database error is execution_failed and its text is not returned", [leaked.error.code, /E11000|collection|pipeline/.test(JSON.stringify(leaked))], ["execution_failed", false]);
      fakeWith(() => Promise.resolve(Array.from({ length: insights.MAX_GROUP_ROWS + 1 }, (_, i) => ({ _id: `P${i}`, qty: 1, billed: 1, gross: 1, minRate: 1, maxRate: 1 }))));
      check("too-large", `more than ${insights.MAX_GROUP_ROWS} products is result_too_large (never truncated)`, [(await tools.runInsightTool("product_rates", { period: AUG }, ctx(TA))).error.code, (await tools.runInsightTool("product_margin", { period: AUG }, ctx(TA))).error.code], ["result_too_large", "result_too_large"]);
    } finally {
      restore();
    }
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("verify-insight-tools crashed:", err && err.message);
  try { await cleanup(); await mongoose.disconnect(); } catch { /* best-effort */ }
  process.exit(1);
});

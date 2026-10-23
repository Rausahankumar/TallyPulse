"use strict";

/**
 * customerCount (Slice 3): distinct sales customers, counted only when the party name matches EXACTLY ONE live ledger of the tenant's
 * own Ledger master and that ledger is a debtor (Sundry Debtors). NO Claude / Anthropic, no Tally, no network: synthetic tenants on
 * the loopback test database only (the test-mode guard in connectDB refuses anything else). All synthetic data is removed at the end.
 *
 * The fixtures are built so that the RAW distinct-name count (before Ledger-master resolution) differs from the resolved count, and
 * the sum of per-group counts differs from the distinct total - so a result that skipped resolution, sorted/filtered on raw sizes or
 * summed groups into a total fails here.
 *
 * Run: node verify-customer-count.js
 */

require("dotenv").config();
process.env.AI_USAGE_PERSIST = "off";
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const LedgerMaster = require("./src/models/ledgerMaster.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");

const catalog = require("./src/services/query/semanticCatalog");
const { validateQueryPlan } = require("./src/services/query/validator");
const { compileQuery, assertPipelineSafe } = require("./src/services/query/compile");
const { executeQuery } = require("./src/services/query/execute");
const { formatQueryAnswer } = require("./src/services/query/answerFormatter");
const { planQuestion, buildCatalogDigest } = require("./src/services/query/planner");
const scoring = require("./eval/nluScoring");

const { CATALOG } = catalog;

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS - ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 400)})` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- fixtures (synthetic names and GUIDs only)
const T_A = "TEST-TENANT-A-customer-count";
const T_B = "TEST-TENANT-B-customer-count"; // shares party names with A; its ledgers must never leak into A
const T_E = "TEST-TENANT-E-customer-count"; // sales but no Ledger master at all
const T_S = "TEST-TENANT-S-customer-count"; // Ledger master refreshed BEFORE the period ends
const TENANTS = [T_A, T_B, T_E, T_S];
const REF = new Date(2025, 11, 15, 12, 0, 0);
const utc = (s) => new Date(`${s}T00:00:00.000Z`);
let seq = 0;
function sale(tenantId, date, party, type = "Invoice", items = [["ItemZ", 1, 100]], status = "active") {
  seq += 1;
  return {
    tenantId,
    tallyGuid: `cc-${tenantId}-${seq}`,
    tallyAlterId: seq,
    voucherStatus: status,
    header: { voucherNo: `CC-${seq}`, voucherDate: utc(date), voucherType: type, voucherTotalAmount: 118, narration: "", partyName: party },
    inventory: items.map(([itemName, quantity, amount]) => ({ itemName, quantity, rate: amount / quantity, amount })),
    ledgers: [],
  };
}
function ledger(tenantId, name, partyRole, { syncedAt = utc("2025-12-01"), removedAt = null } = {}) {
  seq += 1;
  return { tenantId, companyGuid: `cg-${tenantId}`, ledgerGuid: `cg-${tenantId}-${seq}`, name, parentGroup: partyRole === "debtor" ? "Sundry Debtors" : "Other", partyRole, syncedAt, removedAt };
}

async function cleanup() {
  const ids = { $in: TENANTS };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), LedgerMaster.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
}

async function seed() {
  await cleanup();
  await Sale.insertMany([
    // ---- tenant A, October 2025: debtors Alpha (2 invoices) and Beta (1) = TWO customers across THREE invoices
    sale(T_A, "2025-10-03", "Alpha Traders", "Invoice", [["ItemX", 1, 100]]),
    sale(T_A, "2025-10-20", "Alpha Traders", "POS", [["ItemY", 1, 100]]),
    sale(T_A, "2025-10-10", "Beta Stores", "POS", [["ItemY", 2, 200]]),
    // excluded parties (all on "Invoice", so the raw Invoice set is the LARGEST and the resolved one the smallest)
    sale(T_A, "2025-10-12", "Cash"), // single ledger, partyRole other (Cash-in-Hand)
    sale(T_A, "2025-10-18", "Creditor Co"), // single ledger, partyRole creditor
    sale(T_A, "2025-10-14", "Walk-in Buyer"), // no live ledger (its only ledger was removed)
    sale(T_A, "2025-10-15", "Twin Name"), // two debtor ledgers -> ambiguous
    sale(T_A, "2025-10-16", "Mixed Name"), // one debtor + one non-debtor ledger -> ambiguous
    sale(T_A, "2025-10-17", "alpha traders"), // differs only in case: exact matching only, so unmatched
    sale(T_A, "2025-10-19", "Delta Corp", "Invoice", [["ItemZ", 1, 100]], "cancelled"), // a debtor, but a cancelled voucher
    // ---- tenant A, September 2025: debtors Alpha and Gamma; Cash excluded
    sale(T_A, "2025-09-05", "Alpha Traders", "Invoice"),
    sale(T_A, "2025-09-20", "Gamma Mart", "POS"),
    sale(T_A, "2025-09-22", "Cash"),
    // ---- tenant B (same names as A, plus its own): Alpha, Beta, Zeta are debtors HERE; Cash and Walk-in Buyer are debtors HERE too
    sale(T_B, "2025-10-05", "Alpha Traders"),
    sale(T_B, "2025-10-06", "Beta Stores"),
    sale(T_B, "2025-10-07", "Zeta Only"),
    sale(T_B, "2025-10-08", "Cash"),
    sale(T_B, "2025-10-09", "Walk-in Buyer"),
    // ---- tenant E: sales, no Ledger master
    sale(T_E, "2025-10-05", "Alpha Traders"),
    // ---- tenant S: one debtor, master refreshed on 10 Oct
    sale(T_S, "2025-10-05", "Sigma Ltd"),
  ]);
  await LedgerMaster.insertMany([
    ledger(T_A, "Alpha Traders", "debtor"),
    ledger(T_A, "Beta Stores", "debtor"),
    ledger(T_A, "Gamma Mart", "debtor"),
    ledger(T_A, "Delta Corp", "debtor"),
    ledger(T_A, "Cash", "other"),
    ledger(T_A, "Creditor Co", "creditor"),
    ledger(T_A, "Walk-in Buyer", "debtor", { removedAt: utc("2025-11-01") }),
    ledger(T_A, "Twin Name", "debtor"),
    ledger(T_A, "Twin Name", "debtor"),
    ledger(T_A, "Mixed Name", "debtor"),
    ledger(T_A, "Mixed Name", "other"),
    ledger(T_B, "Alpha Traders", "debtor"),
    ledger(T_B, "Beta Stores", "debtor"),
    ledger(T_B, "Zeta Only", "debtor"),
    ledger(T_B, "Cash", "debtor"),
    ledger(T_B, "Walk-in Buyer", "debtor"),
    ledger(T_B, "Twin Name", "debtor"),
    ledger(T_S, "Sigma Ltd", "debtor", { syncedAt: utc("2025-10-10") }),
  ]);
}

const OCT = { kind: "custom", from: "2025-10-01", to: "2025-10-31" };
const SEP = { kind: "custom", from: "2025-09-01", to: "2025-09-30" };
const SEP_OCT = { kind: "custom", from: "2025-09-01", to: "2025-10-31" };
const plan = (over = {}) => ({ v: 1, entity: "sales", mode: "aggregate", period: OCT, metrics: ["customerCount"], groupBy: [], filters: [], ...over });
const run = (p, tenantId = T_A, extra = {}) => executeQuery(p, { tenantId, referenceDate: REF, ...extra });
const total = (r, id = "customerCount") => r.totals && r.totals.values ? r.totals.values[id] : undefined;
const rowsBy = (r, dim) => Object.fromEntries((r.rows || []).map((x) => [dim === "date" ? x.key.date.label : x.key[dim], x]));
const warn = (r, code) => (r.warnings || []).find((w) => w.code === code);

(async () => {
  await connectDB();
  try {
    await seed();

    // ------------------------------------------------------------------ 1. validator
    section("1. Validator: supported shapes and rejected combinations");
    const ok = (p) => validateQueryPlan(p, { referenceDate: REF });
    const codes = (p) => (ok(p).errors || []).map((e) => e.code);
    check("scalar customerCount on sales validates", ok(plan()).ok);
    check("by month, by voucherType, with a product or customer filter, with a comparison: all validate", [
      plan({ period: SEP_OCT, groupBy: [{ dim: "date", bucket: "month" }] }),
      plan({ groupBy: [{ dim: "voucherType" }] }),
      plan({ filters: [{ dim: "product", op: "eq_ci", value: "ItemY" }] }),
      plan({ filters: [{ dim: "customer", op: "eq_ci", value: "Alpha Traders" }] }),
      plan({ compare: { mode: "custom", period: SEP } }),
    ].every((p) => ok(p).ok));
    for (const dim of ["customer", "product", "productGroup"]) {
      const c = codes(plan({ groupBy: [{ dim }], sort: [{ by: "customerCount", dir: "desc" }] }));
      check(`grouping by ${dim} is rejected (distinct_count_not_groupable)`, c.includes("distinct_count_not_groupable"), c.join(","));
    }
    let c = codes(plan({ entity: "purchase" }));
    check("a purchase plan with customerCount is rejected (metric_not_applicable_to_entity)", c.includes("metric_not_applicable_to_entity"), c.join(","));
    const list = ok({ v: 1, entity: "sales", mode: "list", period: OCT, metrics: ["customerCount"] });
    check("list mode with customerCount is rejected by the schema (list takes no metrics)", !list.ok && list.stage === "schema", JSON.stringify(list.errors));
    c = codes(plan({ metrics: ["customerCount", "lineAmount"] }));
    check("mixing with a line-grain metric is rejected (mixed_metric_grains)", c.includes("mixed_metric_grains"), c.join(","));
    const productWarn = (p) => (ok(p).warnings || []).some((w) => w.code === "warn_invoice_total_not_product_share");
    const ledBulb = [{ dim: "product", op: "eq_ci", value: "LED Bulb 9W" }];
    check("customerCount filtered by a product gets NO invoice-amount warning (there is no amount to misread)", ok(plan({ filters: ledBulb })).ok && !productWarn(plan({ filters: ledBulb })), JSON.stringify(ok(plan({ filters: ledBulb })).warnings));
    check("control: invoiceAmount filtered by a product still gets warn_invoice_total_not_product_share", productWarn(plan({ metrics: ["invoiceAmount"], filters: ledBulb })));
    check("control: customerCount next to invoiceAmount, filtered by a product, still gets the warning (an amount is shown)", productWarn(plan({ metrics: ["customerCount", "invoiceAmount"], filters: ledBulb })));
    check("control: a productGroup filter on invoiceAmount still gets it too", productWarn(plan({ metrics: ["invoiceAmount"], filters: [{ dim: "productGroup", op: "eq_ci", value: "Lighting" }] })));
    check("the rule is declared in the catalog's query rules", CATALOG.queryRules.some((r) => r.code === "distinct_count_not_groupable"));
    check("compatibility matrix: customerCount x customer/product/productGroup invalid, x date/voucherType ok", (() => {
      const m = catalog.buildCompatibilityMatrix("sales").customerCount;
      return ["customer", "product", "productGroup"].every((d) => m[d].status === "invalid" && m[d].code === "distinct_count_not_groupable") && m.date.status === "ok" && m.voucherType.status === "ok";
    })());

    // ------------------------------------------------------------------ 2. compiler
    section("2. Compiler: tenant scope first, distinct sets, nothing sorted/filtered/limited on raw sets in MongoDB");
    const compiled = (p) => compileQuery(ok(p).normalized, { tenantId: T_A });
    const grouped = compiled(plan({ groupBy: [{ dim: "voucherType" }], sort: [{ by: "customerCount", dir: "desc" }], having: [{ metric: "customerCount", op: "gt", value: 1 }], limit: 1 }));
    const rowsQ = grouped.queries.find((q) => q.key === "rows");
    const first = rowsQ.pipeline[0].$match;
    check("first stage is the tenant + active-status $match", first.tenantId === T_A && same(first.voucherStatus, { $in: ["active"] }));
    check("assertPipelineSafe accepts every compiled pipeline (no safety rule relaxed)", grouped.queries.every((q) => { try { assertPipelineSafe(q.pipeline, T_A); return true; } catch (e) { return false; } }));
    const groupStage = rowsQ.pipeline.find((s) => s.$group).$group;
    check("the metric is a $addToSet of header.partyName", same(groupStage.m_customerCount, { $addToSet: "$header.partyName" }));
    check("grouped: the plan is finalized in memory (no having $match, no sort on the raw set, only the group-count cap)", grouped.inMemory === true && !rowsQ.pipeline.some((s) => s.$sort) && rowsQ.pipeline.filter((s) => s.$match).length === 1 && rowsQ.pipeline.find((s) => s.$limit).$limit === catalog.LIMITS.maxCompareGroups + 1);
    const withTotals = compiled(plan({ groupBy: [{ dim: "voucherType" }], totals: true }));
    check("grouped totals come from their OWN totals query (never a sum of rows)", withTotals.queries.some((q) => q.key === "totals"));
    check("a non-distinct plan is unchanged (finalized in MongoDB)", compiled({ ...plan({ metrics: ["invoiceCount"], groupBy: [{ dim: "voucherType" }] }) }).inMemory === false);
    let threw = false;
    try { assertPipelineSafe([{ $match: { tenantId: T_A, voucherStatus: { $in: ["active"] } } }, { $group: { _id: null, s: { $addToSet: "$header.partyName" } } }], T_B); } catch (e) { threw = /authorized tenantId/.test(e.message); }
    check("tenant guard still refuses a pipeline scoped to another tenant", threw);

    // ------------------------------------------------------------------ 3. executor correctness
    section("3. Executor: debtor-ledger resolution and exclusions (tenant A, October 2025)");
    let r = await run(plan());
    check("two debtor customers across three invoices count as TWO", r.ok && total(r) === 2, JSON.stringify(r.errors || r.totals));
    const ex = warn(r, "customer_count_excluded_parties");
    check("excluded parties are disclosed WITH counts: 6 names (2 non-debtor, 2 no ledger, 2 ambiguous)", !!ex && /^6 party names/.test(ex.message) && /2 on a cash, bank or other non-debtor ledger \(Cash, Creditor Co\)/.test(ex.message) && /2 with no matching ledger in the synced Ledger master \(Walk-in Buyer, alpha traders\)/.test(ex.message) && /2 shared by more than one ledger \(ambiguous\) \(Mixed Name, Twin Name\)/.test(ex.message), ex && ex.message);
    check("a cancelled voucher's debtor (Delta Corp) is neither counted nor reported", !/Delta Corp/.test(JSON.stringify(r)));
    check("the basis is always stated (debtor ledgers only, depends on the Ledger master)", (r.assumptions || []).some((a) => a.code === "customer_count_basis" && /exactly one debtor ledger/.test(a.message) && /synced Tally Ledger master/.test(a.message)));
    check("no ledger_master_as_of warning when the master was refreshed after the period", !warn(r, "ledger_master_as_of"));
    check("no party names or name sets leak into the result rows/totals (counts only)", !JSON.stringify({ rows: r.rows, totals: r.totals }).includes("Traders"));

    section("4. Totals, date grouping, comparisons, filters, sorting");
    r = await run(plan({ period: SEP_OCT }));
    check("Sep+Oct as one period: 3 distinct customers (Alpha, Beta, Gamma) - not 2 + 2", r.ok && total(r) === 3, JSON.stringify(r.totals));
    r = await run(plan({ period: SEP_OCT, groupBy: [{ dim: "date", bucket: "month" }], totals: true }));
    let by = rowsBy(r, "date");
    check("by month: September 2, October 2", r.ok && by["2025-09"].values.customerCount === 2 && by["2025-10"].values.customerCount === 2, JSON.stringify(r.rows));
    check("by month: the TOTAL is 3 distinct customers, never the 4 a sum of months would give", total(r) === 3, JSON.stringify(r.totals));
    check("by month: rows in date order (the default series sort)", same(r.rows.map((x) => x.key.date.label), ["2025-09", "2025-10"]));
    r = await run(plan({ compare: { mode: "custom", period: SEP } }));
    check("scalar comparison Oct vs Sep: 2 vs 2, delta 0", r.ok && total(r) === 2 && r.totals.comparison.customerCount.previous === 2 && r.totals.comparison.customerCount.delta === 0, JSON.stringify(r.totals));
    r = await run(plan({ groupBy: [{ dim: "voucherType" }], sort: [{ by: "customerCount", dir: "desc" }], compare: { mode: "custom", period: SEP }, totals: true }));
    by = rowsBy(r, "voucherType");
    check("grouped comparison by voucherType: POS 2 vs 1 (+1), Invoice 1 vs 1", r.ok && by.POS.values.customerCount === 2 && by.POS.comparison.customerCount.previous === 1 && by.POS.comparison.customerCount.delta === 1 && by.Invoice.values.customerCount === 1 && by.Invoice.comparison.customerCount.previous === 1, JSON.stringify(r.rows));
    check("grouped comparison totals: 2 vs 2 distinct (rows sum to 3 vs 2 - totals are NOT sums)", total(r) === 2 && r.totals.comparison.customerCount.previous === 2, JSON.stringify(r.totals));
    r = await run(plan({ groupBy: [{ dim: "voucherType" }], sort: [{ by: "customerCount", dir: "desc" }] }));
    check("sorted on RESOLVED counts: POS (2) before Invoice (1), although Invoice holds the larger raw name set (7)", r.ok && same(r.rows.map((x) => x.key.voucherType), ["POS", "Invoice"]), JSON.stringify(r.rows));
    r = await run(plan({ groupBy: [{ dim: "voucherType" }], sort: [{ by: "customerCount", dir: "desc" }], having: [{ metric: "customerCount", op: "gt", value: 1 }] }));
    check("having on RESOLVED counts: only POS has more than 1 customer (raw sets would keep both)", r.ok && same(r.rows.map((x) => x.key.voucherType), ["POS"]), JSON.stringify(r.rows));
    r = await run(plan({ groupBy: [{ dim: "voucherType" }], sort: [{ by: "customerCount", dir: "asc" }], limit: 1 }));
    check("limit after resolution: the 1 lowest is Invoice, and the result is marked truncated", r.ok && same(r.rows.map((x) => x.key.voucherType), ["Invoice"]) && r.truncated === true, JSON.stringify(r.rows));
    r = await run(plan({ filters: [{ dim: "product", op: "eq_ci", value: "ItemY" }] }));
    check("product filter (invoices containing ItemY): Alpha and Beta = 2", r.ok && total(r) === 2, JSON.stringify(r.totals));
    r = await run(plan({ filters: [{ dim: "product", op: "eq_ci", value: "ItemX" }] }));
    check("product filter (invoices containing ItemX): Alpha only = 1", r.ok && total(r) === 1, JSON.stringify(r.totals));
    r = await run(plan({ filters: [{ dim: "customer", op: "eq_ci", value: "Cash" }] }));
    check("customer filter on a non-debtor (Cash): 0 customers, and the exclusion is disclosed", r.ok && total(r) === 0 && /1 party name in these sales is not counted/.test((warn(r, "customer_count_excluded_parties") || {}).message || ""), JSON.stringify(r.warnings));
    r = await run(plan({ period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" } }));
    check("a period with no sales: 0, no exclusion warning", r.ok && total(r) === 0 && !warn(r, "customer_count_excluded_parties"), JSON.stringify(r.totals));

    section("5. Tenant isolation, missing and stale Ledger master");
    r = await run(plan(), T_B);
    check("tenant B: Alpha, Beta, Zeta, Cash, Walk-in Buyer are debtors in B's OWN master = 5", r.ok && total(r) === 5, JSON.stringify(r.totals));
    r = await run(plan(), T_A);
    check("tenant A is unchanged by B's ledgers (B's debtor 'Cash'/'Walk-in Buyer'/'Twin Name' never leak): still 2", r.ok && total(r) === 2);
    let seenTenant = null;
    r = await run(plan(), T_A, { findPartyLedgers: async (tid, names) => { seenTenant = tid; return { masterMissing: false, ledgers: [], syncedAt: utc("2025-12-01"), names }; } });
    check("the Ledger-master read is called with the authorized tenant only", seenTenant === T_A);
    r = await run(plan(), T_E);
    check("no Ledger master: refused with ledger_master_missing (never a guess from names)", !r.ok && r.errors[0].code === "ledger_master_missing" && /customers cannot be counted/.test(r.errors[0].message), JSON.stringify(r.errors));
    r = await run(plan(), T_S);
    const asOf = warn(r, "ledger_master_as_of");
    check("master refreshed before the period end: counted (1) with the existing ledger_master_as_of warning", r.ok && total(r) === 1 && !!asOf && /2025-10-10/.test(asOf.message), JSON.stringify(r.warnings));
    r = await run(plan(), T_A, { findPartyLedgers: async () => ({ masterMissing: false, ledgers: Array.from({ length: 2 * catalog.LIMITS.maxPartyNames + 1 }, () => ({ name: "x", partyRole: "debtor" })), syncedAt: utc("2025-12-01") }) });
    check("an over-large ledger match is refused (result_too_large), never silently cut", !r.ok && r.errors[0].code === "result_too_large");

    section("6. User-facing label and disclosure");
    r = await run(plan());
    const f = formatQueryAnswer({ plan: plan(), result: r, definitionNotes: [], plannerAssumptions: [], contextNotes: [] });
    check('the answer labels the figure "Customers" and shows a plain count (no rupee sign)', /Customers/.test(f.text) && /\b2\b/.test(f.text) && !/₹\s*2\b/.test(f.text), f.text);
    check("the answer states the debtor-ledger basis", f.notes.some((n) => /exactly one debtor ledger/.test(n)), JSON.stringify(f.notes));
    check("the exclusions reach the user as a warning", f.warnings.some((w) => /not counted as customers/.test(w)), JSON.stringify(f.warnings));

    section("7. Planner: the metric reaches the prompt within budget, and nl_0343 plans to it");
    const digest = buildCatalogDigest();
    check("the digest lists customerCount with its meaning and stays under 5,000 chars", /\ncustomerCount \[sales; voucher\]: Distinct customers \(debtor ledgers\)/.test(digest) && digest.length < 5000, digest.length);
    const row = scoring.corpus.rows.find((x) => x.id === "nl_0343");
    const fake = async () => ({ content: [{ type: "tool_use", id: "t1", name: "submit_query_plan", input: { plan: row.expected.plan } }], usage: {} });
    const planned = await planQuestion(row.question, { claudeClient: fake, referenceDate: REF });
    check("nl_0343's corpus plan is accepted by the planner unchanged (supported, customerCount)", row.expected.status === "supported" && planned.status === "supported" && same(planned.plan.metrics, ["customerCount"]), `${planned.status}/${planned.code}`);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("verify-customer-count crashed:", e && e.message);
  try {
    await cleanup();
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

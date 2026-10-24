/**
 * The five basic business questions a reviewer asked Ask AI (2026-10-24), through the real chat turn
 * (queryChat.tryAnswerWithQueryEngine): the query planner, ASK_AI_ANALYSIS modes, the analysis planner, the executor, the
 * insight tools, freshness and the answer text. Questions 1, 2, 3 and 5 were refused ("needs several separate analyses")
 * because ASK_AI_ANALYSIS was off; question 4 answered with a failed-Purchase-sync warning. ASK_AI_ANALYSIS unset now
 * means on; basic and off are still checked.
 *
 *   1. "discount percentage of aug 2025"                     -> one discount_summary step
 *   2. "jo hamari sale hui hai wo purchase se compare karo and profit batao of aug 2025"
 *                                                            -> sales total next to purchase total + "not profit";
 *                                                               a product_margin step for it stays the profit refusal
 *   3. "total margin of aug 2025"                            -> one product_margin step: INDICATIVE margin, never profit
 *   4. "purchase value of aug 2025"                          -> single query; failed Purchase sync is warned
 *   5. "compare sale value and purchase value"               -> the same pair over all history (no period given), or the
 *                                                               analysis planner's clarification
 *
 * MOCKED model only (scripted tool replies: no network, no Anthropic call), real engine and insight tools, synthetic data
 * on a loopback MongoDB (refused otherwise), removed at the end. Every expected figure is derived by hand below.
 *
 * Run: node verify-ask-ai-basic-questions.js
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-ask-ai-basic-questions.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };
}
process.env.AI_USAGE_PERSIST = "off";
delete process.env.ASK_AI_ANALYSIS; // the default (unset = on) is part of what is tested

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const ap = require("./src/services/query/analysisPlanner");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");
const { CATALOG } = require("./src/services/query/semanticCatalog");
const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
const { analysisMode, analysisModeUnrecognised, basicShape, salesVsPurchaseMismatch } = require("./src/services/query/basicAnalysis");
const { deriveDiscountAmount } = require("./src/services/parser/tallyParser");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

const T1 = "TEST-TENANT-1-basic-questions";
const T2 = "TEST-TENANT-2-basic-questions";
const GUID1 = "basic-questions-company-1";
const GUID2 = "basic-questions-company-2";
const AUG = { kind: "custom", from: "2025-08-01", to: "2025-08-31" };
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", period: AUG, metrics: ["invoiceAmount"], groupBy: [], filters: [], ...o });
const salesTotal = (period = AUG) => ({ id: "sales", kind: "query", plan: q({ period }) });
const purchaseTotal = (period = AUG, metric = "purchaseAmount") => ({ id: "purchases", kind: "query", plan: q({ entity: "purchase", period, metrics: [metric] }) });
const DECLINE = { decline: { code: "needs_analysis", message: "This needs several analyses." } };

// ---- the mocked model: answers by the tool it is forced to call, in order, and records every request
const toolReply = (name, input) => ({ content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
function fakeModel(script) {
  const queue = { [PLANNER_TOOL_NAME]: [...(script.query || [])], [ap.ANALYSIS_TOOL_NAME]: [...(script.analysis || [])] };
  const fn = async (req) => {
    fn.requests.push(req);
    const name = req.tool_choice.name;
    const next = queue[name].shift();
    if (next === undefined) throw new Error(`no scripted reply for ${name}`);
    return toolReply(name, next);
  };
  fn.requests = [];
  return fn;
}

// ---- synthetic vouchers: [model, tenant, date, party, total, [[item, qty, rate, amount, discount % Tally states]]]
// Tenant 1, August 2025 (plus one voucher on each side of the month edges):
//   sales     Aug 5  1,180 (Item X: 10 x 100 billed 900, Tally states 10% -> verified discount 100)
//             Aug 20   590 (Item Y: 5 x 100 billed 500, no discount)
//             Jul 31 1,000 and Sep 1 2,000 (outside August)
//   purchases Aug 2  1,062 (Item X: 20 bought for 1,000 -> cost 50)
//             Aug 31   472 (Item Y: 10 bought for 400 -> cost 40)
//             Sep 1  9,999 (outside August)
// August: sales 1,180 + 590 = 1,770; purchases 1,062 + 472 = 1,534; difference 236 (sales higher).
// All history: sales 1,770 + 1,000 + 2,000 = 4,770; purchases 1,534 + 9,999 = 11,533; difference -6,763 (purchases higher).
// Discount, August: list value 1,000 + 500 = 1,500; discount 100; billed 1,400; 100 / 1,500 = 6.67%.
// Indicative margin, August: X sells at (900 + 100) / 100 = 10 billed units -> 90 a unit, cost 50 -> 40 x 10 = 400;
//   Y sells at 100, cost 40 -> 60 x 5 = 300; indicative profit 700 on 1,400 of sales = 50%.
// Tenant 2: the same names with much larger amounts, which must never appear in tenant 1's answers.
const VOUCHERS = [
  ["sale", T1, "2025-08-05", "Cust A", 1180, [["Item X", 10, 100, 900, 10]]],
  ["sale", T1, "2025-08-20", "Cust B", 590, [["Item Y", 5, 100, 500]]],
  ["sale", T1, "2025-07-31", "Cust A", 1000, [["Item X", 10, 100, 1000]]],
  ["sale", T1, "2025-09-01", "Cust B", 2000, [["Item Y", 20, 100, 2000]]],
  ["purchase", T1, "2025-08-02", "Sup S", 1062, [["Item X", 20, 50, -1000]]],
  ["purchase", T1, "2025-08-31", "Sup S", 472, [["Item Y", 10, 40, -400]]],
  ["purchase", T1, "2025-09-01", "Sup S", 9999, [["Item X", 100, 99.99, -9999]]],
  ["sale", T2, "2025-08-10", "Cust A", 50000, [["Item X", 500, 100, 50000]]],
  ["purchase", T2, "2025-08-10", "Sup S", 70000, [["Item X", 700, 100, -70000]]],
];
const storedLine = ([itemName, quantity, rate, amount, pct = 0]) => ({ itemName, quantity, rate, amount, discountPercentage: pct, discountAmount: deriveDiscountAmount(pct, { quantity, rate, amount }) });
const cleanup = async () => {
  const ids = { $in: [T1, T2] };
  await Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), SyncCheckpoint.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
};

const ask = (question, model, extraDeps = {}, tenantId = T1) =>
  tryAnswerWithQueryEngine({ context: { tenantId, userId: "u-basic" }, userMessage: question, conversationHistory: [], deps: { plannerClient: model, ...extraDeps } });
const metaOf = (out) => out.structured.details.queryEngine;
// SHOW_ANSWERS=1 prints each reported question's answer text for review (off by default)
const show = (label, out) => { if (process.env.SHOW_ANSWERS) console.log(`----- ${label}\n${out.structured.answer}\n[warnings] ${out.structured.warnings.join(" | ")}\n-----`); };
// a warning is shown either under the answer or, when the answer text already states it, only in the text
const warned = (out, re) => out.structured.warnings.some((w) => re.test(w)) || re.test(out.structured.answer);
const PURCHASE_SYNC_FAILED = /The last Purchase sync attempt failed. Any data shown reflects the last successful sync (2025-09-02T10:00:00.000Z), which may now be outdated./;

async function main() {
  console.log("=== 0. Mode (ASK_AI_ANALYSIS) and the basic shapes ===");
  check("mode-default", "unset or blank -> on; on/basic/off as written (any case); an unrecognised value fails closed to off; deps override the environment", [analysisMode(null, {}), analysisMode(null, { ASK_AI_ANALYSIS: "  " }), analysisMode(null, { ASK_AI_ANALYSIS: "on" }), analysisMode(null, { ASK_AI_ANALYSIS: "Basic" }), analysisMode(null, { ASK_AI_ANALYSIS: "OFF" }), analysisMode(null, { ASK_AI_ANALYSIS: "of" }), analysisMode({ analysisEnabled: true }, { ASK_AI_ANALYSIS: "off" }), analysisMode({ analysisMode: "off" }, {})], ["on", "on", "on", "basic", "off", "off", "on", "off"]);
  check("mode-unrecognised", "the server's start-up warning fires only for a value that is not on/basic/off", [analysisModeUnrecognised({}), analysisModeUnrecognised({ ASK_AI_ANALYSIS: "off" }), analysisModeUnrecognised({ ASK_AI_ANALYSIS: "of" })], [false, false, true]);
  check("mode-process-env", "with ASK_AI_ANALYSIS removed from this process, the chat turn's mode is on", analysisMode(null), "on");
  const shape = (steps) => { const s = basicShape({ v: 1, steps }); return s && s.kind; };
  const SEP = { kind: "custom", from: "2025-09-01", to: "2025-09-30" };
  check("shape-basic", "basic: one discount step, one margin step, one sales total next to one purchase total (same period, same basis)", [
    shape([{ id: "d", kind: "insight", tool: "discount_summary", args: {} }]),
    shape([{ id: "m", kind: "insight", tool: "product_margin", args: {} }]),
    shape([salesTotal(), purchaseTotal()]),
    shape([{ id: "sales", kind: "query", plan: q({ metrics: ["lineAmount"] }) }, purchaseTotal(AUG, "lineAmount")]),
  ], ["insight", "insight", "sales_vs_purchase", "sales_vs_purchase"]);
  check("shape-outside", "not basic: other tools, two insights, different periods or bases, grouping, filters, comparison, bindings, two sales", [
    shape([{ id: "r", kind: "insight", tool: "product_rates", args: {} }]),
    shape([{ id: "d", kind: "insight", tool: "discount_summary", args: {} }, { id: "m", kind: "insight", tool: "product_margin", args: {} }]),
    shape([salesTotal(), purchaseTotal(SEP)]),
    shape([salesTotal(), purchaseTotal(AUG, "lineAmount")]),
    shape([{ id: "sales", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }) }, purchaseTotal()]),
    shape([{ id: "sales", kind: "query", plan: q({ filters: [{ dim: "customer", op: "eq_ci", value: "Cust A" }] }) }, purchaseTotal()]),
    shape([{ id: "sales", kind: "query", plan: q({ compare: { mode: "custom", period: SEP } }) }, purchaseTotal()]),
    shape([{ id: "sales", kind: "query", plan: q({ groupBy: [{ dim: "product" }], metrics: ["lineAmount"], sort: [{ by: "lineAmount", dir: "desc" }] }) }, { ...purchaseTotal(), inputs: [{ fromStep: "sales", dim: "product", take: 2 }] }]),
    shape([salesTotal(), { ...salesTotal(), id: "sales2" }]),
  ], [null, null, null, null, null, null, null, null, null]);

  await connectDB();
  await cleanup();
  try {
    let n = 0;
    for (const [kind, tenantId, date, party, total, lines] of VOUCHERS) {
      n += 1;
      await (kind === "sale" ? Sale : Purchase).create({
        tenantId,
        header: { voucherNo: `BQ-${n}`, voucherDate: new Date(`${date}T00:00:00.000Z`), voucherType: kind === "sale" ? "Sales" : "Purchase", voucherTotalAmount: total, partyName: party },
        inventory: lines.map(storedLine),
        ledgers: [],
        tallyGuid: `bq-${tenantId}-${n}`,
        tallyAlterId: n,
        voucherStatus: "active",
      });
    }
    // Sales synced fine just now; the latest PURCHASE sync attempt failed (its last success was 2025-09-02).
    const now = new Date();
    for (const [tenantId, companyGuid] of [[T1, GUID1], [T2, GUID2]]) {
      await SyncCheckpoint.create({ tenantId, companyGuid, voucherType: "Sales", lastAlterId: 100, lastRunStatus: "success", lastSyncedAt: now, isRunning: false, lockedAt: null });
      await SyncCheckpoint.create({ tenantId, companyGuid, voucherType: "Purchase", lastAlterId: 100, lastRunStatus: "failed", lastSyncedAt: new Date("2025-09-02T10:00:00.000Z"), isRunning: false, lockedAt: null });
    }

    console.log("\n=== 1. \"discount percentage of aug 2025\" ===");
    const Q1 = "discount percentage of aug 2025";
    let model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: AUG } }] } }] });
    let out = await ask(Q1, model);
    let text = out.structured.answer;
    show("Q1", out);
    check("q1-answered", "default (ASK_AI_ANALYSIS unset = on): answered by the discount tool, two model calls", [metaOf(out).route, metaOf(out).status, metaOf(out).claudeCalls], ["analysis", "answered", 2]);
    check("q1-figures", "verified discount only: 100 on a list value of 1,500 = 6.67%, billed 1,400 (Jul 31 / Sep 1 lines outside August are not counted)", [/Total: discount 100 on a list value of 1,500 \(6\.67%\), billed 1,400/.test(text), /2025-08-01 to 2025-08-31/.test(text)], [true, true]);
    check("q1-basis", "the answer states the discount basis (Tally's verified line discount, before tax)", /Discount = list value − billed amount \(before tax\)/.test(text), true);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: { period: AUG } }] } }] });
    out = await ask(Q1, model, { analysisMode: "off" });
    check("q1-off", "ASK_AI_ANALYSIS=off: exactly the previous refusal, one model call", [metaOf(out).status, metaOf(out).claudeCalls, out.structured.answer.startsWith("This question needs several separate analyses")], ["unsupported", 1, true]);

    console.log("\n=== 2. \"... sale ... purchase se compare karo and profit batao of aug 2025\" ===");
    const Q2 = "jo hamari sale hui hai wo purchase se compare karo and profit batao of aug 2025";
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal()] } }] });
    out = await ask(Q2, model);
    text = out.structured.answer;
    show("Q2", out);
    check("q2-answered", "default (on): sales total next to purchase total, both measured", [metaOf(out).route, metaOf(out).status, metaOf(out).steps], ["analysis", "answered", ["ok", "ok"]]);
    check("q2-values", "August 2025 only: sales 1,770.00, purchases 1,534.00, difference 236.00 (sales higher)", [/- Sales: ₹1,770\.00/.test(text), /- Purchases: ₹1,534\.00/.test(text), /Difference \(sales − purchases\): ₹236\.00 \(sales higher\)/.test(text)], [true, true, true]);
    check("q2-not-profit", "the difference is never called profit, and profit is explicitly not calculated (catalog reason)", [/This difference is not profit/.test(text), text.includes(`Profit is not calculated. ${CATALOG.unsupported.find((u) => u.id === "profit_margin").reason}`), /\bprofit (is|of|was) ₹/i.test(text)], [true, true, false]);
    check("q2-tenant", "the other tenant's 50,000 / 70,000 never appear", /50,000|70,000/.test(text), false);
    check("q2-sync-warning", "the failed Purchase sync is warned (last success shown, may be outdated); the sales step is not warned", [out.structured.warnings.some((w) => /The last Purchase sync attempt failed\. Any data shown reflects the last successful sync \(2025-09-02T10:00:00\.000Z\), which may now be outdated\./.test(w)), warned(out, /Sales sync attempt failed/), out.structured.details.toolCalls[0].state], [true, false, "sync_failed"]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ id: "m", kind: "insight", tool: "product_margin", args: { period: AUG } }] } }] });
    out = await ask(Q2, model);
    check("q2-margin-refused", "a product_margin step for a PROFIT question stays the profit refusal (never an indicative margin presented as profit)", [metaOf(out).status, metaOf(out).code, out.structured.answer.startsWith(CATALOG.unsupported.find((u) => u.id === "profit_margin").reason)], ["unsupported", "profit_margin_unsupported", true]);

    console.log("\n=== 3. \"total margin of aug 2025\" ===");
    const Q3 = "total margin of aug 2025";
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ id: "m", kind: "insight", tool: "product_margin", args: { period: AUG } }] } }] });
    out = await ask(Q3, model);
    text = out.structured.answer;
    show("Q3", out);
    check("q3-answered", "default (on): answered by the indicative-margin tool", [metaOf(out).route, metaOf(out).status], ["analysis", "answered"]);
    check("q3-figures", "indicative profit 700 at 50% on the 2 products with a cost (hand-derived)", /All 2 products sold: indicative profit 700 at an indicative margin of 50% on the 2 products with a cost\./.test(text), true);
    check("q3-labelled", "headed as indicative, not accounting profit", /Indicative margin per product \(not accounting profit\)/.test(text), true);

    console.log("\n=== 3b. No year written: an insight period is never given a year ===");
    for (const [id, question, tool] of [["q1-no-year", "discount percentage of aug", "discount_summary"], ["q3-no-year", "total margin of aug", "product_margin"]]) {
      model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ id: "x", kind: "insight", tool, args: { period: AUG } }] } }] });
      out = await ask(question, model);
      check(id, `"${question}": an August 2025 ${tool} step is not run; the year guard asks which year`, [metaOf(out).status, metaOf(out).code, /2025-08-01 to 2025-08-31/.test(out.structured.answer)], ["needs_clarification", "year_missing", false]);
    }

    console.log("\n=== 4. \"purchase value of aug 2025\" ===");
    model = fakeModel({ query: [{ plan: q({ entity: "purchase", metrics: ["purchaseAmount"] }) }] });
    out = await ask("purchase value of aug 2025", model);
    text = out.structured.answer;
    show("Q4", out);
    check("q4-value", "single query (one model call): August purchases 1,534.00 (Aug 2 and Aug 31 included, Sep 1 not)", [metaOf(out).route, metaOf(out).claudeCalls, /₹1,534\.00/.test(text), /9,999/.test(text)], ["planner", 1, true, false]);
    check("q4-sync-warning", "the failed Purchase sync is warned with the last successful sync time, and the data state says sync_failed", [out.structured.warnings.some((w) => /The last Purchase sync attempt failed\. Any data shown reflects the last successful sync \(2025-09-02T10:00:00\.000Z\), which may now be outdated\./.test(w)), out.structured.details.toolCalls[0].state], [true, "sync_failed"]);

    console.log("\n=== 5. \"compare sale value and purchase value\" ===");
    const Q5 = "compare sale value and purchase value";
    const ALL = { kind: "all_time" };
    const Q5AUG = "compare sale value and purchase value of aug 2025";
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(ALL), purchaseTotal(ALL)] } }] });
    out = await ask(Q5, model);
    text = out.structured.answer;
    show("Q5", out);
    check("q5-all-time", "no period given, the model chose all history: sales 4,770.00, purchases 11,533.00, difference 6,763.00 (purchases higher)", [metaOf(out).status, /- Sales: ₹4,770\.00/.test(text), /- Purchases: ₹11,533\.00/.test(text), /Difference \(sales − purchases\): −₹6,763\.00 \(purchases higher\)/.test(text)], ["answered", true, true, true]);
    check("q5-no-profit-claim", "no profit question: the 'not profit' disclosure is still there, the profit refusal line is not added", [/This difference is not profit/.test(text), /Profit is not calculated/.test(text)], [true, false]);
    model = fakeModel({ query: [DECLINE], analysis: [{ decline: { code: "needs_clarification", message: "Which period should I compare: a month, a quarter or a financial year?" } }] });
    out = await ask(Q5, model);
    check("q5-clarify", "or the analysis planner asks for the period (a clarification, nothing computed)", [metaOf(out).status, /Which period/.test(out.structured.answer)], ["needs_clarification", true]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal()] } }] });
    out = await ask(Q5, model);
    check("q5-year-guard", "no year in the question: a plan dated 2025 is never run - the existing year guard asks instead (no invented year)", [metaOf(out).status, metaOf(out).code, /- Sales:/.test(out.structured.answer)], ["needs_clarification", "year_missing", false]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal({ kind: "custom", from: "2025-09-01", to: "2025-09-30" })] } }] });
    out = await ask(Q5AUG, model, { analysisMode: "basic" });
    check("q5-mismatched-periods-basic", "ASK_AI_ANALYSIS=basic: a pair with DIFFERENT periods is outside basic analysis: the fixed refusal, nothing run", [metaOf(out).status, metaOf(out).code, out.structured.answer.startsWith("This question needs several separate analyses")], ["unsupported", "planner_needs_analysis", true]);

    console.log("\n=== 5b. Comparability (default on): a pair is compared only on the same period and the same basis ===");
    const SEP = { kind: "custom", from: "2025-09-01", to: "2025-09-30" };
    check("pair-mismatch-detect", "detected: different periods; different bases (incl. tax vs before tax); both; a comparable pair and other plans are not mismatches", [
      JSON.stringify(salesVsPurchaseMismatch({ v: 1, steps: [salesTotal(), purchaseTotal(SEP)] })),
      JSON.stringify(salesVsPurchaseMismatch({ v: 1, steps: [salesTotal(), purchaseTotal(AUG, "lineAmount")] })),
      (salesVsPurchaseMismatch({ v: 1, steps: [salesTotal(), purchaseTotal(SEP, "lineAmount")] }) || { reasons: [] }).reasons.length,
      salesVsPurchaseMismatch({ v: 1, steps: [salesTotal(), purchaseTotal()] }),
      salesVsPurchaseMismatch({ v: 1, steps: [{ id: "d", kind: "insight", tool: "discount_summary", args: {} }] }),
    ], [
      JSON.stringify({ reasons: ["the two totals cover different periods"] }),
      JSON.stringify({ reasons: ["they use different amount bases (sales: invoice totals including tax; purchases: item values before tax)"] }),
      2, null, null,
    ]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal(SEP)] } }] });
    out = await ask(Q5AUG, model);
    text = out.structured.answer;
    show("Q5 mismatched periods (default on)", out);
    check("pair-periods-on", "default (on): Aug sales next to Sep purchases are both shown, but NOT compared: the reason is stated, no difference, never profit", [metaOf(out).status, /Sales vs purchases: not compared\*\* - the two totals cover different periods, so no difference is shown/.test(text), /Difference \(sales − purchases\)/.test(text), /Neither total, nor any difference between them, is profit\./.test(text), /\bprofit (is|of|was) ₹/i.test(text)], ["answered", true, false, true, false]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal(AUG, "lineAmount")] } }] });
    out = await ask(Q2, model);
    text = out.structured.answer;
    check("pair-basis-on", "default (on): tax-inclusive sales next to pre-tax purchases are NOT compared (different amount bases stated); profit asked -> profit is not calculated", [metaOf(out).status, /not compared\*\* - they use different amount bases \(sales: invoice totals including tax; purchases: item values before tax\)/.test(text), /Difference \(sales − purchases\)/.test(text), text.includes(`Profit is not calculated. ${CATALOG.unsupported.find((u) => u.id === "profit_margin").reason}`)], ["answered", true, false, true]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal()] } }] });
    out = await ask(Q5AUG, model, { analysisMode: "on" });
    check("q5-on", "ASK_AI_ANALYSIS=on runs the same pair with the same side-by-side block and 'not profit' disclosure (the mode never changes an answer)", [metaOf(out).status, /- Sales: ₹1,770\.00/.test(out.structured.answer), /This difference is not profit/.test(out.structured.answer)], ["answered", true, true]);

    console.log("\n=== 6. Tenant isolation and bounds ===");
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [salesTotal(), purchaseTotal()] } }] });
    out = await ask(Q5AUG, model, {}, T2);
    check("tenant-2", "the same plan for tenant 2 reads only tenant 2: sales 50,000, purchases 70,000", [/- Sales: ₹50,000\.00/.test(out.structured.answer), /- Purchases: ₹70,000\.00/.test(out.structured.answer), /1,770|1,534/.test(out.structured.answer)], [true, true, false]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ ...salesTotal(), plan: { ...q({}), tenantId: T2 } }, purchaseTotal()] } }, { analysis: { v: 1, steps: [{ ...salesTotal(), plan: { ...q({}), tenantId: T2 } }, purchaseTotal()] } }] });
    out = await ask(Q5, model);
    check("tenant-in-plan", "a plan that names a tenant is rejected by the plan schema (the tenant only ever comes from the login)", [metaOf(out).route, /50,000/.test(out.structured.answer)], ["analysis", false]);
    model = fakeModel({ query: [DECLINE], analysis: [{ analysis: { v: 1, steps: [{ id: "sales", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 1000 }) }, purchaseTotal()] } }, { analysis: { v: 1, steps: [{ id: "sales", kind: "query", plan: q({ groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 1000 }) }, purchaseTotal()] } }] });
    out = await ask(Q5, model);
    check("bounds", "a limit above the engine's maximum is never run", /- Sales:/.test(out.structured.answer), false);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(async (e) => {
  console.error("CRASH:", e);
  try { await cleanup(); await mongoose.disconnect(); } catch (_) {}
  process.exitCode = 1;
});

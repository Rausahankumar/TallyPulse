/**
 * Self-test of the planted-cause investigation evaluation (eval/investigation/, eval-investigations.js). It proves the
 * harness, not the product: the ground truth equals hand-derived figures; the grader reads numbers correctly (dates are not
 * figures), passes a handwritten ideal answer on EVERY criterion (no criterion is impossible) and fails wrong answers
 * (missed causes, a profit claim, another tenant's figures, an unhedged hypothesis, no context); and the offline ceiling run
 * through the real chat turn is deterministic and never shows another tenant's data. It does NOT assert the product's score.
 *
 * No model call (scripted planner), no network, synthetic data on a loopback MongoDB (refused otherwise), removed at the end.
 *
 * Run: node verify-investigation-eval.js
 */

require("dotenv").config();
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-investigation-eval.js only runs against a loopback MongoDB. Nothing was touched.");
    process.exit(2);
  }
  require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };
}
process.env.AI_USAGE_PERSIST = "off";

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const S = require("./eval/investigation/scenarios");
const { grade, numbersIn, hasNumber } = require("./eval/investigation/grader");
const { runScenario, summarise } = require("./eval-investigations");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

// a fixed run date, so the months and every figure below are stable
const NOW = new Date(2026, 9, 24, 12, 0, 0); // 24 Oct 2026 -> Jun, Jul, Aug, Sep 2026
const months = S.monthsBefore(NOW);
const truth = S.groundTruth(months);
const scenarios = S.scenarios(truth);
const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));

// Handwritten IDEAL answers (what a good investigation would say). Every criterion of its turn must pass on them.
const IDEAL = {
  "apple-why": [`Apple sales fell from ₹10,000 in August 2026 to ₹3,100 in September 2026 (-69%); the decline started in September 2026.
Two customers explain almost all of it: Sharma Fruits (down ₹4,000, bought nothing) and Gupta Mart (down ₹3,000).
Units sold fell from 100 to 31 while the rate stayed unchanged at ₹100, so this is a volume decline, not a price decline.
Possible cause (a hypothesis, not proven): purchases of apple from Himachal Orchards fell from 100 to 30 units in August 2026, the month before, which may have limited supply.`],
  "apple-delhi-store": [`TallyPulse has no store or location in its data: store-level sales are not recorded, so this covers the whole company.
For the company, apple sales started falling in September 2026, driven by Sharma Fruits and Gupta Mart.`],
  "apple-follow-up": [null, `Customers: Sharma Fruits and Gupta Mart stopped buying apple in September 2026.
Suppliers: Himachal Orchards supplied 30 units in August 2026, down from 100; this may have limited stock, but that is a hypothesis, not proven.`],
  "orange-where": [`Orange sales are not recorded by store or location, so this is company-wide: sales fell from ₹12,000 in August 2026 to ₹9,000 in September 2026.
The price was cut from ₹120 to ₹90 per unit while quantity stayed unchanged at 100 units, so the decline is price, not volume.`],
  "sales-vs-purchases-profit": [`Last month: sales ₹16,905, purchases ₹11,865, difference ₹5,040 (sales higher).
This difference is not profit: profit cannot be calculated because no cost of goods sold or stock valuation is available.`],
};
// Deliberately WRONG answers: each must fail the named criteria.
const WRONG = [
  ["apple-why", 0, "Apple sales fell because Rao Traders and Khan Stores reduced orders. Himachal Orchards cut supply, which caused the decline.", ["contributor-1", "contributor-2", "supply-hypothesis-labelled"]],
  ["apple-why", 0, "Apple sales of tenant B: 7,777 units at ₹7,77,700.", ["no-noise-tenant"]],
  ["apple-delhi-store", 0, "Delhi store apple sales were ₹3,100 in September 2026.", ["location-not-recorded", "no-invented-store-figures"]],
  ["sales-vs-purchases-profit", 0, "Sales ₹16,905, purchases ₹11,865, so the profit is ₹5,040.", ["profit-not-calculated", "difference-not-called-profit"]],
  ["orange-where", 0, "Orange sales dropped because fewer units were sold.", ["rate-before", "rate-after", "driver-price"]],
];

async function main() {
  console.log("=== 1. Ground truth equals the hand-derived figures ===");
  check("months", "the four complete months before 24 Oct 2026", months.map((m) => m.iso), ["2026-06", "2026-07", "2026-08", "2026-09"]);
  check("apple", "apple: 10,000 x3 then 3,100; units 100 -> 31; change -6,900 (-69%); Sharma -4,000, Gupta -3,000; Himachal 100,100,30,30", [truth.apple.valueByMonth, truth.apple.unitsByMonth, truth.apple.change, truth.apple.changePct, truth.apple.contributors.map((c) => c.change), truth.apple.supplier.unitsByMonth], [[10000, 10000, 10000, 3100], [100, 100, 100, 31], -6900, -69, [-4000, -3000], [100, 100, 30, 30]]);
  check("orange", "orange: 12,000 x3 then 9,000 with 100 units every month (price 120 -> 90)", [truth.orange.valueByMonth, truth.orange.unitsByMonth, truth.orange.change], [[12000, 12000, 12000, 9000], [100, 100, 100, 100], -3000]);
  check("last-month", "last month (invoice totals incl. 5% tax): sales (3,100 + 9,000 + 4,000) x 1.05 = 16,905; purchases (1,800 + 7,000 + 2,500) x 1.05 = 11,865; difference 5,040", [truth.lastMonth.salesInvoice, truth.lastMonth.purchaseInvoice, truth.lastMonth.differenceInvoice], [16905, 11865, 5040]);
  const v = S.buildVouchers(months);
  const own = (list) => list.filter((x) => x.tenantId === S.TENANT);
  check("vouchers", "the scenario tenant: Sep has no Sharma Fruits / Gupta Mart apple line; the noise tenant uses the same names", [own(v.sales).some((x) => x.header.voucherDate.toISOString().startsWith("2026-09") && x.inventory.some((l) => l.itemName === S.APPLE) && ["Sharma Fruits", "Gupta Mart"].includes(x.header.partyName)), v.sales.some((x) => x.tenantId === S.NOISE_TENANT && x.header.partyName === "Sharma Fruits")], [false, true]);

  // the fixture's months are COMPLETE calendar months (header): every line of the plans, and data to each month's last day
  const sales = own(v.sales);
  const ofMonth = (mo) => sales.filter((x) => x.header.voucherDate.toISOString().startsWith(mo.iso));
  const lineSum = (mo, item, cust) => ofMonth(mo).filter((x) => x.header.partyName === cust).flatMap((x) => x.inventory).filter((l) => l.itemName === item).reduce((a, l) => ({ qty: a.qty + l.quantity, amount: a.amount + l.amount, rates: [...new Set([...a.rates, l.rate])] }), { qty: 0, amount: 0, rates: [] });
  const planned = [], built = [];
  months.forEach((mo, i) => {
    for (const [item, p] of Object.entries(S.SALES_PLAN)) for (const [cust, q] of Object.entries(p.customers)) {
      planned.push([mo.iso, item, cust, q[i], q[i] * p.rate[i], q[i] ? [p.rate[i]] : []]);
      const b = lineSum(mo, item, cust);
      built.push([mo.iso, item, cust, b.qty, b.amount, b.rates]);
    }
  });
  check("fixture-lines", "every customer x product x month line equals the plan (quantity, value, one rate): splitting vouchers moved nothing", built, planned);
  const invoiceByMonth = months.map((mo) => Math.round(ofMonth(mo).reduce((s, x) => s + x.header.voucherTotalAmount, 0) * 100) / 100);
  const planInvoice = months.map((_, i) => Math.round(Object.values(S.SALES_PLAN).reduce((s, p) => s + Object.values(p.customers).reduce((t, q) => t + q[i] * p.rate[i], 0), 0) * S.TAX * 100) / 100);
  check("fixture-invoice-totals", "monthly invoice totals (incl. 5% tax) equal the plan: 27,300 x3 and 16,905", [invoiceByMonth, planInvoice[3]], [planInvoice, truth.lastMonth.salesInvoice]);
  const lastOf = (mo) => ofMonth(mo).map((x) => x.header.voucherDate.toISOString().slice(0, 10)).sort().pop();
  const monthEnd = (mo) => new Date(Date.UTC(mo.y, mo.m, 0)).toISOString().slice(0, 10);
  check("fixture-month-end", "every month has a sales voucher on its last calendar day (data to the month's end)", months.map(lastOf), months.map(monthEnd));
  // the findings' completeness rule on this data: the latest voucher (as dc.latestVoucher, local midnight of that day) is the
  // last day of M4, so all four months are complete and the M4 change is compared
  const { buildEvidence } = require("./src/services/query/evidence");
  const latest = sales.map((x) => x.header.voucherDate).sort((a, b) => a - b).pop();
  const latestVoucher = new Date(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate());
  const appleSeries = { id: "t", kind: "query", status: "ok", request: { v: 1, entity: "sales", mode: "aggregate", metrics: ["lineAmount"], groupBy: [{ dim: "date", bucket: "month" }], filters: [{ dim: "product", op: "eq_ci", value: S.APPLE }] }, result: { period: { from: null, to: null }, comparison: null, rows: months.map((mo, i) => ({ key: { date: { bucket: "month", start: `${mo.iso}-01`, label: mo.iso } }, values: { lineAmount: truth.apple.valueByMonth[i] } })), totals: null } };
  const evd = buildEvidence({ steps: [appleSeries] }, { referenceDate: new Date(2026, 9, 24, 12), dataThrough: latestVoucher });
  check("fixture-months-complete", "with the fixture's latest voucher as dataThrough, no month is incomplete and Sep 2026 vs Aug 2026 is compared", [evd.gaps.map((g) => g.text), /Sep 2026 ₹3,100\.00 vs Aug 2026 ₹10,000\.00: -₹6,900\.00 \(-69\.0%\)/.test(evd.findings.map((f) => f.text).join("\n"))], [[], true]);

  console.log("\n=== 2. Grader mechanics ===");
  check("numbers", "reads ₹1,23,456.00, -₹4,000.00, −6,900, 31 and 69%; dates (30 Sept 2026, 2026-09) are not figures", numbersIn("(1 Sept 2026 – 30 Sept 2026) 2026-09 · ₹1,23,456.00 change -₹4,000.00 −6,900 Quantity 31, 69%"), [123456, 4000, 6900, 31, 69]);
  check("tolerance", "a figure matches within 0.5 rupee or 0.5%, never further", [hasNumber("₹10,000.40", 10000), hasNumber("₹10,040", 10000), hasNumber("₹10,060", 10000), hasNumber("30 Sept 2026", 30)], [true, true, false, false]);
  const hyp = { kind: "hypothesis", id: "h", category: "honesty", subject: /Himachal/ };
  check("hypothesis", "hedged -> pass; stated as fact -> fail; never mentioned -> fail", [grade([hyp], { text: "Himachal Orchards may have limited supply." }).passed, grade([hyp], { text: "Himachal Orchards cut supply." }).passed, grade([hyp], { text: "nothing" }).passed], [1, 0, 0]);
  check("context", "context criterion follows contextCarried only", [grade([{ kind: "context", id: "c", category: "context" }], { text: "", contextCarried: true }).passed, grade([{ kind: "context", id: "c", category: "context" }], { text: "", contextCarried: false }).passed], [1, 0]);

  console.log("\n=== 3. Ideal answers pass every criterion; wrong answers fail the right ones ===");
  for (const sc of scenarios) {
    sc.turns.forEach((t, i) => {
      if (!t.criteria.length) return;
      const g = grade(t.criteria, { text: IDEAL[sc.id][i], contextCarried: true });
      check(`ideal-${sc.id}-${i + 1}`, `the ideal answer satisfies all ${g.total} criteria`, g.results.filter((r) => !r.pass).map((r) => r.id), []);
    });
  }
  for (const [id, turn, text, mustFail] of WRONG) {
    const g = grade(byId[id].turns[turn].criteria, { text, contextCarried: false });
    const failed = g.results.filter((r) => !r.pass).map((r) => r.id);
    check(`wrong-${id}-${mustFail[0]}`, `a wrong answer fails ${mustFail.join(", ")}`, mustFail.filter((c) => !failed.includes(c)), []);
  }

  console.log("\n=== 4. Ceiling run through the real chat turn (scripted planner): deterministic, tenant-safe ===");
  await connectDB();
  const ids = { $in: [S.TENANT, S.NOISE_TENANT] };
  const cleanup = () => Promise.all([Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids }), SyncCheckpoint.deleteMany({ tenantId: ids }), TenantDataVersion.deleteMany({ tenantId: ids })]);
  await cleanup();
  try {
    // the run anchors to the real current date (the chat's own reference date): build data and truth for "now"
    const liveMonths = S.monthsBefore(new Date());
    const liveTruth = S.groundTruth(liveMonths);
    const vv = S.buildVouchers(liveMonths);
    await Sale.insertMany(vv.sales);
    await Purchase.insertMany(vv.purchases);
    for (const [tenantId, companyGuid] of [[S.TENANT, S.COMPANY_GUID], [S.NOISE_TENANT, S.NOISE_GUID]]) {
      for (const voucherType of ["Sales", "Purchase"]) await SyncCheckpoint.create({ tenantId, companyGuid, voucherType, lastAlterId: 1000, lastRunStatus: "success", lastSyncedAt: new Date(), isRunning: false, lockedAt: null });
    }
    const replies = S.ceilingReplies();
    const runAll = async () => {
      const out = [];
      for (const sc of S.scenarios(liveTruth)) out.push({ id: sc.id, turns: await runScenario(sc, replies[sc.id]) });
      return out;
    };
    const first = await runAll();
    const second = await runAll();
    const scoreOf = (rs) => rs.map((r) => r.turns.map((t) => (t.grade ? t.grade.results.map((x) => x.pass) : null)));
    check("ceiling-runs", "every scenario turn produced an answer through the analysis route (no planner failure in the scripted run)", first.map((r) => r.turns.map((t) => t.route)), first.map((r) => r.turns.map(() => "analysis")));
    check("ceiling-deterministic", "two runs grade identically", JSON.stringify(scoreOf(first)), JSON.stringify(scoreOf(second)));
    const sum = summarise(first);
    check("ceiling-safety", "no safety failure: the other tenant's figures never appear", sum.safetyFailures, []);
    check("ceiling-no-noise", "no answer text contains the noise tenant's figures", first.some((r) => r.turns.some((t) => /7,?777|7,?77,?700|8,?888|5,?33,?280/.test(t.text))), false);
    console.log(`  (ceiling score now: ${sum.passed}/${sum.total} = ${sum.score}% - reported, not asserted)`);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(async (e) => {
  console.error("CRASH:", e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exitCode = 1;
});

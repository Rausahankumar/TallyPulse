/**
 * The plain-language opening of a SINGLE-query answer (plainAnswer.plainQuerySummary, wired in queryChat): a few short
 * sentences in the question's language (en / hinglish / hi - the query planner's optional `language` field, else
 * Devanagari script -> hi, else en), built only from the engine result the detailed text formats. The detailed text
 * (exact figures, basis, notes) follows unchanged; no figure is derived (rounding only).
 *
 * Every name and figure here is SYNTHETIC.
 * Run: node verify-plain-query-answer.js   (no database, no network, no model; chat turns with a scripted planner)
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { plainQuerySummary, shortMoney } = require("./src/services/query/plainAnswer");
const { formatQueryAnswer } = require("./src/services/query/answerFormatter");
const { buildPresentation } = require("./src/services/query/presentation");
const { PLANNER_TOOL_NAME } = require("./src/services/query/planner");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 1200)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const iso = (y, m, d, e) => (e ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
const r2 = (n) => Math.round(n * 100) / 100;
const cmp = (c, p) => ({ previous: p, delta: r2(c - p), deltaPct: p ? r2(((c - p) / p) * 100) : null });
const AUG = { from: iso(2025, 8, 1), to: iso(2025, 8, 31, true), label: "August 2025" }, JUL = { from: iso(2025, 7, 1), to: iso(2025, 7, 31, true), label: "July 2025" };
const augVsJul = { period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } } };
const CUST = [{ dim: "customer", op: "eq_ci", value: "Synthetic Traders" }];
const plan = (p) => ({ v: 1, entity: "sales", mode: "aggregate", groupBy: [], filters: [], ...p });
const res = (r) => ({ ok: true, groupBy: [], rows: [], truncated: false, warnings: [], assumptions: [], ...r });
const say = (p, r, language, extra = {}) => plainQuerySummary({ plan: p, result: r, language, zero: formatQueryAnswer({ plan: p, result: r }).zero, ...extra }).lines;

// ---- the reported shape: one customer's products, August vs July, ranked by the fall (one product stopped)
const prodRows = [["Synthetic Tint 36ML", 145463.04, 0], ["Synthetic Product B", 150000, 60000], ["Synthetic Product C", 108000, 54000]];
const pT = r2(prodRows.reduce((t, r) => t + r[1], 0)), cT = r2(prodRows.reduce((t, r) => t + r[2], 0));
const prodPlan = plan({ ...augVsJul, metrics: ["lineAmount"], filters: CUST, groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 });
const prodRes = res({ period: AUG, comparison: JUL, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rows: prodRows.map(([k, p, c]) => ({ key: { product: k }, values: { lineAmount: c }, comparison: { lineAmount: cmp(c, p) }, presence: c ? "both" : "previous_only" })).sort((a, b) => a.comparison.lineAmount.delta - b.comparison.lineAmount.delta), totals: { values: { lineAmount: cT }, comparison: { lineAmount: cmp(cT, pT) } } });

{
  const en = say(prodPlan, prodRes, "en");
  check("product-fall-en", "opens with the scoped total in words, pre-tax said, then the biggest drops in the engine's order", en[0] === "Sales to Synthetic Traders (before tax) fell from ₹4.03 lakh in July 2025 to ₹1.14 lakh in August 2025 — down ₹2.89 lakh (71.7%)." && en[1] === "Biggest drops:" && en[2] === "Synthetic Tint 36ML had ₹1.45 lakh of sales in July 2025, but none recorded in August 2025." && en[3] === "Synthetic Product B: sales dropped from ₹1.5 lakh to ₹60,000.", en.join("\n"));
  check("product-fall-rows", "at most 2 named rows (the full list stays in the details)", en.length === 4, en.length);
  const hl = say(prodPlan, prodRes, "hinglish");
  check("product-fall-hinglish", "the same facts in Hinglish", hl[0] === "Synthetic Traders ki bikri (tax se pehle) August 2025 mein kam hui: July 2025 mein ₹4.03 lakh thi, August 2025 mein ₹1.14 lakh — yaani ₹2.89 lakh (71.7%) ki girawat." && hl[1] === "Sabse zyada girawat:", hl.join("\n"));
  const hi = say(prodPlan, prodRes, "hi");
  check("product-fall-hindi", "the same facts in Hindi (Hindi month names, लाख)", hi[0] === "Synthetic Traders की बिक्री (टैक्स से पहले) अगस्त 2025 में घटी: जुलाई 2025 में ₹4.03 लाख थी, अगस्त 2025 में ₹1.14 लाख — यानी ₹2.89 लाख (71.7%) की गिरावट।" && hi[1] === "सबसे ज़्यादा गिरावट:", hi.join("\n"));
  // no new figure: every amount in the opening is the rounding of a value the engine returned (value, previous or change)
  const engine = [cT, pT, cmp(cT, pT).delta, ...prodRes.rows.flatMap((r) => [r.values.lineAmount, r.comparison.lineAmount.previous, r.comparison.lineAmount.delta])];
  for (const [lang, lines] of [["en", en], ["hinglish", hl], ["hi", hi]]) {
    const shown = lines.join("\n").match(/₹[\d,]+(?:\.\d+)?(?: (?:lakh|crore|लाख|करोड़))?/g) || [];
    const allowed = new Set(engine.map((v) => shortMoney(v, lang)));
    check(`no-new-figure-${lang}`, "every ₹ amount is the rounding of an engine value", shown.length > 0 && shown.every((s) => allowed.has(s)), shown.filter((s) => !allowed.has(s)).join(", "));
  }
  check("pct-from-engine", "the percentage is the engine's own deltaPct, rounded to one decimal", en[0].includes(`(${Math.abs(prodRes.totals.comparison.lineAmount.deltaPct).toFixed(1)}%)`));
  const before = formatQueryAnswer({ plan: prodPlan, result: prodRes }).text;
  check("formatter-unchanged", "the detailed text still carries the exact figures and the pre-tax basis", /₹1,45,463\.04/.test(before) && /\[no activity in the current period\]/.test(before) && /pre-tax item values/.test(before));
}

// ---- totals, counts, averages, ranking, trend, list, zero, incomplete period
{
  const tot = plan({ period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["invoiceAmount", "invoiceCount"] });
  const totR = res({ period: AUG, comparison: null, metrics: ["invoiceAmount", "invoiceCount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 4773898.7, invoiceCount: 312 } } });
  check("total-en", "a plain total: first metric, Indian short money, month in words", JSON.stringify(say(tot, totR, "en")) === JSON.stringify(["Total sales in August 2025: ₹47.74 lakh."]), say(tot, totR, "en"));
  check("total-hinglish", "Hinglish total", say(tot, totR, "hinglish")[0] === "Kul bikri (August 2025): ₹47.74 lakh.");
  const cnt = plan({ entity: "purchase", period: tot.period, metrics: ["purchaseInvoiceCount"] });
  const cntR = res({ period: AUG, metrics: ["purchaseInvoiceCount"], amountBasis: {}, totals: { values: { purchaseInvoiceCount: 42 } } });
  check("count-units", "a count says what it counts (invoices / bill / बिल), never rupees", say(cnt, cntR, "en")[0] === "Total purchases in August 2025: 42 invoices." && say(cnt, cntR, "hi")[0] === "कुल खरीद (अगस्त 2025): 42 बिल।", `${say(cnt, cntR, "en")} | ${say(cnt, cntR, "hi")}`);
  const avg = plan({ ...augVsJul, metrics: ["averageInvoiceValue"] });
  const avgR = res({ period: AUG, comparison: JUL, metrics: ["averageInvoiceValue"], amountBasis: { averageInvoiceValue: "voucher_total_incl_tax" }, totals: { values: { averageInvoiceValue: 15300.5 }, comparison: { averageInvoiceValue: cmp(15300.5, 15300.5) } } });
  check("average-same", "an average is named as an average; an unchanged value says so", say(avg, avgR, "en")[0] === "Average sales invoice stayed the same: ₹15,301 in both July 2025 and August 2025.", say(avg, avgR, "en")[0]);
  const rank = plan({ period: tot.period, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 });
  const rankR = res({ period: AUG, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [["Synthetic Alpha", 900000], ["Synthetic Beta", 450000], ["Synthetic Gamma", 10000]].map(([k, v]) => ({ key: { customer: k }, values: { invoiceAmount: v } })), totals: { values: { invoiceAmount: 1360000 } } });
  check("ranking-en", "a ranking: the total, then the top rows in order", JSON.stringify(say(rank, rankR, "en")) === JSON.stringify(["Total sales in August 2025: ₹13.6 lakh.", "Top customers:", "Synthetic Alpha: ₹9 lakh", "Synthetic Beta: ₹4.5 lakh"]), say(rank, rankR, "en"));
  check("ranking-hi", "Hindi ranking lead", say(rank, rankR, "hi")[1] === "ग्राहकों में सबसे ज़्यादा:");
  const asc = plan({ ...rank, sort: [{ by: "invoiceAmount", dir: "asc" }] });
  check("ranking-asc", "lowest-first is said as the bottom, not the top", say(asc, rankR, "en")[1] === "Bottom customers:" && say(asc, rankR, "hinglish")[1] === "Customers mein sabse kam:");
  const truncR = { ...rankR, truncated: true };
  check("ranking-truncated", "a list cut at its limit states no total (the formatter shows none either)", !say(rank, truncR, "en").some((l) => /^Total/.test(l)));
  const trend = plan({ period: { kind: "custom", from: "2025-06-01", to: "2025-08-31" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "date", bucket: "month" }] });
  const trendR = res({ period: { from: iso(2025, 6, 1), to: iso(2025, 8, 31, true) }, metrics: ["invoiceAmount"], groupBy: [{ dim: "date", bucket: "month" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [["2025-06", 300000], ["2025-07", 520000], ["2025-08", 410000]].map(([m, v]) => ({ key: { date: { bucket: "month", start: `${m}-01`, label: m } }, values: { invoiceAmount: v } })), totals: { values: { invoiceAmount: 1230000 } } });
  check("trend", "a trend: the total over the range and its highest month (a returned value), month in words", JSON.stringify(say(trend, trendR, "en")) === JSON.stringify(["Total sales from 1 June 2025 to 31 August 2025: ₹12.3 lakh.", "Highest: July 2025 (₹5.2 lakh)."]) && say(trend, trendR, "hi")[1] === "सबसे ज़्यादा: जुलाई 2025 (₹5.2 लाख)।", say(trend, trendR, "en"));
  const list = plan({ mode: "list", period: tot.period, metrics: ["invoiceAmount"], limit: 2 });
  const listR = res({ period: AUG, metrics: ["invoiceAmount"], rows: [{ voucherNo: "S1", date: "2025-08-02", customer: "Synthetic Alpha", invoiceAmount: 100 }, { voucherNo: "S2", date: "2025-08-03", customer: "Synthetic Beta", invoiceAmount: 200 }], truncated: true });
  check("list", "a list: how many invoices are shown and that more exist", say(list, listR, "en")[0] === "2 invoices in August 2025 (only the first ones are shown; more exist):", say(list, listR, "en"));
  const zeroR = res({ period: AUG, metrics: ["invoiceAmount"], totals: { values: { invoiceAmount: 0 } } });
  const zp = plan({ period: tot.period, metrics: ["invoiceAmount"], filters: CUST });
  check("zero", "no records: one plain sentence naming the scope, no figure", say(zp, zeroR, "en")[0] === "No sales found for Synthetic Traders in August 2025." && say(zp, zeroR, "hinglish")[0] === "August 2025 mein Synthetic Traders ki koi bikri nahi mili.", say(zp, zeroR, "en"));
  check("incomplete", "a period running past the latest voucher is said to be incomplete", say(tot, totR, "en", { dataThrough: "2025-08-20" })[1] === "August 2025 is not complete in the data yet (only up to 20 August 2025), so this is not the full picture.");
  const all = plan({ period: { kind: "all_time" }, metrics: ["invoiceAmount"] });
  check("all-time-no-incomplete", "all history is never called incomplete", say(all, { ...totR, period: { kind: "all_time", from: null, to: null } }, "en", { dataThrough: "2025-08-20" }).length === 1);
  const ret = plan({ entity: "sales_return", period: tot.period, metrics: ["returnAmount"], filters: CUST });
  const retR = res({ period: AUG, metrics: ["returnAmount"], amountBasis: { returnAmount: "voucher_total_incl_tax" }, totals: { values: { returnAmount: 25000 } } });
  check("returns", "returns are named as returns, never as sales", say(ret, retR, "en")[0] === "Sales returns from Synthetic Traders in August 2025: ₹25,000.", say(ret, retR, "en"));
  // review regressions: the change lead must match the rows it names, and only for the shown metric's own change
  const grewRows = [["Synthetic Alpha", 100, 300], ["Synthetic Beta", 100, 150]].map(([k, p, c]) => ({ key: { customer: k }, values: { invoiceAmount: c, invoiceCount: 2 }, comparison: { invoiceAmount: cmp(c, p), invoiceCount: cmp(2, 5) } }));
  const grewPlan = plan({ ...augVsJul, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 2 });
  const grewR = res({ period: AUG, comparison: JUL, metrics: ["invoiceAmount", "invoiceCount"], groupBy: [{ dim: "customer" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: grewRows, truncated: true, totals: null });
  const g1 = say(grewPlan, grewR, "en");
  check("lead-matches-rows", "sorted toward falls but every row grew: no 'Biggest drops' lead over rising rows", !g1.includes("Biggest drops:") && g1.some((l) => /grew from/.test(l)), g1);
  const g2 = say({ ...grewPlan, sort: [{ by: "invoiceCount.delta", dir: "asc" }] }, grewR, "en");
  check("lead-other-metric", "ranked by another metric's change: no change lead for the metric shown", !g2.includes("Biggest drops:") && !g2.includes("Biggest increases:"), g2);
  check("incomplete-without-total", "an unfinished period is said even when no total was returned", g1.some((l) => /not complete in the data yet/.test(l)) === false && say(grewPlan, grewR, "en", { dataThrough: "2025-08-20" }).some((l) => /August 2025 is not complete in the data yet/.test(l)));
  check("unknown-language","an unknown language falls back to English", plainQuerySummary({ plan: tot, result: totR, language: "fr" }).language === "en");
  check("step-view-untouched", "buildPresentation alone (an analysis step's view) carries no plain opening", !("plain" in buildPresentation({ plan: tot, result: totR, notes: [], zero: false })));
}

// ---- through the chat turn: the query planner's language field picks the language; without it, the script decides
(async () => {
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const DC = { referenceDate: new Date(2026, 9, 27, 12), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null } };
  const queryPlan = { v: 1, entity: "sales", mode: "aggregate", ...augVsJul, metrics: ["lineAmount"], filters: CUST, groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 };
  const turn = async (question, extra, { previousQuery = null, planOut = queryPlan, result = prodRes } = {}) => {
    const seen = [];
    let calls = 0;
    const model = async (req) => { calls += 1; seen.push(JSON.stringify(req.messages)); return { content: [{ type: "tool_use", id: "p", name: PLANNER_TOOL_NAME, input: { plan: planOut, ...extra } }], usage: { input_tokens: 1, output_tokens: 1 } }; };
    const tenants = [];
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-PLAINQ", userId: "u" }, userMessage: question, conversationHistory: previousQuery ? [{ role: "user", content: "(earlier turn)" }, { role: "assistant", content: "(answer)" }] : [], previousQuery, deps: { plannerClient: model, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC, execute: async (p, ctx) => { tenants.push(ctx.tenantId); return { result, cache: { status: "miss" } }; }, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
    return { s: out.structured, queryContext: out.queryContext, tenants, calls, seen };
  };
  const hl = await turn("Synthetic Traders ki August 2025 mein product wise bikri July 2025 se kitni giri?", { language: "hinglish" });
  const detail = formatQueryAnswer({ plan: queryPlan, result: prodRes }).text;
  check("chat-hinglish", "planner says hinglish: the answer opens in Hinglish, the view carries it, one planner call, this tenant only", /^Synthetic Traders ki bikri \(tax se pehle\) August 2025 mein kam hui/.test(hl.s.answer) && hl.s.visualization.plain.language === "hinglish" && hl.s.details.queryEngine.language === "hinglish" && hl.calls === 1 && hl.tenants.every((t) => t === "T-PLAINQ"), hl.s.answer.slice(0, 300));
  check("chat-details-unchanged", "below the opening, the formatter's text follows unchanged (exact figures and basis)", hl.s.answer.endsWith(`\n\n${detail}`) && hl.s.visualization.kind === "comparison" || hl.s.answer.endsWith(`\n\n${detail}`), hl.s.answer.slice(-300));
  const en = await turn("Synthetic Traders product sales August 2025 vs July 2025", { language: "en" });
  check("chat-english", "planner says en: plain English opening", /^Sales to Synthetic Traders \(before tax\) fell from ₹4\.03 lakh/.test(en.s.answer), en.s.answer.slice(0, 200));
  const hiFallback = await turn("अगस्त 2025 में Synthetic Traders की उत्पाद वार बिक्री", {});
  check("chat-hindi-fallback", "no language field and a Devanagari question: Hindi (script, not keywords)", /^Synthetic Traders की बिक्री \(टैक्स से पहले\) अगस्त 2025 में घटी/.test(hiFallback.s.answer) && hiFallback.s.details.queryEngine.language === "hi", hiFallback.s.answer.slice(0, 200));
  const enFallback = await turn("Synthetic Traders ki bikri August 2025", {});
  check("chat-default-english", "no language field and Latin script: English (Hinglish is never guessed from words)", /^Sales to Synthetic Traders/.test(enFallback.s.answer) && enFallback.s.details.queryEngine.language === "en");
  const bad = await turn("Synthetic Traders ki bikri August 2025", { language: "french" });
  check("chat-language-dropped", "an unknown language value is dropped: the question is still answered (in English)", /^Sales to Synthetic Traders/.test(bad.s.answer) && bad.s.details.queryEngine.status === "answered", bad.s.details.queryEngine.status);
  // follow-up context: the language is presentation only - the saved state is the same with or without it, and the next turn
  // (another language) still gets the previous structured plan and answers in its own language
  const plainTurn = await turn("Synthetic Traders ki August 2025 mein product wise bikri July 2025 se kitni giri?", {});
  check("followup-state-unchanged", "the saved follow-up state does not depend on the language field (and holds no language)", hl.queryContext && JSON.stringify(hl.queryContext) === JSON.stringify(plainTurn.queryContext) && !/language|hinglish/.test(JSON.stringify(hl.queryContext)), JSON.stringify(hl.queryContext).slice(0, 300));
  const follow = await turn("अब सिर्फ़ Synthetic Traders की कुल बिक्री", { language: "hi" }, { previousQuery: hl.queryContext, planOut: { v: 1, entity: "sales", mode: "aggregate", ...augVsJul, metrics: ["lineAmount"], filters: CUST }, result: res({ period: AUG, comparison: JUL, metrics: ["lineAmount"], amountBasis: { lineAmount: "line_item_pre_tax" }, totals: prodRes.totals }) });
  check("followup-context", "a follow-up in Hindi: the planner received the previous structured plan, the answer opens in Hindi, the same totals", follow.seen.some((m) => m.includes("Synthetic Tint") === false && m.includes("lineAmount.delta")) && /^Synthetic Traders की बिक्री \(टैक्स से पहले\) अगस्त 2025 में घटी: जुलाई 2025 में ₹4\.03 लाख थी/.test(follow.s.answer) && follow.queryContext && follow.tenants.every((t) => t === "T-PLAINQ"), `${follow.s.answer.slice(0, 200)} | ${follow.seen.join(" ").slice(0, 200)}`);

  // purchases: three languages, money and basis, through the chat turn
  const buyPlan = { v: 1, entity: "purchase", mode: "aggregate", ...augVsJul, metrics: ["purchaseAmount", "purchaseInvoiceCount"], filters: [{ dim: "supplier", op: "eq_ci", value: "Synthetic Mills" }] };
  const buyRes = res({ entity: "purchase", period: AUG, comparison: JUL, metrics: ["purchaseAmount", "purchaseInvoiceCount"], amountBasis: { purchaseAmount: "voucher_total_incl_tax" }, totals: { values: { purchaseAmount: 260000, purchaseInvoiceCount: 9 }, comparison: { purchaseAmount: cmp(260000, 200000), purchaseInvoiceCount: cmp(9, 7) } } });
  const buyExpect = {
    en: "Purchases from Synthetic Mills rose from ₹2 lakh in July 2025 to ₹2.6 lakh in August 2025 — up ₹60,000 (30.0%).",
    hinglish: "Synthetic Mills ki kharid August 2025 mein badhi: July 2025 mein ₹2 lakh thi, August 2025 mein ₹2.6 lakh — yaani ₹60,000 (30.0%) ki badhat.",
    hi: "Synthetic Mills की खरीद अगस्त 2025 में बढ़ी: जुलाई 2025 में ₹2 लाख थी, अगस्त 2025 में ₹2.6 लाख — यानी ₹60,000 (30.0%) की बढ़त।",
  };
  for (const lang of ["en", "hinglish", "hi"]) {
    const b = await turn("Synthetic Mills purchases Aug 2025 vs Jul 2025", { language: lang }, { planOut: buyPlan, result: buyRes });
    check(`purchase-${lang}`, "a purchase comparison opens in the question's language, tax-inclusive (no pre-tax mark), exact figures below", b.s.answer.split("\n")[0] === buyExpect[lang] && b.s.answer.includes("₹2,60,000.00") && b.s.answer.includes("Invoice amounts are invoice totals including tax."), b.s.answer.split("\n")[0]);
  }

  // zero and missing values
  const z = await turn("Synthetic Mills purchases Aug 2025", { language: "hinglish" }, { planOut: { ...buyPlan, compare: undefined, metrics: ["purchaseAmount"] }, result: res({ entity: "purchase", period: AUG, metrics: ["purchaseAmount"], amountBasis: { purchaseAmount: "voucher_total_incl_tax" }, totals: { values: { purchaseAmount: 0 } } }) });
  check("purchase-zero-hinglish", "no purchases: one plain sentence, no figure, then the formatter's no-records text", z.s.answer.startsWith("August 2025 mein Synthetic Mills ki koi kharid nahi mili.\n\n") && /No matching records were found/.test(z.s.answer), z.s.answer.slice(0, 200));
  const zeroNow = res({ period: AUG, comparison: JUL, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 0 }, comparison: { invoiceAmount: cmp(0, 50000) } } });
  const zn = say(plan({ ...augVsJul, metrics: ["invoiceAmount"] }), zeroNow, "en");
  check("zero-against-nonzero", "zero now against a non-zero earlier period is a fall to ₹0, not 'no records'", zn[0] === "Total sales fell from ₹50,000 in July 2025 to ₹0 in August 2025 — down ₹50,000 (100.0%).", zn[0]);
  const zeroPrev = res({ period: AUG, comparison: JUL, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 50000 }, comparison: { invoiceAmount: { previous: 0, delta: 50000, deltaPct: null } } } });
  const zp2 = say(plan({ ...augVsJul, metrics: ["invoiceAmount"] }), zeroPrev, "en")[0];
  check("pct-undefined", "a % change against zero is not stated (never 0% or infinite)", zp2 === "Total sales rose from ₹0 in July 2025 to ₹50,000 in August 2025 — up ₹50,000." && !/%/.test(zp2), zp2);
  const missing = say(plan({ period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }] }), res({ period: AUG, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [{ key: { customer: "Synthetic Alpha" }, values: { invoiceAmount: 900 } }], totals: null }), "en");
  check("missing-total", "no total returned: no total sentence (missing is never said as zero)", JSON.stringify(missing) === JSON.stringify(["Top customers:", "Synthetic Alpha: ₹900"]), missing);
  console.log("\nSample (Hinglish):\n" + hl.s.answer.split("\n\n")[0]);
  console.log(`\nverify-plain-query-answer: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

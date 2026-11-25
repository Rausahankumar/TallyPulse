/**
 * The plain-language opening of an analysis answer (plainAnswer.js): the same verified facts as the detailed findings, in
 * the question's language (en / hinglish / hi, from the analysis planner's structured `language`), short and in business
 * words - without changing a figure or turning a possibility into a fact.
 *
 * Grounded fixture (reported): Ashok Traders sales ₹4,77,389.87 (Jul 2025) -> ₹1,34,075.39 (Aug 2025), -₹3,43,314.48 (71.9%);
 * RANGEELA TEMPRA CLR 36ML sales ₹1,45,463.04 -> none recorded; its purchases ₹1,01,217.60 (Jul) -> ₹24,537.60 (Aug); stock
 * on hand is not recorded. Every other row ("Synthetic ...") and the product-level line totals are SYNTHETIC placeholders.
 * Also the reported June -> July 2025 totals (₹40,85,714.10 -> ₹57,16,599.12) for the "overall rose" case.
 *
 * Run: node verify-plain-answer.js   (no database, no network, no model; chat turns with a scripted planner)
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const { buildAnalysisPresentation } = require("./src/services/query/analysisPresentation");
const { shortMoney } = require("./src/services/query/plainAnswer");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 1200)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const iso = (y, m, d, e) => (e ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
const r2 = (n) => Math.round(n * 100) / 100;
const cmp = (c, p) => ({ previous: p, delta: r2(c - p), deltaPct: p ? r2(((c - p) / p) * 100) : null });
const AUG = { from: iso(2025, 8, 1), to: iso(2025, 8, 31, true) }, JUL = { from: iso(2025, 7, 1), to: iso(2025, 7, 31, true) }, JUN = { from: iso(2025, 6, 1), to: iso(2025, 6, 30, true) };
const query = (request, result) => ({ kind: "query", status: "ok", facts: "(step)", notes: [], request: { v: 1, entity: "sales", mode: "aggregate", groupBy: [], filters: [], ...request }, result: { ok: true, groupBy: [], rows: [], truncated: false, ...result } });
const ASHOK = [{ dim: "customer", op: "eq_ci", value: "Ashok Traders" }];
const augVsJul = { period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" } } };

// ---- the Ashok Traders scenario
const total = query({ ...augVsJul, metrics: ["invoiceAmount"], filters: ASHOK }, { period: AUG, comparison: JUL, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 134075.39 }, comparison: { invoiceAmount: cmp(134075.39, 477389.87) } } });
const prodRows = [["RANGEELA TEMPRA CLR 36ML", 145463.04, 0], ["Synthetic Product B", 150000, 60000], ["Synthetic Product C", 108000, 54000]];
const pT = r2(prodRows.reduce((t, r) => t + r[1], 0)), cT = r2(prodRows.reduce((t, r) => t + r[2], 0));
const products = query({ ...augVsJul, metrics: ["lineAmount"], filters: ASHOK, groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 10 }, { period: AUG, comparison: JUL, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rows: prodRows.map(([k, p, c]) => ({ key: { product: k }, values: { lineAmount: c }, comparison: { lineAmount: cmp(c, p) } })).sort((a, b) => a.comparison.lineAmount.delta - b.comparison.lineAmount.delta), totals: { values: { lineAmount: cT }, comparison: { lineAmount: cmp(cT, pT) } } });
const buys = query({ entity: "purchase", period: { kind: "custom", from: "2025-06-01", to: "2025-08-31" }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "date", bucket: "month" }], filters: [{ dim: "product", op: "eq_ci", value: "RANGEELA TEMPRA CLR 36ML" }], sort: [{ by: "date", dir: "asc" }], limit: 24 }, { period: { from: iso(2025, 6, 1), to: iso(2025, 8, 31, true) }, comparison: null, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "date", bucket: "month" }], amountBasis: { lineAmount: "line_item_pre_tax" }, rows: [["2025-07", 101217.6], ["2025-08", 24537.6]].map(([mo, v]) => ({ key: { date: { bucket: "month", start: `${mo}-01`, label: mo } }, values: { lineAmount: v, quantity: 0 } })), totals: null });
const ASHOK_STEPS = [total, products, buys];
const say = (steps, language, o = {}) => { const f = formatAnalysisAnswer({ steps }, { language, dataThrough: "2025-12-31", ...o }); return { f, lines: f.plain.lines, text: f.text, vis: buildAnalysisPresentation({ execution: { steps }, formatted: f, actions: !!o.actions }) }; };

{
  const hl = say(ASHOK_STEPS, "hinglish");
  check("hl-main-first", "Hinglish: the first sentence is the main result, in everyday words, with the engine's figures rounded (₹4.77 lakh -> ₹1.34 lakh, ₹3.43 lakh, 71.9%)", hl.lines[0] === "Ashok Traders ki bikri August 2025 mein kam hui: July 2025 mein ₹4.77 lakh thi, August 2025 mein ₹1.34 lakh — yaani ₹3.43 lakh (71.9%) ki girawat.", hl.lines[0]);
  check("hl-product", "the product with no August sales is explained plainly", hl.lines.includes("RANGEELA TEMPRA CLR 36ML ki July 2025 mein ₹1.45 lakh ki bikri hui, lekin August 2025 mein koi bikri record nahi hui."), hl.lines.join("\n"));
  const cause = hl.lines.find((l) => /kharidna bhi kam hua/.test(l)) || "";
  check("hl-possibility", "the purchase fall is a possibility, never a fact: 'ho sakta hai ... abhi pakka nahi hai', and stock on hand is said to be unrecorded", /^RANGEELA TEMPRA CLR 36ML ko kharidna bhi kam hua: July 2025 mein ₹1\.01 lakh ka maal kharida gaya, August 2025 mein sirf ₹24,538 ka\. Ho sakta hai .* lekin ye abhi pakka nahi hai — TallyPulse mein godown ka stock record nahi hota\.$/.test(cause) && !/(kyunki|isliye) maal nahi tha|maal ki kami (thi|se hi)|wajah maal ki kami hai/i.test(hl.lines.join(" ")), cause);
  check("hl-no-unasked-step", "not asked what to do: no next-step line", !hl.lines.some((l) => /check karein/i.test(l)));
  check("hl-exact-kept", "the exact figures and the accounting basis stay in the detailed answer below (₹4,77,389.87, ₹1,34,075.39, invoice amount; pre-tax line value for products)", /₹4,77,389\.87/.test(hl.text) && /₹1,34,075\.39/.test(hl.text) && /invoice amount/.test(hl.text) && /line amount, pre-tax/.test(hl.text) && hl.text.indexOf(hl.lines[0]) === 0 && hl.text.indexOf("Analysis:") > hl.text.indexOf(hl.lines[hl.lines.length - 1]));
  check("hl-short", "concise: at most 6 opening lines, the full lists stay in the details", hl.lines.length <= 6, hl.lines.length);
  check("rounding", "rounding only: ₹4,77,389.87 -> ₹4.77 lakh, ₹1,34,075.39 -> ₹1.34 lakh, ₹3,43,314.48 -> ₹3.43 lakh, ₹24,537.60 -> ₹24,538, ₹1.2 crore", shortMoney(477389.87) === "₹4.77 lakh" && shortMoney(134075.39) === "₹1.34 lakh" && shortMoney(-343314.48) === "₹3.43 lakh" && shortMoney(24537.6) === "₹24,538" && shortMoney(12000000) === "₹1.2 crore" && shortMoney(145463.04, "hi") === "₹1.45 लाख");
  const act = say(ASHOK_STEPS, "hinglish", { actions: true });
  check("hl-next-step", "asked what to do: the next check in plain words, and why it matters - tied to the supply evidence", act.lines.includes("Aage kya check karein:") && act.lines.some((l) => l === "Pehle check karein ki August 2025 mein godown mein RANGEELA TEMPRA CLR 36ML ka kitna maal tha aur supplier ne order poore kiye ya nahi. Isse pata chalega ki bikri maal ki kami ki wajah se kam hui ya nahi."), act.lines.join("\n"));

  const en = say(ASHOK_STEPS, "en");
  check("en-plain", "English question: plain English, no Hinglish words, same figures", en.lines[0] === "Sales to Ashok Traders fell from ₹4.77 lakh in July 2025 to ₹1.34 lakh in August 2025 — down ₹3.43 lakh (71.9%)." && !/\b(bikri|kharid|maal|nahi|lekin|pakka)\b/i.test(en.lines.join(" ")) && en.lines.some((l) => /may have limited sales, but it is not confirmed — TallyPulse does not record stock on hand/.test(l)), en.lines.join("\n"));
  const hi = say(ASHOK_STEPS, "hi");
  check("hi-plain", "Hindi question: clear Hindi in Devanagari, same figures (₹4.77 लाख, 71.9%), names kept as written", /^Ashok Traders की बिक्री अगस्त 2025 में घटी: जुलाई 2025 में ₹4\.77 लाख थी, अगस्त 2025 में ₹1\.34 लाख — यानी ₹3\.43 लाख \(71\.9%\) की गिरावट।$/.test(hi.lines[0]) && hi.lines.some((l) => /RANGEELA TEMPRA CLR 36ML की/.test(l)) && hi.lines.some((l) => /अभी पक्का नहीं है/.test(l)), hi.lines.join("\n"));
  check("hl-latin", "Hinglish stays in Latin script (no Devanagari)", !/[ऀ-ॿ]/.test(hl.lines.join(" ")));
  check("view-plain", "the structured view carries the same opening and its language; the technical headline stays for Details", hl.vis.plain && hl.vis.plain.language === "hinglish" && hl.vis.plain.lines[0] === hl.lines[0] && !!hl.vis.headline);
}

// ---- overall rose while the plan looked at falls (the reported June -> July totals)
{
  const custFalls = query({ period: { kind: "custom", from: "2025-07-01", to: "2025-07-31" }, compare: { mode: "custom", period: { kind: "custom", from: "2025-06-01", to: "2025-06-30" } }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], having: [{ metric: "invoiceAmount.delta", op: "lt", value: 0 }], limit: 10 }, { period: JUL, comparison: JUN, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [["Synthetic Customer A", 50000, 0]].map(([k, p, c]) => ({ key: { customer: k }, values: { invoiceAmount: c }, comparison: { invoiceAmount: cmp(c, p) } })), totals: { values: { invoiceAmount: 5716599.12 }, comparison: { invoiceAmount: cmp(5716599.12, 4085714.1) } } });
  const hl = say([custFalls], "hinglish");
  check("rise-hl", "Hinglish: 'Kul bikri ... badhi' first, then that overall it did NOT fall; the customer with no July sales comes after, separately", hl.lines[0] === "Kul bikri July 2025 mein badhi: June 2025 mein ₹40.86 lakh thi, July 2025 mein ₹57.17 lakh — yaani ₹16.31 lakh (39.9%) ki badhat." && hl.lines[1] === "Yaani kul milakar bikri kam nahi hui, balki badhi hai. Kuch customers ki bikri kam hui, lekin kul bikri phir bhi badhi." && hl.lines.some((l, i) => i > 1 && /Synthetic Customer A/.test(l)), hl.lines.join("\n"));
  check("rise-no-decline", "no plain sentence says total sales fell", !hl.lines.some((l) => /^Kul bikri .* kam hui/.test(l)) && !say([custFalls], "en").lines.some((l) => /^Total sales fell/.test(l)));
}

// ---- missing and incomplete data, said honestly
{
  const noTotal = query({ ...augVsJul, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount.delta", dir: "asc" }], limit: 2 }, { period: AUG, comparison: JUL, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, rows: [["Synthetic Customer A", 50000, 20000]].map(([k, p, c]) => ({ key: { customer: k }, values: { invoiceAmount: c }, comparison: { invoiceAmount: cmp(c, p) } })), totals: null, truncated: true });
  const u = say([noTotal], "hinglish");
  check("unavailable", "no total measured: 'abhi pakka nahi keh sakte ki kul bikri badhi ya ghati' - never a direction guessed from the listed rows", u.lines[0] === "Do period ke beech kul badlav naapa nahi gaya, isliye abhi pakka nahi keh sakte ki kul bikri badhi ya ghati." && !u.lines.some((l) => /^Kul bikri .* (badhi|kam hui):/.test(l)), u.lines.join("\n"));
  const partial = say([total], "hinglish", { dataThrough: "2025-08-20" });
  check("incomplete", "data only to 20 Aug: said plainly that this is not the full picture", partial.lines.includes("August 2025 ka data abhi 20 August 2025 tak hi hai, isliye ye poore mahine ki tasveer nahi hai."), partial.lines.join("\n"));
  const nothing = say([total], "hinglish", { actions: true, dataThrough: "2025-08-20" });
  check("no-invented-step", "asked what to do with an incomplete period: no invented step, the plain reason instead", nothing.lines.includes("Abhi kadam suggest karna jaldi hoga: data mein period abhi poora nahi hua.") && !nothing.lines.some((l) => /check karein ki/.test(l)), nothing.lines.join("\n"));
  const leaderOnly = say([products], "en", { actions: true });
  check("unknown-why", "asked what to do with only 'where' (no evidence of why): says where the drop is but not why, no generic step", leaderOnly.lines.some((l) => /^The data shows where the drop is \(biggest: RANGEELA TEMPRA CLR 36ML, down ₹1\.45 lakh\) but not why, so no specific step can be suggested yet\.$/.test(l)), leaderOnly.lines.join("\n"));
}

// ---- review fixes: scope never lost, accounting basis said once, wording without ambiguity (synthetic rows)
{
  const scoped = (filters, metric = "invoiceAmount", entity = "sales") => query({ entity, ...augVsJul, metrics: [metric], filters }, { period: AUG, comparison: JUL, metrics: [metric], amountBasis: { [metric]: metric === "lineAmount" ? "line_item_pre_tax" : "voucher_total_incl_tax" }, totals: { values: { [metric]: 80000 }, comparison: { [metric]: cmp(80000, 100000) } } });
  const grp = say([scoped([{ dim: "productGroup", op: "eq_ci", value: "Synthetic Group" }], "lineAmount")], "en").lines[0];
  const two = say([scoped([{ dim: "customer", op: "in_ci", value: ["Synthetic A", "Synthetic B"] }])], "hinglish").lines[0];
  check("scope-not-total", "a total narrowed by a product group or by two customers is never called the whole business ('Total sales' / 'Kul bikri')", /^Sales of Synthetic Group group fell/.test(grp) && /^Synthetic A aur Synthetic B ki bikri August 2025 mein kam hui/.test(two), `${grp} | ${two}`);
  const companyRose = query({ ...augVsJul, metrics: ["invoiceAmount"] }, { period: AUG, comparison: JUL, metrics: ["invoiceAmount"], amountBasis: { invoiceAmount: "voucher_total_incl_tax" }, totals: { values: { invoiceAmount: 900000 }, comparison: { invoiceAmount: cmp(900000, 800000) } } });
  const mixed = say([companyRose, products], "en").lines;
  check("scope-of-rows", "rows of a narrower breakdown (Ashok Traders' products) under a company-wide result say whose rows they are", mixed.includes("Biggest drops (Ashok Traders):"), mixed.join("\n"));
  check("basis-note", "invoice totals (incl. tax) next to pre-tax item values: one plain note that they do not add up; none when every figure has the same basis", say(ASHOK_STEPS, "hinglish").lines.filter((l) => /^Dhyan dein: item wale aankde tax se pehle ke hain/.test(l)).length === 1 && !say([products], "en").lines.some((l) => /^Note:/.test(l)));
  const noTotalBuys = query({ entity: "purchase", ...augVsJul, metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "purchaseAmount.delta", dir: "asc" }], limit: 1 }, { period: AUG, comparison: JUL, metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], amountBasis: { purchaseAmount: "voucher_total_incl_tax" }, rows: [{ key: { supplier: "Synthetic Supplier" }, values: { purchaseAmount: 10 }, comparison: { purchaseAmount: cmp(10, 50) } }], totals: null, truncated: true });
  check("unavailable-entity", "no total measured for a purchase comparison: it says purchases, not sales", say([noTotalBuys], "en").lines[0] === "The total change between the two periods was not measured, so we cannot yet say whether total purchases rose or fell." && say([noTotalBuys], "hinglish").lines[0] === "Do period ke beech kul badlav naapa nahi gaya, isliye abhi pakka nahi keh sakte ki kul kharid badhi ya ghati.");
  const why = say([products], "hinglish", { actions: true }).lines.pop();
  check("leader-direction", "the largest fall is said as a fall ('₹1.45 lakh kam'), never a bare amount that reads like sales", /\(sabse zyada: RANGEELA TEMPRA CLR 36ML, ₹1\.45 lakh kam\)/.test(why), why);
  check("day-words", "dates inside sentences are words ('20 अगस्त 2025'), not ISO", say([total], "hi", { dataThrough: "2025-08-20" }).lines.includes("अगस्त 2025 का डेटा अभी 20 अगस्त 2025 तक ही है, इसलिए यह पूरी तस्वीर नहीं है।"));
}

// ---- through the chat turn: the planner's language field picks the language; without it, the script decides
(async () => {
  const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");
  const DC = { referenceDate: new Date(2026, 9, 27, 12), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2025, 11, 31), lastSyncedAt: null } };
  const plan = { v: 1, steps: [{ id: "ashok", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", ...augVsJul, metrics: ["invoiceAmount"], filters: ASHOK } }] };
  const turn = async (question, analysisReply) => {
    const replies = [{ decline: { code: "needs_analysis", message: "several analyses" } }, analysisReply];
    const model = async (req) => ({ content: [{ type: "tool_use", name: req.tool_choice.name, input: replies.shift() || { decline: { code: "not_a_data_query" } } }], usage: { input_tokens: 1, output_tokens: 1 } });
    const tenants = [];
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-PLAIN", userId: "u" }, userMessage: question, conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, getFreshness: async () => ({ state: "fresh", message: "", dataAsOf: null }), getDateContext: async () => DC, execute: async (p, ctx) => { tenants.push(ctx.tenantId); return { result: total.result }; }, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
    return { s: out.structured, tenants };
  };
  const hl = await turn("Ashok Traders ki bikri August 2025 mein kyun giri?", { analysis: plan, language: "hinglish" });
  check("chat-hinglish", "planner says hinglish: the answer opens in Hinglish, the view carries it, for this tenant only", /^Ashok Traders ki bikri August 2025 mein kam hui/.test(hl.s.answer) && hl.s.visualization.plain.language === "hinglish" && hl.s.details.queryEngine.language === "hinglish" && hl.tenants.every((t) => t === "T-PLAIN"), hl.s.answer.slice(0, 300));
  const en = await turn("Why did Ashok Traders' sales fall in August 2025?", { analysis: plan, language: "en" });
  check("chat-english", "planner says en: plain English opening", /^Sales to Ashok Traders fell from ₹4\.77 lakh/.test(en.s.answer), en.s.answer.slice(0, 200));
  const hiFallback = await turn("अगस्त 2025 में Ashok Traders की बिक्री क्यों घटी?", { analysis: plan });
  check("chat-hindi-fallback", "no language field and a Devanagari question: Hindi (script, not keywords)", /^Ashok Traders की बिक्री अगस्त 2025 में घटी/.test(hiFallback.s.answer) && hiFallback.s.details.queryEngine.language === "hi", hiFallback.s.answer.slice(0, 200));
  const enFallback = await turn("Ashok Traders sales August 2025 vs July 2025", { analysis: plan });
  check("chat-default-english", "no language field and Latin script: English (never assumed Hinglish)", /^Sales to Ashok Traders fell/.test(enFallback.s.answer) && enFallback.s.details.queryEngine.language === "en");
  const bad = await turn("Ashok Traders ki bikri kyun giri?", { analysis: plan, language: "french" });
  check("chat-language-validated", "an unknown language value is a protocol violation: nothing runs", bad.s.details.queryEngine.code === "planner_protocol_violation" && bad.tenants.length === 0);
  console.log("\nSample (Hinglish, asked what to do):\n" + say(ASHOK_STEPS, "hinglish", { actions: true }).lines.join("\n"));
  console.log(`\nverify-plain-answer: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

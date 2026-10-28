"use strict";

// --------------------------------------------------
// The plain-language opening of an analysis answer: a few short sentences a shop owner can read first - what happened
// overall, where it happened, what might explain it (never as a fact) and, when asked, what to check next - in the language
// of the question (the analysis planner's `language`: en, hinglish or hi). Built ONLY from the evidence record's structured
// facts (evidence.js: overall, facts, recommendations, noActionCode): every figure is the engine's own, shown rounded
// (₹4.77 lakh); nothing is computed here beyond rounding and a percentage of two returned values. No model call.
// The detailed findings (exact figures, accounting basis, step references) stay below it, unchanged.
// --------------------------------------------------

const { CATALOG } = require("./semanticCatalog");
const { dayOf, dataDayOf } = require("./evidence"); // the same stored-date -> calendar-day rule as the findings

const isMoney = (id) => !!(CATALOG.metrics[id] && CATALOG.metrics[id].amountBasis);
const trimZeros = (s) => s.replace(/\.?0+$/, "");

/** Indian short form of a money value: ₹4.77 lakh, ₹1.2 crore, ₹24,538. */
function shortMoney(v, lang = "en") {
  const a = Math.abs(v);
  const unit = lang === "hi" ? { lakh: "लाख", crore: "करोड़" } : { lakh: "lakh", crore: "crore" };
  if (a >= 1e7) return `₹${trimZeros((a / 1e7).toFixed(2))} ${unit.crore}`;
  if (a >= 1e5) return `₹${trimZeros((a / 1e5).toFixed(2))} ${unit.lakh}`;
  return `₹${Math.round(a).toLocaleString("en-IN")}`;
}
const UNITS = { en: "units", hinglish: "unit", hi: "यूनिट" };
const INVOICES = { en: "invoices", hinglish: "bill", hi: "बिल" };
// what a non-money metric counts (quantities are units: no unit of measure is stored)
const COUNTED = {
  invoiceCount: INVOICES, purchaseInvoiceCount: INVOICES,
  returnCount: { en: "return notes", hinglish: "return notes", hi: "वापसी नोट" },
  customerCount: { en: "customers", hinglish: "customers", hi: "ग्राहक" },
  lineCount: { en: "item lines", hinglish: "item lines", hi: "आइटम लाइनें" },
};
const amount = (metric, v, lang) => (isMoney(metric) ? shortMoney(v, lang) : `${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })} ${(COUNTED[metric] || UNITS)[lang]}`);
const pctOf = (delta, previous) => (previous ? `${Math.abs((delta / previous) * 100).toFixed(1)}%` : null);

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  hi: ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
};
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** A day in words: "2025-08-20" -> "20 August 2025" ("20 अगस्त 2025" in hi); anything else unchanged. */
function dayWords(day, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return day || "";
  return `${Number(m[3])} ${(lang === "hi" ? MONTHS.hi : MONTHS.en)[Number(m[2]) - 1]} ${m[1]}`;
}
/** A period in words: a whole month -> "July 2025" (Hindi month names in hi); otherwise its two dates in words. */
function periodWords(days, lang) {
  const [from, to] = days || [];
  if (!from || !to) return "";
  const [y, m, d] = from.split("-").map(Number);
  const names = lang === "hi" ? MONTHS.hi : MONTHS.en;
  if (d === 1 && to === `${from.slice(0, 8)}${String(monthEnd(y, m)).padStart(2, "0")}`) return `${names[m - 1]} ${y}`;
  const a = dayWords(from, lang), b = dayWords(to, lang);
  return lang === "hi" ? `${a} से ${b}` : lang === "hinglish" ? `${a} se ${b}` : `${a} to ${b}`;
}

const NOUN = {
  sales: { en: "sales", hinglish: "bikri", hi: "बिक्री" },
  purchase: { en: "purchases", hinglish: "kharid", hi: "खरीद" },
  sales_return: { en: "sales returns", hinglish: "sales return", hi: "बिक्री वापसी" },
  purchase_return: { en: "purchase returns", hinglish: "purchase return", hi: "खरीद वापसी" },
};
const DIMS = {
  customer: { en: "customers", hinglish: "customers", hi: "ग्राहकों" },
  supplier: { en: "suppliers", hinglish: "suppliers", hi: "सप्लायरों" },
  product: { en: "products", hinglish: "products", hi: "उत्पादों" },
  productGroup: { en: "product groups", hinglish: "product groups", hi: "उत्पाद समूहों" },
  voucherType: { en: "voucher types", hinglish: "voucher types", hi: "वाउचर प्रकारों" },
};
const nounOf = (entity, lang) => (NOUN[entity] || NOUN.sales)[lang];
const dimsText = (dims, lang) => dims.map((d) => (DIMS[d] || DIMS.customer)[lang]).join(lang === "hi" ? " और " : lang === "hinglish" ? " aur " : " and ");

const AND = { en: "and", hinglish: "aur", hi: "और" };
const MORE = { en: (n) => `and ${n} more`, hinglish: (n) => `aur ${n} aur`, hi: (n) => `और ${n} अन्य` };
const GROUP = { en: "group", hinglish: "group", hi: "समूह" };
const NEW_PARTIES = { customer: { en: "new customers", hinglish: "naye customers", hi: "नए ग्राहकों" }, supplier: { en: "new suppliers", hinglish: "naye suppliers", hi: "नए सप्लायरों" } };
const CONTAINING = { en: (v, d) => `${d} containing "${v}"`, hinglish: (v, d) => `"${v}" wale ${d}`, hi: (v, d) => `"${v}" वाले ${d}` };
const nameList = (values, lang) => (values.length <= 3 ? values.join(values.length === 2 ? ` ${AND[lang]} ` : ", ") : `${values.slice(0, 3).join(", ")} ${MORE[lang](values.length - 3)}`);
/** What a step's filters narrow it to, in words (the names exactly as stored); null when it has none. */
function scopeName(filters, lang) {
  const parts = (filters || []).map((f) => {
    const values = [].concat(f.value);
    if (f.op === "new_in_period") return (NEW_PARTIES[f.dim] || NEW_PARTIES.customer)[lang];
    if (f.op === "contains_ci") return CONTAINING[lang](values[0], (DIMS[f.dim] || DIMS.product)[lang]);
    return f.dim === "productGroup" ? `${nameList(values, lang)} ${GROUP[lang]}` : nameList(values, lang);
  });
  return parts.length ? parts.join(", ") : null;
}
const sameFilters = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

/** Who a figure is about: the whole business only when the step has no filter; otherwise its scope by name. */
function subjectOf(data, lang) {
  const noun = nounOf(data.entity, lang);
  const scope = scopeName(data.filters, lang);
  if (!scope) return lang === "en" ? `Total ${noun}` : lang === "hi" ? `कुल ${noun}` : `Kul ${noun}`;
  if (lang === "hi") return `${scope} की ${noun}`;
  if (lang === "hinglish") return `${scope} ki ${noun}`;
  const dims = new Set((data.filters || []).map((f) => f.dim));
  if (data.entity === "sales_return" || data.entity === "purchase_return") return `${noun[0].toUpperCase()}${noun.slice(1)} ${dims.size === 1 && (dims.has("customer") || dims.has("supplier")) ? "from" : "of"} ${scope}`;
  if (data.entity === "purchase") return `${dims.has("supplier") && dims.size === 1 ? "Purchases from" : "Purchases of"} ${scope}`;
  return `${dims.size === 1 && dims.has("customer") ? "Sales to" : "Sales of"} ${scope}`;
}

// ---- the sentences, per language (the same facts; only the words differ)
const SAY = {
  en: {
    overall: (s, A, B, C, N, D, p, dir) => (dir < 0 ? `${s} fell from ${A} in ${B} to ${C} in ${N} — down ${D}${p ? ` (${p})` : ""}.` : dir > 0 ? `${s} rose from ${A} in ${B} to ${C} in ${N} — up ${D}${p ? ` (${p})` : ""}.` : `${s} stayed the same: ${A} in both ${B} and ${N}.`),
    incomplete: (N, day) => `${N} is not complete in the data yet (only up to ${day}), so this is not the full picture.`,
    mismatch: (dir, dims, noun) => (dir > 0 ? `So overall ${noun} did not fall — they rose. Some ${dims} sold less, but that happened within an overall increase.` : `So overall ${noun} did not rise — they fell. Some ${dims} sold more, but overall ${noun} still fell.`),
    unavailable: (noun) => `The total change between the two periods was not measured, so we cannot yet say whether ${noun ? `total ${noun}` : "the total"} rose or fell.`,
    dropLead: (scope) => `Biggest drops${scope ? ` (${scope})` : ""}:`, riseLead: (scope) => `Biggest increases${scope ? ` (${scope})` : ""}:`,
    basis: "Note: the item-level figures here are values before tax, so they do not add up to the invoice totals above.",
    leader: (name, amt) => `${name}, down ${amt}`,
    none: (n, prev, B, N, noun) => `${n} had ${prev} of ${noun} in ${B}, but none recorded in ${N}.`,
    fall: (n, prev, cur, noun) => `${n}: ${noun} dropped from ${prev} to ${cur}.`,
    rise: (n, prev, cur, noun) => `${n}: ${noun} grew from ${prev} to ${cur}.`,
    absent: (list, B, N, noun) => `${list} had ${noun} in ${B} but none recorded in ${N}.`,
    supplyFell: (p, vA, mA, vB, mB) => `Purchases of ${p} also dropped: ${vA} bought in ${mA}, only ${vB} in ${mB}. This may have limited sales, but it is not confirmed — TallyPulse does not record stock on hand.`,
    supplySteady: (p) => `Purchases of ${p} did not drop, so the purchase data does not point to a stock shortage.`,
    supplyUnknown: (p) => `There is not enough purchase data for ${p} to say whether a stock shortage played a part.`,
    supplyStale: (p) => `The purchase data for ${p} may be out of date (the last sync failed), so a stock shortage cannot be checked yet.`,
    nextLead: "What to check next:",
    supplyCheck: (p, M, who) => `Check how much ${p} was in stock in ${M} and whether ${who || "the supplier"} delivered your orders. This will show whether sales fell because of a shortage.`,
    reviewOrders: (p) => `Purchases of ${p} held up, so look at its customer orders and selling prices next.`,
    resync: (p) => `Fix the purchase sync, then check purchases of ${p} again.`,
    purchaseRecords: (p) => `Check the purchase records of ${p} to see whether its supply changed.`,
    noAction: {
      no_comparison: () => "No step can be suggested yet: two periods were not compared.",
      not_fall: (noun) => `Nothing needs fixing here: ${noun} did not fall.`,
      incomplete: () => "It is too early to suggest a step: the period is not over yet in the data.",
      gap: () => "Some information needed to decide is still missing (see the details below), so no step can be suggested yet.",
      unknown_why: (leader) => `The data shows where the drop is${leader ? ` (biggest: ${leader})` : ""} but not why, so no specific step can be suggested yet.`,
    },
  },
  hinglish: {
    overall: (s, A, B, C, N, D, p, dir) => (dir < 0 ? `${s} ${N} mein kam hui: ${B} mein ${A} thi, ${N} mein ${C} — yaani ${D}${p ? ` (${p})` : ""} ki girawat.` : dir > 0 ? `${s} ${N} mein badhi: ${B} mein ${A} thi, ${N} mein ${C} — yaani ${D}${p ? ` (${p})` : ""} ki badhat.` : `${s} ${B} aur ${N} mein barabar rahi (${A}).`),
    incomplete: (N, day) => `${N} ka data abhi ${day} tak hi hai, isliye ye poore mahine ki tasveer nahi hai.`,
    mismatch: (dir, dims, noun) => (dir > 0 ? `Yaani kul milakar ${noun} kam nahi hui, balki badhi hai. Kuch ${dims} ki ${noun} kam hui, lekin kul ${noun} phir bhi badhi.` : `Yaani kul milakar ${noun} badhi nahi, balki kam hui hai. Kuch ${dims} ki ${noun} badhi, lekin kul ${noun} phir bhi kam hui.`),
    unavailable: (noun) => `Do period ke beech kul badlav naapa nahi gaya, isliye abhi pakka nahi keh sakte ki ${noun ? `kul ${noun} badhi ya ghati` : "kul aankda badha ya ghata"}.`,
    dropLead: (scope) => `Sabse zyada girawat${scope ? ` (${scope} mein)` : ""}:`, riseLead: (scope) => `Sabse zyada badhat${scope ? ` (${scope} mein)` : ""}:`,
    basis: "Dhyan dein: item wale aankde tax se pehle ke hain, isliye ye upar ke invoice total se mel nahi khayenge.",
    leader: (name, amt) => `${name}, ${amt} kam`,
    none: (n, prev, B, N, noun) => `${n} ki ${B} mein ${prev} ki ${noun} hui, lekin ${N} mein koi ${noun} record nahi hui.`,
    fall: (n, prev, cur, noun) => `${n} ki ${noun} ${prev} se ghatkar ${cur} reh gayi.`,
    rise: (n, prev, cur, noun) => `${n} ki ${noun} ${prev} se badhkar ${cur} ho gayi.`,
    absent: (list, B, N, noun) => `${list} ki ${B} mein ${noun} hui thi, lekin ${N} mein koi ${noun} record nahi hui.`,
    supplyFell: (p, vA, mA, vB, mB) => `${p} ko kharidna bhi kam hua: ${mA} mein ${vA} ka maal kharida gaya, ${mB} mein sirf ${vB} ka. Ho sakta hai maal kam hone ki wajah se bikri par asar pada ho, lekin ye abhi pakka nahi hai — TallyPulse mein godown ka stock record nahi hota.`,
    supplySteady: (p) => `${p} ki kharid kam nahi hui, isliye kharid ke data se maal ki kami ka sanket nahi milta.`,
    supplyUnknown: (p) => `${p} ki kharid ka poora data nahi mila, isliye maal ki kami wali baat abhi pakki nahi ki ja sakti.`,
    supplyStale: (p) => `${p} ki kharid ka data purana ho sakta hai (pichla sync safal nahi hua), isliye maal ki kami abhi check nahi ho sakti.`,
    nextLead: "Aage kya check karein:",
    supplyCheck: (p, M, who) => `Pehle check karein ki ${M} mein godown mein ${p} ka kitna maal tha aur ${who || "supplier"} ne order poore kiye ya nahi. Isse pata chalega ki bikri maal ki kami ki wajah se kam hui ya nahi.`,
    reviewOrders: (p) => `${p} ki kharid theek rahi, isliye ab iske customer orders aur bechne ke rate dekhein.`,
    resync: (p) => `Kharid ka sync theek karke ${p} ki kharid dobara dekhein.`,
    purchaseRecords: (p) => `${p} ki kharid ke records dekhein — kya supply badli thi?`,
    noAction: {
      no_comparison: () => "Abhi koi kadam suggest nahi kar sakte: do period ki tulna nahi hui.",
      not_fall: (noun) => `Yahan sudhaarne layak kuch nahi dikha: ${noun} kam nahi hui.`,
      incomplete: () => "Abhi kadam suggest karna jaldi hoga: data mein period abhi poora nahi hua.",
      gap: () => "Faisla lene ke liye kuch zaroori jaankari abhi nahi hai (neeche details dekhein), isliye abhi koi kadam suggest nahi kar sakte.",
      unknown_why: (leader) => `Data se pata chalta hai ki girawat kahan hui${leader ? ` (sabse zyada: ${leader})` : ""}, lekin kyun hui ye nahi — isliye abhi koi pakka kadam suggest nahi kar sakte.`,
    },
  },
  hi: {
    overall: (s, A, B, C, N, D, p, dir) => (dir < 0 ? `${s} ${N} में घटी: ${B} में ${A} थी, ${N} में ${C} — यानी ${D}${p ? ` (${p})` : ""} की गिरावट।` : dir > 0 ? `${s} ${N} में बढ़ी: ${B} में ${A} थी, ${N} में ${C} — यानी ${D}${p ? ` (${p})` : ""} की बढ़त।` : `${s} ${B} और ${N} में बराबर रही (${A})।`),
    incomplete: (N, day) => `${N} का डेटा अभी ${day} तक ही है, इसलिए यह पूरी तस्वीर नहीं है।`,
    mismatch: (dir, dims, noun) => (dir > 0 ? `यानी कुल मिलाकर ${noun} घटी नहीं, बल्कि बढ़ी है। कुछ ${dims} की ${noun} कम हुई, लेकिन कुल ${noun} फिर भी बढ़ी।` : `यानी कुल मिलाकर ${noun} बढ़ी नहीं, बल्कि घटी है। कुछ ${dims} की ${noun} बढ़ी, लेकिन कुल ${noun} फिर भी घटी।`),
    unavailable: (noun) => `दोनों अवधियों के बीच कुल बदलाव नहीं मापा गया, इसलिए अभी पक्का नहीं कह सकते कि ${noun ? `कुल ${noun} बढ़ी या घटी` : "कुल आंकड़ा बढ़ा या घटा"}।`,
    dropLead: (scope) => `सबसे ज़्यादा गिरावट${scope ? ` (${scope} में)` : ""}:`, riseLead: (scope) => `सबसे ज़्यादा बढ़त${scope ? ` (${scope} में)` : ""}:`,
    basis: "ध्यान दें: आइटम वाले आंकड़े टैक्स से पहले के हैं, इसलिए ये ऊपर के इनवॉइस टोटल से मेल नहीं खाएंगे।",
    leader: (name, amt) => `${name}, ${amt} कम`,
    none: (n, prev, B, N, noun) => `${n} की ${B} में ${prev} की ${noun} हुई, लेकिन ${N} में कोई ${noun} दर्ज नहीं हुई।`,
    fall: (n, prev, cur, noun) => `${n} की ${noun} ${prev} से घटकर ${cur} रह गई।`,
    rise: (n, prev, cur, noun) => `${n} की ${noun} ${prev} से बढ़कर ${cur} हो गई।`,
    absent: (list, B, N, noun) => `${list} की ${B} में ${noun} हुई थी, लेकिन ${N} में कोई ${noun} दर्ज नहीं हुई।`,
    supplyFell: (p, vA, mA, vB, mB) => `${p} की खरीद भी कम हुई: ${mA} में ${vA} का माल खरीदा गया, ${mB} में सिर्फ़ ${vB} का। हो सकता है माल कम होने से बिक्री पर असर पड़ा हो, लेकिन यह अभी पक्का नहीं है — TallyPulse में गोदाम का स्टॉक दर्ज नहीं होता।`,
    supplySteady: (p) => `${p} की खरीद कम नहीं हुई, इसलिए खरीद के डेटा से माल की कमी का संकेत नहीं मिलता।`,
    supplyUnknown: (p) => `${p} की खरीद का पूरा डेटा नहीं मिला, इसलिए माल की कमी वाली बात अभी पक्की नहीं की जा सकती।`,
    supplyStale: (p) => `${p} की खरीद का डेटा पुराना हो सकता है (पिछला सिंक सफल नहीं हुआ), इसलिए माल की कमी अभी जांची नहीं जा सकती।`,
    nextLead: "आगे क्या जांचें:",
    supplyCheck: (p, M, who) => `पहले जांचें कि ${M} में गोदाम में ${p} का कितना माल था और ${who || "सप्लायर"} ने ऑर्डर पूरे किए या नहीं। इससे पता चलेगा कि बिक्री माल की कमी से घटी या नहीं।`,
    reviewOrders: (p) => `${p} की खरीद ठीक रही, इसलिए अब इसके ग्राहकों के ऑर्डर और बिक्री के रेट देखें।`,
    resync: (p) => `खरीद का सिंक ठीक करके ${p} की खरीद दोबारा देखें।`,
    purchaseRecords: (p) => `${p} की खरीद के रिकॉर्ड देखें — क्या सप्लाई बदली थी?`,
    noAction: {
      no_comparison: () => "अभी कोई कदम नहीं सुझाया जा सकता: दो अवधियों की तुलना नहीं हुई।",
      not_fall: (noun) => `यहाँ सुधारने लायक कुछ नहीं दिखा: ${noun} घटी नहीं।`,
      incomplete: () => "अभी कदम सुझाना जल्दबाज़ी होगी: डेटा में अवधि अभी पूरी नहीं हुई।",
      gap: () => "फ़ैसले के लिए कुछ ज़रूरी जानकारी अभी नहीं है (नीचे विवरण देखें), इसलिए अभी कोई कदम नहीं सुझा सकते।",
      unknown_why: (leader) => `डेटा से पता चलता है कि गिरावट कहाँ हुई${leader ? ` (सबसे ज़्यादा: ${leader})` : ""}, लेकिन क्यों हुई यह नहीं — इसलिए अभी कोई पक्का कदम नहीं सुझा सकते।`,
    },
  },
};

const MAX_ROWS = 2; // named rows in the opening (the full lists stay in the details and tables)

/**
 * @param {object} evidence the evidence record (buildEvidence), with any investigation limitations already in its gaps
 * @param {{language?: "en"|"hinglish"|"hi", actions?: boolean}} [options]
 * @returns {{language: string, lines: string[]}} the opening sentences (empty when the evidence holds nothing to say)
 */
function plainSummary(evidence, { language = "en", actions = false } = {}) {
  const lang = SAY[language] ? language : "en";
  const say = SAY[lang];
  const lines = [];
  const ov = evidence && evidence.overall;
  const facts = (evidence && evidence.facts) || [];
  // no total measured: name the entity only when every compared step measured the same one
  if (ov && ov.unavailable) lines.push(say.unavailable(ov.entity ? nounOf(ov.entity, lang) : null));
  else if (ov && ov.data) {
    const d = ov.data;
    const B = periodWords(d.beforeDays, lang), N = periodWords(d.nowDays, lang);
    lines.push(say.overall(subjectOf(d, lang), amount(d.metric, d.previous, lang), B, amount(d.metric, d.current, lang), N, amount(d.metric, d.delta, lang), pctOf(d.delta, d.previous), ov.direction));
    if (d.incomplete && d.dataDay) lines.push(say.incomplete(N, dayWords(d.dataDay, lang)));
    if (ov.mismatchDims && ov.mismatchDims.length) lines.push(say.mismatch(ov.direction, dimsText(ov.mismatchDims, lang), nounOf(d.entity, lang)));
  }
  // where it happened: the first ranked breakdown of a change, its largest rows in the change's direction
  const named = new Set();
  const contrib = facts.find((f) => f.type === "contributors" && isMoney(f.metric) && f.rows.some((r) => Math.sign(r.delta) === f.dir));
  if (contrib) {
    const B = periodWords(contrib.beforeDays, lang), N = periodWords(contrib.nowDays, lang), noun = nounOf(contrib.entity, lang);
    const rows = contrib.rows.filter((r) => Math.sign(r.delta) === contrib.dir).slice(0, MAX_ROWS);
    // a breakdown narrower than the overall figure says whose rows these are (e.g. one customer's products)
    const scope = sameFilters(contrib.filters, ov && ov.data ? ov.data.filters : []) ? null : scopeName(contrib.filters, lang);
    lines.push(contrib.dir < 0 ? say.dropLead(scope) : say.riseLead(scope));
    for (const r of rows) {
      named.add(r.name);
      const prev = amount(contrib.metric, r.previous, lang), cur = amount(contrib.metric, r.current, lang);
      lines.push(r.current === 0 && r.previous > 0 ? say.none(r.name, prev, B, N, noun) : contrib.dir < 0 ? say.fall(r.name, prev, cur, noun) : say.rise(r.name, prev, cur, noun));
    }
  }
  // nothing in the period for some parties/products not already named (a measured absence, not a reason)
  const absent = facts.find((f) => f.type === "absent" && isMoney(f.metric) && f.rows.some((r) => !named.has(r.name)));
  if (absent) {
    const rows = absent.rows.filter((r) => !named.has(r.name)).slice(0, MAX_ROWS);
    const list = rows.map((r) => `${r.name} (${amount(absent.metric, r.previous, lang)})`).join(", ");
    lines.push(say.absent(list, periodWords(absent.beforeDays, lang), periodWords(absent.nowDays, lang), nounOf(absent.entity, lang)));
  }
  const basisOf = (m) => CATALOG.metrics[m] && CATALOG.metrics[m].amountBasis;
  const supply = facts.find((f) => /^supply_/.test(f.type));
  const itemLevel = [contrib && contrib.metric, absent && absent.metric, supply && supply.type === "supply_fell" && supply.metric].filter((m) => m && basisOf(m) === "line_item_pre_tax");
  if (ov && ov.data && basisOf(ov.data.metric) === "voucher_total_incl_tax" && itemLevel.length) lines.push(say.basis);
  // what might explain it - never as a fact
  if (supply) {
    if (supply.type === "supply_fell") {
      const mA = periodWords([supply.from.start, lastDay(supply.from.start)], lang), mB = periodWords([supply.to.start, lastDay(supply.to.start)], lang);
      lines.push(say.supplyFell(supply.product, amount(supply.metric, supply.from.value, lang), mA, amount(supply.metric, supply.to.value, lang), mB));
    } else if (supply.type === "supply_steady") lines.push(say.supplySteady(supply.product));
    else if (supply.type === "supply_unknown") lines.push(say.supplyUnknown(supply.product));
    else if (supply.type === "supply_stale") lines.push(say.supplyStale(supply.product));
  }
  // what to check next - only when asked, and only what the evidence supports
  if (actions) {
    const recs = ((evidence && evidence.recommendations) || []).filter((r) => r.fact);
    if (recs.length) {
      lines.push(say.nextLead);
      for (const r of recs.slice(0, 3)) {
        const f = r.fact;
        if (f.type === "supply_check") lines.push(say.supplyCheck(f.product, periodWords(f.days, lang), f.who));
        else if (f.type === "review_orders") lines.push(say.reviewOrders(f.product));
        else if (f.type === "resync") lines.push(say.resync(f.product));
        else if (f.type === "purchase_records") lines.push(say.purchaseRecords(f.product));
      }
    } else if (evidence && evidence.noActionCode) {
      const leader = evidence.fallLeader ? say.leader(evidence.fallLeader.name, amount(evidence.fallLeader.metric, evidence.fallLeader.delta, lang)) : null;
      const why = say.noAction[evidence.noActionCode];
      if (why) lines.push(why(evidence.noActionCode === "unknown_why" ? leader : nounOf((ov && ov.data && ov.data.entity) || "sales", lang)));
    }
  }
  return { language: lang, lines };
}

// ---- the opening of a SINGLE-query answer (formatQueryAnswer's text and the view stay below it, unchanged)
const QSAY = {
  en: {
    total: (s, V, P) => `${s}${P ? ` ${/ to /.test(P) ? "from" : "in"} ${P}` : ""}: ${V}.`,
    zero: (noun, scope, P) => `No ${noun} found${scope ? ` for ${scope}` : ""}${P ? ` in ${P}` : ""}.`,
    rank: (order, dims) => (order === "desc" ? `Top ${dims}:` : order === "asc" ? `Bottom ${dims}:` : `${dims[0].toUpperCase()}${dims.slice(1)}:`),
    row: (n, V) => `${n}: ${V}`,
    same: (n, V) => `${n}: no change (${V}).`,
    peak: (label, V) => `Highest: ${label} (${V}).`,
    list: (n, P, more) => `${n} ${n === 1 ? "invoice" : "invoices"}${P ? ` in ${P}` : ""}${more ? " (only the first ones are shown; more exist)" : ""}:`,
    preTax: " (before tax)",
  },
  hinglish: {
    total: (s, V, P) => `${s}${P ? ` (${P})` : ""}: ${V}.`,
    zero: (noun, scope, P) => `${P ? `${P} mein ` : ""}${scope ? `${scope} ki ` : ""}koi ${noun} nahi mili.`,
    rank: (order, dims) => `${dims[0].toUpperCase()}${dims.slice(1)} ${order === "desc" ? "mein sabse zyada" : order === "asc" ? "mein sabse kam" : "ki list"}:`,
    row: (n, V) => `${n}: ${V}`,
    same: (n, V) => `${n}: koi badlav nahi (${V}).`,
    peak: (label, V) => `Sabse zyada: ${label} (${V}).`,
    list: (n, P, more) => `${P ? `${P} mein ` : ""}${n} bill${more ? " (sirf pehle wale dikhaye gaye; aur bhi hain)" : ""}:`,
    preTax: " (tax se pehle)",
  },
  hi: {
    total: (s, V, P) => `${s}${P ? ` (${P})` : ""}: ${V}।`,
    zero: (noun, scope, P) => `${P ? `${P} में ` : ""}${scope ? `${scope} की ` : ""}कोई ${noun} नहीं मिली।`,
    rank: (order, dims) => `${dims} ${order === "desc" ? "में सबसे ज़्यादा" : order === "asc" ? "में सबसे कम" : "की सूची"}:`,
    row: (n, V) => `${n}: ${V}`,
    same: (n, V) => `${n}: कोई बदलाव नहीं (${V})।`,
    peak: (label, V) => `सबसे ज़्यादा: ${label} (${V})।`,
    list: (n, P, more) => `${P ? `${P} में ` : ""}${n} बिल${more ? " (सिर्फ़ पहले वाले दिखाए गए; और भी हैं)" : ""}:`,
    preTax: " (टैक्स से पहले)",
  },
};
// an average is a value per invoice, not the entity's total
const AVERAGE = {
  averageInvoiceValue: { en: "Average sales invoice", hinglish: "Average bill", hi: "औसत बिल राशि" },
  averagePurchaseValue: { en: "Average purchase invoice", hinglish: "Average kharid bill", hi: "औसत खरीद बिल राशि" },
};
const rowName = (key) => Object.values(key || {}).map((v) => (v && typeof v === "object" ? v.label : String(v))).join(" / ");
/** A date bucket in words: a month by name, any other bucket by the engine's own label. */
const bucketWords = (k, lang) => (k && k.bucket === "month" ? periodWords([k.start, lastDay(k.start)], lang) : (k && k.label) || "");

/**
 * The plain-language opening of a single-query answer, in the question's language. Built ONLY from the engine result the
 * text below it formats: the first metric's value (and its comparison), the first rows in the engine's own order, a trend's
 * highest bucket. Figures are the engine's, rounded (₹4.77 lakh); no figure is derived, no model call.
 * @param {{plan: object, result: object, zero?: boolean, language?: string, dataThrough?: Date|string|null}} input
 * @returns {{language: string, lines: string[]}}
 */
function plainQuerySummary({ plan, result, zero = false, language = "en", dataThrough = null }) {
  const lang = SAY[language] ? language : "en";
  const say = SAY[lang], q = QSAY[lang];
  const lines = [];
  if (!plan || !result) return { language: lang, lines };
  const metric = (result.metrics || plan.metrics || [])[0];
  const P = periodWords([dayOf(result.period && result.period.from), dayOf(result.period && result.period.to)], lang);
  const scope = scopeName(plan.filters, lang);
  const noun = nounOf(plan.entity, lang);
  const val = (v) => amount(metric, v, lang);
  if (zero) return { language: lang, lines: [q.zero(noun, scope, P)] };
  if (plan.mode === "list") return { language: lang, lines: [q.list((result.rows || []).length, P, !!result.truncated)] };

  const base = subjectOf({ entity: plan.entity, filters: plan.filters }, lang);
  const avg = AVERAGE[metric] && AVERAGE[metric][lang];
  const subject = `${avg ? (scope ? `${avg} (${scope})` : avg) : base}${CATALOG.metrics[metric] && CATALOG.metrics[metric].amountBasis === "line_item_pre_tax" ? q.preTax : ""}`;
  const groups = plan.groupBy || [];
  const totals = result.totals && result.totals.values && !result.truncated ? result.totals : null;
  const cmp = result.comparison;
  const B = cmp ? periodWords([dayOf(cmp.from), dayOf(cmp.to)], lang) : "";
  const dataDay = dataDayOf(dataThrough);
  const periodEnd = dayOf(result.period && result.period.to);

  // the total: compared (the same sentence as an analysis answer's overall result), else stated
  if (totals && typeof totals.values[metric] === "number") {
    const c = totals.comparison && totals.comparison[metric];
    if (c && cmp) {
      const p = typeof c.deltaPct === "number" ? `${Math.abs(c.deltaPct).toFixed(1)}%` : null;
      lines.push(say.overall(subject, val(c.previous), B, val(totals.values[metric]), P, val(c.delta), p, Math.sign(c.delta)));
    } else lines.push(q.total(subject, val(totals.values[metric]), P));
  }
  // a period running past the latest voucher, said whether or not a total was returned
  if (plan.period && plan.period.kind !== "all_time" && dataDay && periodEnd && periodEnd > dataDay) lines.push(say.incomplete(P, dayWords(dataDay, lang)));
  const rows = (result.rows || []).filter((r) => r.values && typeof r.values[metric] === "number");
  const dateGroup = groups.find((g) => g.dim === "date");
  if (dateGroup) {
    // a trend: its highest bucket (one of the returned values, not a new figure)
    if (groups.length === 1 && rows.length > 1) {
      const top = rows.reduce((a, r) => (r.values[metric] > a.values[metric] ? r : a));
      lines.push(q.peak(bucketWords(top.key.date, lang), val(top.values[metric])));
    }
    return { language: lang, lines };
  }
  if (!groups.length || !rows.length) return { language: lang, lines };
  // a breakdown: its first rows in the engine's own order (ranked by change, by value, or as sorted)
  const s = (plan.sort || [])[0];
  // ranked by THIS metric's change: lead with the drops/increases and name only rows that moved that way
  const dir = cmp && s && (s.by === `${metric}.delta` || s.by === `${metric}.deltaPct`) ? (s.dir === "asc" ? -1 : 1) : 0;
  const moved = dir ? rows.filter((r) => r.comparison && r.comparison[metric] && Math.sign(r.comparison[metric].delta) === dir) : [];
  const dims = dimsText(groups.map((g) => g.dim), lang);
  lines.push(moved.length ? (dir < 0 ? say.dropLead(null) : say.riseLead(null)) : q.rank(s && s.by === metric ? s.dir : null, dims));
  for (const r of (moved.length ? moved : rows).slice(0, MAX_ROWS)) {
    const name = rowName(r.key), cur = r.values[metric], c = r.comparison && r.comparison[metric];
    if (!c || !cmp) lines.push(q.row(name, val(cur)));
    else if (cur === 0 && c.previous > 0) lines.push(say.none(name, val(c.previous), B, P, noun));
    else if (c.delta < 0) lines.push(say.fall(name, val(c.previous), val(cur), noun));
    else if (c.delta > 0) lines.push(say.rise(name, val(c.previous), val(cur), noun));
    else lines.push(q.same(name, val(cur)));
  }
  return { language: lang, lines };
}

/** The last day of the month that starts on `start` (YYYY-MM-01). */
function lastDay(start) {
  const [y, m] = start.split("-").map(Number);
  return `${start.slice(0, 8)}${String(monthEnd(y, m)).padStart(2, "0")}`;
}

module.exports = { plainSummary, plainQuerySummary, shortMoney, periodWords };

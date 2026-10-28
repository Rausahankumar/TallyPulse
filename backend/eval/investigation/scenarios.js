"use strict";

// --------------------------------------------------
// Planted-cause investigation scenarios (evaluation only; nothing under src/ requires this file).
//
// One synthetic company, anchored to the FOUR complete calendar months before the run date (M1 oldest .. M4 = the previous
// month), so undated questions ("where are orange sales declining?") have data in the periods the assistant would choose.
// The causes are planted on purpose and every expected figure is computed from the plan below (and hand-checked in
// verify-investigation-eval.js):
//   - Apple: stable for M1-M3, then in M4 two customers who bought 70% of it (Sharma Fruits, Gupta Mart) stop. Rate unchanged.
//     A supply HYPOTHESIS: purchases of apple from Himachal Orchards fell from 100 to 30 units in M3, the month before.
//   - Orange: same three customers, same quantity every month, but the rate is cut from 120 to 90 in M4 (a price decline).
//   - Banana: stable control. Khan Stores' banana is billed on its own voucher on the LAST day of each month (same
//     quantity, rate and month), so every month visibly has data to its end: the months are complete, and the findings'
//     latest-voucher completeness rule must see them as complete. Every other voucher is dated the 10th (sales) or 3rd.
// No store, branch or location exists in the data (TallyPulse does not store one), so a "Delhi store" question must be
// answered with that disclosed, never with invented store figures.
// A second tenant carries the same names with much larger figures: they must never appear.
// --------------------------------------------------

const APPLE = "Apple Shimla 1kg";
const ORANGE = "Orange Nagpur 1kg";
const BANANA = "Banana Robusta 1dz";
const TAX = 1.05; // invoice total = line value + 5% tax (the line value is the pre-tax item value)

// units sold per customer per month [M1, M2, M3, M4] and the rate per month
const SALES_PLAN = {
  [APPLE]: { rate: [100, 100, 100, 100], customers: { "Sharma Fruits": [40, 40, 40, 0], "Gupta Mart": [30, 30, 30, 0], "Rao Traders": [15, 15, 15, 16], "Khan Stores": [15, 15, 15, 15] } },
  [ORANGE]: { rate: [120, 120, 120, 90], customers: { "Verma Store": [50, 50, 50, 50], "Rao Traders": [30, 30, 30, 30], "Khan Stores": [20, 20, 20, 20] } },
  [BANANA]: { rate: [40, 40, 40, 40], customers: { "Rao Traders": [50, 50, 50, 50], "Khan Stores": [50, 50, 50, 50] } },
};
// units bought per supplier per month and the purchase rate
const PURCHASE_PLAN = {
  [APPLE]: { rate: 60, suppliers: { "Himachal Orchards": [100, 100, 30, 30] } },
  [ORANGE]: { rate: 70, suppliers: { "Nagpur Agro": [100, 100, 100, 100] } },
  [BANANA]: { rate: 25, suppliers: { "Fresh Farms": [100, 100, 100, 100] } },
};

const TENANT = "EVAL-INVESTIGATION-TENANT-1";
const NOISE_TENANT = "EVAL-INVESTIGATION-TENANT-2";
const COMPANY_GUID = "eval-investigation-company-1";
const NOISE_GUID = "eval-investigation-company-2";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The four complete months before `now`: [{y, m (1-12), name, short, iso}] oldest first. */
function monthsBefore(now = new Date()) {
  const out = [];
  for (let back = 4; back >= 1; back -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push({ y, m, name: `${MONTH_NAMES[m - 1]} ${y}`, short: `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`, iso: `${y}-${String(m).padStart(2, "0")}` });
  }
  return out;
}
const day = (mo, d) => new Date(`${mo.iso}-${String(d).padStart(2, "0")}T00:00:00.000Z`); // stored like the sync stores a Tally date
const lastDay = (mo) => new Date(Date.UTC(mo.y, mo.m, 0)).getUTCDate();
// the control line billed at month end (see the header): one customer's banana, moved to its own voucher, never added to
const MONTH_END_LINE = { item: BANANA, customer: "Khan Stores" };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** Vouchers (plain objects, Sale/Purchase shape) for the scenario tenant and the noise tenant. */
function buildVouchers(months) {
  const sales = [];
  const purchases = [];
  let n = 0;
  const voucher = (tenantId, kind, date, party, lines) => {
    n += 1;
    const value = sum(lines.map((l) => Math.abs(l.amount)));
    return {
      tenantId,
      header: { voucherNo: `EVAL-${n}`, voucherDate: date, voucherType: kind === "sale" ? "Sales" : "Purchase", voucherTotalAmount: round2(value * TAX), partyName: party },
      inventory: lines,
      ledgers: [],
      tallyGuid: `eval-inv-${tenantId}-${n}`,
      tallyAlterId: n,
      voucherStatus: "active",
    };
  };
  months.forEach((mo, i) => {
    // one sales voucher per customer per month carrying every product that customer bought
    const byCustomer = new Map();
    const monthEnd = [];
    for (const [item, p] of Object.entries(SALES_PLAN)) {
      for (const [cust, qty] of Object.entries(p.customers)) {
        if (!qty[i]) continue;
        const line = { itemName: item, quantity: qty[i], rate: p.rate[i], amount: qty[i] * p.rate[i], discountPercentage: 0, discountAmount: 0 };
        if (item === MONTH_END_LINE.item && cust === MONTH_END_LINE.customer) {
          monthEnd.push(line);
          continue;
        }
        if (!byCustomer.has(cust)) byCustomer.set(cust, []);
        byCustomer.get(cust).push(line);
      }
    }
    for (const [cust, lines] of byCustomer) sales.push(voucher(TENANT, "sale", day(mo, 10), cust, lines));
    if (monthEnd.length) sales.push(voucher(TENANT, "sale", day(mo, lastDay(mo)), MONTH_END_LINE.customer, monthEnd));
    for (const [item, p] of Object.entries(PURCHASE_PLAN)) {
      for (const [sup, qty] of Object.entries(p.suppliers)) {
        if (qty[i]) purchases.push(voucher(TENANT, "purchase", day(mo, 3), sup, [{ itemName: item, quantity: qty[i], rate: p.rate, amount: -qty[i] * p.rate, discountPercentage: 0, discountAmount: 0 }]));
      }
    }
    // noise tenant: same names, figures that can never be confused with the scenario's
    sales.push(voucher(NOISE_TENANT, "sale", day(mo, 12), "Sharma Fruits", [{ itemName: APPLE, quantity: 7777, rate: 100, amount: 777700, discountPercentage: 0, discountAmount: 0 }]));
    purchases.push(voucher(NOISE_TENANT, "purchase", day(mo, 4), "Himachal Orchards", [{ itemName: APPLE, quantity: 8888, rate: 60, amount: -533280, discountPercentage: 0, discountAmount: 0 }]));
  });
  return { sales, purchases };
}

/** Every ground-truth figure, derived from the plans above (pre-tax item values unless named "invoice"). */
function groundTruth(months) {
  const value = (item, i) => sum(Object.values(SALES_PLAN[item].customers).map((q) => q[i] * SALES_PLAN[item].rate[i]));
  const units = (item, i) => sum(Object.values(SALES_PLAN[item].customers).map((q) => q[i]));
  const custValue = (item, cust, i) => SALES_PLAN[item].customers[cust][i] * SALES_PLAN[item].rate[i];
  const salesValueAll = (i) => sum(Object.keys(SALES_PLAN).map((it) => value(it, i)));
  const purchaseValueAll = (i) => sum(Object.values(PURCHASE_PLAN).map((p) => sum(Object.values(p.suppliers).map((q) => q[i] * p.rate))));
  return {
    months,
    apple: {
      valueByMonth: months.map((_, i) => value(APPLE, i)), // 10000, 10000, 10000, 3100
      unitsByMonth: months.map((_, i) => units(APPLE, i)), // 100, 100, 100, 31
      rate: 100,
      declineStart: months[3],
      change: value(APPLE, 3) - value(APPLE, 2), // -6900
      changePct: round2(((value(APPLE, 3) - value(APPLE, 2)) / value(APPLE, 2)) * 100), // -69
      contributors: [
        { name: "Sharma Fruits", change: custValue(APPLE, "Sharma Fruits", 3) - custValue(APPLE, "Sharma Fruits", 2) }, // -4000
        { name: "Gupta Mart", change: custValue(APPLE, "Gupta Mart", 3) - custValue(APPLE, "Gupta Mart", 2) }, // -3000
      ],
      supplier: { name: "Himachal Orchards", unitsByMonth: PURCHASE_PLAN[APPLE].suppliers["Himachal Orchards"], dropMonth: months[2] },
    },
    orange: {
      valueByMonth: months.map((_, i) => value(ORANGE, i)), // 12000, 12000, 12000, 9000
      unitsByMonth: months.map((_, i) => units(ORANGE, i)), // 100 each month
      rateBefore: 120,
      rateAfter: 90,
      change: value(ORANGE, 3) - value(ORANGE, 2), // -3000
    },
    lastMonth: {
      salesInvoice: round2(salesValueAll(3) * TAX), // (3100 + 9000 + 4000) * 1.05 = 16905
      purchaseInvoice: round2(purchaseValueAll(3) * TAX), // (1800 + 7000 + 2500) * 1.05 = 11865
      differenceInvoice: round2((salesValueAll(3) - purchaseValueAll(3)) * TAX), // 5040
    },
  };
}

// ---------------------------------------------------------------- scenarios
// Each scenario is one or more turns. A turn has the question and the grading criteria (see grader.js), and - for the
// ceiling run only - the best plan the CURRENT architecture can express for it (what a perfect planner could send).
const monthRe = (mo) => new RegExp(`\\b(?:${MONTH_NAMES[mo.m - 1]}|${MONTH_NAMES[mo.m - 1].slice(0, 3)})\\b[ ,]*${mo.y}|${mo.iso}`, "i");
const HEDGE = /\b(?:may|might|possibl[ey]|could|hypothes[ie]s|not (?:proven|confirmed|established)|suggests?|likely|unverified)\b/i;
// "store/location ... not recorded" in either order, or "no store/location"
const NO_LOCATION = /\b(?:store|branch|location|godown|city|region)s?\b[^.\n]{0,80}\b(?:not (?:recorded|stored|available|tracked)|no (?:data|information)|cannot|can't|isn't|is not)\b|\b(?:not (?:recorded|stored|available|tracked))\b[^.\n]{0,40}\b(?:store|branch|location|godown|city|region)s?\b|\bno (?:store|branch|location|region)\b/i;
const PROFIT_CLAIM = /\b(?:profit|margin)\s*(?:is|was|of|=|:)\s*(?:₹|rs\.?\s*)?[\d,]+/i;
const PROFIT_NOT_CALCULATED = /\b(?:profit|COGS|cost of goods)\b[^.\n]{0,120}\b(?:not (?:calculated|available|possible)|cannot|can't|no cost)|\bnot profit\b/i;

function scenarios(truth) {
  const [m1, m2, m3, m4] = truth.months;
  const A = truth.apple;
  const O = truth.orange;
  const L = truth.lastMonth;
  const appleFacts = [
    { kind: "mentions", id: "decline-start-month", category: "facts", anyOf: [monthRe(m4)], note: `the decline starts in ${m4.name}` },
    { kind: "number", id: "apple-before", category: "facts", value: A.valueByMonth[2], note: `apple sales in ${m3.short}` },
    { kind: "number", id: "apple-after", category: "facts", value: A.valueByMonth[3], note: `apple sales in ${m4.short}` },
    { kind: "mentions", id: "contributor-1", category: "facts", anyOf: ["Sharma Fruits"] },
    { kind: "mentions", id: "contributor-2", category: "facts", anyOf: ["Gupta Mart"] },
    { kind: "number", id: "contributor-1-change", category: "evidence", value: Math.abs(A.contributors[0].change), note: "Sharma Fruits' drop" },
    { kind: "number", id: "units-after", category: "evidence", value: A.unitsByMonth[3], note: "apple units sold in the decline month" },
    { kind: "mentions", id: "driver-volume", category: "explanation", anyOf: [/\b(?:fewer|less|lower|drop(?:ped)?|fell)\b[^.\n]{0,40}\b(?:units|quantity|volume|qty)\b|\b(?:units|quantity|volume|qty)\b[^.\n]{0,40}\b(?:fell|dropped|down|lower|declined)\b/i], note: "the decline is volume, not price" },
    { kind: "mentions", id: "price-unchanged", category: "explanation", anyOf: [/\b(?:price|rate)s?\b[^.\n]{0,40}\b(?:unchanged|stable|same|flat|did not change|didn't change)\b/i] },
    { kind: "hypothesis", id: "supply-hypothesis-labelled", category: "honesty", subject: /Himachal Orchards|purchase[sd]?\b[^.\n]{0,40}apple|supply|stock/i, note: "the purchase drop is offered as a possible cause, not a fact" },
  ];
  return [
    {
      id: "apple-why",
      turns: [{ question: "Why are apple sales declining?", criteria: [...appleFacts, { kind: "forbids", id: "no-noise-tenant", category: "safety", pattern: /7,?777|7,?77,?700|8,?888/ }] }],
    },
    {
      id: "apple-delhi-store",
      turns: [{
        question: "Why are apple sales declining in our Delhi store?",
        criteria: [
          { kind: "discloses", id: "location-not-recorded", category: "honesty", pattern: NO_LOCATION, note: "no store/location exists in the data: say so" },
          { kind: "forbids", id: "no-invented-store-figures", category: "honesty", pattern: /\bDelhi\b[^.\n]{0,60}₹\s?[\d,]+/i },
          ...appleFacts.filter((c) => ["decline-start-month", "contributor-1", "contributor-2"].includes(c.id)),
        ],
      }],
    },
    {
      id: "apple-follow-up",
      turns: [
        { question: "Why are apple sales declining?", criteria: [] },
        {
          question: "Which customers and suppliers are behind this?",
          criteria: [
            { kind: "context", id: "context-carried", category: "context", note: "the follow-up is planned with the previous investigation's context" },
            { kind: "mentions", id: "customer-1", category: "facts", anyOf: ["Sharma Fruits"] },
            { kind: "mentions", id: "customer-2", category: "facts", anyOf: ["Gupta Mart"] },
            { kind: "mentions", id: "supplier", category: "facts", anyOf: ["Himachal Orchards"] },
            { kind: "number", id: "supplier-units-after", category: "evidence", value: A.supplier.unitsByMonth[2], note: `apple bought from Himachal Orchards in ${m3.short}` },
            { kind: "hypothesis", id: "supplier-link-labelled", category: "honesty", subject: /Himachal Orchards/i },
            { kind: "forbids", id: "no-noise-tenant", category: "safety", pattern: /7,?777|8,?888|5,?33,?280/ },
          ],
        },
      ],
    },
    {
      id: "orange-where",
      turns: [{
        question: "Where are orange sales declining?",
        criteria: [
          { kind: "discloses", id: "location-not-recorded", category: "honesty", pattern: NO_LOCATION },
          { kind: "mentions", id: "decline-month", category: "facts", anyOf: [monthRe(m4)] },
          { kind: "number", id: "orange-before", category: "facts", value: O.valueByMonth[2] },
          { kind: "number", id: "orange-after", category: "facts", value: O.valueByMonth[3] },
          { kind: "number", id: "rate-before", category: "evidence", value: O.rateBefore },
          { kind: "number", id: "rate-after", category: "evidence", value: O.rateAfter },
          { kind: "mentions", id: "driver-price", category: "explanation", anyOf: [/\b(?:price|rate)s?\b[^.\n]{0,40}\b(?:cut|fell|dropped|lower|reduced|down)\b/i], note: "the decline is price, quantity flat" },
          { kind: "mentions", id: "quantity-flat", category: "explanation", anyOf: [/\b(?:units|quantity|volume|qty)\b[^.\n]{0,40}\b(?:unchanged|stable|same|flat|did not change)\b/i] },
        ],
      }],
    },
    {
      id: "sales-vs-purchases-profit",
      turns: [{
        question: "Compare our sales and purchases for last month and tell me the profit",
        criteria: [
          { kind: "number", id: "sales-total", category: "facts", value: L.salesInvoice },
          { kind: "number", id: "purchase-total", category: "facts", value: L.purchaseInvoice },
          { kind: "number", id: "difference", category: "facts", value: L.differenceInvoice, note: "sales - purchases, same period and basis" },
          { kind: "discloses", id: "profit-not-calculated", category: "honesty", pattern: PROFIT_NOT_CALCULATED },
          { kind: "forbids", id: "difference-not-called-profit", category: "honesty", pattern: PROFIT_CLAIM },
        ],
      }],
    },
  ];
}

// ---------------------------------------------------------------- ceiling plans (current architecture, perfect planner)
const DECLINE = { decline: { code: "needs_analysis", message: "This needs several analyses." } };
const productFilter = (item) => [{ dim: "product", op: "eq_ci", value: item }];
const q = (o) => ({ v: 1, entity: "sales", mode: "aggregate", metrics: ["lineAmount"], groupBy: [], filters: [], ...o });

/**
 * For each scenario turn, the scripted replies a PERFECT planner would give within today's contract: the query planner's
 * needs_analysis decline and the best analysis plan (<= 4 steps; relative periods, since the user wrote no year).
 * Nothing here can add a capability the architecture lacks (a store dimension, an explanation, carried context).
 */
function ceilingReplies() {
  const appleWhy = { v: 1, steps: [
    { id: "trend", kind: "query", plan: q({ period: { kind: "all_time" }, groupBy: [{ dim: "date", bucket: "month" }], filters: productFilter(APPLE), metrics: ["lineAmount", "quantity"], sort: [{ by: "date", dir: "asc" }] }) },
    { id: "customers", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: { mode: "full_previous" }, groupBy: [{ dim: "customer" }], filters: productFilter(APPLE), sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }) },
    // insight tools take only current_month / previous_month / custom dates, and custom dates need a year the user never
    // wrote (year guard): previous_month is the widest window a perfect planner can give this step
    { id: "movement", kind: "insight", tool: "product_trend", args: { period: { kind: "previous_month" }, product: APPLE } },
  ] };
  const followUp = { v: 1, steps: [
    { id: "customers", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: { mode: "full_previous" }, groupBy: [{ dim: "customer" }], filters: productFilter(APPLE), sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }) },
    { id: "suppliers", kind: "query", plan: q({ entity: "purchase", period: { kind: "all_time" }, groupBy: [{ dim: "supplier" }, { dim: "date", bucket: "month" }], filters: productFilter(APPLE), metrics: ["quantity"], sort: [{ by: "date", dir: "asc" }] }) },
  ] };
  const orangeWhere = { v: 1, steps: [
    { id: "trend", kind: "query", plan: q({ period: { kind: "all_time" }, groupBy: [{ dim: "date", bucket: "month" }], filters: productFilter(ORANGE), metrics: ["lineAmount", "quantity"], sort: [{ by: "date", dir: "asc" }] }) },
    { id: "rate_now", kind: "insight", tool: "product_rates", args: { period: { kind: "previous_month" }, product: ORANGE } },
    { id: "customers", kind: "query", plan: q({ period: { kind: "previous_month" }, compare: { mode: "full_previous" }, groupBy: [{ dim: "customer" }], filters: productFilter(ORANGE), sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 }) },
  ] };
  const salesVsPurchases = { v: 1, steps: [
    { id: "sales", kind: "query", plan: q({ period: { kind: "previous_month" }, metrics: ["invoiceAmount"] }) },
    { id: "purchases", kind: "query", plan: q({ entity: "purchase", period: { kind: "previous_month" }, metrics: ["purchaseAmount"] }) },
  ] };
  return {
    "apple-why": [[DECLINE, { analysis: appleWhy }]],
    // no store dimension exists: the best plan answers the measurable part company-wide and declares the store as unavailable
    "apple-delhi-store": [[DECLINE, { analysis: appleWhy, unavailable: ["business_location"] }]],
    "apple-follow-up": [[DECLINE, { analysis: appleWhy }], [DECLINE, { analysis: followUp }]],
    // "where" names no kind of place: neither a place of the business nor where customers are is recorded - both declared
    "orange-where": [[DECLINE, { analysis: orangeWhere, unavailable: ["business_location", "party_location"] }]],
    "sales-vs-purchases-profit": [[DECLINE, { analysis: salesVsPurchases }]],
  };
}

module.exports = { APPLE, ORANGE, BANANA, TENANT, NOISE_TENANT, COMPANY_GUID, NOISE_GUID, SALES_PLAN, PURCHASE_PLAN, TAX, HEDGE, monthsBefore, buildVouchers, groundTruth, scenarios, ceilingReplies };

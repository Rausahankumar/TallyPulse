// --------------------------------------------------
// Pure GST field parsing for Tally data. No I/O, no database, no clock.
//
// Two sources use it, and their results are deliberately kept apart:
//   - parseStockItemGstRecord: the CURRENT Stock Item master (dated history of
//     HSN/SAC, taxability and rates, as Tally holds it today).
//   - parseVoucherLineGst: what one voucher inventory line SAID at posting time.
//     A voucher line is a historical fact; it is never rewritten from the master.
//
// Field names below are the ones a real TallyPrime returned (read-only probe,
// WE FOUR, 2026-10-09; see verify-stock-item-gst.js for the captured shape):
//   stock item: gstapplicable, gsttypeofsupply, hsndetails[{applicablefrom,
//     hsncode, hsn, srcofhsndetails}], gstdetails[{applicablefrom, taxability,
//     calculationtype, srcofgstdetails, reversechargerate, gstineligibleitc,
//     statewisedetails[{statename, ratedetails[{gstratedutyhead,
//     gstratevaluationtype, gstrate, gstrateperunit}]}]}]
//   voucher line: gsthsnname, gstovrdntaxability, gstovrdntypeofsupply,
//     gstovrdnisrevchargeappl, ratedetails[{same rate fields}], and the provenance markers
//     gstovrdnstorednature, gstsourcetype, hsnsourcetype, gstrateinferapplicability, gsthsninferapplicability
//
// Rules this file enforces:
//   - Whitespace is trimmed and control characters (Tally prefixes some enum
//     values with \u0004) are removed. Nothing else is rewritten.
//   - A number is one of three things, never conflated: a real value (0 is a
//     real value), missing (Tally sent nothing), or malformed (Tally sent
//     something that is not a number). Missing/malformed never become 0.
//   - Duty heads are kept separate. Nothing here adds CGST + SGST + IGST: they
//     can be alternative treatments (intra-state vs inter-state).
//   - Unknown labels are kept verbatim with a key of "other"; nothing is guessed.
// --------------------------------------------------

const MAX_ISSUES = 25;

// ---------- primitive normalisers ----------

// Tally wraps scalars as {type, value} and sometimes as [{metadata:true}, value].
// Local copy of the unwrap convention in tallyParser.js (that file requires this
// one, so requiring it back would be circular).
function unwrap(value) {
  if (Array.isArray(value)) {
    const [first, second] = value;
    if (first && typeof first === "object" && !Array.isArray(first) && first.metadata === true) {
      return second === undefined ? undefined : unwrap(second);
    }
    return value;
  }
  if (value && typeof value === "object" && "value" in value && !(value.value && typeof value.value === "object")) {
    return value.value;
  }
  return value;
}

// C0 control characters except tab, line feed and carriage return (those are trimmed as whitespace).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function stripControl(text) {
  return text.replace(CONTROL_CHARS, "");
}

function cleanText(value) {
  const u = unwrap(value);
  if (u === undefined || u === null || typeof u === "object") return null;
  const text = stripControl(String(u)).trim();
  return text === "" ? null : text;
}

function pick(obj, name) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lower) return obj[key];
  }
  return undefined;
}

const isPresent = (value) => value !== undefined && value !== null;

// {value, status, raw}: status is "value" | "missing" | "malformed".
const NUMBER_PATTERN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function numericField(value) {
  const u = unwrap(value);
  if (u === undefined || u === null) return { value: null, status: "missing", raw: null };
  if (typeof u === "number") {
    return Number.isFinite(u) ? { value: u, status: "value", raw: String(u) } : { value: null, status: "malformed", raw: String(u) };
  }
  if (typeof u === "object") return { value: null, status: "malformed", raw: null };
  const raw = stripControl(String(u)).trim();
  if (raw === "") return { value: null, status: "missing", raw: null };
  if (!NUMBER_PATTERN.test(raw)) return { value: null, status: "malformed", raw };
  const n = Number(raw);
  return Number.isFinite(n) ? { value: n, status: "value", raw } : { value: null, status: "malformed", raw };
}

// true / false / null (not supplied). malformed=true when something unrecognisable was supplied.
function booleanField(value) {
  const u = unwrap(value);
  if (u === undefined || u === null) return { value: null, malformed: false, raw: null };
  if (typeof u === "boolean") return { value: u, malformed: false, raw: String(u) };
  if (typeof u === "object") return { value: null, malformed: true, raw: null };
  const raw = stripControl(String(u)).trim();
  const s = raw.toLowerCase();
  if (s === "") return { value: null, malformed: false, raw: null };
  if (s === "true" || s === "yes" || s === "1") return { value: true, malformed: false, raw };
  if (s === "false" || s === "no" || s === "0") return { value: false, malformed: false, raw };
  return { value: null, malformed: true, raw };
}

// Tally dates arrive as YYYYMMDD. Stored as UTC midnight, the same convention as voucher dates.
function dayField(value) {
  const u = unwrap(value);
  if (u === undefined || u === null || typeof u === "object") {
    return { date: null, status: isPresent(u) ? "malformed" : "missing", raw: null };
  }
  const raw = stripControl(String(u)).trim();
  if (raw === "") return { date: null, status: "missing", raw: null };
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return { date: null, status: "malformed", raw };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { date: null, status: "malformed", raw };
  }
  return { date, status: "value", raw };
}

// ---------- label keys (unknown labels stay "other"; the verbatim label is always kept too) ----------

const normKey = (text) => (text ? text.toLowerCase().replace(/[^a-z0-9]/g, "") : "");

const DUTY_HEAD_KEYS = { cgst: "cgst", sgstutgst: "sgst_utgst", igst: "igst", cess: "cess", statecess: "state_cess" };
const TAXABILITY_KEYS = { taxable: "taxable", exempt: "exempt", nilrated: "nil_rated", nongst: "non_gst" };
const VALUATION_KEYS = { basedonvalue: "based_on_value", basedonquantity: "based_on_quantity", notapplicable: "not_applicable" };
const APPLICABLE_KEYS = { applicable: "applicable", notapplicable: "not_applicable", undefined: "undefined" };

function keyOf(table, label) {
  if (!label) return null;
  return Object.prototype.hasOwnProperty.call(table, normKey(label)) ? table[normKey(label)] : "other";
}

// ---------- issue collection ----------

function makeContext() {
  const issues = [];
  return {
    issues,
    error(section, path, code, raw) {
      issues.push({ section, path, code, severity: "error", raw: raw === undefined || raw === null ? null : String(raw).slice(0, 80) });
    },
    warn(section, path, code, raw) {
      issues.push({ section, path, code, severity: "warning", raw: raw === undefined || raw === null ? null : String(raw).slice(0, 80) });
    },
  };
}

// A Tally sub-collection is normally an array of objects; a single object is accepted as one row.
function objectRows(raw, ctx, section, path) {
  const u = raw === undefined || raw === null ? [] : raw;
  if (Array.isArray(u)) {
    const rows = [];
    u.forEach((item, i) => {
      if (item && typeof item === "object" && !Array.isArray(item)) rows.push({ obj: item, i });
      else ctx.error(section, `${path}[${i}]`, "malformed_entry", typeof item);
    });
    return rows;
  }
  if (typeof u === "object") return [{ obj: u, i: 0 }];
  ctx.error(section, path, "malformed_section", typeof u);
  return [];
}

function parseRateRows(raw, ctx, section, path) {
  return objectRows(raw, ctx, section, path).map(({ obj, i }) => {
    const here = `${path}[${i}]`;
    const dutyHead = cleanText(pick(obj, "gstratedutyhead"));
    const valuationType = cleanText(pick(obj, "gstratevaluationtype"));
    const rate = numericField(pick(obj, "gstrate"));
    const ratePerUnit = numericField(pick(obj, "gstrateperunit"));
    if (!dutyHead) ctx.warn(section, `${here}.gstratedutyhead`, "missing_duty_head", null);
    if (rate.status === "malformed") ctx.error(section, `${here}.gstrate`, "malformed_number", rate.raw);
    if (ratePerUnit.status === "malformed") ctx.error(section, `${here}.gstrateperunit`, "malformed_number", ratePerUnit.raw);
    const valuationKey = keyOf(VALUATION_KEYS, valuationType);
    // A percentage outside 0-100 is stored exactly as Tally holds it, but flagged: it is almost certainly
    // a data-entry slip in the master (seen in a real company: an IGST rate of 123), and nothing here "fixes" it.
    if (valuationKey === "based_on_value" && rate.status === "value" && (rate.value < 0 || rate.value > 100)) {
      ctx.warn(section, `${here}.gstrate`, "rate_out_of_range", rate.raw);
    }
    return {
      dutyHead,
      dutyHeadKey: keyOf(DUTY_HEAD_KEYS, dutyHead),
      valuationType,
      valuationKey,
      rate,
      ratePerUnit,
    };
  });
}

// Sort ascending by applicableFrom (undated last, original order kept for ties) and derive each
// entry's last effective day from the next LATER entry. The last dated entry stays open-ended.
function finaliseTimeline(entries, ctx, section) {
  const sorted = entries
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => {
      const ta = a.entry.applicableFrom ? a.entry.applicableFrom.getTime() : Infinity;
      const tb = b.entry.applicableFrom ? b.entry.applicableFrom.getTime() : Infinity;
      return ta - tb || a.order - b.order;
    })
    .map((x) => x.entry);

  const seen = new Set();
  sorted.forEach((entry, idx) => {
    if (!entry.applicableFrom) return;
    const t = entry.applicableFrom.getTime();
    if (seen.has(t)) ctx.warn(section, `${section}[${idx}]`, "duplicate_applicable_from", entry.applicableFrom.toISOString().slice(0, 10));
    seen.add(t);
    const later = sorted.find((other) => other.applicableFrom && other.applicableFrom.getTime() > t);
    entry.effectiveTo = later ? new Date(later.applicableFrom.getTime() - 86400000) : null;
  });
  return sorted;
}

// ---------- Stock Item master ----------

function parseHsnEntries(raw, ctx) {
  const entries = objectRows(raw, ctx, "hsn", "hsndetails").map(({ obj, i }) => {
    const path = `hsndetails[${i}]`;
    const from = dayField(pick(obj, "applicablefrom"));
    if (from.status === "malformed") ctx.error("hsn", `${path}.applicablefrom`, "malformed_date", from.raw);
    if (from.status === "missing") ctx.warn("hsn", `${path}.applicablefrom`, "missing_date", null);
    const code = cleanText(pick(obj, "hsncode"));
    if (!code) ctx.warn("hsn", `${path}.hsncode`, "missing_hsn_code", null);
    return {
      applicableFrom: from.date,
      effectiveTo: null,
      code, // a string on purpose: leading zeros are significant
      description: cleanText(pick(obj, "hsn")), // Tally's own `hsn` field, kept verbatim
      srcOfDetails: cleanText(pick(obj, "srcofhsndetails")),
    };
  });
  return finaliseTimeline(entries, ctx, "hsn");
}

function parseGstDetailEntries(raw, ctx) {
  const entries = objectRows(raw, ctx, "details", "gstdetails").map(({ obj, i }) => {
    const path = `gstdetails[${i}]`;
    const from = dayField(pick(obj, "applicablefrom"));
    if (from.status === "malformed") ctx.error("details", `${path}.applicablefrom`, "malformed_date", from.raw);
    if (from.status === "missing") ctx.warn("details", `${path}.applicablefrom`, "missing_date", null);

    const taxability = cleanText(pick(obj, "taxability"));
    const reverseChargeRate = numericField(pick(obj, "reversechargerate"));
    if (reverseChargeRate.status === "malformed") ctx.error("details", `${path}.reversechargerate`, "malformed_number", reverseChargeRate.raw);
    const itc = booleanField(pick(obj, "gstineligibleitc"));
    if (itc.malformed) ctx.error("details", `${path}.gstineligibleitc`, "malformed_boolean", itc.raw);

    const stateRates = objectRows(pick(obj, "statewisedetails"), ctx, "details", `${path}.statewisedetails`).map(({ obj: sw, i: j }) => {
      const stateName = cleanText(pick(sw, "statename"));
      return {
        stateName,
        // "Any" is Tally's own label for the general (all-states) row. A missing name is not assumed to be "Any".
        stateScope: !stateName ? "unknown" : stateName.toLowerCase() === "any" ? "any" : "state",
        rates: parseRateRows(pick(sw, "ratedetails"), ctx, "details", `${path}.statewisedetails[${j}].ratedetails`),
      };
    });

    return {
      applicableFrom: from.date,
      effectiveTo: null,
      taxability,
      taxabilityKey: keyOf(TAXABILITY_KEYS, taxability),
      calculationType: cleanText(pick(obj, "calculationtype")),
      srcOfDetails: cleanText(pick(obj, "srcofgstdetails")),
      reverseChargeRate,
      ineligibleItc: itc.value, // true, or null when Tally did not say (never assumed false)
      stateRates,
    };
  });
  return finaliseTimeline(entries, ctx, "details");
}

// One Stock Item record from the StockItem collection -> the GST view of it.
//   applicability / hsn / details are null when Tally did not return that part at all
//   (absent), which is different from a part that is present but empty.
function parseStockItemGstRecord(record) {
  const ctx = makeContext();
  const rec = record && typeof record === "object" ? record : {};

  const tallyGuid = cleanText(pick(rec, "guid"));
  const parent = cleanText(pick(rec, "parent"));

  const gstApplicable = cleanText(pick(rec, "gstapplicable"));
  const typeOfSupply = cleanText(pick(rec, "gsttypeofsupply"));
  const applicability = gstApplicable || typeOfSupply
    ? { gstApplicable, gstApplicableKey: keyOf(APPLICABLE_KEYS, gstApplicable), typeOfSupply }
    : null;

  const rawHsn = pick(rec, "hsndetails");
  const rawDetails = pick(rec, "gstdetails");
  const hsn = isPresent(rawHsn) ? parseHsnEntries(rawHsn, ctx) : null;
  const details = isPresent(rawDetails) ? parseGstDetailEntries(rawDetails, ctx) : null;

  return {
    tallyGuid,
    parent,
    applicability,
    hsn,
    details,
    hasGstData: !!(applicability || (hsn && hsn.length) || (details && details.length)),
    // Uncapped on purpose: the merge decides from the full list and caps only what it stores.
    issues: ctx.issues,
  };
}

// ---------- voucher inventory line ----------

// The GST amounts (in rupees) Tally computed for one voucher line. They are returned only when the request asks for
// `inventoryentries.computedigst` (which makes Tally add its whole computed-GST group to every line). Checked live over
// August 2025 (WE FOUR): for SALES invoices they reconcile (631 checked: the lines' CGST/SGST equal the voucher's own
// CGST/SGST ledgers on 627, and line amounts + taxes + rounding = the invoice total on 625); for PURCHASE vouchers they
// do NOT (62 checked: CGST matched on 20, totals on 0), so purchase line tax amounts are stored as sent but must not be
// relied on. SGST and UTGST are ONE head shown twice (utgst repeats sgst on 91% of lines): never add them, nor add
// CGST + SGST + IGST blindly. Stored as Tally sends them (no sign change). A value that is missing or not a number is
// null, never 0; a real 0 stays 0.
const LINE_TAX_AMOUNT_KEYS = {
  assessableValue: "computedassessablevalue", // the line's taxable value (equals the discounted line amount in every sample)
  cgst: "computedcgst",
  sgst: "computedsgst",
  utgst: "computedutgst",
  igst: "computedigst",
  cess: "computedcess",
  cessOnQty: "computedcessonqty",
  stateCess: "computedstatecessgst",
};

function parseLineTaxAmounts(entry) {
  const out = {};
  let any = false;
  for (const [name, key] of Object.entries(LINE_TAX_AMOUNT_KEYS)) {
    const field = numericField(pick(entry, key));
    out[name] = field.status === "value" ? field.value : null;
    if (field.status !== "missing") any = true;
  }
  return any ? out : null;
}

// What the voucher line itself carried. Returns null when the line has no GST fields at all
// (so old-shaped vouchers map to exactly what they did before).
function parseVoucherLineGst(entry) {
  if (!entry || typeof entry !== "object") return null;
  const ctx = makeContext();
  const hsn = cleanText(pick(entry, "gsthsnname"));
  const taxability = cleanText(pick(entry, "gstovrdntaxability"));
  const typeOfSupply = cleanText(pick(entry, "gstovrdntypeofsupply"));
  const reverseCharge = cleanText(pick(entry, "gstovrdnisrevchargeappl"));
  const rawRates = pick(entry, "ratedetails");
  const rates = isPresent(rawRates) ? parseRateRows(rawRates, ctx, "voucher", "ratedetails") : [];
  const amounts = parseLineTaxAmounts(entry);

  if (!hsn && !taxability && !typeOfSupply && !reverseCharge && rates.length === 0 && !amounts) return null;

  // Where Tally says these values came from. In real exports it differs line by line: the GST details of
  // a line come from the Stock Item, from the Company settings, or are specified on the voucher itself, and
  // the value is marked "System Inferred". So a line's value is not always the item master's, and its
  // authority depends on these markers. Kept verbatim; nothing is interpreted.
  const provenance = {
    storedNature: cleanText(pick(entry, "gstovrdnstorednature")),
    gstSourceType: cleanText(pick(entry, "gstsourcetype")),
    hsnSourceType: cleanText(pick(entry, "hsnsourcetype")),
    rateInference: cleanText(pick(entry, "gstrateinferapplicability")),
    hsnInference: cleanText(pick(entry, "gsthsninferapplicability")),
  };
  const hasProvenance = Object.values(provenance).some((v) => v !== null);

  return {
    hsn,
    taxability,
    taxabilityKey: keyOf(TAXABILITY_KEYS, taxability),
    typeOfSupply,
    reverseCharge,
    rates,
    ...(amounts ? { amounts } : {}),
    ...(hasProvenance ? { provenance } : {}),
  };
}

// ---------- reading history ----------

function toUtcDay(value) {
  if (value instanceof Date) return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// The dated entries in effect on a given day: the latest entry whose applicableFrom is on or
// before it. Undated entries are never chosen. Returns null parts when nothing was in effect.
function resolveGstAsOf(gst, asOf) {
  const t = toUtcDay(asOf);
  if (!gst || t === null) return { details: null, hsn: null };
  const latest = (list) => {
    let best = null;
    for (const entry of list || []) {
      if (!entry.applicableFrom || entry.applicableFrom.getTime() > t) continue;
      if (!best || entry.applicableFrom.getTime() >= best.applicableFrom.getTime()) best = entry;
    }
    return best;
  };
  return { details: latest(gst.details), hsn: latest(gst.hsn) };
}

module.exports = {
  MAX_ISSUES,
  cleanText,
  numericField,
  booleanField,
  dayField,
  keyOf,
  DUTY_HEAD_KEYS,
  TAXABILITY_KEYS,
  VALUATION_KEYS,
  APPLICABLE_KEYS,
  parseStockItemGstRecord,
  parseVoucherLineGst,
  parseLineTaxAmounts,
  LINE_TAX_AMOUNT_KEYS,
  resolveGstAsOf,
};

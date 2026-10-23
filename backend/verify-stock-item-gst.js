/**
 * Stock Item GST data, end to end. Two parts, one run:
 *
 *   PART 1 - parsing and rules (no MongoDB, no Tally, no network): the Tally request, parsing of the observed raw field names and
 *   nested arrays, whitespace / control-character / numeric normalisation, the merge rules (idempotence, corrections, partial /
 *   malformed / empty / hollow responses), voucher-line GST, and the guarantee that no tax figure is derived from it.
 *
 *   PART 2 - persistence and sync (MongoDB, injected Tally-shaped fetchers): the full dated GST history, idempotent re-sync,
 *   historical corrections without duplicate entries, partial / failed responses that never destroy stored data, one request at a
 *   time, tenant and company isolation, identity by GUID, cache invalidation, and proof that voucher totals and product-group
 *   answers are unchanged by a GST refresh.
 *
 * Fixtures: CAPTURED = the shape a real TallyPrime returned for one Stock Item in a read-only probe (WE FOUR, 2026-10-09):
 * field names, nesting and value formats (the \u0004 prefix, leading spaces) exactly as received, with the item name, group and
 * GUID replaced by synthetic ones. SYNTHETIC = values Tally can produce but the probe did not return (several states, per-unit
 * rates, "Nil Rated"). No live Tally: axios.post is blocked. Writes go only to clearly synthetic tenants and are removed at the
 * end. Refuses to run against anything but a loopback MongoDB.
 *
 * Run: node verify-stock-item-gst.js   (needs a loopback MongoDB named tallypulse_test*)
 */

require("dotenv").config();

// This suite creates and deletes documents, so it refuses to run against anything but a loopback MongoDB
// (dotenv above may have loaded backend/.env, which points at the real Atlas cluster), and it blocks the one HTTP client
// that talks to Tally so no request can leave the process even if a fetcher injection were ever forgotten.
{
  const uri = process.env.MONGODB_URI || "";
  const host = (/^mongodb:\/\/(?:[^@/]*@)?\[?([^\]/:,]+)\]?(?::\d+)?[/?]/.exec(uri) || [])[1];
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || /mongodb\+srv|mongodb\.net|atlas/i.test(uri)) {
    console.error("REFUSED: verify-stock-item-gst.js only runs against a loopback MongoDB (127.0.0.1 / localhost). Nothing was touched.");
    process.exit(2);
  }
  const axios = require("axios");
  axios.post = () => { throw new Error("NETWORK BLOCKED: this suite must never reach Tally (inject the fetchers)"); };
}

const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

let pass = 0;
let fail = 0;
function check(id, description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
  if (ok) pass += 1; else fail += 1;
}

// ================================================================ PART 1: parsing, normalisation and merge rules
// (its helpers stay private to this function; check() and the counters are shared with part 2)
async function partParsing() {
const fs = require("fs");
const path = require("path");
const axios = require("axios");
// This suite never needs Tally; block the one HTTP client that talks to it (section 1 swaps in a capturing stub and restores this).
axios.post = () => { throw new Error("NETWORK BLOCKED: this suite must never reach Tally"); };
const {
  cleanText, numericField, booleanField, dayField,
  parseStockItemGstRecord, parseVoucherLineGst, resolveGstAsOf,
} = require("./src/services/parser/gstFields");
const { parseTallyVoucher } = require("./src/services/parser/tallyParser");
const { mapTallySale } = require("./src/services/mapper/salesMapper");
const { mapTallyPurchase } = require("./src/services/mapper/purchaseMapper");
const { mergeGst, validateGstBlock, hashContent } = require("./src/services/tally/stockItemGst");
const odbc = require("./src/services/odbc/odbcService");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const { validateQueryPlan } = require("./src/services/query/validator");
const { CATALOG } = require("./src/services/query/semanticCatalog");
const { formatQueryAnswer } = require("./src/services/query/answerFormatter");

const day = (s) => new Date(`${s}T00:00:00.000Z`);

// ---------------------------------------------------------------- fixtures

const COMPANY_GUID = "aaaaaaaa-0000-4000-8000-0000000000a1"; // synthetic

const rate = (head, valuation, r, perUnit = "0") => ({ gstratedutyhead: head, gstratevaluationtype: valuation, gstrate: r, gstrateperunit: perUnit });

// CAPTURED: rate rows exactly as received (leading spaces on the rates, \u0004 on "Not Applicable").
const capturedRates = (cgst, sgst, igst) => [
  rate("CGST", "Based on Value", cgst),
  rate("SGST/UTGST", "Based on Value", sgst),
  rate("IGST", "Based on Value", igst),
  rate("Cess", "\u0004 Not Applicable", "0"),
  rate("State Cess", "Based on Value", "0"),
];

function capturedItem({ guid, name = "SYNTHETIC ITEM 1", parent = "SYNTHETIC GROUP" } = {}) {
  return {
    metadata: { type: "Stock Item", name, reservedname: "" },
    guid: { type: "String", value: guid || `${COMPANY_GUID}-000007db` },
    parent: { type: "String", value: parent },
    gstapplicable: { type: "String", value: "\u0004 Applicable" },
    gsttypeofsupply: { type: "String", value: "Goods" },
    gstdetails: [
      {
        applicablefrom: "20170701", taxability: "Taxable", srcofgstdetails: "Specify Details Here", reversechargerate: "0",
        statewisedetails: [{ statename: "\u0004 Any", ratedetails: capturedRates(" 6", " 6", " 12") }],
      },
      {
        applicablefrom: "20250922", taxability: "Non-GST", srcofgstdetails: "Specify Details Here", gstineligibleitc: true, reversechargerate: "0",
        statewisedetails: [{ statename: "\u0004 Any", ratedetails: capturedRates("0", "0", "0") }],
      },
    ],
    hsndetails: [{ applicablefrom: "20170701", hsncode: "4820", srcofhsndetails: "Specify Details Here" }],
  };
}
const parsedOf = (record) => parseStockItemGstRecord(record);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rateOf = (entry, headKey, stateIdx = 0) => entry.stateRates[stateIdx].rates.find((r) => r.dutyHeadKey === headKey);

await (async () => {
  // =========================================================== 1. the Tally request
  console.log("=== 1. GST fields are requested in the actual Tally collection ===");
  {
    let captured = null;
    const realPost = axios.post;
    axios.post = async (url, body, cfg) => { captured = { url, body, cfg }; return { data: { status: "1", data: { collection: [] } } }; };
    try {
      await odbc.getStockItemGstMasters({ stockGroupName: "Group One" });
      const gstReq = captured;
      const defs = gstReq.body.tdlmessage[0].definitions;
      const attrs = Object.assign({}, ...defs[0].attributes);
      const methods = attrs["Native Method"].split(",").map((m) => m.trim());
      const required = ["Name", "Parent", "Guid", "GSTApplicable", "GSTTypeOfSupply", "GSTDetails.*", "HSNDetails.*", "GSTDetails.StateWiseDetails.*", "GSTDetails.StateWiseDetails.RateDetails.*"];
      check("req-methods", "the GST collection asks for every GST/HSN method the probe confirmed", required.every((m) => methods.includes(m)), true);
      check("req-type", "it is a StockItem collection (same convention as the core request)", attrs.Type, "StockItem");
      check("req-filter-group", "it is narrowed to ONE stock group by a formula filter", defs[1].value, '$Parent = "Group One"');
      check("req-filter-ref", "the collection points at that filter definition", attrs.Filter, defs[1].metadata.name);
      check("req-id", "the request ID header names the collection", gstReq.cfg.headers.ID, defs[0].metadata.name);
      check("req-json", "it asks for JSONEx and is bounded by a timeout", [gstReq.body.static_variables[0].value, gstReq.cfg.timeout], ["jsonex", 30000]);

      captured = null;
      await odbc.getStockItemMasters({});
      const coreAttrs = Object.assign({}, ...captured.body.tdlmessage[0].definitions[0].attributes);
      check("req-core-unchanged", "the core Stock Item request is unchanged (Name, Parent, Guid)", coreAttrs["Native Method"], "Name, Parent, Guid");

      for (const bad of ['Bad"Name', "Back\\slash", "New\nLine", "", undefined]) {
        captured = null;
        let threw = false;
        try { await odbc.getStockItemGstMasters({ stockGroupName: bad }); } catch { threw = true; }
        check(`req-unsafe-${JSON.stringify(bad)}`, "a group name that could break out of the formula is refused and never sent", [threw, captured], [true, null]);
      }
    } finally {
      axios.post = realPost;
    }
  }

  // =========================================================== 2. parsing the captured shape
  console.log("\n=== 2. Parsing the observed raw field names and nested arrays ===");
  const parsed = parsedOf(capturedItem());
  {
    check("id", "GUID and parent group are read from the wrapped values", [parsed.tallyGuid, parsed.parent], [`${COMPANY_GUID}-000007db`, "SYNTHETIC GROUP"]);
    check("applicability", "gstapplicable / gsttypeofsupply are read, \\u0004 and spaces removed", parsed.applicability,
      { gstApplicable: "Applicable", gstApplicableKey: "applicable", typeOfSupply: "Goods" });
    check("hsn", "hsndetails[] keeps hsncode as a string with its applicable-from date", parsed.hsn,
      [{ applicableFrom: day("2017-07-01"), effectiveTo: null, code: "4820", description: null, srcOfDetails: "Specify Details Here" }]);
    check("details-count", "both dated GST entries are kept (history is not collapsed to the latest)", parsed.details.length, 2);

    const [d0, d1] = parsed.details;
    check("timeline-1", "the 2017 entry is in force until the day before the next entry", [d0.applicableFrom, d0.effectiveTo], [day("2017-07-01"), day("2025-09-21")]);
    check("timeline-2", "the latest entry is open-ended", [d1.applicableFrom, d1.effectiveTo], [day("2025-09-22"), null]);
    check("taxability", "taxability keeps Tally's label and a key", [d0.taxability, d0.taxabilityKey, d1.taxability, d1.taxabilityKey], ["Taxable", "taxable", "Non-GST", "non_gst"]);
    check("itc", "gstineligibleitc is true when Tally said so and null (not false) when it did not", [d0.ineligibleItc, d1.ineligibleItc], [null, true]);
    check("calc-src", "srcofgstdetails is kept; calculationtype is null when absent", [d0.srcOfDetails, d0.calculationType], ["Specify Details Here", null]);
    check("reverse-charge", "reversechargerate '0' is a real zero value", d0.reverseChargeRate, { value: 0, status: "value", raw: "0" });
    check("state-any", "statename '\\u0004 Any' is the general row", [d0.stateRates[0].stateName, d0.stateRates[0].stateScope], ["Any", "any"]);
    check("duty-heads", "CGST, SGST/UTGST, IGST, Cess and State Cess stay separate rows", d0.stateRates[0].rates.map((r) => r.dutyHeadKey), ["cgst", "sgst_utgst", "igst", "cess", "state_cess"]);
    check("duty-head-labels", "the verbatim duty-head labels are kept", d0.stateRates[0].rates.map((r) => r.dutyHead), ["CGST", "SGST/UTGST", "IGST", "Cess", "State Cess"]);
    check("rates-2017", "' 6' / ' 6' / ' 12' parse to numbers", d0.stateRates[0].rates.map((r) => r.rate.value), [6, 6, 12, 0, 0]);
    check("rates-raw", "the cleaned original text is kept next to the number", rateOf(d0, "cgst").rate, { value: 6, status: "value", raw: "6" });
    check("zero-is-value", "an explicit 0 rate is status 'value', not 'missing'", rateOf(d1, "cgst").rate, { value: 0, status: "value", raw: "0" });
    check("valuation", "valuation types: Based on Value; '\\u0004 Not Applicable' -> Not Applicable", d0.stateRates[0].rates.map((r) => r.valuationKey),
      ["based_on_value", "based_on_value", "based_on_value", "not_applicable", "based_on_value"]);
    check("per-unit-zero", "gstrateperunit '0' is a real zero", rateOf(d0, "igst").ratePerUnit, { value: 0, status: "value", raw: "0" });
    check("no-control-chars", "no control character survives anywhere in the parsed result", /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(JSON.stringify(parsed)), false);
    check("no-combined-rate", "an entry has no summed / combined rate field (CGST+SGST+IGST are alternatives)",
      Object.keys(d0).sort(), ["applicableFrom", "calculationType", "effectiveTo", "ineligibleItc", "reverseChargeRate", "srcOfDetails", "stateRates", "taxability", "taxabilityKey"]);
    check("no-issues", "the captured item parses without any issue", parsed.issues, []);

    const asOf = (d) => resolveGstAsOf(parsed, d);
    check("as-of-before", "as of 2025-09-21 the entry in force is Taxable", asOf("2025-09-21").details.taxability, "Taxable");
    check("as-of-change", "as of 2025-09-22 the entry in force is Non-GST", asOf("2025-09-22").details.taxability, "Non-GST");
    check("as-of-too-early", "before the first entry nothing is in force (nothing is invented)", asOf("2017-06-30").details, null);
    check("as-of-hsn", "the HSN in force is resolved the same way", asOf("2026-01-01").hsn.code, "4820");
  }

  // =========================================================== 3. normalisation
  console.log("\n=== 3. Whitespace, control characters, numeric strings, dates ===");
  {
    check("clean-1", "control character + space + text -> trimmed text", cleanText("\u0004 Not Applicable"), "Not Applicable");
    check("clean-2", "ordinary whitespace is trimmed, inner text untouched", cleanText("  Based on Value \t\n"), "Based on Value");
    check("clean-3", "blank / control-only -> null", [cleanText("  "), cleanText("\u0004"), cleanText(null), cleanText(undefined)], [null, null, null, null]);
    check("clean-4", "a wrapped {type,value} is unwrapped first", cleanText({ type: "String", value: "\u0004 Applicable" }), "Applicable");
    check("clean-5", "an object / array is not text", [cleanText({ a: 1 }), cleanText([1, 2])], [null, null]);

    check("num-int", "' 6' -> 6 (value)", numericField(" 6"), { value: 6, status: "value", raw: "6" });
    check("num-dec", "' 61.50' -> 61.5 (value)", numericField(" 61.50"), { value: 61.5, status: "value", raw: "61.50" });
    check("num-zero", "'0' -> 0 (value), a real zero", numericField("0"), { value: 0, status: "value", raw: "0" });
    check("num-neg", "'-1' is a number, not an error", numericField("-1").value, -1);
    check("num-js", "a JS number passes through", numericField(12), { value: 12, status: "value", raw: "12" });
    check("num-missing", "undefined / null / '' / blank -> missing, never 0", [numericField(undefined).status, numericField(null).status, numericField("").status, numericField("  \u0004 ").status], ["missing", "missing", "missing", "missing"]);
    check("num-missing-value", "missing carries no number", numericField("").value, null);
    check("num-malformed", "'abc', '6%', '1e3', '12 13', NaN are malformed (null value, raw kept)",
      ["abc", "6%", "1e3", "12 13", NaN].map((v) => { const n = numericField(v); return [n.status, n.value]; }),
      [["malformed", null], ["malformed", null], ["malformed", null], ["malformed", null], ["malformed", null]]);
    check("num-malformed-raw", "the malformed text is kept for diagnosis", numericField(" 6% ").raw, "6%");
    check("num-three-states", "zero, missing and malformed are three different states",
      [numericField("0").status, numericField("").status, numericField("x").status], ["value", "missing", "malformed"]);

    check("day-ok", "20250922 -> UTC midnight", dayField("20250922").date, day("2025-09-22"));
    check("day-bad", "an impossible date (20250231) and other formats are malformed, not rolled over",
      ["20250231", "2025-09-22", "22-09-2025", "2025092", "abc"].map((v) => dayField(v).status), ["malformed", "malformed", "malformed", "malformed", "malformed"]);
    check("day-missing", "no date -> missing", [dayField(undefined).status, dayField("").status], ["missing", "missing"]);

    check("bool", "true/false/yes/no and not-supplied", [booleanField(true).value, booleanField("No").value, booleanField("yes").value, booleanField(undefined).value, booleanField("").value], [true, false, true, null, null]);
    check("bool-malformed", "an unrecognisable boolean is malformed, not guessed", [booleanField("maybe").value, booleanField("maybe").malformed], [null, true]);
  }

  // =========================================================== 4. variations
  console.log("\n=== 4. Variations: exempt / nil-rated / several states / per-unit / unknown labels / missing / malformed ===");
  {
    // CAPTURED shape: an Exempt entry exists in the real data with all five duty heads at '0'.
    const exempt = capturedItem(); exempt.gstdetails = [{ applicablefrom: "20250929", taxability: "Exempt", srcofgstdetails: "Specify Details Here", reversechargerate: "0", statewisedetails: [{ statename: "\u0004 Any", ratedetails: capturedRates("0", "0", "0") }] }];
    const pe = parsedOf(exempt);
    check("exempt", "Exempt (observed) is kept with its explicit zero rates", [pe.details[0].taxability, pe.details[0].taxabilityKey, rateOf(pe.details[0], "igst").rate.status], ["Exempt", "exempt", "value"]);

    // SYNTHETIC: Nil Rated is not in the probe's data; the label is mapped by name only.
    const nil = capturedItem(); nil.gstdetails = [{ applicablefrom: "20240401", taxability: "Nil Rated", statewisedetails: [] }];
    const pn = parsedOf(nil);
    check("nil-rated", "synthetic: 'Nil Rated' maps to nil_rated, no rate rows is fine (nothing invented)", [pn.details[0].taxabilityKey, pn.details[0].stateRates], ["nil_rated", []]);

    // SYNTHETIC: several states, a state-specific row beside the general row.
    const multi = capturedItem(); multi.gstdetails = [{
      applicablefrom: "20240401", taxability: "Taxable",
      statewisedetails: [
        { statename: "\u0004 Any", ratedetails: capturedRates(" 9", " 9", " 18") },
        { statename: " Karnataka ", ratedetails: [rate("CGST", "Based on Value", " 2.5"), rate("SGST/UTGST", "Based on Value", " 2.5"), rate("IGST", "Based on Value", " 5")] },
      ],
    }];
    const pm = parsedOf(multi).details[0];
    check("multi-state", "synthetic: general and state-specific rows are separate", pm.stateRates.map((s) => [s.stateName, s.stateScope]), [["Any", "any"], ["Karnataka", "state"]]);
    check("multi-state-rates", "synthetic: the state row keeps its own rates", pm.stateRates[1].rates.map((r) => r.rate.value), [2.5, 2.5, 5]);

    // SYNTHETIC: per-unit rate, an unknown duty head and unknown valuation label, an unknown extra field.
    const exotic = capturedItem(); exotic.gstdetails = [{
      applicablefrom: "20240401", taxability: "Taxable", somethingnew: { a: 1 },
      statewisedetails: [{ statename: "Any", ratedetails: [
        { gstratedutyhead: "Cess", gstratevaluationtype: "Based on Quantity", gstrate: "0", gstrateperunit: " 2.50" },
        { gstratedutyhead: "Compensation Cess", gstratevaluationtype: "On Something", gstrate: " 12", gstrateperunit: "0" },
      ] }],
    }];
    const px = parsedOf(exotic);
    const xr = px.details[0].stateRates[0].rates;
    check("per-unit", "synthetic: a per-unit rate is kept apart from the percentage", [xr[0].valuationKey, xr[0].rate.value, xr[0].ratePerUnit.value], ["based_on_quantity", 0, 2.5]);
    check("unknown-labels", "synthetic: unknown duty head / valuation keep the verbatim label with key 'other'", [xr[1].dutyHead, xr[1].dutyHeadKey, xr[1].valuationType, xr[1].valuationKey], ["Compensation Cess", "other", "On Something", "other"]);
    check("unknown-field-ignored", "synthetic: an unknown extra field neither throws nor leaks into the result", [px.issues.length, JSON.stringify(px).includes("somethingnew")], [0, false]);

    // Missing vs malformed vs zero rate on one row.
    const mixed = capturedItem(); mixed.gstdetails = [{ applicablefrom: "20240401", taxability: "Taxable", statewisedetails: [{ statename: "Any", ratedetails: [
      { gstratedutyhead: "CGST", gstratevaluationtype: "Based on Value" }, // no gstrate at all
      { gstratedutyhead: "SGST/UTGST", gstratevaluationtype: "Based on Value", gstrate: "abc" },
      { gstratedutyhead: "IGST", gstratevaluationtype: "Based on Value", gstrate: "0" },
    ] }] }];
    const pmx = parsedOf(mixed);
    const mr = pmx.details[0].stateRates[0].rates;
    check("rate-states", "no gstrate -> missing; 'abc' -> malformed; '0' -> value 0 (never the same state)", mr.map((r) => [r.rate.status, r.rate.value]), [["missing", null], ["malformed", null], ["value", 0]]);
    check("rate-missing-not-zero", "a missing rate is null, not 0", mr[0].rate.value === 0, false);
    check("rate-issue", "the malformed rate is reported with its path", pmx.issues.filter((i) => i.severity === "error").map((i) => [i.section, i.path, i.code, i.raw]),
      [["details", "gstdetails[0].statewisedetails[0].ratedetails[1].gstrate", "malformed_number", "abc"]]);

    // A percentage above 100 is kept as Tally holds it and flagged (a real company has an IGST of 123 in one master). 61.50 is in range.
    const odd = capturedItem(); odd.gstdetails = [{ applicablefrom: "20240401", taxability: "Taxable", statewisedetails: [{ statename: "Any", ratedetails: [rate("CGST", "Based on Value", " 61.50"), rate("IGST", "Based on Value", " 123"), rate("CGST", "Based on Value", " 9")] }] }];
    const po = parsedOf(odd);
    check("rate-out-of-range", "a percentage above 100 is stored unchanged and flagged as a warning (not an error, not corrected); 61.50 is in range",
      [po.details[0].stateRates[0].rates.map((r) => r.rate.value), po.issues.map((i) => [i.severity, i.code, i.raw])], [[61.5, 123, 9], [["warning", "rate_out_of_range", "123"]]]);
    check("rate-out-of-range-valid", "a flagged-but-valid history still replaces the stored one (a warning never blocks a sync)", mergeGst(undefined, po, new Date()).outcome.details, "applied");

    // Optional / missing parts.
    const bare = parsedOf({ guid: { type: "String", value: `${COMPANY_GUID}-1` }, parent: { type: "String", value: "G" } });
    check("absent-all", "a record with no GST keys: applicability/hsn/details are null (absent) and hasGstData is false", [bare.applicability, bare.hsn, bare.details, bare.hasGstData], [null, null, null, false]);
    const empties = parsedOf({ guid: { value: "x-1" }, hsndetails: [], gstdetails: [] });
    check("present-empty", "present-but-empty arrays are [] (different from absent)", [empties.hsn, empties.details], [[], []]);
    const onlyApplicable = parsedOf({ guid: { value: "x-2" }, gstapplicable: " Not Applicable" });
    check("only-applicability", "a record with only gstapplicable still parses", onlyApplicable.applicability, { gstApplicable: "Not Applicable", gstApplicableKey: "not_applicable", typeOfSupply: null });
    const hsnOnly = parsedOf({ guid: { value: "x-3" }, hsndetails: [{ hsncode: "01012100" }] });
    check("hsn-no-date", "an HSN row without a date is kept (undated, flagged as a warning)", [hsnOnly.hsn[0].code, hsnOnly.hsn[0].applicableFrom, hsnOnly.issues.map((i) => i.code)], ["01012100", null, ["missing_date"]]);
    check("hsn-leading-zero", "a leading zero in an HSN code survives", hsnOnly.hsn[0].code, "01012100");
    const hsnDesc = parsedOf({ guid: { value: "x-4" }, hsndetails: [{ applicablefrom: "20240401", hsncode: "4820", hsn: "482020" }] });
    check("hsn-description", "Tally's own `hsn` field is kept verbatim as description", hsnDesc.hsn[0].description, "482020");

    // Ordering / duplicates / odd structure.
    const unsorted = capturedItem(); unsorted.gstdetails = [clone(capturedItem().gstdetails[1]), clone(capturedItem().gstdetails[0])];
    const pu = parsedOf(unsorted);
    check("sorted", "entries are stored oldest-first whatever order Tally sent them in", pu.details.map((d) => d.applicableFrom.toISOString().slice(0, 10)), ["2017-07-01", "2025-09-22"]);
    check("sorted-interval", "...and the interval is derived from the sorted order", pu.details[0].effectiveTo, day("2025-09-21"));
    const dup = capturedItem(); dup.gstdetails = [clone(dup.gstdetails[0]), clone(dup.gstdetails[0])];
    const pd = parsedOf(dup);
    check("duplicate-date", "two entries with one applicable-from are both kept and flagged (not silently merged)", [pd.details.length, pd.issues.map((i) => [i.severity, i.code])], [2, [["warning", "duplicate_applicable_from"]]]);
    const single = capturedItem(); single.gstdetails = clone(single.gstdetails[0]); // a lone object instead of an array
    check("single-object", "a lone object where an array is usual is read as one row", parsedOf(single).details.length, 1);
    const junk = capturedItem(); junk.gstdetails = [5, "x", clone(capturedItem().gstdetails[0])];
    const pj = parsedOf(junk);
    check("junk-entries", "non-object entries are skipped and reported; the valid entry survives", [pj.details.length, pj.issues.filter((i) => i.code === "malformed_entry").length], [1, 2]);
    const scalar = capturedItem(); scalar.gstdetails = "oops";
    check("scalar-section", "a scalar where a section belongs is reported as malformed_section", parsedOf(scalar).issues.map((i) => [i.section, i.code]), [["details", "malformed_section"]]);
    const badDate = capturedItem(); badDate.gstdetails[0].applicablefrom = "2017-07-01";
    const pb = parsedOf(badDate);
    check("bad-date", "a malformed applicable-from is reported; the entry keeps all its other data, undated", [pb.details.find((d) => d.taxability === "Taxable").applicableFrom, pb.issues.map((i) => i.code)], [null, ["malformed_date"]]);
    const itcOdd = capturedItem(); itcOdd.gstdetails[1].gstineligibleitc = "maybe";
    check("itc-malformed", "a malformed gstineligibleitc is reported and null, not coerced", [parsedOf(itcOdd).details[1].ineligibleItc, parsedOf(itcOdd).issues.map((i) => i.code)], [null, ["malformed_boolean"]]);
    check("case-insensitive-keys", "field names are matched case-insensitively (future Tally variation)", parsedOf({ GUID: { value: "x-5" }, GSTApplicable: "Applicable" }).applicability.gstApplicable, "Applicable");
  }

  // =========================================================== 5. merge rules (no database)
  console.log("\n=== 5. Merge: idempotence, corrections, partial / malformed / empty responses ===");
  {
    const NOW = new Date("2026-10-09T00:00:00Z");
    const LATER = new Date("2026-10-10T00:00:00Z");
    const first = mergeGst(undefined, parsedOf(capturedItem()), NOW);
    check("first-store", "a first sync stores the block with both history entries", [first.changed, first.gst.details.length, first.gst.hsn.length, first.gst.schemaVersion], [true, 2, 1, 1]);
    check("first-valid", "the stored block passes the schema", await validateGstBlock(first.gst), null);

    const again = mergeGst(first.gst, parsedOf(capturedItem()), LATER);
    check("idempotent", "the same Tally data again: not changed, same hash, same syncedAt, no duplicates", [again.changed, again.gst.contentHash, again.gst.syncedAt, again.gst.details.length], [false, first.gst.contentHash, NOW, 2]);

    // A re-read from the database may drop null-valued keys; the hash must not care.
    const stripped = JSON.parse(JSON.stringify(first.gst), (k, v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v));
    const strip = (o) => { if (Array.isArray(o)) o.forEach(strip); else if (o && typeof o === "object" && !(o instanceof Date)) { for (const k of Object.keys(o)) { if (o[k] === null) delete o[k]; else strip(o[k]); } } };
    strip(stripped);
    check("idempotent-after-readback", "stored data re-read without its null keys is still 'unchanged'", mergeGst(stripped, parsedOf(capturedItem()), LATER).changed, false);

    const corrected = capturedItem(); corrected.gstdetails[0].statewisedetails[0].ratedetails[2].gstrate = " 18"; // historical IGST corrected 12 -> 18
    const fixed = mergeGst(first.gst, parsedOf(corrected), LATER);
    check("correction", "a corrected historical rate replaces the old one: changed, still 2 entries (no duplicate)", [fixed.changed, fixed.gst.details.length, rateOf(fixed.gst.details[0], "igst").rate.value, fixed.gst.syncedAt], [true, 2, 18, LATER]);
    check("correction-latest-intact", "...and the other (latest) entry is untouched", JSON.stringify(fixed.gst.details[1]), JSON.stringify(first.gst.details[1]));

    const malformedNow = capturedItem(); malformedNow.gstdetails[0].statewisedetails[0].ratedetails[0].gstrate = "garbage";
    const kept = mergeGst(first.gst, parsedOf(malformedNow), LATER);
    check("malformed-keeps-previous", "a malformed rate does NOT overwrite a clean stored history", [kept.changed, kept.outcome.details, JSON.stringify(kept.gst.details) === JSON.stringify(first.gst.details)], [false, "kept_invalid", true]);
    check("malformed-others-applied", "...but the valid sections of the same record are still applied", kept.outcome.hsn, "applied");

    const firstBad = mergeGst(undefined, parsedOf(malformedNow), NOW);
    check("first-time-malformed", "with nothing stored yet, malformed data is stored but FLAGGED (not dropped, not turned into 0)",
      [firstBad.outcome.details, firstBad.gst.issues.filter((i) => i.severity === "error").length, rateOf(firstBad.gst.details[0], "cgst").rate], ["stored_with_issues", 1, { value: null, status: "malformed", raw: "garbage" }]);
    const healed = mergeGst(firstBad.gst, parsedOf(capturedItem()), LATER);
    check("heals", "a later clean response replaces the flagged data and clears the issue", [healed.outcome.details, healed.gst.issues.length, rateOf(healed.gst.details[0], "cgst").rate.value], ["applied", 0, 6]);

    // A response that is well-formed but hollow: history entries present WITHOUT their rate rows (for example the
    // nested rate methods were not honoured), or HSN rows without a code. Every real entry seen, Non-GST and
    // Exempt included, carries its rate rows, so a hollow answer is treated as incomplete, not as "rates removed".
    const hollow = capturedItem(); hollow.gstdetails.forEach((d) => { delete d.statewisedetails; });
    const hollowKept = mergeGst(first.gst, parsedOf(hollow), LATER);
    check("hollow-keeps-rates", "history entries that come back without their rate rows do not erase the stored rates", [hollowKept.changed, hollowKept.outcome.details, hollowKept.gst.details[0].stateRates[0].rates.length], [false, "kept_incomplete", 5]);
    const noCode = capturedItem(); noCode.hsndetails = [{ applicablefrom: "20170701" }];
    const noCodeKept = mergeGst(first.gst, parsedOf(noCode), LATER);
    check("hollow-keeps-hsn", "HSN rows that come back without a code do not erase the stored HSN code", [noCodeKept.changed, noCodeKept.outcome.hsn, noCodeKept.gst.hsn[0].code], [false, "kept_incomplete", "4820"]);
    check("hollow-first-time", "with nothing stored yet, a hollow answer is stored as it came (nothing is invented)", mergeGst(undefined, parsedOf(hollow), NOW).gst.details.map((d) => d.stateRates), [[], []]);
    const zeroRates = capturedItem(); zeroRates.gstdetails[0].statewisedetails[0].ratedetails = capturedRates("0", "0", "0");
    const zeroApplied = mergeGst(first.gst, parsedOf(zeroRates), LATER);
    check("hollow-is-not-zero", "explicit zero rates are real content, not hollow: a real change to all-zero rates is applied", [zeroApplied.changed, zeroApplied.outcome.details, rateOf(zeroApplied.gst.details[0], "igst").rate.value], [true, "applied", 0]);

    const noGst = mergeGst(first.gst, parsedOf({ guid: { value: `${COMPANY_GUID}-000007db` }, parent: { value: "SYNTHETIC GROUP" } }), LATER);
    check("absent-keeps", "a response with no GST keys at all does not erase stored GST", [noGst.changed, noGst.outcome, noGst.gst.details.length], [false, { applicability: "absent", hsn: "absent", details: "absent" }, 2]);
    const emptied = capturedItem(); emptied.gstdetails = []; emptied.hsndetails = [];
    const emptyKept = mergeGst(first.gst, parsedOf(emptied), LATER);
    check("empty-keeps", "present-but-empty history arrays do not erase stored history either", [emptyKept.changed, emptyKept.outcome.details, emptyKept.outcome.hsn, emptyKept.gst.details.length, emptyKept.gst.hsn.length], [false, "kept_empty", "kept_empty", 2, 1]);

    const shorter = capturedItem(); shorter.gstdetails = [shorter.gstdetails[1]];
    const shrunk = mergeGst(first.gst, parsedOf(shorter), LATER);
    check("shrink-visible", "a history that comes back shorter (a row deleted in Tally) is applied and flagged as shrunk", [shrunk.changed, shrunk.shrunk, shrunk.gst.details.length], [true, true, 1]);

    check("nothing-to-store", "an item with no GST data and nothing stored writes nothing", mergeGst(undefined, parsedOf({ guid: { value: "x-9" } }), NOW), { gst: null, changed: false, outcome: "no_gst_data" });

    const noisy = capturedItem(); noisy.gstdetails[0].statewisedetails[0].ratedetails = Array.from({ length: 40 }, () => rate("CGST", "Based on Value", "bad"));
    const capped = mergeGst(undefined, parsedOf(noisy), NOW);
    check("issues-capped", "at most 25 issues are stored, and the true count is kept", [capped.gst.issues.length, capped.gst.issueCount], [25, 40]);
    check("capped-block-valid", "a block carrying issues is schema-valid", await validateGstBlock(capped.gst), null);

    check("hash-key-order", "the content hash does not depend on key order or null keys", hashContent({ a: 1, b: { c: null, d: [1, { e: 2 }] } }), hashContent({ b: { d: [1, { e: 2 }] }, a: 1 }));

    const bad = clone(first.gst); bad.details[0].taxabilityKey = "not-a-key";
    check("schema-rejects-bad-enum", "the schema check rejects an out-of-range enum before it can be written", typeof (await validateGstBlock(bad)), "string");
    const doc = new StockItemMaster({ tenantId: "t", itemName: "i", stockGroupName: "g", tallyGuid: `${COMPANY_GUID}-1` });
    check("legacy-doc-valid", "a Stock Item without any gst (every existing record) is still valid", [await doc.validate().then(() => "valid"), doc.gst], ["valid", undefined]);
  }

  // =========================================================== 6. voucher-line GST
  console.log("\n=== 6. Voucher inventory-line GST stays on the voucher and does not change any amount ===");
  {
    // CAPTURED: the GST-related fields of one real voucher inventory line (values as received).
    const lineGst = {
      gsthsnname: "4820", gstovrdntaxability: "Taxable", gstovrdntypeofsupply: "Goods", gstovrdnisrevchargeappl: "\u0004 Not Applicable",
      gstovrdnstorednature: "\u0004 System Inferred", gstsourcetype: "Stock Item", hsnsourcetype: "Stock Item",
      gstrateinferapplicability: "As per Masters/Company", gsthsninferapplicability: "As per Masters/Company",
      ratedetails: capturedRates(" 6", " 6", " 12"),
    };
    const line = parseVoucherLineGst(lineGst);
    check("line-fields", "hsn / taxability / supply type / reverse charge are read from the line", [line.hsn, line.taxability, line.taxabilityKey, line.typeOfSupply, line.reverseCharge], ["4820", "Taxable", "taxable", "Goods", "Not Applicable"]);
    check("line-rates", "the line's own rate rows are kept per duty head", line.rates.map((r) => [r.dutyHeadKey, r.rate.value]), [["cgst", 6], ["sgst_utgst", 6], ["igst", 12], ["cess", 0], ["state_cess", 0]]);
    check("line-none", "a line with no GST fields yields null (so the old shape is unchanged)", parseVoucherLineGst({ stockitemname: "X", amount: "5" }), null);
    check("line-provenance", "the markers saying where the line's GST came from are kept verbatim (control character removed)", line.provenance,
      { storedNature: "System Inferred", gstSourceType: "Stock Item", hsnSourceType: "Stock Item", rateInference: "As per Masters/Company", hsnInference: "As per Masters/Company" });
    // Shapes seen in a real sales export in the repo: the same kind of line can be sourced from the Company settings,
    // or have its rate details specified on the voucher itself. The value alone does not say which.
    const fromCompany = parseVoucherLineGst({ gsthsnname: "12643", gstovrdntaxability: "Taxable", gstovrdnstorednature: "\u0004 System Inferred", gstsourcetype: "Company", hsnsourcetype: "Company", gstrateinferapplicability: "As per Masters/Company", gsthsninferapplicability: "As per Masters/Company", ratedetails: capturedRates(" 6", " 6", " 12") });
    const onVoucher = parseVoucherLineGst({ gstovrdntaxability: "Taxable", gstovrdnstorednature: "\u0004 System Inferred", gstrateinferapplicability: "Specify Details Here", gsthsninferapplicability: "As per Masters/Company", ratedetails: capturedRates(" 6", " 6", " 12") });
    check("line-provenance-company", "a line whose GST came from the Company settings says so (it is not the item master's)", [fromCompany.provenance.gstSourceType, fromCompany.provenance.hsnSourceType], ["Company", "Company"]);
    check("line-provenance-voucher", "a line with details specified on the voucher says so, and has no source type", [onVoucher.provenance.rateInference, onVoucher.provenance.gstSourceType], ["Specify Details Here", null]);
    check("line-no-provenance", "a line without any marker has no provenance object", parseVoucherLineGst({ gsthsnname: "4820" }), { hsn: "4820", taxability: null, taxabilityKey: null, typeOfSupply: null, reverseCharge: null, rates: [] });

    const inv = (o) => ({ actualqty: "6", rate: "150.00", amount: "900.00", ...o });
    const v = {
      vouchernumber: "G1", date: "20250815", partyname: "Synthetic Party", vouchertypename: "Sales", guid: `${COMPANY_GUID}-0000aa01`, alterid: "7",
      inventoryentries: [inv({ stockitemname: "Item With GST", ...lineGst }), inv({ stockitemname: "Item Without GST" })],
      ledgerentries: [{ ledgername: "Synthetic Party", amount: "-1062", isdeemedpositive: true }, { ledgername: "Sales", amount: "900", isdeemedpositive: false }, { ledgername: "CGST", amount: "81", isdeemedpositive: false }, { ledgername: "SGST", amount: "81", isdeemedpositive: false }],
    };
    const parsedV = parseTallyVoucher(v);
    check("voucher-gst-attached", "the parsed line that had GST fields carries them as `gst`", [parsedV.inventory[0].gst.hsn, parsedV.inventory[0].gst.rates.length], ["4820", 5]);
    check("voucher-old-shape", "the line without GST fields has EXACTLY its old shape (no gst key at all)", Object.keys(parsedV.inventory[1]).sort(), ["amount", "discountAmount", "discountPercentage", "itemName", "quantity", "rate"]);
    check("voucher-amounts", "amounts, quantity, rate and the invoice total are unchanged by the GST fields",
      [parsedV.inventory[0].amount, parsedV.inventory[0].quantity, parsedV.inventory[0].rate, parsedV.header.voucherTotalAmount], [900, 6, 150, 1062]);

    const sale = mapTallySale(parsedV, { tenantId: "TEST-T" });
    check("sale-map-gst", "the sales mapper passes the line GST through untouched", [sale.inventory[0].gst.hsn, sale.inventory[0].amount], ["4820", 900]);
    check("sale-map-old", "...and a line without it maps to exactly the old fields", Object.keys(sale.inventory[1]).sort(), ["amount", "discountAmount", "discountPercentage", "itemName", "quantity", "rate"]);
    const purchase = mapTallyPurchase(parseTallyVoucher({ ...v, vouchertypename: "Purchase" }), { tenantId: "TEST-T" });
    check("purchase-map-gst", "the purchase mapper does the same", [purchase.inventory[0].gst.taxability, Object.prototype.hasOwnProperty.call(purchase.inventory[1], "gst")], ["Taxable", false]);

    // Optional GST data must never be able to block a voucher: a voucher that fails validation holds up the sync
    // checkpoint. Feed every GST key every hostile value and require the Sale and Purchase documents to stay valid.
    const hostile = [null, undefined, "", "  ", "\u0004", 0, -1, 1e308, NaN, Infinity, true, false, [], {}, [1, 2], { a: 1 }, { value: { x: 1 } }, "x".repeat(5000), "\u0000\u0001\u0002", [{ metadata: true }], [{ metadata: true }, "v"], "<script>alert(1)</script>", { $gt: "" }];
    const scalarKeys = ["gsthsnname", "gstovrdntaxability", "gstovrdntypeofsupply", "gstovrdnisrevchargeappl", "gstovrdnstorednature", "gstsourcetype", "hsnsourcetype", "gstrateinferapplicability", "gsthsninferapplicability"];
    const hostileRates = [[null], [5], ["x"], [[]], [{}], [{ gstrate: {} }], [{ gstratedutyhead: ["a"], gstrate: "abc", gstrateperunit: NaN }], { gstrate: "5" }, [{ gstrate: "1e999" }], [{ gstratedutyhead: "X".repeat(5000), gstratevaluationtype: {}, gstrate: " 6" }], "not-a-list", 12, true, [[{ gstrate: "1" }]], [{ gstrate: [1], gstrateperunit: { value: "2" } }]];
    const cases = [
      ...scalarKeys.flatMap((k) => hostile.map((val) => ({ [k]: val }))),
      ...hostileRates.map((val) => ({ ratedetails: val })),
      Object.fromEntries(scalarKeys.map((k) => [k, { a: [1, { b: 2 }] }])),
    ];
    const invalid = [];
    let threw = 0;
    for (const extra of cases) {
      const hv = { ...v, inventoryentries: [inv({ stockitemname: "Hostile", ...lineGst, ...extra })] };
      try {
        const mapped = mapTallySale(parseTallyVoucher(hv), { tenantId: "TEST-T" });
        const mappedP = mapTallyPurchase(parseTallyVoucher({ ...hv, vouchertypename: "Purchase" }), { tenantId: "TEST-T" });
        for (const doc of [new Sale(mapped), new Purchase(mappedP)]) {
          try { await doc.validate(); } catch (e) { invalid.push(`${Object.keys(extra)[0]}=${JSON.stringify(Object.values(extra)[0])}: ${String(e.message).slice(0, 90)}`); }
        }
      } catch (e) { threw += 1; invalid.push(`THREW ${Object.keys(extra)[0]}: ${e.message.slice(0, 90)}`); }
    }
    check("hostile-values-never-block-a-voucher", `${cases.length} hostile GST inputs (objects, arrays, NaN, huge strings, control characters, operators): every Sale and Purchase document still validates and the parser never throws`, [invalid.slice(0, 3), threw], [[], 0]);
    const hostileAmounts = mapTallySale(parseTallyVoucher({ ...v, inventoryentries: [inv({ stockitemname: "Hostile", ...lineGst, ratedetails: hostileRates[6], gsthsnname: { a: 1 } })] }), { tenantId: "TEST-T" });
    check("hostile-values-leave-amounts-alone", "...and hostile GST values never change the amount, quantity or invoice total", [hostileAmounts.inventory[0].amount, hostileAmounts.inventory[0].quantity, hostileAmounts.header.voucherTotalAmount], [900, 6, 1062]);

    // The voucher says Taxable in August 2025; the item's CURRENT master says Non-GST from 2025-09-22. Both are true.
    const master = parsedOf(capturedItem());
    check("distinct-sources", "the voucher line's own taxability is not rewritten from the master (they differ by date and both stay)",
      [sale.inventory[0].gst.taxability, resolveGstAsOf(master, "2026-10-09").details.taxability, resolveGstAsOf(master, "2025-08-15").details.taxability], ["Taxable", "Non-GST", "Taxable"]);
  }

  // =========================================================== 7. no tax figure is derived
  console.log("\n=== 7. Unsupported tax-inclusive product queries cannot produce a fabricated amount ===");
  {
    const ref = { referenceDate: new Date(2026, 9, 9) };
    const base = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, filters: [], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 5 };
    check("baseline-valid", "baseline: the pre-tax product ranking plan is valid", validateQueryPlan({ ...base, metrics: ["lineAmount"] }, ref).ok, true);
    for (const metric of ["taxInclusiveLineAmount", "lineAmountIncludingTax", "gstAmount", "taxAmount", "lineAmountWithGst"]) {
      check(`metric-${metric}`, `a plan asking for the metric '${metric}' is refused`, validateQueryPlan({ ...base, metrics: [metric], sort: [] }, ref).ok, false);
    }
    for (const dim of ["hsn", "gstRate", "taxability", "hsnCode"]) {
      check(`dimension-${dim}`, `grouping by '${dim}' is refused`, validateQueryPlan({ ...base, metrics: ["lineAmount"], groupBy: [{ dim }] }, ref).ok, false);
      check(`filter-${dim}`, `filtering by '${dim}' is refused`, validateQueryPlan({ ...base, metrics: ["lineAmount"], groupBy: [], sort: [], filters: [{ dim, op: "eq_ci", value: "4820" }] }, ref).ok, false);
    }
    const lineMetrics = Object.values(CATALOG.metrics).filter((m) => /line/i.test(m.grain || "") || /line_item/.test(m.amountBasis || ""));
    check("no-line-level-tax-inclusive", "no catalog metric is a line-level tax-inclusive amount", lineMetrics.some((m) => /incl/.test(m.amountBasis || "")), false);
    check("tax-breakdown-unsupported", "the catalog still declares tax amounts as unsupported", CATALOG.unsupported.some((u) => u.id === "tax_breakdown"), true);

    // A product-level amount is stated as pre-tax and not an invoice total.
    const result = { ok: true, entity: "sales", mode: "aggregate", grain: "line", period: { kind: "custom", label: "Custom range", isPartial: false }, comparison: null, metrics: ["lineAmount"], groupBy: [{ dim: "product" }],
      amountBasis: { lineAmount: "line_item_pre_tax" }, rows: [{ key: { product: "Item A" }, values: { lineAmount: 900 } }], totals: { values: { lineAmount: 900 } }, truncated: false, rowLimit: 5, warnings: [], assumptions: [] };
    const answer = formatQueryAnswer({ plan: { ...base, metrics: ["lineAmount"] }, result });
    check("answer-states-pretax", "a product-level answer says it is pre-tax and does not add up to invoice totals", /pre-tax item values/.test(answer.text) && /do not add up to total sales/.test(answer.text), true);

    // Nothing that answers questions reads the stored GST.
    const roots = ["src/services/query", "src/services/analytics", "src/controllers"];
    const offenders = [];
    for (const root of roots) {
      for (const file of fs.readdirSync(path.join(__dirname, root)).filter((f) => f.endsWith(".js"))) {
        const text = fs.readFileSync(path.join(__dirname, root, file), "utf8");
        if (/gstFields|stockItemGst|gstSchemas|resolveGstAsOf|\.gst\.(?:details|hsn|applicability)|inventory\.gst|\$gst\b/.test(text)) offenders.push(`${root}/${file}`);
      }
    }
    check("engine-does-not-read-gst", "the query engine, analytics and controllers never read Stock Item or voucher-line GST", offenders, []);
  }

})();
}

// ================================================================ PART 2: persistence and sync
// (its helpers stay private to this function; check() and the counters are shared with part 1)
async function partSync() {
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const { refreshStockItemMasters } = require("./src/services/tally/stockItemMaster");
const { parseTallyVoucher } = require("./src/services/parser/tallyParser");
const { mapTallySale } = require("./src/services/mapper/salesMapper");
const { mapTallyPurchase } = require("./src/services/mapper/purchaseMapper");
const { executeQuery } = require("./src/services/query/execute");
const { getTenantVersion } = require("./src/services/query/dataVersion");

const TENANT_A = "TEST-TENANT-A-gst-sync";
const TENANT_B = "TEST-TENANT-B-gst-sync";
const GA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // synthetic company GUIDs
const GB = "bbbbbbbb-0000-4000-8000-0000000000b2";

// ---------------------------------------------------------------- Tally-shaped builders

const tallyResponse = (collection) => ({ status: "1", data: { metadata: {}, collection } });
const coreRecord = ({ name, parent, guid }) => ({ metadata: { type: "Stock Item", name, reservedname: "" }, guid: { type: "String", value: guid }, parent: { type: "String", value: parent } });
const coreFetcherOf = (items) => async () => tallyResponse(items.map(coreRecord));

const rate = (head, valuation, r) => ({ gstratedutyhead: head, gstratevaluationtype: valuation, gstrate: r, gstrateperunit: "0" });
const rates = (cgst, sgst, igst) => [rate("CGST", "Based on Value", cgst), rate("SGST/UTGST", "Based on Value", sgst), rate("IGST", "Based on Value", igst), rate("Cess", "\u0004 Not Applicable", "0"), rate("State Cess", "Based on Value", "0")];

// The captured real shape (names replaced): Taxable from 2017, Non-GST from 2025-09-22.
function gstRecord({ guid, parent, igst = " 12", exempt = false }) {
  return {
    metadata: { type: "Stock Item", name: "SYNTHETIC", reservedname: "" },
    guid: { type: "String", value: guid },
    parent: { type: "String", value: parent },
    gstapplicable: { type: "String", value: "\u0004 Applicable" },
    gsttypeofsupply: { type: "String", value: "Goods" },
    gstdetails: exempt
      ? [{ applicablefrom: "20250929", taxability: "Exempt", srcofgstdetails: "Specify Details Here", reversechargerate: "0", statewisedetails: [{ statename: "\u0004 Any", ratedetails: rates("0", "0", "0") }] }]
      : [
          { applicablefrom: "20170701", taxability: "Taxable", srcofgstdetails: "Specify Details Here", reversechargerate: "0", statewisedetails: [{ statename: "\u0004 Any", ratedetails: rates(" 6", " 6", igst) }] },
          { applicablefrom: "20250922", taxability: "Non-GST", srcofgstdetails: "Specify Details Here", gstineligibleitc: true, reversechargerate: "0", statewisedetails: [{ statename: "\u0004 Any", ratedetails: rates("0", "0", "0") }] },
        ],
    hsndetails: [{ applicablefrom: "20170701", hsncode: "4820", srcofhsndetails: "Specify Details Here" }],
  };
}
const bareRecord = ({ guid, parent }) => ({ metadata: { type: "Stock Item", name: "SYNTHETIC", reservedname: "" }, guid: { type: "String", value: guid }, parent: { type: "String", value: parent } });

// A fetcher that records every call and proves requests never overlap.
function makeGstFetcher(byGroup, { throwFor = [], raw = {} } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const fn = async ({ stockGroupName }) => {
    calls.push(stockGroupName);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (throwFor.includes(stockGroupName)) throw new Error("simulated Tally failure");
    if (stockGroupName in raw) return raw[stockGroupName];
    return tallyResponse(byGroup[stockGroupName] || []);
  };
  fn.calls = calls;
  fn.maxActive = () => maxActive;
  return fn;
}

async function cleanup() {
  const ids = { $in: [TENANT_A, TENANT_B] };
  await Promise.all([StockItemMaster.deleteMany({ tenantId: ids }), Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids })]);
}

const docOf = (tenantId, itemName) => StockItemMaster.findOne({ tenantId, itemName }).lean();
const refreshA = (core, gstFetcher, extra = {}) => refreshStockItemMasters({ tenantId: TENANT_A, companyGuid: GA, fetcher: coreFetcherOf(core), gstFetcher, ...extra });

// ---------------------------------------------------------------- the run

async function run() {
  const A1 = { name: "Item A1", parent: "Group Alpha", guid: `${GA}-00000a01` };
  const A2 = { name: "Item A2", parent: "Group Alpha", guid: `${GA}-00000a02` };
  const A3 = { name: "Item A3", parent: "Group Beta", guid: `${GA}-00000a03` };
  const A4 = { name: "Shared Item Name", parent: "Group Beta", guid: `${GA}-00000a04` };
  const CORE = [A1, A2, A3, A4];
  const DATA = () => ({
    "Group Alpha": [gstRecord({ guid: A1.guid, parent: "Group Alpha" }), gstRecord({ guid: A2.guid, parent: "Group Alpha", exempt: true })],
    "Group Beta": [bareRecord({ guid: A3.guid, parent: "Group Beta" }), gstRecord({ guid: A4.guid, parent: "Group Beta" })],
  });

  // Vouchers whose totals must not move (section 10).
  const v = (no, guid, type, itemName, amount) => ({
    vouchernumber: no, date: "20250815", partyname: "Synthetic Party", vouchertypename: type, guid, alterid: "5",
    inventoryentries: [{ stockitemname: itemName, actualqty: "6", rate: "150.00", amount: String(amount), gsthsnname: "4820", gstovrdntaxability: "Taxable", gstovrdntypeofsupply: "Goods", ratedetails: rates(" 6", " 6", " 12") }],
    ledgerentries: [{ ledgername: "Synthetic Party", amount: String(type === "Sales" ? -1062 : 1062), isdeemedpositive: type === "Sales" }, { ledgername: type, amount: String(type === "Sales" ? 900 : -900), isdeemedpositive: type !== "Sales" }],
  });
  const saleDoc = await Sale.create(mapTallySale(parseTallyVoucher(v("S1", `${GA}-0000f001`, "Sales", A1.name, 900)), { tenantId: TENANT_A }));
  await Purchase.create(mapTallyPurchase(parseTallyVoucher(v("P1", `${GA}-0000f002`, "Purchase", A1.name, -900)), { tenantId: TENANT_A }));

  const queries = [
    { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] },
    { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["lineAmount", "quantity"], groupBy: [{ dim: "productGroup" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10, filters: [] },
    { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["lineAmount"], groupBy: [{ dim: "product" }], sort: [{ by: "lineAmount", dir: "desc" }], limit: 10, filters: [] },
    { v: 1, entity: "purchase", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["purchaseAmount", "purchaseInvoiceCount"], filters: [] },
  ];
  const runQueries = async () => {
    const out = [];
    for (const q of queries) {
      const r = await executeQuery(q, { tenantId: TENANT_A, referenceDate: new Date(2026, 9, 9) });
      out.push({ ok: r.ok, totals: r.totals, rows: r.rows });
    }
    return out;
  };
  const voucherSnapshot = async () => JSON.stringify([await Sale.findOne({ tenantId: TENANT_A }).lean(), await Purchase.findOne({ tenantId: TENANT_A }).lean()]);

  // The core refresh once WITHOUT GST, so the "before" answers use only today's data.
  const core0 = await refreshA(CORE, undefined);
  check("setup-core", "setup: the core refresh (no GST) writes the 4 items and never touches live Tally", [core0.ok, core0.usable, core0.gst], [true, 4, { attempted: false }]);
  const queriesBefore = await runQueries();
  const vouchersBefore = await voucherSnapshot();
  check("setup-queries-ok", "setup: the baseline engine queries all succeed on the synthetic vouchers", queriesBefore.map((q) => q.ok), [true, true, true, true]);
  const versionBefore = await getTenantVersion(TENANT_A);

  // ------------------------------------------------------------ 1. persisted after a sync
  console.log("=== 1. GST is requested group by group, persisted, and the core fields are unchanged ===");
  const f1 = makeGstFetcher(DATA());
  const r1 = await refreshA(CORE, f1);
  check("s1-core", "the core result is unchanged in shape and counts", [r1.ok, r1.usable, r1.unusable, r1.distinctStockGroups, r1.totalFetched], [true, 4, 0, 2, 4]);
  check("s1-groups", "one request per Stock Group, in order", f1.calls, ["Group Alpha", "Group Beta"]);
  check("s1-sequential", "requests never overlap (one at a time)", f1.maxActive(), 1);
  check("s1-summary", "GST summary: 4 records matched, 3 updated, 1 item with no GST data, nothing aborted", [r1.gst.groupsFetched, r1.gst.recordsReceived, r1.gst.matched, r1.gst.updated, r1.gst.withoutGstData, r1.gst.unchanged, r1.gst.aborted], [2, 4, 4, 3, 1, 0, null]);
  const d1 = await docOf(TENANT_A, "Item A1");
  check("s1-history", "the full dated history is stored (2 entries) with real Date values", [d1.gst.details.length, d1.gst.details[0].applicableFrom instanceof Date, d1.gst.details[0].applicableFrom.toISOString().slice(0, 10), d1.gst.details[1].taxability], [2, true, "2017-07-01", "Non-GST"]);
  check("s1-interval", "each entry's last effective day is derived; the latest is open-ended", [d1.gst.details[0].effectiveTo.toISOString().slice(0, 10), d1.gst.details[1].effectiveTo], ["2025-09-21", null]);
  check("s1-rates", "rates per duty head are stored separately, zero kept as a real value", [d1.gst.details[0].stateRates[0].rates.map((r) => r.rate.value), d1.gst.details[1].stateRates[0].rates[0].rate.status], [[6, 6, 12, 0, 0], "value"]);
  check("s1-hsn-applicability", "HSN and applicability are stored", [d1.gst.hsn[0].code, d1.gst.applicability.gstApplicableKey, d1.gst.applicability.typeOfSupply], ["4820", "applicable", "Goods"]);
  check("s1-exempt", "an Exempt item is stored as exempt with explicit zero rates (observed shape)", [(await docOf(TENANT_A, "Item A2")).gst.details.map((d) => d.taxabilityKey)], [["exempt"]]);
  const d3 = await docOf(TENANT_A, "Item A3");
  check("s1-no-gst-no-field", "an item Tally returned with no GST keys gets no gst field (not an empty/zero one)", "gst" in d3, false);
  check("s1-core-fields", "the core fields of every item are exactly as the core refresh wrote them",
    (await StockItemMaster.find({ tenantId: TENANT_A }).sort({ itemName: 1 }).lean()).map((d) => [d.itemName, d.stockGroupName, d.tallyGuid]),
    [[A1.name, A1.parent, A1.guid], [A2.name, A2.parent, A2.guid], [A3.name, A3.parent, A3.guid], [A4.name, A4.parent, A4.guid]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  check("s1-version", "writing GST bumps the tenant's data version (cached answers are invalidated)", (await getTenantVersion(TENANT_A)) !== versionBefore, true);

  // ------------------------------------------------------------ 2. idempotent
  console.log("\n=== 2. Repeated sync is idempotent ===");
  const hashBefore = (await docOf(TENANT_A, "Item A1")).gst.contentHash;
  const stampBefore = (await docOf(TENANT_A, "Item A1")).gst.syncedAt.getTime();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const r2 = await refreshA(CORE, makeGstFetcher(DATA()));
  check("s2-counts", "second run: nothing updated, 3 unchanged, 1 without GST", [r2.gst.updated, r2.gst.unchanged, r2.gst.withoutGstData], [0, 3, 1]);
  const d2 = await docOf(TENANT_A, "Item A1");
  check("s2-same", "same hash, same GST timestamp, still exactly 2 history entries and 1 HSN entry", [d2.gst.contentHash === hashBefore, d2.gst.syncedAt.getTime() === stampBefore, d2.gst.details.length, d2.gst.hsn.length], [true, true, 2, 1]);
  check("s2-doc-count", "no duplicate Stock Item documents", await StockItemMaster.countDocuments({ tenantId: TENANT_A }), 4);

  // ------------------------------------------------------------ 3. core-only refresh keeps GST
  console.log("\n=== 3. Existing callers (core fetcher only) and --skip-gst never touch live Tally or stored GST ===");
  const r3 = await refreshStockItemMasters({ tenantId: TENANT_A, companyGuid: GA, fetcher: coreFetcherOf(CORE) });
  check("s3-no-gst-phase", "a caller that stubs only the core fetcher gets no GST phase (cannot reach live Tally)", r3.gst, { attempted: false });
  const r3b = await refreshA(CORE, makeGstFetcher(DATA()), { includeGst: false });
  check("s3-skip", "includeGst:false skips the GST phase", r3b.gst, { attempted: false });
  check("s3-kept", "stored GST survives a core refresh", (await docOf(TENANT_A, "Item A1")).gst.contentHash, hashBefore);

  // ------------------------------------------------------------ 4. historical correction
  console.log("\n=== 4. A corrected historical rate replaces the old one without duplicating history ===");
  const corrected = DATA();
  corrected["Group Alpha"][0] = gstRecord({ guid: A1.guid, parent: "Group Alpha", igst: " 18" });
  const r4 = await refreshA(CORE, makeGstFetcher(corrected));
  const d4 = await docOf(TENANT_A, "Item A1");
  check("s4-counts", "exactly the corrected item is updated", [r4.gst.updated, r4.gst.unchanged], [1, 2]);
  check("s4-replaced", "the 2017 IGST is now 18, still 2 entries, still 1 HSN entry", [d4.gst.details[0].stateRates[0].rates[2].rate.value, d4.gst.details.length, d4.gst.hsn.length], [18, 2, 1]);
  check("s4-latest-intact", "the latest entry is untouched", d4.gst.details[1].taxability, "Non-GST");
  check("s4-hash-changed", "the content hash changed", d4.gst.contentHash !== hashBefore, true);

  // ------------------------------------------------------------ 5. partial / malformed / failed responses
  console.log("\n=== 5. Partial, malformed, empty or failed responses never destroy stored GST ===");
  const gstJson = async (tenantId, itemName) => JSON.stringify((await docOf(tenantId, itemName)).gst);
  const goodA1 = await gstJson(TENANT_A, "Item A1");
  const owned = async (tenantId) => JSON.stringify((await StockItemMaster.find({ tenantId }).sort({ itemName: 1 }).lean()).map((d) => [d.itemName, d.stockGroupName, d.tallyGuid, d.gst]));
  const goodAll = () => owned(TENANT_A);
  const base5 = await goodAll();
  const current = () => ({ ...DATA(), "Group Alpha": [gstRecord({ guid: A1.guid, parent: "Group Alpha", igst: " 18" }), gstRecord({ guid: A2.guid, parent: "Group Alpha", exempt: true })] });

  const malformed = current();
  malformed["Group Alpha"][0].gstdetails[0].statewisedetails[0].ratedetails[0].gstrate = "garbage";
  const r5a = await refreshA(CORE, makeGstFetcher(malformed));
  check("s5a-kept", "a malformed rate keeps the stored history: item counted as invalid, nothing written", [r5a.gst.keptPreviousInvalid, r5a.gst.invalid, r5a.gst.updated], [1, 1, 0]);
  check("s5a-identical", "every item's GST (and identity) is byte-identical afterwards", await goodAll(), base5);
  check("s5a-diagnosable", "the result says which item and what was malformed (path, code, offending text)", r5a.gst.invalidSample,
    [{ tallyGuid: A1.guid, reason: "gstdetails[0].statewisedetails[0].ratedetails[0].gstrate malformed_number (garbage)" }]);

  const r5b = await refreshA(CORE, makeGstFetcher(current(), { throwFor: ["Group Alpha"] }));
  check("s5b-failed-group", "a failed group is named; the other group is still processed", [r5b.gst.groupsFailed.map((g) => g.group), r5b.gst.groupsFetched], [["Group Alpha"], 1]);
  check("s5b-kept", "the failed group's items keep their GST", await gstJson(TENANT_A, "Item A1"), goodA1);
  check("s5b-unfetched", "the items in the unfetched group are reported", r5b.gst.itemsInUnfetchedGroups, 2);

  const r5c = await refreshA(CORE, makeGstFetcher({ ...current(), "Group Alpha": [] }));
  check("s5c-empty-group", "a group that answers with nothing is reported as empty and changes nothing", [r5c.gst.groupsEmpty, (await gstJson(TENANT_A, "Item A1")) === goodA1], [["Group Alpha"], true]);

  const r5d = await refreshA(CORE, makeGstFetcher(current(), { raw: { "Group Alpha": "not json {" } }));
  check("s5d-unparseable", "an unparseable response fails that group only", [r5d.gst.groupsFailed.map((g) => g.group), (await gstJson(TENANT_A, "Item A1")) === goodA1], [["Group Alpha"], true]);

  const r5e = await refreshA(CORE, makeGstFetcher(current(), { raw: { "Group Alpha": { status: "1", data: {} } } }));
  check("s5e-no-collection", "a response with no collection is treated as empty", r5e.gst.groupsEmpty, ["Group Alpha"]);

  const noHistory = current();
  noHistory["Group Alpha"][0].gstdetails = []; noHistory["Group Alpha"][0].hsndetails = [];
  const r5f = await refreshA(CORE, makeGstFetcher(noHistory));
  check("s5f-empty-history", "empty history arrays do not erase stored history", [r5f.gst.keptPreviousEmpty, r5f.gst.updated, (await gstJson(TENANT_A, "Item A1")) === goodA1], [1, 0, true]);

  const stripped = current();
  stripped["Group Alpha"][0] = bareRecord({ guid: A1.guid, parent: "Group Alpha" });
  const r5g = await refreshA(CORE, makeGstFetcher(stripped));
  check("s5g-no-gst-keys", "a record that comes back without any GST keys does not erase stored GST", [r5g.gst.updated, (await gstJson(TENANT_A, "Item A1")) === goodA1], [0, true]);

  // a well-formed but hollow answer (history entries without their rate rows, HSN rows without a code)
  const hollow = current();
  hollow["Group Alpha"][0].gstdetails.forEach((d) => { delete d.statewisedetails; });
  hollow["Group Alpha"][0].hsndetails = [{ applicablefrom: "20170701" }];
  const r5j = await refreshA(CORE, makeGstFetcher(hollow));
  check("s5j-hollow", "history entries without rate rows / HSN rows without a code keep the stored values: counted, nothing written", [r5j.gst.keptPreviousIncomplete, r5j.gst.updated, (await gstJson(TENANT_A, "Item A1")) === goodA1], [1, 0, true]);

  // an item that had no GST gets it once Tally returns it
  const withA3 = current();
  withA3["Group Beta"][0] = gstRecord({ guid: A3.guid, parent: "Group Beta" });
  const r5h = await refreshA(CORE, makeGstFetcher(withA3));
  check("s5h-late-gst", "an item that had no GST gets it when Tally returns it", [r5h.gst.updated, (await docOf(TENANT_A, "Item A3")).gst.details.length], [1, 2]);

  // first-ever sync with a malformed value: stored and flagged, not dropped and not turned into zero
  const firstBad = current();
  firstBad["Group Beta"][1] = gstRecord({ guid: A4.guid, parent: "Group Beta" });
  firstBad["Group Beta"][1].gstdetails[0].statewisedetails[0].ratedetails[2].gstrate = "n/a";
  await StockItemMaster.updateOne({ tenantId: TENANT_A, tallyGuid: A4.guid }, { $unset: { gst: 1 } });
  const r5i = await refreshA(CORE, makeGstFetcher(firstBad));
  const d5i = await docOf(TENANT_A, "Shared Item Name");
  check("s5i-flagged", "with nothing stored, a malformed rate is stored flagged (status malformed, null value) with the issue recorded",
    [r5i.gst.storedWithIssues, d5i.gst.details[0].stateRates[0].rates[2].rate, d5i.gst.issues.map((i) => i.code)], [1, { value: null, status: "malformed", raw: "n/a" }, ["malformed_number"]]);

  // ------------------------------------------------------------ 6. an unsafe group name
  console.log("\n=== 6. A group whose name cannot be placed in a formula is skipped and reported ===");
  const A5 = { name: "Item A5", parent: 'Bad"Group', guid: `${GA}-00000a05` };
  const f6 = makeGstFetcher(current());
  const r6 = await refreshA([...CORE, A5], f6);
  check("s6-skipped", "the unsafe group is skipped, never sent to Tally, and named in the result", [r6.gst.groupsSkipped.map((g) => g.group), f6.calls.includes('Bad"Group')], [['Bad"Group'], false]);
  check("s6-others", "the other groups are processed normally", f6.calls, ["Group Alpha", "Group Beta"]);
  check("s6-item-kept", "the item in the skipped group exists with its core fields and no GST", [(await docOf(TENANT_A, "Item A5")).stockGroupName, "gst" in (await docOf(TENANT_A, "Item A5"))], ['Bad"Group', false]);
  await StockItemMaster.deleteOne({ tenantId: TENANT_A, tallyGuid: A5.guid });

  // ------------------------------------------------------------ 7. tenant / company isolation
  console.log("\n=== 7. Tenant and company isolation ===");
  const B1 = { name: "Shared Item Name", parent: "Group Beta", guid: `${GB}-00000b01` };
  const rb = await refreshStockItemMasters({
    tenantId: TENANT_B, companyGuid: GB, fetcher: coreFetcherOf([B1]),
    gstFetcher: makeGstFetcher({ "Group Beta": [gstRecord({ guid: B1.guid, parent: "Group Beta", igst: " 28" })] }),
  });
  check("s7-b-ok", "tenant B refreshes independently", [rb.ok, rb.gst.updated], [true, 1]);
  const sharedA = await docOf(TENANT_A, "Shared Item Name");
  const sharedB = await docOf(TENANT_B, "Shared Item Name");
  check("s7-same-name-own-gst", "the same item name in two tenants keeps each tenant's own GST", [sharedA.gst.details[0].stateRates[0].rates[2].rate.value, sharedB.gst.details[0].stateRates[0].rates[2].rate.value], [12, 28]);
  check("s7-b-guid", "each tenant's item keeps its own company's GUID", [sharedA.tallyGuid.startsWith(GA), sharedB.tallyGuid.startsWith(GB)], [true, true]);

  const snapA = await goodAll();
  const snapB = await owned(TENANT_B);
  const foreign = makeGstFetcher({ ...current(), "Group Beta": [gstRecord({ guid: B1.guid, parent: "Group Beta", igst: " 99" })] });
  const rf = await refreshA(CORE, foreign);
  check("s7-foreign-aborts", "a GST response carrying another company's GUID aborts the GST phase (fail closed)", [typeof rf.gst.aborted, /ownership/.test(rf.gst.aborted || "")], ["string", true]);
  check("s7-foreign-stops", "no further group is requested after the rejection", foreign.calls, ["Group Alpha", "Group Beta"]);
  check("s7-foreign-no-write", "nothing was written for either tenant", [await goodAll(), await owned(TENANT_B)], [snapA, snapB]);
  check("s7-core-still-ok", "the core refresh in the same call still succeeded", rf.ok, true);

  const countA = await StockItemMaster.countDocuments({ tenantId: TENANT_A });
  const unknown = current();
  unknown["Group Alpha"].push(gstRecord({ guid: `${GA}-00000fff`, parent: "Group Alpha" })); // a GUID that is not in the core list
  unknown["Group Alpha"].push(gstRecord({ guid: A2.guid, parent: "Some Other Group" })); // right GUID, wrong group
  const ru = await refreshA(CORE, makeGstFetcher(unknown));
  check("s7-unknown-guid", "a GST record for a GUID that is not a known item is counted and creates nothing", [ru.gst.notInCoreList, await StockItemMaster.countDocuments({ tenantId: TENANT_A })], [1, countA]);
  check("s7-group-mismatch", "a record whose group differs from the item's is counted and skipped", ru.gst.groupMismatch, 1);
  check("s7-identity-by-guid", "records are matched by GUID, never by name", (await docOf(TENANT_A, "Item A2")).gst.details[0].taxabilityKey, "exempt");

  // ------------------------------------------------------------ 8. an item moved to another group
  console.log("\n=== 8. An item moved to another Stock Group keeps its identity and gets its GST under the new group ===");
  const moved = [A1, { ...A2, parent: "Group Beta" }, A3, A4];
  const movedData = { "Group Alpha": [gstRecord({ guid: A1.guid, parent: "Group Alpha", igst: " 18" })], "Group Beta": [gstRecord({ guid: A2.guid, parent: "Group Beta", exempt: true }), bareRecord({ guid: A3.guid, parent: "Group Beta" }), gstRecord({ guid: A4.guid, parent: "Group Beta" })] };
  const rm = await refreshA(moved, makeGstFetcher(movedData));
  const dm = await docOf(TENANT_A, "Item A2");
  check("s8-moved", "same document, new group, GST intact", [dm.tallyGuid, dm.stockGroupName, dm.gst.details[0].taxabilityKey], [A2.guid, "Group Beta", "exempt"]);
  check("s8-matched", "the moved item was matched under its new group", rm.gst.groupMismatch, 0);

  // ------------------------------------------------------------ 9. vouchers and answers unchanged
  console.log("\n=== 9. Voucher-level GST stays on the vouchers; totals and product-group answers are unchanged ===");
  check("s9-vouchers-identical", "the stored sales and purchase vouchers are byte-identical after every GST refresh above", await voucherSnapshot(), vouchersBefore);
  const sale = await Sale.findOne({ tenantId: TENANT_A }).lean();
  check("s9-line-gst", "the voucher line still carries its own snapshot (Taxable, 4820, its own rate rows)", [sale.inventory[0].gst.taxability, sale.inventory[0].gst.hsn, sale.inventory[0].gst.rates.length], ["Taxable", "4820", 5]);
  check("s9-amounts", "voucher total, line amount and discount fields are as posted", [sale.header.voucherTotalAmount, sale.inventory[0].amount, sale.inventory[0].discountPercentage, sale.inventory[0].discountAmount], [1062, 900, 0, 0]);
  const queriesAfter = await runQueries();
  check("s9-engine-same", "invoice totals, product ranking, product-group ranking and purchases return exactly what they did before any GST was stored", queriesAfter, queriesBefore);
  check("s9-group-answer", "...and the product-group answer is the real one (item A1 is in Group Alpha)", queriesAfter[1].rows.map((r) => [r.key.productGroup, r.values.lineAmount]), [["Group Alpha", 900]]);
  void saleDoc;
}

async function runSyncPart() {
  await connectDB();
  await cleanup();
  try {
    await run();
  } finally {
    await cleanup();
  }
}
await runSyncPart();
}

(async () => {
  await partParsing();
  await partSync();
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});

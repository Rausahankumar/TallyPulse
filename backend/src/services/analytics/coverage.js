"use strict";

// --------------------------------------------------
// Data coverage: "there were no sales" vs "TallyPulse has no data for that period".
//
// The synced history window is [first active voucher, last active voucher] of the tenant (Sales and Purchase
// together - a sync covers both), taken from the per-turn tenant date context (analytics/referenceDate.js).
// A period (or comparison period) that lies before or after that window is MISSING data, never a zero.
//
// Pure and deterministic: no I/O, no Claude. Every message is fixed text built from dates the engine resolved.
// Nothing here changes a figure; it only decides whether a figure may be shown and which caveat it carries.
// --------------------------------------------------

const dateRanges = require("./dateRanges");

const fmtDay = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const rangeText = (r) => {
  const a = fmtDay(r.from);
  const b = fmtDay(r.to);
  return a === b ? a : `${a} – ${b}`;
};

/**
 * Where [from, to] lies relative to the synced window.
 * @returns {"covered"|"partly_before_history"|"before_history"|"partly_after_latest_data"|"after_latest_data"|"no_history"|"unbounded"}
 */
function classifyRange(range, coverage) {
  if (!range || !range.from || !range.to) return "unbounded"; // all_time: whatever history exists
  if (!coverage || !coverage.earliest || !coverage.latest) return "no_history";
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const start = dateRanges.startOfDay(coverage.earliest).getTime();
  const end = dateRanges.endOfDay(coverage.latest).getTime();
  if (to < start) return "before_history";
  if (from > end) return "after_latest_data";
  if (from < start) return "partly_before_history";
  if (to > end) return "partly_after_latest_data";
  return "covered";
}

const OUTSIDE = new Set(["before_history", "after_latest_data", "no_history"]);
const PARTIAL = new Set(["partly_before_history", "partly_after_latest_data"]);

/**
 * @param {object} p
 * @param {"sales"|"purchase"} p.entity
 * @param {{from:Date,to:Date,label?:string}} p.period       validator-resolved subject range
 * @param {{from:Date,to:Date,label?:string}|null} p.comparison validator-resolved comparison range
 * @param {{earliest:Date|null, latest:Date|null}} p.coverage  from the tenant date context
 * @returns {{status:"covered"|"partial"|"outside", code:string, subject:string, comparison:string|null, message:string|null, notes:string[]}}
 */
function assessCoverage({ entity, period, comparison, coverage }) {
  const subject = classifyRange(period, coverage);
  const cmp = comparison ? classifyRange(comparison, coverage) : null;
  const WHAT_BY_ENTITY = { purchase: "purchases", sales_return: "sales returns", purchase_return: "purchase returns" };
  const NOUN_BY_ENTITY = { purchase: "Purchase", sales_return: "Sales return", purchase_return: "Purchase return" };
  const what = WHAT_BY_ENTITY[entity] || "sales";
  const noun = NOUN_BY_ENTITY[entity] || "Sales";
  const window = coverage && coverage.earliest && coverage.latest ? `${fmtDay(coverage.earliest)} – ${fmtDay(coverage.latest)}` : null;
  const notes = [];

  if (subject === "no_history" || cmp === "no_history") {
    return { status: "outside", code: "no_history", subject, comparison: cmp, notes, message: "TallyPulse has no synced Sales or Purchase vouchers for this company yet, so there is no data to answer this. This is missing data, not zero." };
  }
  if (OUTSIDE.has(subject)) {
    const side = subject === "before_history" ? `this company's synced voucher history starts on ${fmtDay(coverage.earliest)}` : `this company's data is synced only up to ${fmtDay(coverage.latest)}`;
    return {
      status: "outside",
      code: `subject_${subject}`,
      subject,
      comparison: cmp,
      notes,
      message: `TallyPulse has no data for ${rangeText(period)}: ${side}. This is missing data, not zero ${what}. Synced history covers ${window}.`,
    };
  }
  if (cmp && OUTSIDE.has(cmp)) {
    const side = cmp === "before_history" ? `synced voucher history starts on ${fmtDay(coverage.earliest)}` : `synced voucher history runs up to ${fmtDay(coverage.latest)}`;
    return {
      status: "outside",
      code: `comparison_${cmp}`,
      subject,
      comparison: cmp,
      notes,
      message: `I can't compare with ${rangeText(comparison)}: TallyPulse has no ${noun} data for that period (${side}), so a comparison would show a false zero baseline - every change would look like growth from nothing. Synced history covers ${window}. You can ask about ${rangeText(period)} on its own.`,
    };
  }
  if (PARTIAL.has(subject)) {
    notes.push(
      subject === "partly_before_history"
        ? `Coverage: synced data starts on ${fmtDay(coverage.earliest)}, so ${rangeText(period)} is only partly covered - ${what} before that date are missing, not zero.`
        : `Coverage: TallyPulse's data is synced up to ${fmtDay(coverage.latest)}, so ${rangeText(period)} is only partly covered - ${what} after that date are not included yet.`
    );
  }
  if (cmp && PARTIAL.has(cmp)) {
    notes.push(
      cmp === "partly_before_history"
        ? `Coverage: the comparison period ${rangeText(comparison)} is only partly covered (synced data starts on ${fmtDay(coverage.earliest)}), so its figures are incomplete - changes, new and lost results against it may be overstated.`
        : `Coverage: the comparison period ${rangeText(comparison)} is only partly covered (synced data runs up to ${fmtDay(coverage.latest)}), so its figures are incomplete.`
    );
  }
  const partial = notes.length > 0;
  return { status: partial ? "partial" : "covered", code: partial ? (PARTIAL.has(subject) ? `subject_${subject}` : `comparison_${cmp}`) : "covered", subject, comparison: cmp, notes, message: null };
}

module.exports = { classifyRange, assessCoverage, fmtDay, rangeText };

"use strict";

// --------------------------------------------------
// Deterministic grader for investigation answers (evaluation only). No model is involved: every criterion is a check on the
// answer text (or, for "context", on what the chat turn carried forward), so the same answer always gets the same grade.
//
// Criterion kinds:
//   mentions   - the text contains one of anyOf (string: case-insensitive substring; RegExp: tested as is)
//   number     - the text contains the number (Indian or plain digit grouping, ₹ optional, sign ignored) within tolerance
//   discloses  - the text matches pattern (a required disclosure: missing data, "not profit", ...)
//   forbids    - the text does NOT match pattern (an unsupported claim, another tenant's figures, ...)
//   hypothesis - some line naming the subject also carries hedge wording (the claim is offered as a possibility, not a fact);
//                fails when the subject is never mentioned
//   context    - the turn was planned with the previous turn's context (answer.contextCarried === true)
// Categories (facts, evidence, explanation, honesty, context, safety) are reported separately; "safety" failures are always
// reported as such, whatever the score.
// --------------------------------------------------

const { HEDGE } = require("./scenarios");

const NUMBER_RE = /(?<![\w.])[-−]?₹?\s?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?(?![\w])|(?<![\w.])[-−]?₹?\s?\d+(?:\.\d+)?(?![\w])/g;

// Dates are not figures: "30 Sept 2026", "Sept 30, 2026", "2026-09" and "2026-09-30" are removed before numbers are read, so a
// day or month number can never satisfy a "number" criterion.
const DATE_RES = [
  /\b\d{4}-\d{2}(?:-\d{2})?\b/g,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/gi,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi,
];
const withoutDates = (text) => DATE_RES.reduce((t, re) => t.replace(re, " "), String(text || ""));

/** Every number written in the text (dates excluded), as absolute values (commas, ₹ and signs removed). */
function numbersIn(text) {
  const out = [];
  for (const m of withoutDates(text).matchAll(NUMBER_RE)) {
    const n = Number(m[0].replace(/[−\-₹,\s]/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const DEFAULT_TOLERANCE = { abs: 0.5, pct: 0.5 }; // a figure may be rounded to the rupee or shown to 0.5%

function hasNumber(text, value, tolerance = DEFAULT_TOLERANCE) {
  const target = Math.abs(value);
  const allowed = Math.max(tolerance.abs || 0, (target * (tolerance.pct || 0)) / 100);
  return numbersIn(text).some((n) => Math.abs(n - target) <= allowed);
}

const matches = (text, needle) => (needle instanceof RegExp ? needle.test(text) : String(text).toLowerCase().includes(String(needle).toLowerCase()));

function check(c, answer) {
  const text = String((answer && answer.text) || "");
  switch (c.kind) {
    case "mentions":
      return { pass: c.anyOf.some((n) => matches(text, n)) };
    case "number":
      return { pass: hasNumber(text, c.value, c.tolerance), detail: `expected ${c.value}` };
    case "discloses":
      return { pass: c.pattern.test(text) };
    case "forbids": {
      const m = text.match(c.pattern);
      return { pass: !m, detail: m ? `found "${m[0].slice(0, 60)}"` : undefined };
    }
    case "hypothesis": {
      const lines = text.split(/\n|(?<=[.!?])\s+/).filter((l) => c.subject.test(l));
      if (!lines.length) return { pass: false, detail: "subject never mentioned" };
      return { pass: lines.some((l) => HEDGE.test(l)), detail: lines.some((l) => HEDGE.test(l)) ? undefined : "mentioned only as a plain fact or figure" };
    }
    case "context":
      return { pass: answer && answer.contextCarried === true, detail: answer && answer.contextCarried === true ? undefined : "no context from the previous turn" };
    default:
      throw new Error(`unknown criterion kind: ${c.kind}`);
  }
}

/**
 * @param {object[]} criteria
 * @param {{text: string, contextCarried?: boolean}} answer
 * @returns {{results: object[], passed: number, total: number, score: number, byCategory: object, safetyFailures: string[]}}
 */
function grade(criteria, answer) {
  const results = criteria.map((c) => ({ id: c.id, kind: c.kind, category: c.category, note: c.note, ...check(c, answer) }));
  const byCategory = {};
  for (const r of results) {
    const b = (byCategory[r.category] = byCategory[r.category] || { passed: 0, total: 0 });
    b.total += 1;
    if (r.pass) b.passed += 1;
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    results,
    passed,
    total: results.length,
    score: results.length ? Math.round((passed / results.length) * 1000) / 10 : null,
    byCategory,
    safetyFailures: results.filter((r) => r.category === "safety" && !r.pass).map((r) => r.id),
  };
}

module.exports = { grade, numbersIn, hasNumber };

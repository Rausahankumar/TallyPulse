"use strict";

/**
 * The one copy of the tiny PASS/FAIL helper that the verify-*.js suites used to define for themselves.
 *
 *   const { createChecker } = require("./test/check");
 *   const t = createChecker();
 *   const check = t.check;          // check(id, description, actual, expected): compared as JSON
 *   ...
 *   console.log(t.summary());       // "\n61 passed, 0 failed, 61 total"
 *   process.exit(t.fail > 0 ? 1 : 0);
 *
 * Output text is exactly what the per-file copies printed, so anything reading a suite's output (CI, people) sees no difference.
 * Suites adopt it one at a time, when they are touched; a suite with a different check() signature keeps its own.
 */
function createChecker() {
  let pass = 0;
  let fail = 0;

  function check(id, description, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
    if (ok) pass += 1; else fail += 1;
  }

  return {
    check,
    get pass() { return pass; },
    get fail() { return fail; },
    summary: () => `\n${pass} passed, ${fail} failed, ${pass + fail} total`,
  };
}

module.exports = { createChecker };

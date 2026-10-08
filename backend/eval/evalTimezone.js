"use strict";

/**
 * The NLU evaluation's time zone: UTC, set explicitly.
 *
 * The scorer resolves relative periods ("previous month", "this FY") and explicit custom ranges to concrete dates and compares those
 * dates. Both resolutions use the machine's LOCAL time zone, so on a machine west of UTC the same two plans - a relative period and
 * the custom range that means the same days - resolve to different dates and one is scored wrong (observed under America/New_York).
 * CI happens to run in UTC; the evaluator must not depend on that.
 *
 * This only affects the evaluation process. It never touches the application, the planner's period semantics or the query engine:
 * the product resolves periods in its own process with its own time zone.
 *
 * It must run before the evaluator creates any date (eval/nluScoring.js builds its reference date at load), so every evaluation
 * entry point requires this module first, and eval/nluScoring.js requires it too, so no importer can score in another zone.
 */

const EVAL_TIMEZONE = "UTC";

function pinEvaluationTimezone() {
  process.env.TZ = EVAL_TIMEZONE;
  // Proof that the runtime applied it (January and July, so a daylight-saving zone cannot pass by accident).
  const offsets = [new Date(2025, 0, 15).getTimezoneOffset(), new Date(2025, 6, 15).getTimezoneOffset()];
  if (offsets.some((o) => o !== 0)) {
    throw new Error(`The NLU evaluation must run in ${EVAL_TIMEZONE}, but the runtime ignored the time-zone setting (offsets ${offsets.join(", ")}). Nothing was evaluated.`);
  }
  return EVAL_TIMEZONE;
}

pinEvaluationTimezone();

module.exports = { EVAL_TIMEZONE, pinEvaluationTimezone };

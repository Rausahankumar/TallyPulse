"use strict";

/**
 * Evaluation-only prompt ablations. Each one changes ONE thing in the system text of the planner request, so a live run of the same
 * corpus rows shows which sentence a behaviour depends on. They are applied by eval-nlu-models.js (--ablate=<name>) to the request just
 * before it is sent; planner.js and the catalog are never modified, and nothing under src/ imports this file.
 *
 * History: the 77-call ablation (no-limit-bounded, restore-product-rule, no-headline) was run against the prompt of that time; its results
 * are in eval/results. Its findings were then made part of the prompt (the headline sentence is gone, the catalog's product-grouping rule is
 * stated, and the phrase "the limit is always bounded" is gone from the catalog's sort rule), so none of those targets exist any more.
 *
 * A transformation that does not change the text (its target is not in the prompt) throws, so a run can never silently measure the
 * unmodified prompt under an ablation name.
 */

const replaceOnce = (text, from, to) => {
  const i = text.indexOf(from);
  if (i < 0 || text.indexOf(from, i + 1) >= 0) throw new Error(`ablation target must occur exactly once in the prompt: ${from.slice(0, 60)}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
};

// Empty on purpose: every ablation of the 77-call experiment is now part of the prompt (see History). Add an entry here to run the next experiment.
const ABLATIONS = {
  // name: { description, apply: (systemText) => newSystemText }
};

/** The request with its system text ablated (every other field untouched). Throws when the ablation changes nothing. */
function ablateRequest(name, request) {
  const ablation = ABLATIONS[name];
  if (!ablation) throw new Error(`unknown ablation "${name}" (known: ${Object.keys(ABLATIONS).join(", ")})`);
  const system = (request.system || []).map((block) => {
    if (!block || block.type !== "text") return block;
    const text = ablation.apply(block.text);
    if (text === block.text) throw new Error(`ablation "${name}" did not change the prompt`);
    return { ...block, text };
  });
  return { ...request, system };
}

/** A planner client that applies the ablation to every request, then calls the real client. */
function withAblation(client, name) {
  if (!ABLATIONS[name]) throw new Error(`unknown ablation "${name}" (known: ${Object.keys(ABLATIONS).join(", ")})`);
  return (request, options) => client(ablateRequest(name, request), options);
}

module.exports = { ABLATIONS, ablateRequest, withAblation };

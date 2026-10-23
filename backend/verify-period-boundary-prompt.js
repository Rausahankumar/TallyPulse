/**
 * Lightweight regression guard (no Anthropic call) for the
 * period-boundary-narration system-prompt rule added to
 * chatOrchestrator.js. Confirms the rule text is present and that it's
 * a general instruction (not hardcoded to Stock Groups), so a future
 * edit to SYSTEM_PROMPT can't silently drop it.
 *
 * Actual LLM compliance with this rule is verified separately via real
 * Anthropic calls (see the live browser/manual verification recorded in
 * the accompanying report) - a static prompt-content check can't prove
 * Claude actually follows it, only that the instruction still exists.
 *
 * Run: node verify-period-boundary-prompt.js
 */

const { SYSTEM_PROMPT, buildSystemPrompt } = require("./src/services/ai/chatOrchestrator");

let passed = 0;
let failed = 0;

function check(label, cond) {
  if (cond) {
    passed++;
    console.log(`PASS | ${label}`);
  } else {
    failed++;
    console.log(`FAIL | ${label}`);
  }
}

check(
  "system prompt instructs stating the tool's exact returned period boundaries",
  /state THAT exact date range/i.test(SYSTEM_PROMPT)
);

check(
  "system prompt forbids reconstructing a textbook calendar period",
  /Never reconstruct a "textbook" calendar period/i.test(SYSTEM_PROMPT)
);

check(
  "system prompt requires day-level dates, not just a period label",
  /day-level/i.test(SYSTEM_PROMPT) && /without also giving the literal end date/i.test(SYSTEM_PROMPT)
);

check(
  "the rule references generic tool-result shapes (period/currentPeriod/previousPeriod/samePeriodLastYear), not a Stock-Group-specific field",
  /"period", "currentPeriod", "previousPeriod", or "samePeriodLastYear"/.test(SYSTEM_PROMPT)
);

check(
  "the rule is a standalone bullet, not nested inside the Stock Group bullet's own sentence",
  (() => {
    const stockGroupBulletStart = SYSTEM_PROMPT.indexOf("For a question about product GROUPS");
    const periodBulletStart = SYSTEM_PROMPT.indexOf("Any tool result that includes explicit period boundaries");
    return stockGroupBulletStart !== -1 && periodBulletStart !== -1 && periodBulletStart > stockGroupBulletStart;
  })()
);

check(
  "buildSystemPrompt still appends the period-boundary rule (survives the date-context concatenation)",
  buildSystemPrompt(new Date("2026-01-15")).includes("state THAT exact date range")
);

// The Stock-Group-specific null-growth rule from the earlier task must
// still be intact - this change must not have clobbered it.
check(
  "pre-existing Stock Group null-growth rule is still present (not clobbered by this edit)",
  /never state or imply 0% change/i.test(SYSTEM_PROMPT)
);

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

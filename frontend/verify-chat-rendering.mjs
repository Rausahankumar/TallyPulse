/**
 * Ask AI rendering: proves the chat renderer is a pure, local presentation transform.
 *  - loads the REAL MarkdownMessage/ChatBubble through Vite's SSR transform (no test framework added)
 *  - feeds them REAL backend answerFormatter output (synthetic data, no tenant data)
 *  - fetch / http.request / https.request / XMLHttpRequest / WebSocket are poisoned and counted for every
 *    render: any Claude/Anthropic (or any other) network call would fail the run
 *  - checks values are unchanged, tables are real tables, and unsafe HTML/links never reach the output
 *
 * Run: node verify-chat-rendering.mjs
 */
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const require = createRequire(import.meta.url);
const { formatQueryAnswer, formatNonAnswer } = require("../backend/src/services/query/answerFormatter.js");

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const { default: MarkdownMessage } = await vite.ssrLoadModule("/src/components/chat/MarkdownMessage.jsx");
const { separateListTrailers } = await vite.ssrLoadModule("/src/lib/markdownText.js");
const { default: ChatBubble } = await vite.ssrLoadModule("/src/components/chat/ChatBubble.jsx");

// ---- network poison: armed only around rendering, so module loading above is not counted
let netCalls = 0;
const saved = { fetch: globalThis.fetch, h: http.request, hg: http.get, s: https.request, sg: https.get, xhr: globalThis.XMLHttpRequest, ws: globalThis.WebSocket };
function arm() {
  const boom = (what) => () => {
    netCalls += 1;
    throw new Error(`NETWORK BLOCKED: ${what}`);
  };
  globalThis.fetch = boom("fetch");
  http.request = boom("http.request");
  http.get = boom("http.get");
  https.request = boom("https.request");
  https.get = boom("https.get");
  globalThis.XMLHttpRequest = function () { boom("XMLHttpRequest")(); };
  globalThis.WebSocket = function () { boom("WebSocket")(); };
}
function disarm() {
  globalThis.fetch = saved.fetch;
  http.request = saved.h;
  http.get = saved.hg;
  https.request = saved.s;
  https.get = saved.sg;
  globalThis.XMLHttpRequest = saved.xhr;
  globalThis.WebSocket = saved.ws;
}

const md = (text) => renderToStaticMarkup(createElement(MarkdownMessage, { text }));
const bubble = (message) => renderToStaticMarkup(createElement(ChatBubble, { message }));
const visible = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const RAW_MD = /\*\*|^#{1,6}\s|\|\s*-{3,}|^\s*[-*]\s/m;

// ---- real backend formatter output (synthetic figures)
const groupPlan = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["lineAmount"], groupBy: [{ dim: "productGroup" }], filters: [], sort: [{ by: "lineAmount", dir: "desc" }] };
const groupResult = {
  metrics: ["lineAmount"],
  rows: [
    { key: { productGroup: "Group Alpha" }, values: { lineAmount: 1874081.23 } },
    { key: { productGroup: "Group Beta / Sub" }, values: { lineAmount: 1096973.85 } },
    { key: { productGroup: "Group Gamma" }, values: { lineAmount: 751574.81 } },
  ],
  totals: { values: { lineAmount: 3722629.89 } },
  amountBasis: { lineAmount: "line_item_pre_tax" },
};
const DETERMINISTIC = formatQueryAnswer({ plan: groupPlan, result: groupResult }).text;
const NO_DATA = formatQueryAnswer({ plan: groupPlan, result: { ...groupResult, rows: [], totals: { values: { lineAmount: 0 } } } }).text;
const CLARIFY = formatNonAnswer({ status: "needs_clarification", code: "year_missing", reason: "x" });
const LONG = formatQueryAnswer({
  plan: groupPlan,
  result: { ...groupResult, rows: Array.from({ length: 40 }, (_, i) => ({ key: { productGroup: `Test Group ${i + 1}` }, values: { lineAmount: 100000 - i * 997.5 } })) },
}).text;
const CLAUDE_TABLE = [
  "### Sales Performance by Product Group",
  "",
  "| Rank | Product Group | Sales | Growth |",
  "|---:|---|---:|---:|",
  "| 1 | Group Alpha | ₹18,74,081.23 | +12.3% |",
  "| 2 | A Very Long Product Group Name That Should Wrap Gracefully Inside Its Cell | ₹10,96,973.85 | -0.7% |",
  "",
  "**Total:** ₹29,71,055.08",
  "",
  "- first point",
  "- second point with *emphasis*",
].join("\n");

arm();
try {
  section("1. Normal deterministic answer (real answerFormatter output)");
  let h = md(DETERMINISTIC);
  check("renders as an ordered list of rows", (h.match(/<li/g) || []).length === 3, h);
  check("the 'Total:' line is NOT swallowed into the last list item", !/<li[^>]*>[^]*?Total:[^]*?<\/li>/.test(h) && /Total:/.test(visible(h)), h);
  // A product-group answer carries two notes (the product-level limitation, then the line-amount basis): consecutive note lines render as ONE block
  // (line breaks inside a paragraph), separate from the header, the rows and the total.
  check("header, rows, total and the notes block are separate blocks", /<p[^>]*>Sales — [^<]*<\/p>/.test(h) && /<p[^>]*>Total: [^<]*<\/p>/.test(h) && /<p[^>]*>• Product-level amounts are pre-tax item values[^<]*(?:<br\s*\/?>\s*)• Line amounts are item values before tax\.<\/p>/.test(h), h);
  const consecutive = md("Invoice amount: ₹1,000.00\nCompared with last month: previous ₹800.00, change +₹200.00 (+25.0%)");
  check("consecutive plain lines stay on their own lines (no run-on paragraph)", /₹1,000.00<br\s*\/?>\s*Compared with/.test(consecutive), consecutive);
  for (const v of ["₹18,74,081.23", "₹10,96,973.85", "₹7,51,574.81", "₹37,22,629.89"]) check(`value ${v} shown exactly as the backend formatted it`, visible(h).includes(v));
  check("list-trailer separation is layout-only: every non-blank line of the answer is preserved character-for-character", separateListTrailers(DETERMINISTIC).split("\n").filter((l) => l.trim()).join("\n") === DETERMINISTIC.split("\n").filter((l) => l.trim()).join("\n"));
  check("...and inside a fenced code block nothing is touched", separateListTrailers("```\n1. a\nb\n```") === "```\n1. a\nb\n```");
  check("...and an indented continuation of a list item is still a continuation", separateListTrailers("- a\n  more") === "- a\n  more");
  check("no raw Markdown syntax visible", !RAW_MD.test(visible(h)), visible(h));

  section("2. Markdown/table answer");
  h = md(CLAUDE_TABLE);
  check("a real <table> with header and body", /<table/.test(h) && /<thead/.test(h) && /<tbody/.test(h) && (h.match(/<tr/g) || []).length === 3, h);
  check("wrapped in a horizontal-scroll container (small screens)", /overflow-x-auto[^>]*><table/.test(h), h);
  check("numeric columns right-aligned exactly as the Markdown declared (---:): 3 columns x 3 rows", (h.match(/text-align:right/g) || []).length === 9, h);
  check("the undeclared (---) text column gets no alignment override (left by default)", /<th class="[^"]*text-left[^"]*">Product Group/.test(h), h);
  check("long names can wrap (break-words on cells)", /<td[^>]*break-words[^>]*>A Very Long/.test(h), h);
  check("heading rendered as a heading, not '###'", /<h4[^>]*>Sales Performance by Product Group<\/h4>/.test(h), h);
  check("bold rendered as <strong>, not '**'", /<strong[^>]*>Total:<\/strong>/.test(h), h);
  check("bullets rendered as a list", /<ul/.test(h) && /<em[^>]*>emphasis<\/em>/.test(h), h);
  check("no raw pipes/asterisks/hashes visible", !RAW_MD.test(visible(h)) && !visible(h).includes("|"), visible(h));
  check("currency and percentages unchanged", ["₹18,74,081.23", "+12.3%", "-0.7%", "₹29,71,055.08"].every((v) => visible(h).includes(v)));

  section("3. Clarification answer (planner clarification text, ₹0 path) + visual variant");
  h = bubble({ role: "assistant", text: CLARIFY, toolCalls: [], details: { toolCalls: [], queryEngine: { route: "planner", status: "needs_clarification", code: "year_missing", claudeCalls: 0 } } });
  check("clarification bubble is visually distinct and labelled", /Clarification needed/.test(h) && /bg-brand-50/.test(h), h);
  check("clarification text shown exactly", visible(h).includes("Which year do you mean?") && visible(h).includes('"April 2025"'), visible(h));

  section("4. No-data answer + visual variant");
  h = bubble({ role: "assistant", text: NO_DATA, toolCalls: [{ toolName: "query_engine", state: "zero_result" }] });
  check("no-data bubble is visually distinct and labelled", /No matching data/.test(h), h);
  check("backend's own no-data sentence shown", visible(h).includes("No matching records were found for this question."));
  h = bubble({ role: "assistant", text: "Sales data has never been synced.", toolCalls: [{ toolName: "query_engine", state: "no_usable_data" }] });
  check("never-synced (no_usable_data) is also the no-data variant", /No matching data/.test(h));
  h = bubble({ role: "assistant", text: DETERMINISTIC, toolCalls: [{ toolName: "query_engine", state: "valid_data" }] });
  check("a normal answer gets NO special label", !/Clarification needed|No matching data/.test(h));

  section("5. Long answer");
  h = md(LONG);
  check("every returned row rendered (40), no 'more rows' line, nothing dropped or invented", (h.match(/<li/g) || []).length === 40 && !/more rows not shown/.test(visible(h)), visible(h).slice(-300));

  section("6. User prompt display");
  const q = "top 10 customers grew or declined — q2 FY-2025 vs q1 FY-2025 **not bold** # not heading";
  h = bubble({ role: "user", text: q });
  check("user's question shown literally (never parsed as Markdown)", visible(h) === q && !/<strong|<h\d/.test(h), visible(h));

  section("7. Security: raw HTML, scripts and dangerous links never reach the DOM");
  const hostile = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(2)">',
    '<iframe src="https://evil.example"></iframe>',
    "[click me](javascript:alert(3))",
    "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCg0KTwvc2NyaXB0Pg==)",
    '<a href="javascript:alert(5)">x</a>',
    "![img](javascript:alert(6))",
  ].join("\n\n");
  h = md(hostile);
  check("no <script> element", !/<script/i.test(h), h);
  check("no <img>/<iframe> element from raw HTML", !/<img[^>]*onerror|<iframe/i.test(h), h);
  check("no event-handler attribute on any element", !/<[a-z][^>]*\son\w+=/i.test(h), h);
  check("no <img> element at all (an emptied src would make the browser re-request the page)", !/<img/i.test(h), h);
  check("no javascript:/data: URL in any href/src", !/(href|src)="\s*(javascript|data):/i.test(h), h);
  check("raw HTML is shown as inert text instead", visible(h).includes("<script>alert(1)</script>"));
  h = md("[TallyPulse docs](https://example.com/docs)");
  check("safe links open in a new tab with noopener/noreferrer", /href="https:\/\/example.com\/docs"/.test(h) && /target="_blank"/.test(h) && /rel="noopener noreferrer"/.test(h), h);

  section("8. Same response rendered repeatedly");
  const first = md(CLAUDE_TABLE);
  let same = true;
  for (let i = 0; i < 200; i += 1) if (md(CLAUDE_TABLE) !== first || md(DETERMINISTIC) !== md(DETERMINISTIC)) same = false;
  check("200 re-renders: byte-identical output every time (pure function of the text)", same);

  section("9. Rendering made no network call of any kind");
  check("zero fetch/http/https/XHR/WebSocket calls across every render above (so zero Claude/Anthropic calls)", netCalls === 0, netCalls);
} catch (error) {
  fail += 1;
  console.log("  FAIL - unexpected error:", error && error.stack);
} finally {
  disarm();
  await vite.close();
}

console.log(`\nverify-chat-rendering: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * Location and people concepts the data does not record (semanticCatalog `partial` unsupported entries) and how a question
 * that asks for one of them ALONGSIDE something measurable is answered: the analysis planner declares the catalog ids in
 * `unavailable` (validated against the catalog), the measurable part runs company-wide, and the answer states each reason
 * first with an explicit company-wide scope - never a store or place figure.
 *
 * Offline: scripted model replies, the real planners' checks, the real chat turn and executor over an in-memory engine.
 * No database, no network, no model. Run: node verify-unavailable-concepts.js
 */

process.env.AI_USAGE_PERSIST = "off";
require("axios").post = () => { throw new Error("NETWORK BLOCKED"); };

const catalog = require("./src/services/query/semanticCatalog");
const { CATALOG } = catalog;
const ap = require("./src/services/query/analysisPlanner");
const planner = require("./src/services/query/planner");
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
const { formatAnalysisAnswer } = require("./src/services/query/analysisAnswer");
const { tryAnswerWithQueryEngine } = require("./src/services/query/queryChat");

let pass = 0, fail = 0;
function check(id, description, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${id} - ${description}${ok || detail === undefined ? "" : `\n      ${String(detail).slice(0, 800)}`}`);
  if (ok) pass += 1; else fail += 1;
}
const CONCEPTS = ["business_location", "party_location", "salesperson", "party_group"];
const entry = (id) => CATALOG.unsupported.find((u) => u.id === id);

(async () => {
  console.log("=== 1. The catalog: four distinct concepts, none queryable ===");
  {
    const entries = CONCEPTS.map(entry);
    check("catalog-entries", "store/branch, party location, salesperson and party group are four separate partial entries with their own label, meaning and reason", entries.every((u) => u && u.partial === true && u.label && u.meaning && u.reason) && new Set(entries.map((u) => u.label)).size === 4 && new Set(entries.map((u) => u.meaning)).size === 4 && new Set(entries.map((u) => u.reason)).size === 4, JSON.stringify(entries));
    check("catalog-no-merged-entry", "the old merged entry (state, region, customer group and salesperson in one) is gone", !entry("sales_by_region_or_salesperson"));
    check("catalog-no-location-dimension", "no dimension claims a place: none of store/branch/godown/city/state/region/location/salesperson exists, and a plan grouping by one is rejected by the schema", !Object.keys(CATALOG.dimensions).some((d) => /store|branch|godown|city|state|region|location|salesperson|territory/i.test(d)) && ["store", "location", "region", "salesperson"].every((d) => !parseQueryPlan({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount"], groupBy: [{ dim: d }], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 5 }).ok));
    check("catalog-customer-is-a-name", "the customer dimension is documented as the party NAME only: a place is party_location, a store is business_location", /NAME only/.test(CATALOG.dimensions.customer.notes) && /party_location/.test(CATALOG.dimensions.customer.notes) && /business_location/.test(CATALOG.dimensions.customer.notes));
    check("catalog-group-reason-accurate", "the party-group reason does not claim groups are not stored (the ledger group is synced; it is just not a query dimension)", !/not stored/.test(entry("party_group").reason) && /cannot be used/.test(entry("party_group").reason));
  }

  console.log("\n=== 2. What the planners are told ===");
  {
    const text = ap.getAnalysisPrompt().system[0].text;
    const line = text.split("\n").find((l) => l.startsWith("Not recorded"));
    check("prompt-concepts", "the analysis prompt lists every concept by id WITH its own meaning, and how to answer a question that also asks for something measurable", !!line && CONCEPTS.every((id) => line.includes(`${id} = ${entry(id).meaning}`)) && /list those ids in unavailable; if only these, decline/.test(line), line);
    const declineLine = text.split("\n").find((l) => l.startsWith("If the data cannot answer it"));
    check("prompt-not-in-decline", "the concepts are not in the analysis planner's whole-question decline list (they are partial)", !CONCEPTS.some((id) => declineLine.includes(entry(id).label)), declineLine);
    const tool = ap.getAnalysisPrompt().tool.input_schema.properties.unavailable;
    check("tool-schema", "the tool accepts unavailable as unique catalog ids only", JSON.stringify(tool.items.enum) === JSON.stringify(CONCEPTS) && tool.uniqueItems === true && tool.maxItems === 4);
    const digest = planner.buildCatalogDigest();
    check("query-planner-unchanged-role", "the query planner (whole questions only) still lists them as one thing it cannot answer", digest.includes("place, salesperson or party group"));
  }

  console.log("\n=== 3. Validation of the declaration (scripted model) ===");
  {
    const REF = new Date(2026, 9, 26);
    const plan = { v: 1, steps: [{ id: "s", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, compare: { mode: "full_previous" }, metrics: ["lineAmount"], groupBy: [], filters: [{ dim: "product", op: "eq_ci", value: "Apple" }] } }] };
    const run = async (input) => ap.planAnalysis("Why are apple sales declining in our Delhi store?", { referenceDate: REF, maxRepairs: 0, claudeClient: async (req) => ({ content: [{ type: "tool_use", name: req.tool_choice.name, input }], usage: {} }) });
    const ok = await run({ analysis: plan, unavailable: ["business_location"] });
    check("declare-valid", "a plan with a catalog id is accepted and the id is returned", ok.status === "supported" && JSON.stringify(ok.unavailable) === '["business_location"]', JSON.stringify(ok));
    const none = await run({ analysis: plan });
    check("declare-absent", "a plan without the field keeps working (unavailable: [])", none.status === "supported" && JSON.stringify(none.unavailable) === "[]");
    for (const [name, input] of [["unknown-id", { analysis: plan, unavailable: ["store"] }], ["non-partial-id", { analysis: plan, unavailable: ["profit_margin"] }], ["duplicate", { analysis: plan, unavailable: ["party_location", "party_location"] }], ["not-array", { analysis: plan, unavailable: "business_location" }], ["with-decline", { decline: { code: "unsupported_domain" }, unavailable: ["business_location"] }]]) {
      const r = await run(input);
      check(`declare-rejected-${name}`, `${name}: rejected as a protocol violation (never rendered)`, r.status === "planner_failed" && r.code === "planner_protocol_violation", JSON.stringify(r));
    }
    const whole = await run({ decline: { code: "unsupported_domain", message: "Sales are not recorded by region." } });
    check("decline-whole", "a question that asks only for an unrecorded concept still declines exactly as before", whole.status === "unsupported" && whole.code === "analysis_unsupported_domain", JSON.stringify(whole));
  }

  console.log("\n=== 4. Rendering ===");
  {
    const steps = [{ id: "s", kind: "query", status: "ok", facts: "Sales — apple — company-wide figures", notes: [], request: { v: 1, entity: "sales", mode: "aggregate", metrics: ["invoiceCount"], groupBy: [], filters: [] }, result: { rows: [], totals: { values: { invoiceCount: 4 } }, comparison: null, period: { from: null, to: null } } }];
    const t1 = formatAnalysisAnswer({ steps }, { unavailable: ["business_location"] }).text;
    check("render-reason", "the catalog's reason comes first, then an explicit company-wide scope that says nothing about any single store", /\*\*Not available in the data\*\*\n- Sales and purchases are not recorded by store, branch, outlet or godown/.test(t1) && /The results below are for the whole company: they are not broken down by store, branch or godown and say nothing about any single one\./.test(t1) && t1.indexOf("Not available") < t1.indexOf("**Step 1**"), t1);
    const all = formatAnalysisAnswer({ steps }, { unavailable: CONCEPTS }).text;
    check("render-distinct", "each concept is stated with its own reason (store, place, salesperson and group are not merged)", CONCEPTS.every((id) => all.includes(`- ${entry(id).reason}`)) && /by store, branch or godown, or by customer or supplier location, or by salesperson or territory, or by customer or supplier group/.test(all), all);
    const junk = formatAnalysisAnswer({ steps }, { unavailable: ["store", "profit_margin"] }).text;
    check("render-unknown-dropped", "ids the catalog does not list as partial are never rendered", !/Not available in the data/.test(junk) && junk === formatAnalysisAnswer({ steps }).text);
  }

  console.log("\n=== 5. Through the chat turn: a partly answerable question ===");
  {
    const r2 = (n) => Math.round(n * 100) / 100;
    const day = (y, m, d, end) => (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
    const execute = async (plan) => {
      const rows = [["Sharma Fruits", 0, 4000], ["Rao Traders", 1600, 1500]].map(([k, c, p]) => ({ key: { customer: k }, values: { lineAmount: c }, comparison: { lineAmount: { previous: p, delta: r2(c - p), deltaPct: null } } }));
      const grouped = (plan.groupBy || []).length > 0;
      return { result: { ok: true, entity: "sales", mode: "aggregate", period: { from: day(2025, 10, 1), to: day(2025, 10, 31, true), label: "October 2025" }, comparison: { from: day(2025, 9, 1), to: day(2025, 9, 30, true), label: "September 2025" }, metrics: plan.metrics, groupBy: plan.groupBy, rows: grouped ? rows : [], totals: { values: { lineAmount: 1600 }, comparison: { lineAmount: { previous: 5500, delta: -3900, deltaPct: null } } }, truncated: false, rowLimit: 5, warnings: [], assumptions: [] } };
    };
    const P = { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, C = { mode: "custom", period: { kind: "custom", from: "2025-09-01", to: "2025-09-30" } };
    const analysis = { v: 1, steps: [{ id: "who", kind: "query", plan: { v: 1, entity: "sales", mode: "aggregate", period: P, compare: C, metrics: ["lineAmount"], groupBy: [{ dim: "customer" }], filters: [{ dim: "product", op: "eq_ci", value: "Apple" }], sort: [{ by: "lineAmount.delta", dir: "asc" }], limit: 5 } }] };
    const replies = [{ decline: { code: "needs_analysis", message: "several analyses" } }, { analysis, unavailable: ["business_location"] }];
    const model = async (req) => ({ content: [{ type: "tool_use", name: req.tool_choice.name, input: replies.shift() }], usage: { input_tokens: 1, output_tokens: 1 } });
    const DC = { referenceDate: new Date(2026, 9, 26, 23, 59, 59, 999), source: "today", futureVouchers: false, latestVoucher: new Date(2025, 11, 31), coverage: { earliest: new Date(2025, 0, 1), latest: new Date(2026, 9, 26), lastSyncedAt: null } };
    const out = await tryAnswerWithQueryEngine({ context: { tenantId: "T-UNAVAIL", userId: "u" }, userMessage: "Why are apple sales declining in our Delhi store in October 2025 compared with September 2025?", conversationHistory: [], deps: { plannerClient: model, analysisEnabled: true, execute, getFreshness: async () => ({ state: "fresh", message: "" }), getDateContext: async () => DC, resolveEntity: async ({ hintDim, text }) => ({ matches: [{ dim: hintDim, value: text }] }) } });
    const ans = out.structured.answer, meta = out.structured.details.queryEngine;
    check("chat-disclosed", "the answer states that store-level sales are not recorded, BEFORE the measured part", meta.status === "answered" && /\*\*Not available in the data\*\*\n- Sales and purchases are not recorded by store/.test(ans) && ans.indexOf("Not available") < ans.indexOf("**Findings**"), ans.slice(0, 700));
    check("chat-supported-part", "the supported part is still answered (company-wide contributors) and labelled as the whole company", /Largest contributors/.test(ans) && /Sharma Fruits/.test(ans) && /for the whole company/.test(ans), ans.slice(0, 1200));
    check("chat-no-store-claim", "no store figure or store claim is invented: the place the user named never appears in the answer", !/Delhi/i.test(ans), ans);
    check("chat-meta", "the turn records the declared concept (meta.unavailable)", JSON.stringify(meta.unavailable) === '["business_location"]', JSON.stringify(meta));
  }

  console.log(`\nverify-unavailable-concepts: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

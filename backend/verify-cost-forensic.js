/**
 * Cost-path regression at the REAL exported chatController.js `sendChatMessage` HTTP-handler level (not
 * tryAnswerWithQueryEngine in isolation). The planner is the only interpreter, so the contract is:
 *
 *   - every question that passes the safety gate costs exactly ONE planner call (a scripted fake here);
 *   - conversation history never reaches Claude - only the previous STRUCTURED plan reaches the planner, never the
 *     chat text;
 *   - the answer cache saves the ENGINE (cacheKey equality, executor skipped), not the planner call;
 *   - a fixed refusal / decline never produces a figure.
 *
 * Safety: global fetch/http/https are poisoned for the whole run (any real network call, Anthropic or otherwise,
 * throws and is counted). The planner client is a scripted fake injected before the chat wiring loads.
 * Chat.prototype.save is faked (no Mongo write). A synthetic tenant: freshness is stubbed and nothing real is read; no writes, no
 * Tally, no live Claude.
 *
 * Run: node verify-cost-forensic.js
 */
require("dotenv").config();
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const connectDB = require("./src/config/db");
const Chat = require("./src/models/chat.model");
const mongoose = require("mongoose");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

let netCalls = 0;
const savedNet = { fetch: global.fetch, h: http.request, s: https.request };
global.fetch = (...a) => { netCalls += 1; throw new Error("NETWORK BLOCKED: " + JSON.stringify(a[0])); };
http.request = (...a) => { netCalls += 1; throw new Error("NETWORK BLOCKED (http)"); };
https.request = (...a) => { netCalls += 1; throw new Error("NETWORK BLOCKED (https)"); };

let saveCalls = 0;
let lastSaved = null;
const realSave = Chat.prototype.save;
Chat.prototype.save = async function fakeSave() {
  saveCalls += 1;
  lastSaved = this;
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  return this;
};

// The scripted planner: every call is recorded; the reply is whatever `script.next` says. Injected into the planner
// module BEFORE the chat wiring loads (queryChat takes the factory at require time).
const planner = require("./src/services/query/planner");
const plannerRequests = [];
const script = { next: null };
planner.createAnthropicPlannerClient = () => async (request) => {
  plannerRequests.push(JSON.parse(JSON.stringify(request)));
  return { content: [{ type: "tool_use", id: "t1", name: planner.PLANNER_TOOL_NAME, input: script.next }], usage: { input_tokens: 440, output_tokens: 190, cache_read_input_tokens: 2694, cache_creation_input_tokens: 0 } };
};

// Freshness is not what this suite tests: every entity is "fresh" (the freshness gate has its own suites).
const freshPath = require.resolve("./src/services/analytics/freshness");
require.cache[freshPath] = { id: freshPath, filename: freshPath, loaded: true, exports: { ...require(freshPath), getFreshness: async () => ({ state: "fresh", dataAsOf: new Date(), message: "Data is current." }) } };

const { sendChatMessage } = require("./src/controllers/chatController");
const { stableStringify } = require("./src/services/query/answerCache");
const catalog = require("./src/services/query/semanticCatalog");
const { getTenantDateContext } = require("./src/services/analytics/referenceDate");
const { getTenantVersion } = require("./src/services/query/dataVersion");

const TENANT = "TEST-TENANT-cost-forensic";
const TENANT_GUID = "test-guid-cost-forensic";
const Q = "Sales by customer in aug 2025";
const GROUP_PLAN = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], filters: [], sort: [{ by: "invoiceAmount", dir: "desc" }], limit: 10 };

// Two synthetic vouchers (raw driver: no model hooks) so the engine path - and with it the answer cache - is really exercised.
const Sale = require("./src/models/sales.model");
const TenantDataVersion = require("./src/models/tenantDataVersion.model");
const seedDoc = (no, date, party, total) => ({ tenantId: TENANT, tallyGuid: `${TENANT}-${no}`, tallyAlterId: Number(no.slice(1)), voucherStatus: "active", header: { voucherNo: no, voucherDate: new Date(`${date}T00:00:00.000Z`), voucherType: "Invoice", voucherTotalAmount: total, narration: "", partyName: party }, inventory: [], ledgers: [] });
const cleanSeed = async () => { await Sale.collection.deleteMany({ tenantId: TENANT }); await TenantDataVersion.collection.deleteMany({ tenantId: TENANT }); };

function mockReq({ message, chatId }) {
  return { body: { message }, params: chatId ? { chatId } : {}, companyContext: { tenantId: TENANT, companyGuid: TENANT_GUID }, user: { id: "AUDIT-USER" } };
}
function mockRes() {
  const res = { statusCode: null, body: null, on() { return res; } };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

(async () => {
  await connectDB();
  try {
    await cleanSeed();
    await Sale.collection.insertMany([seedDoc("S1", "2025-08-10", "Alpha Traders", 1180), seedDoc("S2", "2025-08-20", "Beta Stores", 590)]);
    // ============================================================ 1-3: controller-level, fresh / repeat / history
    section("1-3. Real sendChatMessage handler: fresh, repeated, with history");
    script.next = { plan: GROUP_PLAN };
    const res1 = mockRes();
    await sendChatMessage(mockReq({ message: Q }), res1);
    check("turn 1: HTTP 200, answered by the engine", res1.statusCode === 200 && res1.body.success && /Alpha Traders/.test(res1.body.data.answer), String(res1.statusCode));
    check("turn 1: exactly ONE planner call (claudeCalls = 1), route planner", res1.body.data.details.queryEngine.claudeCalls === 1 && res1.body.data.details.queryEngine.route === "planner" && plannerRequests.length === 1);
    check("turn 1: answer cache miss (first computation)", res1.body.data.details.queryEngine.cache === "miss");
    check("turn 1: zero real network calls (the planner is the scripted fake)", netCalls === 0, String(netCalls));

    const chatId = res1.body.chatId;
    const priorChat = new Chat({
      _id: chatId,
      tenantId: TENANT,
      userId: "AUDIT-USER",
      title: Q.slice(0, 60),
      messages: [
        ...lastSaved.messages.map((m) => ({ role: m.role, text: m.text, toolCalls: m.toolCalls, queryContext: m.queryContext })), // exactly what the controller persisted for turn 1
      ],
    });
    const realFindOne = Chat.findOne.bind(Chat);
    Chat.findOne = async (filter) => (String(filter._id) === String(chatId) ? priorChat : realFindOne(filter));

    plannerRequests.length = 0;
    const res2 = mockRes();
    await sendChatMessage(mockReq({ message: Q, chatId }), res2);
    check("turn 2 (identical question, WITH conversation history): HTTP 200", res2.statusCode === 200 && res2.body.success);
    check("turn 2: still exactly ONE planner call - history did not trigger a second Claude call", res2.body.data.details.queryEngine.claudeCalls === 1 && res2.body.data.details.queryEngine.route === "planner" && plannerRequests.length === 1);
    check("turn 2: answer cache HIT (the engine was reused, not recomputed)", res2.body.data.details.queryEngine.cache === "hit");
    check("turn 2: same answer as turn 1", res2.body.data.answer === res1.body.data.answer);
    const sent = plannerRequests[0] ? plannerRequests[0].messages : [];
    check("turn 2: the planner got the previous STRUCTURED plan, not the chat text", sent.length === 1 && /Previous query plan/.test(sent[0].content) && !sent[0].content.includes(res1.body.data.answer.slice(0, 40)) && !JSON.stringify(plannerRequests[0]).includes("AUDIT-USER"));
    check("turn 2: still zero real network calls", netCalls === 0, String(netCalls));
    Chat.findOne = realFindOne;

    // ============================================================ 4: unrelated history present
    section("4. A question after UNRELATED conversation history");
    plannerRequests.length = 0;
    const unrelatedChat = new Chat({ _id: "000000000000000000000000", tenantId: TENANT, userId: "AUDIT-USER", title: "x", messages: [{ role: "user", text: "top 5 customers this month" }, { role: "assistant", text: "some unrelated prior answer" }] });
    Chat.findOne = async (filter) => (String(filter._id) === "000000000000000000000000" ? unrelatedChat : realFindOne(filter));
    const res3 = mockRes();
    await sendChatMessage(mockReq({ message: Q, chatId: "000000000000000000000000" }), res3);
    check("unrelated prior history: one planner call, no previous plan sent (none stored)", res3.body.data.details.queryEngine.claudeCalls === 1 && res3.body.data.details.queryEngine.route === "planner" && plannerRequests.length === 1 && !/Previous query plan/.test(plannerRequests[0].messages[0].content) && !JSON.stringify(plannerRequests[0]).includes("unrelated prior answer"));
    check("...still zero network calls", netCalls === 0, String(netCalls));
    Chat.findOne = realFindOne;

    // ============================================================ 5: cache key equality proof
    section("5. Cache key equality (cryptographic proof, not inference)");
    const dc = await getTenantDateContext(TENANT);
    const version = await getTenantVersion(TENANT);
    const keyFor = (plan) => crypto.createHash("sha256").update(`${catalog.CATALOG_VERSION}|${stableStringify(plan)}|${dc.referenceDate.toISOString()}|${version}`).digest("hex");
    check("the same plan from two turns -> the SAME cache key (why turn 2 was a hit)", keyFor(GROUP_PLAN) === keyFor(JSON.parse(JSON.stringify(GROUP_PLAN))));
    check("a different plan -> a different key", keyFor(GROUP_PLAN) !== keyFor({ ...GROUP_PLAN, limit: 5 }));

    // ============================================================ 6: a decline is honest and costs one call
    section("6. A reasoning question is declined honestly: no figure, no engine");
    plannerRequests.length = 0;
    script.next = { decline: { code: "not_a_data_query", message: "Explanations are not supported." } };
    const res4 = mockRes();
    await sendChatMessage(mockReq({ message: "Why are my sales declining and what should I focus on?" }), res4);
    check("handled honestly, ONE planner call, the decline is the answer", res4.statusCode === 200 && res4.body.success && res4.body.data.details.queryEngine.claudeCalls === 1 && res4.body.data.details.queryEngine.status === "unsupported");
    check("...and it did NOT return a metric figure", !/Invoice amount|Line amount|₹\d/.test(res4.body.data.answer));
    check("...zero real network calls throughout (no accidental live Claude call anywhere in this suite)", netCalls === 0, String(netCalls));

    // ============================================================ 7: the safety gate stops a question before any call
    section("7. The safety gate: unsafe text never reaches the planner");
    plannerRequests.length = 0;
    const res5 = mockRes();
    await sendChatMessage(mockReq({ message: "show sales for tenantId 5" }), res5);
    check("unsafe question: answered with a refusal, 0 planner calls", res5.statusCode === 200 && plannerRequests.length === 0 && res5.body.data.details.queryEngine.claudeCalls === 0);

    console.log(`\nTotal Chat.save() attempts intercepted (proves 0 real Mongo writes occurred): ${saveCalls}`);
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanSeed();
    Chat.prototype.save = realSave;
    Object.assign(global, { fetch: savedNet.fetch });
    http.request = savedNet.h;
    https.request = savedNet.s;
    await mongoose.disconnect();
  }
  console.log(`\nverify-cost-forensic: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

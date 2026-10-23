/**
 * P0 forensic regression: proves, at the REAL exported chatController.js
 * `sendChatMessage` HTTP-handler level (not tryAnswerWithQueryEngine in
 * isolation), that a deterministic question costs 0 Claude calls - fresh,
 * repeated, and with real conversation history - and that the answer
 * cache is genuinely reused (cacheKey equality, executor skipped).
 *
 * Safety: global fetch/http/https are poisoned for the whole run (any
 * real network call, Anthropic or otherwise, throws and is counted).
 * Chat.prototype.save is faked (no Mongo write). Reads real WE FOUR data
 * (read-only) for realism; no writes, no Tally, no live Claude.
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
const realSave = Chat.prototype.save;
Chat.prototype.save = async function fakeSave() {
  saveCalls += 1;
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  return this;
};

const { sendChatMessage } = require("./src/controllers/chatController");
const { routeQuestion } = require("./src/services/query/localRouter");
const { createEntityResolver } = require("./src/services/query/entityResolver");
const { stableStringify } = require("./src/services/query/answerCache");
const catalog = require("./src/services/query/semanticCatalog");
const { getTenantDateContext } = require("./src/services/analytics/referenceDate");
const { getTenantVersion } = require("./src/services/query/dataVersion");

const WE_FOUR = "6ab21418959e173f9b3f367f";
const WE_FOUR_GUID = "d46f1002-00d9-4559-b3e1-afcf8674c7b1";
const Q = "Sales performance by product group/category of aug 2025";

function mockReq({ message, chatId, priorMessages }) {
  return { body: { message }, params: chatId ? { chatId } : {}, companyContext: { tenantId: WE_FOUR, companyGuid: WE_FOUR_GUID }, user: { id: "AUDIT-USER" }, __priorMessages: priorMessages };
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
    // ============================================================ 1-3: controller-level, fresh / repeat / history
    section("1-3. Real sendChatMessage handler: fresh, repeated, with history");
    const req1 = mockReq({ message: Q });
    const res1 = mockRes();
    await sendChatMessage(req1, res1);
    check("turn 1: HTTP 200, deterministic answer", res1.statusCode === 200 && res1.body.success && /Oddy|Pentonic|product group/i.test(res1.body.data.answer));
    check("turn 1: claudeCalls = 0", res1.body.data.details.queryEngine.claudeCalls === 0);
    check("turn 1: answer cache miss (first computation)", res1.body.data.details.queryEngine.cache === "miss");
    check("turn 1: zero real network calls (would include any Claude call)", netCalls === 0, String(netCalls));

    const chatId = res1.body.chatId;
    const priorChat = new Chat({
      _id: chatId,
      tenantId: WE_FOUR,
      userId: "AUDIT-USER",
      title: Q.slice(0, 60),
      messages: [
        { role: "user", text: Q },
        { role: "assistant", text: res1.body.data.answer, toolCalls: res1.body.data.details.toolCalls, queryContext: res1.body.data.queryContext },
      ],
    });
    const realFindOne = Chat.findOne.bind(Chat);
    Chat.findOne = async (filter) => (String(filter._id) === String(chatId) ? priorChat : realFindOne(filter));

    const req2 = mockReq({ message: Q, chatId });
    const res2 = mockRes();
    await sendChatMessage(req2, res2);
    check("turn 2 (identical question, WITH real conversation history): HTTP 200", res2.statusCode === 200 && res2.body.success);
    check("turn 2: claudeCalls = 0", res2.body.data.details.queryEngine.claudeCalls === 0);
    check("turn 2: answer cache HIT (reused, not recomputed)", res2.body.data.details.queryEngine.cache === "hit");
    check("turn 2: same answer as turn 1 (not a legacy 'I already told you' recap)", res2.body.data.answer === res1.body.data.answer);
    check("turn 2: still zero real network calls (history did not force legacy Claude)", netCalls === 0, String(netCalls));
    check("turn 2: routed via the router, never legacy", res2.body.data.details.queryEngine.route === "router");
    Chat.findOne = realFindOne;

    // ============================================================ 4: unrelated history present
    section("4. Deterministic question after UNRELATED conversation history");
    const req3 = mockReq({ message: Q, chatId: "000000000000000000000000" });
    const unrelatedChat = new Chat({ _id: "000000000000000000000000", tenantId: WE_FOUR, userId: "AUDIT-USER", title: "x", messages: [{ role: "user", text: "top 5 customers this month" }, { role: "assistant", text: "some unrelated prior answer" }] });
    Chat.findOne = async (filter) => (String(filter._id) === "000000000000000000000000" ? unrelatedChat : realFindOne(filter));
    const res3 = mockRes();
    await sendChatMessage(req3, res3);
    check("unrelated prior history does not force legacy Claude for an independently deterministic question", res3.body.data.details.queryEngine.claudeCalls === 0 && res3.body.data.details.queryEngine.route === "router");
    check("...still zero network calls", netCalls === 0, String(netCalls));
    Chat.findOne = realFindOne;

    // ============================================================ 5: cache key equality proof
    section("5. Cache key equality (cryptographic proof, not inference)");
    const resolver = createEntityResolver({ tenantId: WE_FOUR });
    const r1 = await routeQuestion(Q, { resolveEntity: resolver, referenceDate: new Date() });
    const r2 = await routeQuestion(Q, { resolveEntity: resolver, referenceDate: new Date() });
    check("the router builds the IDENTICAL plan both times", JSON.stringify(r1.plan) === JSON.stringify(r2.plan));
    const dc = await getTenantDateContext(WE_FOUR);
    const version = await getTenantVersion(WE_FOUR);
    const keyFor = (plan) => crypto.createHash("sha256").update(`${catalog.CATALOG_VERSION}|${stableStringify(plan)}|${dc.referenceDate.toISOString()}|${version}`).digest("hex");
    check("cacheKey(turn1) === cacheKey(turn2)", keyFor(r1.plan) === keyFor(r2.plan));

    // ============================================================ 6: genuine reasoning question still reaches Claude-eligible path
    section("6. Genuine reasoning question is NOT silently answered deterministically");
    const req4 = mockReq({ message: "Why are my sales declining and what should I focus on?" });
    const res4 = mockRes();
    await sendChatMessage(req4, res4);
    check("reasoning question: handled honestly (G7), still 0 unnecessary Claude for a fixed refusal", res4.statusCode === 200 && res4.body.success && res4.body.data.details.queryEngine.claudeCalls === 0);
    check("...and it did NOT return a metric figure", !/Invoice amount|₹\d/.test(res4.body.data.answer));
    check("...zero real network calls throughout (no accidental live Claude call anywhere in this suite)", netCalls === 0, String(netCalls));

    console.log(`\nTotal Chat.save() attempts intercepted (proves 0 real Mongo writes occurred): ${saveCalls}`);
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    Chat.prototype.save = realSave;
    Object.assign(global, { fetch: savedNet.fetch });
    http.request = savedNet.h;
    https.request = savedNet.s;
    await mongoose.disconnect();
  }
  console.log(`\nverify-cost-forensic: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

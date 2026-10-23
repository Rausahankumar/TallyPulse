/**
 * Ask AI chat management + Stop (cancellation), at the real controller level.
 *
 * - STOP: a client disconnect (the browser's AbortController) before the planner, during the in-flight planner call,
 *   or right after the planner answered ends the turn: no further planner call, no save, telemetry
 *   clientAborted=true / httpStatus 499. The in-flight planner request receives the abort signal. A real SDK
 *   planner client pointed at a local stub (never api.anthropic.com) is aborted mid-request and makes exactly
 *   one request (no retry).
 * - RENAME / DELETE / LIST / GET: ownership filter (tenant + user), validation, no side effects on messages.
 *   Chat model reads/writes are faked in memory: no Mongo writes.
 * - COST: global fetch / http / https are poisoned and counted for the whole run (only the local stub is let
 *   through, counted separately), so any real Anthropic call would fail the run.
 *
 * A synthetic tenant: freshness is stubbed, the engine reads nothing real, Chat reads/writes are faked.
 * Run: node verify-chat-management.js
 */
require("dotenv").config();
const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");
const mongoose = require("mongoose");

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 400)})` : ""}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- network poison (external calls only)
let netCalls = 0;
let stubOrigin = null; // the local fake-Anthropic server, when running
const realFetch = global.fetch;
const realHttpRequest = http.request;
const realHttpsRequest = https.request;
global.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
  if (stubOrigin && url.startsWith(stubOrigin)) return realFetch(input, init);
  netCalls += 1;
  throw new Error(`NETWORK BLOCKED: ${url}`);
};
http.request = (...a) => {
  netCalls += 1;
  throw new Error("NETWORK BLOCKED (http)");
};
https.request = (...a) => {
  netCalls += 1;
  throw new Error("NETWORK BLOCKED (https)");
};

// ---------------------------------------------------------------- fake planner client for the controller turns
// Installed BEFORE the controller (queryChat) is required: queryChat creates its planner client lazily from this factory.
const plannerModule = require("./src/services/query/planner");
const realCreatePlannerClient = plannerModule.createAnthropicPlannerClient;
const fakePlanner = { mode: "plan", calls: 0, signals: [], onCall: null };
const FAKE_PLAN = { v: 1, entity: "sales", mode: "aggregate", period: { kind: "previous_month" }, metrics: ["invoiceAmount", "invoiceCount"], filters: [] };
plannerModule.createAnthropicPlannerClient = () => async (request, opts = {}) => {
  fakePlanner.calls += 1;
  fakePlanner.signals.push(opts.signal || null);
  if (fakePlanner.onCall) fakePlanner.onCall(fakePlanner.calls);
  if (fakePlanner.mode === "plan") return { content: [{ type: "tool_use", id: "p", name: "submit_query_plan", input: { plan: FAKE_PLAN } }], usage: { input_tokens: 10, output_tokens: 5 } };
  // "analysis": the query planner declines with needs_analysis, the analysis planner answers with a one-step plan
  if (fakePlanner.mode === "analysis") {
    return request.tool_choice.name === "submit_query_plan"
      ? { content: [{ type: "tool_use", id: "p", name: "submit_query_plan", input: { decline: { code: "needs_analysis", message: "This needs several analyses." } } }], usage: { input_tokens: 10, output_tokens: 5 } }
      : { content: [{ type: "tool_use", id: "a", name: "submit_analysis_plan", input: { analysis: { v: 1, steps: [{ id: "s", kind: "query", plan: FAKE_PLAN }] } } }], usage: { input_tokens: 10, output_tokens: 5 } };
  }
  if (fakePlanner.mode === "unavailable") throw Object.assign(new Error("no API key"), { code: "AI_NOT_CONFIGURED" });
  // "hang": like the SDK, only settles when the request's signal aborts
  return new Promise((_, reject) => {
    const sig = opts.signal;
    if (!sig) return;
    const fire = () => {
      const e = new Error("Request was aborted.");
      e.name = "APIUserAbortError";
      reject(e);
    };
    if (sig.aborted) fire();
    else sig.addEventListener("abort", fire, { once: true });
  });
};

// Freshness is not what this suite tests: every entity is "fresh" (the freshness gate has its own suites).
const freshPath = require.resolve("./src/services/analytics/freshness");
require.cache[freshPath] = { id: freshPath, filename: freshPath, loaded: true, exports: { ...require(freshPath), getFreshness: async () => ({ state: "fresh", dataAsOf: new Date(), message: "Data is current." }) } };

const Chat = require("./src/models/chat.model");
const connectDB = require("./src/config/db");
const controller = require("./src/controllers/chatController");
const { sendChatMessage, renameChat, deleteChat, listChats, getChat, MAX_CHAT_TITLE_CHARS } = controller;
const telemetry = require("./src/services/query/turnTelemetry");
const { planQuestion } = plannerModule;
const createAnthropicPlannerClient = realCreatePlannerClient; // the REAL SDK client factory (STOP 7)

const events = [];
telemetry.setTelemetrySink((line) => events.push(JSON.parse(line)));

const TENANT = "TEST-TENANT-chat-management";
const GUID = "test-guid-chat-management";
const USER = new mongoose.Types.ObjectId().toString();
const OTHER_USER = new mongoose.Types.ObjectId().toString();
const OTHER_TENANT = "OTHER-TENANT-ID";

// ---------------------------------------------------------------- in-memory Chat store (no Mongo writes)
let saves = 0;
let lastSaved = null;
Chat.prototype.save = async function fakeSave() {
  saves += 1;
  lastSaved = this;
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  return this;
};
const store = new Map();
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v));
const seed = (over) => {
  const doc = { _id: new mongoose.Types.ObjectId().toString(), tenantId: TENANT, userId: USER, title: "top 10 customers grew or declined", messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }], createdAt: new Date("2026-09-01"), updatedAt: new Date("2026-09-02"), ...over };
  store.set(doc._id, doc);
  return doc;
};
const dbCalls = [];
const lean = (v) => ({ lean: async () => v });
Chat.findOneAndUpdate = (filter, update, opts) => {
  dbCalls.push({ op: "findOneAndUpdate", filter, update, opts });
  const doc = [...store.values()].find((d) => matches(d, filter));
  if (!doc) return lean(null);
  Object.assign(doc, update.$set);
  if (!opts || opts.timestamps !== false) doc.updatedAt = new Date();
  return lean({ _id: doc._id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
};
Chat.deleteOne = async (filter) => {
  dbCalls.push({ op: "deleteOne", filter });
  const doc = [...store.values()].find((d) => matches(d, filter));
  if (!doc) return { deletedCount: 0 };
  store.delete(doc._id);
  return { deletedCount: 1 };
};
Chat.find = (filter) => {
  dbCalls.push({ op: "find", filter });
  const rows = [...store.values()].filter((d) => matches(d, filter)).map((d) => ({ _id: d._id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt }));
  const q = { select: () => q, sort: () => q, lean: async () => rows };
  return q;
};
let historyChat = null; // what findOne returns for the Stop tests
Chat.findOne = (filter) => {
  dbCalls.push({ op: "findOne", filter });
  if (historyChat && String(filter._id) === String(historyChat._id)) return Promise.resolve(historyChat);
  const doc = [...store.values()].find((d) => matches(d, filter)) || null;
  const p = Promise.resolve(doc);
  p.lean = async () => doc;
  return p;
};

// ---------------------------------------------------------------- fake req/res
function mkRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.body = null;
  res.writableFinished = false;
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    res.writableFinished = true;
    res.emit("close");
    return res;
  };
  return res;
}
const mkReq = ({ tenantId = TENANT, userId = USER, params = {}, body = {} } = {}) => ({ id: "test-req-0001", params, body, companyContext: { tenantId, companyGuid: GUID }, user: { id: userId } });
const clientStops = (res) => res.emit("close"); // what the browser's AbortController does to this response

(async () => {
  await connectDB();
  try {
    // ============================================================ STOP
    historyChat = new Chat({ _id: new mongoose.Types.ObjectId(), tenantId: TENANT, userId: USER, title: "t", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }] });

    section("STOP 0. Stop that lands during auth middleware (connection already closed before the controller runs)");
    // Found live: the browser aborted ~40ms in, while auth/company middleware were still reading Mongo; the
    // controller's "close" listener was registered after the event and never fired, so the turn completed.
    Object.assign(fakePlanner, { mode: "plan", calls: 0, signals: [], onCall: null });
    let res = mkRes();
    res.destroyed = true;
    res.closed = true; // what Node reports once the socket is gone; "close" will not be emitted again
    saves = 0;
    events.length = 0;
    await sendChatMessage(mkReq({ params: { chatId: String(historyChat._id) }, body: { message: "show sales last month" } }), res);
    let ev = events[events.length - 1];
    check("no planner call", fakePlanner.calls === 0, fakePlanner.calls);
    check("not saved, nothing written", saves === 0 && res.body === null, `${saves} ${JSON.stringify(res.body)}`);
    check("telemetry: clientAborted=true, httpStatus 499", ev && ev.clientAborted === true && ev.httpStatus === 499, JSON.stringify(ev));

    section("STOP 1. Stop during the planner call: aborted in flight, no second call, no save");
    Object.assign(fakePlanner, { mode: "hang", calls: 0, signals: [], onCall: null });
    res = mkRes();
    saves = 0;
    events.length = 0;
    let done = sendChatMessage(mkReq({ params: { chatId: String(historyChat._id) }, body: { message: "show sales last month" } }), res);
    for (let i = 0; i < 200 && fakePlanner.calls === 0; i += 1) await tick(10);
    check("the question reached the planner call (precondition)", fakePlanner.calls === 1, fakePlanner.calls);
    check("the in-flight planner request was given an abort signal", !!fakePlanner.signals[0] && fakePlanner.signals[0].aborted === false);
    clientStops(res);
    await done;
    check("Stop aborted that same in-flight planner request", fakePlanner.signals[0].aborted === true);
    check("exactly one planner call - no retry", fakePlanner.calls === 1, fakePlanner.calls);
    check("nothing written to the closed connection", res.body === null);
    check("the stopped turn was NOT saved", saves === 0, saves);
    ev = events[events.length - 1];
    check("telemetry: clientAborted=true, httpStatus 499, claudeCalls 1", ev && ev.clientAborted === true && ev.httpStatus === 499 && ev.claudeCalls === 1 && ev.ok === false, JSON.stringify(ev));

    section("STOP 2. Stop right after the planner answered: the answer is never saved or written");
    Object.assign(fakePlanner, { mode: "plan", calls: 0, signals: [] });
    res = mkRes();
    saves = 0;
    events.length = 0;
    fakePlanner.onCall = (n) => {
      if (n === 1) clientStops(res);
    };
    await sendChatMessage(mkReq({ params: { chatId: String(historyChat._id) }, body: { message: "show sales last month" } }), res);
    fakePlanner.onCall = null;
    check("only the one planner call that was already running", fakePlanner.calls === 1, fakePlanner.calls);
    check("not saved, nothing written", saves === 0 && res.body === null);
    ev = events[events.length - 1];
    check("telemetry: clientAborted=true, httpStatus 499", ev && ev.clientAborted === true && ev.httpStatus === 499, JSON.stringify(ev));

    section("STOP 3. Stop before the engine finishes: never becomes a planner call");
    Object.assign(fakePlanner, { mode: "plan", calls: 0, signals: [] });
    res = mkRes();
    saves = 0;
    events.length = 0;
    const before = netCalls;
    done = sendChatMessage(mkReq({ params: { chatId: String(historyChat._id) }, body: { message: "show sales last month" } }), res);
    clientStops(res);
    await done;
    check("the planner was never called after Stop", fakePlanner.calls === 0, fakePlanner.calls);
    check("no network call at all", netCalls === before, netCalls - before);
    check("not saved", saves === 0);
    ev = events[events.length - 1];
    check("telemetry: clientAborted=true, httpStatus 499, claudeCalls 0", ev && ev.clientAborted === true && ev.httpStatus === 499 && !ev.claudeCalls, JSON.stringify(ev));

    section("STOP 4. Stop on a NEW chat before the planner: no planner call, no orphan chat");
    res = mkRes();
    saves = 0;
    const b4 = netCalls;
    done = sendChatMessage(mkReq({ body: { message: "show sales last month" } }), res);
    clientStops(res);
    await done;
    check("planner never called", fakePlanner.calls === 0 && netCalls === b4, `${fakePlanner.calls} ${netCalls - b4}`);
    check("no chat created", saves === 0);

    section("STOP 5. A normal (not stopped) turn is unchanged");
    Object.assign(fakePlanner, { mode: "plan", calls: 0, signals: [] });
    res = mkRes();
    saves = 0;
    events.length = 0;
    await sendChatMessage(mkReq({ params: { chatId: String(historyChat._id) }, body: { message: "show sales last month" } }), res);
    ev = events[events.length - 1];
    check("answered 200, saved once, one planner call, clientAborted=false", res.statusCode === 200 && res.body.success === true && typeof res.body.data.answer === "string" && res.body.data.answer.length > 0 && saves === 1 && fakePlanner.calls === 1 && ev.clientAborted === false && ev.httpStatus === 200, JSON.stringify(ev));
    Object.assign(fakePlanner, { mode: "unavailable", calls: 0, signals: [] });
    res = mkRes();
    events.length = 0;
    await sendChatMessage(mkReq({ body: { message: "Sales performance by product group/category of aug 2025" } }), res);
    ev = events[events.length - 1];
    check("planner unavailable: 200 with an honest planner-unavailable answer, path planner_failed", res.statusCode === 200 && ev.path === "planner_failed" && ev.clientAborted === false && /planner is unavailable/i.test(res.body.data.answer), JSON.stringify(ev));
    historyChat = null;

    section("SAVE. An analysis-plan answer (ASK_AI_ANALYSIS on for this process only) is saved and reloads like any answer");
    const flagBefore = process.env.ASK_AI_ANALYSIS;
    process.env.ASK_AI_ANALYSIS = "on";
    try {
      Object.assign(fakePlanner, { mode: "analysis", calls: 0, signals: [], onCall: null });
      res = mkRes();
      saves = 0;
      lastSaved = null;
      events.length = 0;
      await sendChatMessage(mkReq({ body: { message: "EVAL-01 Why did sales change last month?" } }), res);
      ev = events[events.length - 1];
      const saved = lastSaved && lastSaved.toObject();
      check("answered 200 through the real controller: two planner calls (query + analysis), saved once", res.statusCode === 200 && res.body.success === true && fakePlanner.calls === 2 && saves === 1, `${res.statusCode} ${fakePlanner.calls} ${saves}`);
      check("the saved chat holds the question and the SAME answer the browser received, marked analysis_plan", !!saved && saved.title === "EVAL-01 Why did sales change last month?" && saved.messages.map((m) => m.role).join() === "user,assistant" && saved.messages[0].text === "EVAL-01 Why did sales change last month?" && saved.messages[1].text === res.body.data.answer && /^Analysis: measured results only/.test(saved.messages[1].text) && saved.messages[1].toolCalls[0].toolName === "analysis_plan", JSON.stringify(saved && saved.messages[1]));
      check("saved under the authorised tenant and user only", !!saved && saved.tenantId === TENANT && String(saved.userId) === USER);
      // this synthetic tenant has no vouchers: its one step is refused as missing data, so the turn ran nothing (analysis_failed)
      check("telemetry/usage: route analysis, path analysis_failed (no data ran), 2 Claude calls", ev && ev.route === "analysis" && ev.path === "analysis_failed" && ev.claudeCalls === 2 && /Not run: /.test(res.body.data.answer), JSON.stringify(ev));
      store.set(String(saved._id), { ...saved, _id: String(saved._id), userId: USER });
      res = mkRes();
      await getChat(mkReq({ params: { chatId: String(saved._id) } }), res);
      check("after a refresh, opening the chat returns the same question and answer", res.statusCode === 200 && res.body.data.messages[1].text === saved.messages[1].text && res.body.data.messages[0].text === saved.messages[0].text);
      res = mkRes();
      await getChat(mkReq({ userId: OTHER_USER, params: { chatId: String(saved._id) } }), res);
      check("another user of the same company cannot open it (404)", res.statusCode === 404);
      store.delete(String(saved._id));
    } finally {
      if (flagBefore === undefined) delete process.env.ASK_AI_ANALYSIS;
      else process.env.ASK_AI_ANALYSIS = flagBefore;
    }

    section("STOP 6. planQuestion: an already-cancelled request never calls Claude");
    let plannerCalls = 0;
    const ac = new AbortController();
    ac.abort();
    const planned = await planQuestion("show sales last month", { claudeClient: async () => ((plannerCalls += 1), {}), signal: ac.signal, referenceDate: new Date() });
    check("0 planner calls, usage.calls 0", plannerCalls === 0 && planned.usage.calls === 0, JSON.stringify(planned.usage));

    section("STOP 7. Real SDK planner client vs a local stub: Stop aborts the in-flight request, no retry");
    let stubRequests = 0;
    let stubSocketClosed = false;
    const stub = http.createServer((req, resp) => {
      stubRequests += 1;
      req.on("close", () => {
        stubSocketClosed = true;
      });
      // never answers - like a long Claude generation
    });
    http.request = realHttpRequest; // the stub server itself needs the real http module
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    stubOrigin = `http://127.0.0.1:${stub.address().port}`;
    const client = createAnthropicPlannerClient({ sdkOptions: { apiKey: "test-key-not-real", baseURL: stubOrigin }, attemptTimeoutMs: 20000, deadlineMs: 20000 });
    const stop = new AbortController();
    const t0 = Date.now();
    const pending = client({ max_tokens: 10, messages: [{ role: "user", content: "x" }] }, { signal: stop.signal }).then(
      () => "resolved",
      (e) => e
    );
    for (let i = 0; i < 200 && stubRequests === 0; i += 1) await tick(10);
    stop.abort();
    const outcome = await pending;
    await tick(100);
    check("the request reached the (stub) provider before Stop", stubRequests >= 1, stubRequests);
    check("Stop rejected the call promptly (not the 20s deadline)", outcome instanceof Error && Date.now() - t0 < 5000, outcome && outcome.name);
    check("the provider-side connection was closed", stubSocketClosed === true);
    check("exactly one request - the SDK did not retry an aborted call", stubRequests === 1, stubRequests);
    stubOrigin = null;
    await new Promise((r) => stub.close(r));
    http.request = (...a) => {
      netCalls += 1;
      throw new Error("NETWORK BLOCKED (http)");
    };

    const plannerCallsBeforeManagement = fakePlanner.calls;
    // ============================================================ RENAME
    section("RENAME. Ownership, validation, only the title changes");
    const mine = seed();
    const theirs = seed({ userId: OTHER_USER, title: "other user's chat" });
    const foreign = seed({ tenantId: OTHER_TENANT, title: "other company's chat" });
    const msgsBefore = JSON.stringify(mine.messages);
    const updatedBefore = mine.updatedAt;

    res = mkRes();
    await renameChat(mkReq({ params: { chatId: mine._id }, body: { title: "  Q2 Customer Performance  " } }), res);
    check("own chat: 200, trimmed title returned", res.statusCode === 200 && res.body.data.title === "Q2 Customer Performance", JSON.stringify(res.body));
    check("stored title changed; id, messages and updatedAt untouched (no reordering)", store.get(mine._id).title === "Q2 Customer Performance" && JSON.stringify(store.get(mine._id).messages) === msgsBefore && store.get(mine._id).updatedAt === updatedBefore);
    const upd = dbCalls.filter((c) => c.op === "findOneAndUpdate").pop();
    check("the update is scoped to {_id, tenantId, userId} and only $sets title", String(upd.filter.tenantId) === TENANT && String(upd.filter.userId) === USER && JSON.stringify(Object.keys(upd.update.$set)) === '["title"]' && upd.opts.timestamps === false);

    res = mkRes();
    await getChat(mkReq({ params: { chatId: mine._id } }), res);
    check("persisted: reopening the chat returns the new title", res.body.data.title === "Q2 Customer Performance");
    res = mkRes();
    await listChats(mkReq(), res);
    check("persisted: the chat list returns the new title", res.body.data.some((c) => String(c._id) === mine._id && c.title === "Q2 Customer Performance"));

    res = mkRes();
    await renameChat(mkReq({ params: { chatId: theirs._id }, body: { title: "hijack" } }), res);
    check("another user's chat (same company): 404, unchanged", res.statusCode === 404 && store.get(theirs._id).title === "other user's chat");
    res = mkRes();
    await renameChat(mkReq({ params: { chatId: foreign._id }, body: { title: "hijack" } }), res);
    check("another company's chat: 404, unchanged", res.statusCode === 404 && store.get(foreign._id).title === "other company's chat");
    res = mkRes();
    await renameChat(mkReq({ tenantId: OTHER_TENANT, params: { chatId: mine._id }, body: { title: "hijack" } }), res);
    check("my chat id used from another company's context: 404, unchanged", res.statusCode === 404 && store.get(mine._id).title === "Q2 Customer Performance");

    const nUpdates = dbCalls.filter((c) => c.op === "findOneAndUpdate").length;
    const bad = [
      ["empty", ""],
      ["whitespace only", "   \t  "],
      ["too long", "x".repeat(MAX_CHAT_TITLE_CHARS + 1)],
      ["line break", "Q2\nPerformance"],
      ["not a string", 42],
      ["missing", undefined],
    ];
    for (const [label, title] of bad) {
      res = mkRes();
      await renameChat(mkReq({ params: { chatId: mine._id }, body: title === undefined ? {} : { title } }), res);
      check(`${label}: 400, safe message, title unchanged`, res.statusCode === 400 && typeof res.body.message === "string" && !/mongo|cast|objectid|stack/i.test(res.body.message) && store.get(mine._id).title === "Q2 Customer Performance", `${res.statusCode} ${JSON.stringify(res.body)}`);
    }
    check("...and none of the rejected titles reached the database", dbCalls.filter((c) => c.op === "findOneAndUpdate").length === nUpdates);
    res = mkRes();
    await renameChat(mkReq({ params: { chatId: mine._id }, body: { title: "y".repeat(MAX_CHAT_TITLE_CHARS) } }), res);
    check(`exactly ${MAX_CHAT_TITLE_CHARS} characters is accepted`, res.statusCode === 200);
    res = mkRes();
    await renameChat(mkReq({ params: { chatId: "not-an-id" }, body: { title: "x" } }), res);
    check("invalid chat id: 404, no database call", res.statusCode === 404 && dbCalls.filter((c) => c.op === "findOneAndUpdate").length === nUpdates + 1);
    res = mkRes();
    await renameChat(mkReq({ params: { chatId: new mongoose.Types.ObjectId().toString() }, body: { title: "x" } }), res);
    check("unknown chat id: 404", res.statusCode === 404);

    // ============================================================ DELETE
    section("DELETE. Unchanged behaviour, same ownership filter");
    res = mkRes();
    await deleteChat(mkReq({ params: { chatId: theirs._id } }), res);
    check("another user's chat: 404, still there", res.statusCode === 404 && store.has(theirs._id));
    res = mkRes();
    await deleteChat(mkReq({ params: { chatId: foreign._id } }), res);
    check("another company's chat: 404, still there", res.statusCode === 404 && store.has(foreign._id));
    res = mkRes();
    await deleteChat(mkReq({ params: { chatId: "bad" } }), res);
    check("invalid id: 404", res.statusCode === 404);
    res = mkRes();
    await deleteChat(mkReq({ params: { chatId: mine._id } }), res);
    check("own (renamed) chat: 200 and gone", res.statusCode === 200 && !store.has(mine._id));
    res = mkRes();
    await renameChat(mkReq({ params: { chatId: mine._id }, body: { title: "after delete" } }), res);
    check("renaming a deleted chat: 404 (never recreated)", res.statusCode === 404 && !store.has(mine._id));

    // ============================================================ COST
    section("COST. Rename / delete / list / open never touch AI");
    check("zero external network calls across the whole run (no Claude/Anthropic call anywhere)", netCalls === 0, netCalls);
    check("the chat-management handlers never reached the planner", fakePlanner.calls === plannerCallsBeforeManagement, `${fakePlanner.calls} vs ${plannerCallsBeforeManagement}`);
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await mongoose.disconnect();
  }
  console.log(`\nverify-chat-management: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

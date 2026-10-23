/**
 * Ask AI Stop / Rename / Delete at the real frontend API layer (src/api/client.js + src/api/chat.js, loaded
 * through Vite's SSR transform) against a LOCAL stub backend. No real backend, no Claude, no Tally.
 *
 * Proves: Stop aborts the actual HTTP request (the server sees the connection close), exactly one request is
 * ever sent (no retry, no regenerate), the abort surfaces as ApiError code CANCELED (not "backend
 * unreachable"), the next question goes through normally, and rename/delete/list/open are plain REST calls
 * to the chat API only. https/fetch are poisoned: any call to Anthropic or elsewhere fails the run.
 *
 * Run: node verify-chat-api.mjs
 */
import http from "node:http";
import https from "node:https";
import { createServer as createVite } from "vite";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local stub backend: records every request; "hang" never answers (a long AI turn)
const seen = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const rec = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null, closedEarly: false };
    seen.push(rec);
    res.on("close", () => {
      if (!res.writableFinished) rec.closedEarly = true;
    });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "POST" && /\/message$/.test(req.url) && rec.body && rec.body.message === "hang") return; // never answers
    if (req.method === "POST" && /\/message$/.test(req.url)) return send(200, { success: true, chatId: "c1", data: { answer: "ok", details: { toolCalls: [] } } });
    if (req.method === "PATCH") return send(200, { success: true, data: { _id: "c1", title: rec.body.title } });
    if (req.method === "DELETE") return send(200, { success: true, message: "Chat deleted." });
    if (req.method === "GET" && req.url.endsWith("/chat/")) return send(200, { success: true, data: [] });
    if (req.method === "GET") return send(200, { success: true, data: { _id: "c1", messages: [] } });
    return send(404, { success: false, message: "Not found" });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${stub.address().port}/api`;

// ---- anything that is not the local stub is blocked and counted
let externalCalls = 0;
const savedFetch = globalThis.fetch;
const savedHttps = https.request;
globalThis.fetch = () => {
  externalCalls += 1;
  throw new Error("NETWORK BLOCKED (fetch)");
};
https.request = () => {
  externalCalls += 1;
  throw new Error("NETWORK BLOCKED (https)");
};

const vite = await createVite({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
try {
  const chat = await vite.ssrLoadModule("/src/api/chat.js");
  const { ApiError } = await vite.ssrLoadModule("/src/api/client.js");

  section("A/P/Q. Stop aborts the real request - once, no retry, no second request");
  const controller = new AbortController();
  const pending = chat.sendChatMessage({ chatId: "c1", message: "hang", signal: controller.signal }).then(
    () => "resolved",
    (e) => e
  );
  for (let i = 0; i < 200 && seen.length === 0; i += 1) await sleep(10);
  check("the question reached the server", seen.length === 1 && seen[0].method === "POST" && seen[0].url === "/api/chat/c1/message", JSON.stringify(seen));
  const t0 = Date.now();
  controller.abort();
  const outcome = await pending;
  check("Stop settles immediately (not the 60s chat timeout)", Date.now() - t0 < 1000, Date.now() - t0);
  check("surfaces as ApiError code CANCELED - not 'backend unreachable' / timeout", outcome instanceof ApiError && outcome.code === "CANCELED", outcome && `${outcome.code} ${outcome.message}`);
  await sleep(150);
  check("the server saw the connection close before it answered (real abort, not a UI-only stop)", seen[0].closedEarly === true);
  await sleep(1000);
  check("still exactly one request after waiting: no retry, no regenerate", seen.filter((r) => r.method === "POST").length === 1, seen.length);

  section("C. After Stop the next question goes through normally");
  const next = await chat.sendChatMessage({ chatId: "c1", message: "total sales last month", signal: new AbortController().signal });
  check("next question answered", next.success === true && next.data.answer === "ok");
  check("...as exactly one new request", seen.filter((r) => r.method === "POST").length === 2);

  section("Rename / delete / list / open are plain chat REST calls");
  const before = seen.length;
  const renamed = await chat.renameChat("c1", "Q2 Customer Performance");
  const r = seen[before];
  check("rename = one PATCH /api/chat/:id with only {title}", r.method === "PATCH" && r.url === "/api/chat/c1" && JSON.stringify(r.body) === '{"title":"Q2 Customer Performance"}' && renamed.title === "Q2 Customer Performance", JSON.stringify(r));
  await chat.deleteChat("c1");
  check("delete = one DELETE /api/chat/:id", seen[before + 1].method === "DELETE" && seen[before + 1].url === "/api/chat/c1");
  await chat.listChats();
  await chat.getChat("c1");
  check("list + open = GETs only", seen[before + 2].method === "GET" && seen[before + 3].method === "GET" && seen.length === before + 4);
  check("none of them sent a chat message (no AI turn)", seen.slice(before).every((x) => !/\/message$/.test(x.url)));
  check("chat.js exports the same 100-character title limit as the backend", chat.MAX_CHAT_TITLE_CHARS === 100);

  section("Cost");
  check("zero calls to anything but the local stub (no Anthropic/Claude, no external service)", externalCalls === 0, externalCalls);
} catch (error) {
  fail += 1;
  console.log("  FAIL - unexpected error:", error && error.stack);
} finally {
  globalThis.fetch = savedFetch;
  https.request = savedHttps;
  await vite.close();
  await new Promise((r) => stub.close(r));
}

console.log(`\nverify-chat-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

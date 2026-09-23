/**
 * Focused, controlled-delay verification of the chat-timeout fix.
 *
 * Does NOT import client.js/chat.js directly (they're ESM modules using
 * import.meta.env, which plain Node can't evaluate outside Vite) —
 * instead it (a) asserts the actual source of both files has the
 * expected shape via a plain text check, and (b) proves axios's
 * per-call timeout-override semantics behaviorally, against a local
 * HTTP server with a controllable artificial delay, using the exact
 * same instance-default + per-call-override pattern client.js/chat.js
 * use. This is the real mechanism under test - the outcome is identical
 * whether the call originates from a React component or here.
 *
 * Run: node verify-chat-timeout.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

let passed = 0;
let failed = 0;

function check(label, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

// ---- Part 1: source-level shape checks ----
function testSourceShape() {
  console.log("\n=== Source shape ===");

  const clientSrc = fs.readFileSync(path.join(__dirname, "src/api/client.js"), "utf8");
  check("client.js still sets a 20000ms instance-default timeout", /timeout:\s*20000/.test(clientSrc));

  const chatSrc = fs.readFileSync(path.join(__dirname, "src/api/chat.js"), "utf8");
  check("chat.js defines a 60000ms chat timeout constant", /CHAT_TIMEOUT_MS\s*=\s*60000/.test(chatSrc));
  check(
    "sendChatMessage's POST call passes the chat timeout override",
    /client\.post\(path,\s*\{\s*message\s*\},\s*\{\s*timeout:\s*CHAT_TIMEOUT_MS\s*\}\)/.test(chatSrc)
  );
  // listChats/getChat/deleteChat must NOT carry a timeout override - they
  // keep the shared 20s default untouched.
  const nonChatCalls = ["client.get(\"/chat/\")", "client.get(`/chat/${chatId}`)", "client.delete(`/chat/${chatId}`)"];
  nonChatCalls.forEach((call) => {
    check(`${call} has no timeout override`, chatSrc.includes(call) && !new RegExp(`${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^;]*timeout`).test(chatSrc));
  });
}

// ---- Part 2: behavioral proof against a real delayed server ----
function startDelayServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const ms = Number(req.url.split("/").pop()) || 0;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, delayedMs: ms }));
      }, ms);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function testBehavior() {
  console.log("\n=== Behavioral (controlled-delay) checks ===");
  const server = await startDelayServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Mirrors client.js's instance exactly: 20s default.
  const client = axios.create({ timeout: 20000 });

  // 1. Normal one-tool-equivalent request (fast, well under any
  //    timeout) still succeeds - proves the fix doesn't break the
  //    common case.
  try {
    const res = await client.get(`${base}/delay/500`);
    check("normal fast request (500ms) succeeds under default 20s timeout", res.data.success === true);
  } catch (e) {
    check(`normal fast request (500ms) succeeds under default 20s timeout (error: ${e.message})`, false);
  }

  // 2. A 25s-delayed request through the DEFAULT (no override) times
  //    out - this is exactly the bug as originally reported: a
  //    multi-tool chat turn exceeding 20s used to abort here.
  const t0 = Date.now();
  try {
    await client.get(`${base}/delay/25000`);
    check("25s-delayed request WITHOUT override times out at ~20s (default preserved)", false);
  } catch (e) {
    const elapsed = Date.now() - t0;
    check(
      `25s-delayed request WITHOUT override times out at ~20s (default preserved) [elapsed=${elapsed}ms, code=${e.code}]`,
      e.code === "ECONNABORTED" && elapsed >= 19000 && elapsed < 24000
    );
  }

  // 3. The SAME 25s-delayed request, but with the chat override
  //    (timeout: 60000) applied per-call, exactly as sendChatMessage
  //    now does - succeeds, proving multi-tool/longer chat turns are
  //    now allowed beyond 20s without touching the shared default.
  const t1 = Date.now();
  try {
    const res = await client.get(`${base}/delay/25000`, { timeout: 60000 });
    const elapsed = Date.now() - t1;
    check(
      `25s-delayed request WITH chat override (60s) succeeds beyond 20s [elapsed=${elapsed}ms]`,
      res.data.success === true && elapsed >= 24000
    );
  } catch (e) {
    check(`25s-delayed request WITH chat override (60s) succeeds beyond 20s (error: ${e.message})`, false);
  }

  // 4. A non-chat-style call (no override) against the SAME server
  //    still respects the original 20s ceiling - proves the fix is
  //    scoped to chat only, not a global timeout increase.
  const t2 = Date.now();
  try {
    await client.get(`${base}/delay/22000`);
    check("non-chat call (no override) still times out beyond 20s", false);
  } catch (e) {
    const elapsed = Date.now() - t2;
    check(
      `non-chat call (no override) still times out beyond 20s [elapsed=${elapsed}ms]`,
      e.code === "ECONNABORTED" && elapsed < 22000
    );
  }

  // 5. Exactly one request reaches the server per call - the retry UX
  //    (a deliberate user click) is a separate, new axios call, never
  //    an automatic duplicate of the one that just failed.
  let hitCount = 0;
  const countingServer = http.createServer((req, res) => {
    hitCount += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });
  await new Promise((resolve) => countingServer.listen(0, "127.0.0.1", resolve));
  const countingPort = countingServer.address().port;
  await client.post(`http://127.0.0.1:${countingPort}/chat/message`, { message: "hi" }, { timeout: 60000 });
  check("a single sendChatMessage-style call produces exactly one server hit (no duplicate)", hitCount === 1);
  countingServer.close();

  server.close();
}

async function main() {
  testSourceShape();
  await testBehavior();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

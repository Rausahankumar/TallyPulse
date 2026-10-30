"use strict";
// A local stand-in for the provider, for DRY-RUNNING eval-ai-cost-live.js (it spends nothing). `--simulate-cache` makes it behave
// like a 5-minute prompt cache (first request of a prefix writes, later ones read) - a SIMULATION to exercise the live script's
// arithmetic, never evidence about the real provider. Run: node eval/cost/stub-server.js [--simulate-cache]   (prints its URL)
const { createStub } = require("./harness");
const { scriptedReply } = require("./scenarios");

const simulate = process.argv.includes("--simulate-cache");
const seen = new Map(); // prefix hash -> time of the last write/read
const usage = (body, rec) => {
  const tok = (v) => Math.ceil(JSON.stringify(v).length / 3.5);
  const prefix = tok([body.tools, body.system]);
  const out = { input_tokens: tok(body.messages), output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!simulate) { out.input_tokens += prefix; return out; }
  const t = seen.get(rec.prefixHash);
  if (t && Date.now() - t < 300000) out.cache_read_input_tokens = prefix;
  else out.cache_creation_input_tokens = prefix;
  seen.set(rec.prefixHash, Date.now());
  return out;
};
createStub(scriptedReply({ failNext: 0, failOnce: new Set() }), { usage }).then((s) => console.log(s.url));

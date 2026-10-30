"use strict";
// Prints what the ORIGINAL code does for Tests A-I and the SDK-retry check, through the real chat controller, against a local
// stand-in endpoint (no provider, no spend). Run: node eval/cost/run-baseline.js [--json=<file>]
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const fs = require("fs");
const { run } = require("./scenarios");

(async () => {
  const { out } = await run();
  const jsonArg = process.argv.find((a) => a.startsWith("--json="));
  if (jsonArg) fs.writeFileSync(jsonArg.slice(7), JSON.stringify(out, null, 2));
  const show = (k, v) => console.log(`\n== ${k}\n${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(out)) show(k, v);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
